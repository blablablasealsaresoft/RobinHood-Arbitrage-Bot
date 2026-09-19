import fs from 'node:fs';

const BPS = 10_000n;

export function expectedValueGate({
  grossProfit,
  successGasCost,
  revertGasCost,
  loseRaceBps = 0n,
  minExpectedValue = 0n,
}) {
  if (loseRaceBps < 0n || loseRaceBps > BPS) throw new Error('loseRaceBps must be 0..10000');
  const winBps = BPS - loseRaceBps;
  const successNet = grossProfit - successGasCost;
  const weighted = winBps * successNet - loseRaceBps * revertGasCost;
  const expectedValue = weighted / BPS;
  return {
    pass: grossProfit > 0n && expectedValue > minExpectedValue,
    expectedValue,
    successNet,
  };
}

export class NonceCoordinator {
  constructor(provider, address) {
    this.provider = provider;
    this.address = address;
    this.next = null;
  }
  async init() {
    this.next = await this.provider.getTransactionCount(this.address, 'pending');
    return this.next;
  }
  reserve() {
    if (this.next == null) throw new Error('nonce coordinator not initialized');
    return this.next++;
  }
  async resync() {
    return this.init();
  }
}

export class OpportunityDedupe {
  constructor(maxEntries = 4096) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  take(key, l2Block) {
    if (this.map.has(key)) return false;
    this.map.set(key, l2Block);
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
    return true;
  }
  invalidateFrom(l2Block) {
    for (const [key, block] of this.map) if (block >= l2Block) this.map.delete(key);
  }
}

export class Telemetry {
  constructor(path = process.env.SEQUENCER_TELEMETRY || 'sequencer-telemetry.ndjson') {
    this.path = path;
    this.queue = [];
    this.timer = setInterval(() => this.flush(), 100);
    this.timer.unref?.();
  }
  record(type, fields = {}) {
    this.queue.push({
      type,
      tNs: process.hrtime.bigint().toString(),
      wallMs: Date.now(),
      ...fields,
    });
  }
  flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0);
    fs.appendFile(this.path, batch.map(x => JSON.stringify(x)).join('\n') + '\n', () => {});
  }
  close() {
    clearInterval(this.timer);
    this.flush();
  }
}

export async function waitForExactL2Block(provider, targetBlock, targetHash, {
  timeoutMs = Number(process.env.LOCAL_NODE_CATCHUP_MS || 120),
  pollMs = Number(process.env.LOCAL_NODE_POLL_MS || 4),
} = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const head = await provider.getBlockNumber();
    if (head >= targetBlock) {
      const block = await provider.getBlock(targetBlock);
      if (!block) throw new Error('local node missing anchor block');
      if (String(block.hash).toLowerCase() !== String(targetHash).toLowerCase()) {
        throw new Error(`local node branch mismatch at ${targetBlock}`);
      }
      return block;
    }
    if (performance.now() >= deadline) throw new Error('local node did not catch sequencer block in time');
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
