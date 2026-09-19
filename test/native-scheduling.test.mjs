import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RouteBook, MarketState, NativeEngine, NonceCoordinator, normalizeCosts } from '../native/core.mjs';
const H = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const read = () => JSON.parse(fs.readFileSync('native/example.json', 'utf8'));
const input = () => fs.readFileSync('native/example.ndjson', 'utf8').trim().split('\n').map(JSON.parse);
function next(previous, updates = []) {
  const n = BigInt(previous.blockNumber) + 1n;
  return { ...previous, type: 'block', sequence: String(BigInt(previous.sequence) + 1n), blockNumber: String(n),
    blockHash: H(n + 1000n), feedBlockHash: H(n + 1000n), parentHash: previous.blockHash, updates };
}
function setup({ maxInFlight = 4, wire } = {}) {
  const config = read(), book = new RouteBook(config.pools, config.routes);
  let now = 0;
  const state = new MarketState(book, { clock: () => now });
  const nonces = new NonceCoordinator({ maxInFlight }); nonces.bootstrap({ latest: 0, pending: 0 });
  const costs = new Map(config.costs.map(x => [x.settlementToken, normalizeCosts({ ...x, validUntilBlock: '100000' }, x.settlementToken)]));
  const signed = [], sent = [];
  const engine = new NativeEngine({ book, state, nonces, costs, live: true,
    wire: async (op, nonce) => { signed.push({ head: op.head.number, nonce }); if (wire) await wire(op, nonce);
      return { hash: H(nonce + 5000n), raw: '0x01' }; },
    broadcaster: { broadcast: async (_raw, hash) => { sent.push(hash); return { path: 'stub' }; } } });
  return { engine, state, nonces, signed, sent, config, advanceClock: n => { now = n; } };
}
test('newest changed state is evaluated after an old signing operation is discarded', async () => {
  let release; const barrier = new Promise(r => { release = r; });
  const f = setup({ wire: (_op, nonce) => f.signed.length === 1 ? barrier : undefined });
  const [a,b] = input(); await f.engine.onFrame(a); const old = f.engine.onFrame(b);
  const c = next(b, [{ ...a.updates[0], reserve1: '2100000' }]);
  assert.equal(await f.engine.onFrame(c), null);
  release(); assert.equal(await old, null);
  const result = await f.engine.drainPending();
  assert.equal(result.head.number, BigInt(c.blockNumber)); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.signed.map(x => x.nonce), [0n,0n]); assert.equal(f.engine.hasPendingDecision, false);
});
test('an unchanged newer block preserves the unsent route dependency', async () => {
  let release; const barrier = new Promise(r => { release = r; });
  const f = setup({ wire: () => f.signed.length === 1 ? barrier : undefined });
  const [a,b] = input(); await f.engine.onFrame(a); const old = f.engine.onFrame(b);
  const c = next(b); await f.engine.onFrame(c); release(); await old;
  assert.equal(f.engine.hasPendingDecision, true);
  assert.equal((await f.engine.drainPending()).head.number, BigInt(c.blockNumber));
});
test('many busy blocks coalesce into bounded dependencies and the newest anchor', async () => {
  let release; const barrier = new Promise(r => { release = r; });
  const f = setup({ wire: () => f.signed.length === 1 ? barrier : undefined });
  const [a,b] = input(); await f.engine.onFrame(a); const old = f.engine.onFrame(b);
  let frame = b;
  for (let i=0; i<100; i++) { frame = next(frame, [{...a.updates[i % 2], reserve1: String((i % 2 === 0 ? 2100000 : 1000000) + i)}]); await f.engine.onFrame(frame); }
  assert.ok(f.engine.pendingPools.size <= f.engine.book.pools.size);
  assert.equal(f.engine.pendingHead.head.number, BigInt(frame.blockNumber));
  release(); await old; const result = await f.engine.drainPending();
  assert.equal(result.head.number, BigInt(frame.blockNumber)); assert.equal(f.signed.length, 2);
});
test('invalidation clears deferred decisions and never resurrects the old epoch', async () => {
  let release; const barrier = new Promise(r => { release = r; }); const f = setup({ wire: () => barrier });
  const [a,b] = input(); await f.engine.onFrame(a); const old = f.engine.onFrame(b);
  await f.engine.onFrame(next(b)); await f.engine.onFrame({ type: 'invalidate', reason: 'reorg' });
  release(); await old; assert.equal(await f.engine.drainPending(), null);
  assert.equal(f.sent.length, 0); assert.equal(f.nonces.blocked, true); assert.equal(f.engine.hasPendingDecision, false);
});
test('expired coalesced state is dropped rather than signed after a stall', async () => {
  let release; const barrier = new Promise(r => { release = r; }); const f = setup({ wire: () => barrier });
  const [a,b] = input(); await f.engine.onFrame(a); const old = f.engine.onFrame(b);
  await f.engine.onFrame(next(b)); f.advanceClock(1000); release(); await old;
  assert.equal(await f.engine.drainPending(), null); assert.equal(f.sent.length, 0);
});
test('nonce backpressure preserves changed dependencies until receipt reconciliation', async () => {
  const f = setup({ maxInFlight: 1 }), [a,b] = input(); await f.engine.onFrame(a); const first = await f.engine.onFrame(b);
  const c = next(b, [{...a.updates[0], reserve1: '2100000'}]); await f.engine.onFrame(c);
  assert.equal(f.engine.hasPendingDecision, true); assert.equal(f.sent.length,1);
  f.nonces.included(first.nonce, first.hash);
  const second = await f.engine.drainPending(); assert.equal(second.nonce,1n); assert.equal(second.head.number,BigInt(c.blockNumber));
});
test('latest coalesced state can remove the opportunity; no historical quote is reused', async () => {
  let release; const barrier = new Promise(r => { release = r; }); const f = setup({ wire: () => barrier });
  const [a,b] = input(); await f.engine.onFrame(a); const old = f.engine.onFrame(b);
  const c = next(b, a.updates.map(x => ({...x, reserve0: '1000000', reserve1: '1000000'})));
  await f.engine.onFrame(c); release(); await old;
  assert.equal(await f.engine.drainPending(),null); assert.equal(f.signed.length,1); assert.equal(f.sent.length,0);
});
test('ambiguous dispatch does not trigger a deferred transaction or nonce rewind', async () => {
  let release; const barrier = new Promise(r => { release = r; }); const f = setup();
  let started; const dispatched = new Promise(r => { started = r; });
  f.engine.broadcaster.broadcast = async () => { started(); await barrier; throw new Error('ambiguous ACK'); };
  const [a,b] = input(); await f.engine.onFrame(a); const old = f.engine.onFrame(b);
  await dispatched; await f.engine.onFrame(next(b, [{...a.updates[0],reserve1:'2100000'}]));
  release(); await assert.rejects(old,/ambiguous/); assert.equal(await f.engine.drainPending(),null);
  assert.equal(f.nonces.next,1n); assert.equal(f.signed.length,1);
});
