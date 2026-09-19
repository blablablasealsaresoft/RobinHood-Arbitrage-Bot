// sequencer-feed.js — execution-grade Robinhood Chain Nitro feed client.
//
// Post Sep-17-2026 semantics: the sequencer has already ordered AND executed a
// block before broadcasting its feed message. This is a soft-confirmed block
// stream for racing into the NEXT block, not a pre-execution mempool.

import WebSocket from 'ws';
import { decodeFeedTransactions } from './sequencer-codec.js';
import { MAINNET_FEED_SIGNER, verifyFeedEntry } from './sequencer-verify.js';

const DEFAULT_URL = 'wss://feed.mainnet.chain.robinhood.com';
const DIRECT_HOST = 'feed.mainnet.chain.robinhood.com';

function envBool(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}
function parseSigners(raw) {
  const xs = String(raw || MAINNET_FEED_SIGNER).split(',').map((x) => x.trim()).filter(Boolean);
  return xs.length ? xs : [MAINNET_FEED_SIGNER];
}
function isDirectUrl(url) {
  try { return new URL(url).hostname === DIRECT_HOST; } catch { return false; }
}

export class SequencerFeedClient {
  constructor({
    url = process.env.SEQUENCER_FEED_URL || DEFAULT_URL,
    onBatch = () => {},
    onStatus = () => {},
    WebSocketImpl = WebSocket,
    reconnectMinMs = 500,
    reconnectMaxMs = 15000,
    idleTimeoutMs = 30000,
    maxLiveAgeMs = 5000,
    decodeTransactions = true,
    verifySignatures = envBool('SEQUENCER_VERIFY_SIGNATURES', true),
    allowedSigners = parseSigners(process.env.SEQUENCER_FEED_SIGNERS),
    integrityCooldownMs = 5000,
    reorgWindow = 1024,
    now = Date.now,
  } = {}) {
    this.url = url;
    this.onBatch = onBatch;
    this.onStatus = onStatus;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxLiveAgeMs = maxLiveAgeMs;
    this.decodeTransactions = decodeTransactions;
    this.verifySignatures = verifySignatures;
    this.allowedSigners = allowedSigners;
    this.integrityCooldownMs = integrityCooldownMs;
    this.reorgWindow = reorgWindow;
    this.now = now;

    this.ws = null;
    this.stopped = true;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.highestSequence = null;
    this.blockHashes = new Map();
    this.lastIntegrityIssueAt = 0;
    this.stats = {
      connected: false,
      connects: 0,
      reconnects: 0,
      frames: 0,
      messages: 0,
      liveMessages: 0,
      backlogMessages: 0,
      parseErrors: 0,
      duplicateMessages: 0,
      unverifiedMessages: 0,
      sequenceGaps: 0,
      reorgs: 0,
      lastFrameAt: null,
      lastSequenceNumber: null,
      lastBlockHash: null,
      lastError: null,
      quality: 'RPC_ONLY',
      direct: isDirectUrl(url),
      signatureVerification: verifySignatures,
    };
  }

  start() {
    if (!this.WebSocketImpl) throw new Error('Sequencer feed requires WebSocket support.');
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    this.reconnectTimer = null;
    this.idleTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch {} }
    this.stats.connected = false;
    this.stats.quality = 'RPC_ONLY';
  }

  snapshot() { return { ...this.stats }; }

  #connect() {
    if (this.stopped) return;
    let ws;
    try {
      const headers = { 'Arbitrum-Feed-Client-Version': '2' };
      if (this.highestSequence !== null) {
        headers['Arbitrum-Requested-Sequence-Number'] = String(this.highestSequence);
      }
      ws = new this.WebSocketImpl(this.url, {
        // Robinhood public feed is compressed-only since 2026-09-17.
        perMessageDeflate: true,
        headers,
        maxPayload: 16 * 1024 * 1024,
      });
    } catch (error) {
      this.#fail(error);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.stopped) return;
      this.stats.connected = true;
      this.stats.connects++;
      if (this.reconnectAttempt > 0) this.stats.reconnects++;
      this.reconnectAttempt = 0;
      this.stats.lastError = null;
      this.stats.quality = 'DEGRADED';
      this.onStatus({ type: 'connected', at: this.now(), stats: this.snapshot() });
      this.#armIdle(ws);
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws || this.stopped) return;
      this.#armIdle(ws);
      void this.#handleFrame(event.data).catch((error) => {
        this.stats.parseErrors++;
        this.#markIntegrityIssue();
        this.#fail(error);
      });
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws || this.stopped) return;
      this.#fail(new Error('sequencer feed websocket error'));
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stats.connected = false;
      this.stats.quality = 'RPC_ONLY';
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.onStatus({ type: 'disconnected', at: this.now(), stats: this.snapshot() });
      if (!this.stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const exp = Math.min(this.reconnectAttempt++, 8);
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** exp));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #armIdle(ws) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.ws !== ws || this.stopped) return;
      this.#markIntegrityIssue();
      this.#fail(new Error('sequencer feed idle timeout'));
      try { ws.close(); } catch {}
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.stats.lastError = message;
    this.onStatus({ type: 'error', at: this.now(), error: message, stats: this.snapshot() });
  }

  #markIntegrityIssue() { this.lastIntegrityIssueAt = this.now(); }

  #remember(seq, hash) {
    if (!hash) return;
    this.blockHashes.set(String(seq), hash.toLowerCase());
    if (this.blockHashes.size > this.reorgWindow * 2 && this.highestSequence !== null) {
      const cutoff = this.highestSequence - BigInt(this.reorgWindow);
      for (const key of this.blockHashes.keys()) {
        if (BigInt(key) < cutoff) this.blockHashes.delete(key);
      }
    }
  }

  #rewind(seq) {
    for (const key of [...this.blockHashes.keys()]) {
      if (BigInt(key) >= seq) this.blockHashes.delete(key);
    }
    this.highestSequence = seq - 1n;
  }

  #quality(live, hasHash) {
    if (!this.stats.connected) return 'RPC_ONLY';
    if (!live || !hasHash || this.now() - this.lastIntegrityIssueAt < this.integrityCooldownMs) return 'DEGRADED';
    if (!this.verifySignatures) return 'DEGRADED';
    return this.stats.direct ? 'DIRECT_VERIFIED' : 'RELAY_VERIFIED';
  }

  async #handleFrame(data) {
    const text = await frameToText(data);
    const parsed = JSON.parse(text);
    const rawMessages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const receivedAt = this.now();
    const accepted = [];
    let frameReorg = false;
    let frameGap = false;

    for (const entry of rawMessages) {
      if (this.verifySignatures) {
        const verified = verifyFeedEntry(entry, { allowedSigners: this.allowedSigners });
        if (!verified.ok) {
          this.stats.unverifiedMessages++;
          this.#markIntegrityIssue();
          this.onStatus({ type: 'unverified', at: receivedAt, signer: verified.signer, stats: this.snapshot() });
          continue;
        }
      }

      const rawSeq = entry?.sequenceNumber;
      if (rawSeq == null) continue;
      const seq = BigInt(rawSeq);
      const hash = entry?.blockHash ? String(entry.blockHash).toLowerCase() : null;
      const previousHash = this.blockHashes.get(String(seq));

      if (this.highestSequence !== null && seq <= this.highestSequence) {
        if (previousHash && hash && previousHash !== hash) {
          this.stats.reorgs++;
          frameReorg = true;
          this.#markIntegrityIssue();
          this.#rewind(seq);
          this.onStatus({
            type: 'reorg', at: receivedAt, sequenceNumber: String(seq),
            oldBlockHash: previousHash, newBlockHash: hash, stats: this.snapshot(),
          });
        } else {
          this.stats.duplicateMessages++;
          continue;
        }
      }

      if (this.highestSequence !== null && seq > this.highestSequence + 1n) {
        this.stats.sequenceGaps++;
        frameGap = true;
        this.#markIntegrityIssue();
        this.onStatus({
          type: 'gap', at: receivedAt,
          expected: String(this.highestSequence + 1n), got: String(seq), stats: this.snapshot(),
        });
      }

      this.highestSequence = seq;
      this.#remember(seq, hash);
      accepted.push(entry);
    }

    if (!accepted.length) return;
    const filteredFrame = { ...parsed, messages: accepted };
    const last = accepted[accepted.length - 1];
    const lastSequenceNumber = String(last.sequenceNumber);
    const anchorBlockHash = last?.blockHash || null;
    const timestamps = accepted
      .map((m) => Number(m?.message?.message?.header?.timestamp || 0))
      .filter((v) => Number.isFinite(v) && v > 0);
    const latestTimestamp = timestamps.length ? Math.max(...timestamps) : 0;
    const messageAgeMs = latestTimestamp ? receivedAt - latestTimestamp * 1000 : null;
    const live = messageAgeMs !== null && messageAgeMs <= this.maxLiveAgeMs;
    const transactions = this.decodeTransactions ? decodeFeedTransactions(filteredFrame) : [];
    const quality = this.#quality(live, Boolean(anchorBlockHash));

    this.stats.frames++;
    this.stats.messages += accepted.length;
    this.stats[live ? 'liveMessages' : 'backlogMessages'] += accepted.length;
    this.stats.lastFrameAt = receivedAt;
    this.stats.lastSequenceNumber = lastSequenceNumber;
    this.stats.lastBlockHash = anchorBlockHash;
    this.stats.quality = quality;

    this.onBatch({
      receivedAt,
      version: parsed?.version ?? null,
      messageCount: accepted.length,
      lastSequenceNumber,
      anchorBlock: lastSequenceNumber,
      anchorBlockHash,
      frameBytes: Buffer.byteLength(text),
      latestTimestamp,
      messageAgeMs,
      live,
      quality,
      reorg: frameReorg,
      sequenceGap: frameGap,
      transactions,
    });
  }
}

async function frameToText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof data.text === 'function') return await data.text();
  return String(data);
}
