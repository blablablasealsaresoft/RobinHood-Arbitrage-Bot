import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { uint, hash32, stable } from './core.mjs';

// One persistent connection pool per path; the only hot-path method is
// eth_sendRawTransaction. Never call wallet.populateTransaction here.
export class RawBroadcaster {
  constructor(endpoints, { timeoutMs = 250, maxResponseBytes = 65_536, record = () => {} } = {}) {
    if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > 8) throw new Error('1..8 submission paths required');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('positive timeout required');
    this.timeoutMs = timeoutMs; this.maxResponseBytes = maxResponseBytes; this.record = record;
    this.paths = endpoints.map((endpoint, index) => {
      const url = new URL(endpoint);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('HTTP(S) endpoint required');
      if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('remote submission requires TLS');
      const client = url.protocol === 'https:' ? https : http;
      return { id: `path-${index}`, url, client, agent: new client.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 }) };
    });
  }
  #post(p, payload) {
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const req = p.client.request(p.url, { method: 'POST', agent: p.agent,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
        let body = '', size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > this.maxResponseBytes) req.destroy(new Error('oversized RPC response'));
          else body += chunk.toString('utf8');
        });
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new Error('RPC response aborted')));
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(new Error(`RPC HTTP ${res.statusCode}`));
          try {
            const result = JSON.parse(body);
            if (result.jsonrpc !== '2.0' || result.id !== 1) throw new Error('invalid RPC envelope');
            finish(null, result);
          } catch (error) { finish(error); }
        });
      });
      timer = setTimeout(() => { const error = new Error('submission deadline exceeded'); finish(error); req.destroy(error); }, this.timeoutMs);
      req.on('error', error => finish(error));
      req.end(payload);
    });
  }
  async warm() {
    // Cold-path TLS/socket warm-up only. Some sequencers reject eth_chainId;
    // that still establishes the connection and is not an inclusion guarantee.
    await Promise.allSettled(this.paths.map(p => this.#post(p, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }))));
  }
  async broadcast(raw, expectedHash, fresh = () => true) {
    if (typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw)) throw new Error('signed raw bytes required');
    expectedHash = hash32(expectedHash);
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] });
    const attempts = this.paths.map(async p => {
      if (!fresh()) throw new Error('opportunity obsolete before dispatch');
      const start = process.hrtime.bigint(); this.record('POST_started', { path: p.id, txHash: expectedHash });
      try {
        const response = await this.#post(p, payload);
        // An arbitrary "already known" error is NOT proof of acceptance of our
        // expected hash. All ambiguous outcomes stay uncertain until reconciled.
        if (response.error || String(response.result).toLowerCase() !== expectedHash) throw new Error('RPC did not acknowledge expected transaction hash');
        const result = { path: p.id, latencyUs: ((process.hrtime.bigint() - start) / 1000n).toString() };
        this.record('path_accepted', { ...result, txHash: expectedHash }); return result;
      } catch (error) { this.record('path_failed', { path: p.id, message: error.message }); throw error; }
    });
    // The slowest path must not delay the first valid acknowledgment. Handlers
    // stay attached to every attempt, so late failures never become unhandled.
    return Promise.any(attempts);
  }
  close() { for (const p of this.paths) p.agent.destroy(); }
}

export class Telemetry {
  constructor(filename, { maxQueued = 4096 } = {}) {
    this.filename = filename; this.maxQueued = maxQueued; this.queue = []; this.dropped = 0;
    this.flushing = false; this.closed = false; this.error = null;
    this.timer = setInterval(() => { void this.flush(); }, 100); this.timer.unref();
  }
  record = (type, fields = {}) => {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueued) { this.dropped++; return; }
    this.queue.push(stable({ type, monotonicNs: process.hrtime.bigint().toString(), wallMs: Date.now(), ...fields }));
  };
  async flush() {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue.splice(0).join('\n') + '\n';
    try { await fs.promises.appendFile(this.filename, batch, { mode: 0o600 }); }
    catch (error) { this.error = error; this.dropped += batch.split('\n').length - 1; }
    finally { this.flushing = false; }
  }
  async close() {
    clearInterval(this.timer); this.closed = true;
    while (this.flushing) await new Promise(resolve => setTimeout(resolve, 2));
    await this.flush();
  }
}

// Process ownership is local to this filesystem: NEVER run the same EOA on
// another host. A crash leaves the lock/journal behind on purpose. Restart only
// after independent latest/pending/receipt reconciliation; expiry is not nonce
// cancellation. No key material or endpoint credentials are journaled.
export class RelayerJournal {
  constructor(directory, relayer) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = relayer.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(name)) throw new Error('invalid relayer');
    this.lock = path.join(directory, `${name}.lock`);
    this.filename = path.join(directory, `${name}.ndjson`);
    this.lockFd = fs.openSync(this.lock, 'wx', 0o600);
    fs.writeSync(this.lockFd, `${process.pid}\n`); fs.fsyncSync(this.lockFd);
    try {
      if (fs.existsSync(this.filename) && fs.statSync(this.filename).size > 0) throw new Error('existing nonce journal requires operator reconciliation/archive');
      this.fd = fs.openSync(this.filename, 'ax', 0o600);
    } catch (error) { fs.closeSync(this.lockFd); fs.unlinkSync(this.lock); throw error; }
    this.dirty = false;
  }
  append(entry) {
    this.dirty = true;
    fs.writeSync(this.fd, stable({ wallMs: Date.now(), ...entry }) + '\n');
    fs.fsyncSync(this.fd); // Explicit durability/latency trade-off; measured stage.
  }
  close() {
    if (this.fd == null) return;
    fs.closeSync(this.fd); fs.closeSync(this.lockFd); this.fd = null;
    if (!this.dirty) { fs.unlinkSync(this.lock); fs.unlinkSync(this.filename); }
    // Any signed/broadcast history retains the interlock, even after clean exit.
  }
}
