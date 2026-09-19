import test from 'node:test';
import assert from 'node:assert/strict';
import { RouteBook, MarketState, uint, isqrt, v2Quote, quoteRoute, optimizeRoute, expectedValueGate,
  normalizeCosts, NativeEngine, NonceCoordinator, OpportunityDedupe, fingerprint } from '../native/core.mjs';
import { sqrtAtTick, concentratedQuote, Q96 } from '../native/concentrated.mjs';
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const A = addr(1), B = addr(2);
function config() {
  return { pools: [1, 2].map(n => ({ id: `p${n}`, kind: 'v2', pair: addr(10+n), adapter: addr(20+n),
    token0: A, token1: B, feeNumerator: '997', feeDenominator: '1000' })),
    routes: [{ id: 'roundtrip', settlementToken: A, minInput: '1', maxInput: '100000', borrowCap: '100000',
      legs: [{ poolId: 'p1', tokenIn: A, tokenOut: B }, { poolId: 'p2', tokenIn: B, tokenOut: A }] }] };
}
function fixture() { const c = config(); const book = new RouteBook(c.pools, c.routes); return { book, state: new MarketState(book) }; }
function frame(n, updates = []) { return { schema: 1, type: n === 100 ? 'snapshot' : 'block', complete: true, chainId: 4663,
  sequence: String(n), blockNumber: String(n), blockHash: hash(n), feedBlockHash: hash(n), parentHash: hash(n-1), timestamp: '1000', updates }; }
const reserves = () => [{ poolId: 'p1', reserve0: '1000000', reserve1: '2000000' }, { poolId: 'p2', reserve0: '1000000', reserve1: '1000000' }];
function boot(state) { state.ingest(frame(100, reserves())); state.ingest(frame(101)); }
function costs() { return new Map([[A, normalizeCosts({ settlementToken: A, validUntilBlock: '10000',
  successGasWei: '1', revertGasWei: '2', settlementUnitsPerWeiNumerator: '1', settlementUnitsPerWeiDenominator: '1', loseRaceBps: '2000' }, A)]]); }

test('integers reject precision loss and coercion', () => {
  for (const n of [Number.MAX_SAFE_INTEGER + 1, -1, '', null, true, '1.2', '1e18']) assert.throws(() => uint(n));
  assert.equal(uint('9007199254740993'), 9007199254740993n);
});
test('integer square root handles optimizer values beyond uint256', () => {
  const n = (1n << 700n) + 56789n; const root = isqrt(n);
  assert.ok(root * root <= n && (root + 1n) ** 2n > n);
  assert.equal(isqrt(0n), 0n); assert.equal(isqrt(144n), 12n); assert.throws(() => isqrt(-1n));
});
test('compiled routes are closed, continuous, unique-pool and bounded', () => {
  for (const mutate of [c => c.routes[0].legs[1].tokenOut = B, c => c.routes[0].legs[1].tokenIn = A,
    c => c.routes[0].legs[1].poolId = 'p1', c => c.routes[0].maxInput = '100001', c => c.pools[0].kind = 'robinfun']) {
    const c = config(); mutate(c); assert.throws(() => new RouteBook(c.pools, c.routes));
  }
});
test('exact V2 integer quote includes fee and price impact', () => {
  const { state } = fixture(); boot(state);
  const pool = state.pools.get('p1');
  assert.equal(v2Quote(pool, A, 1000n), 1992n);
  assert.throws(() => v2Quote(pool, addr(9), 10n));
  assert.throws(() => v2Quote(pool, A, 1n << 112n));
});
test('small-domain optimizer matches exhaustive integer search', () => {
  for (let seed = 1; seed < 35; seed++) {
    const { book, state } = fixture();
    const r = reserves(); r[0].reserve0 = String(100 + seed * 7); r[0].reserve1 = String(300 + seed * 11);
    r[1].reserve0 = String(200 + seed * 13); r[1].reserve1 = String(300 + seed * 5);
    state.ingest(frame(100, r)); state.ingest(frame(101));
    const route = { ...book.routes.get('roundtrip'), maxInput: 100n };
    const actual = optimizeRoute(route, state.pools);
    const brute = Array.from({length: 100}, (_, i) => quoteRoute(route, state.pools, BigInt(i+1)))
      .filter(x => x.outputs.length === 2 && x.outputs.every(n => n > 0n))
      .sort((a, b) => a.grossProfit === b.grossProfit ? Number(a.amount-b.amount) : Number(b.grossProfit-a.grossProfit))[0];
    assert.equal(actual?.grossProfit, brute?.grossProfit); assert.equal(actual?.amount, brute?.amount);
  }
});
test('large-domain optimizer uses local analytic sizing', () => {
  const { book, state } = fixture(); boot(state);
  const q = optimizeRoute(book.routes.get('roundtrip'), state.pools);
  assert.ok(q.grossProfit > 0n && q.amount <= 100000n);
});
test('TickMath reference endpoints and zero', () => {
  assert.equal(sqrtAtTick(0), Q96);
  assert.equal(sqrtAtTick(-887272), 4295128739n);
  assert.equal(sqrtAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  assert.throws(() => sqrtAtTick(887273));
});
test('single-tick quotes use integer rounding and refuse a crossing', () => {
  const lower = sqrtAtTick(0), upper = sqrtAtTick(1), P = (lower+upper)/2n;
  const p = {kind:'v3', token0:A, token1:B, sqrtPriceX96:P, liquidity:10n**24n, feePips:3000n, lowerX96:lower, upperX96:upper};
  const q = 10n**12n, net = q*997000n/1000000n;
  const next = (p.liquidity*Q96*P + p.liquidity*Q96+net*P-1n)/(p.liquidity*Q96+net*P);
  assert.equal(concentratedQuote(p,A,q),p.liquidity*(P-next)/Q96);
  assert.ok(concentratedQuote(p,B,q)>0n);
  assert.throws(() => concentratedQuote(p,A,10n**24n), /tick crossing/);
});
test('V4 directional protocol fee changes output', () => {
  const p = {kind:'v4', token0:A, token1:B, sqrtPriceX96:(sqrtAtTick(0)+sqrtAtTick(1))/2n,
    liquidity:10n**24n, lpFee:3000n, protocolFee:1000n, lowerX96:sqrtAtTick(0), upperX96:sqrtAtTick(1)};
  const plain = {...p, protocolFee:0n};
  assert.ok(concentratedQuote(p,A,10n**12n) < concentratedQuote(plain,A,10n**12n));
  assert.equal(concentratedQuote(p,B,10n**12n), concentratedQuote(plain,B,10n**12n));
});
test('V4 hooks and dynamic fee configurations fail closed', () => {
  const c = config(); Object.assign(c.pools[0], {kind:'v4', feePips:'3000', hooks:addr(9), adapterData:'0x'});
  assert.throws(() => new RouteBook(c.pools, c.routes), /hooks/);
});
test('snapshot is not tradable until a contiguous executed block arrives', () => {
  const { state } = fixture(); state.ingest(frame(100, reserves())); assert.equal(state.healthy(), false);
  state.ingest(frame(101)); assert.equal(state.healthy(), true);
});
test('all watched pools are required in the initial snapshot', () => {
  const {state} = fixture(); assert.throws(() => state.ingest(frame(100, reserves().slice(0,1))), /every watched/);
});
test('state updates are atomic and immutable', () => {
  const {state} = fixture(); boot(state); const before = state.pools.get('p1');
  assert.throws(() => state.ingest(frame(102, [{poolId:'p1',reserve0:'7',reserve1:'8'},{poolId:'p2',reserve0:'bad',reserve1:'8'}])));
  assert.equal(state.pools.get('p1'), before); assert.equal(state.head.number,101n); assert.equal(state.healthy(),false);
  assert.throws(() => before.reserve0 = 1n);
});
test('a gap, replacement, parent mismatch or wrong feed hash stops trading', () => {
  for (const bad of [frame(103), {...frame(101),blockHash:hash(999),feedBlockHash:hash(999)},
    {...frame(102),parentHash:hash(999)}, {...frame(102),feedBlockHash:hash(999)}]) {
    const {state}=fixture();boot(state);assert.throws(()=>state.ingest(bad));assert.equal(state.healthy(),false);
  }
});
test('duplicates do not refresh state age; reconciliation is explicit', () => {
  let now=0; const {book}=fixture();const state=new MarketState(book,{clock:()=>now,maxAgeMs:100});boot(state);
  now=90;assert.equal(state.ingest(frame(101)),null);now=101;assert.equal(state.healthy(),false);
  assert.throws(()=>state.ingest(frame(102)),/reconciliation/);
  state.ingest({...frame(103,reserves()),type:'snapshot'});assert.equal(state.healthy(),false);
  state.ingest(frame(104));assert.equal(state.healthy(),true);
});
test('sequence numbers above JS safe integer remain exact', () => {
  const {state}=fixture(); const base=9007199254740993n;
  state.ingest({...frame(100,reserves()),sequence:String(base),blockNumber:String(base)});
  state.ingest({...frame(101),sequence:String(base+1n),blockNumber:String(base+1n)});
  assert.equal(state.head.sequence,base+1n);
});
test('negative-EV volume, stale costs and wrong units are rejected', () => {
  assert.equal(expectedValueGate({grossProfit:15n,successGasCost:20n,revertGasCost:8n,loseRaceBps:1000n}).pass,false);
  assert.equal(expectedValueGate({grossProfit:300n,successGasCost:20n,revertGasCost:8n,loseRaceBps:1000n}).pass,true);
  assert.equal(expectedValueGate({grossProfit:1n,successGasCost:0n,revertGasCost:0n,loseRaceBps:9999n}).pass,true);
  assert.equal(expectedValueGate({grossProfit:9999n,successGasCost:10000n,revertGasCost:0n,loseRaceBps:9999n}).pass,false);
  assert.throws(()=>normalizeCosts({settlementToken:B},A));
  assert.throws(()=>expectedValueGate({grossProfit:1n,successGasCost:0n,revertGasCost:0n}));
});
test('gas conversion rounds upward in settlement base units', () => {
  const c=normalizeCosts({settlementToken:A,validUntilBlock:2,successGasWei:1,revertGasWei:4,
    settlementUnitsPerWeiNumerator:1,settlementUnitsPerWeiDenominator:3,loseRaceBps:1},A);
  assert.equal(c.successGasCost,1n);assert.equal(c.revertGasCost,2n);
});
test('nonce coordinator never rewinds a possibly submitted nonce', () => {
  const n=new NonceCoordinator({maxInFlight:2});n.bootstrap({latest:5,pending:5});
  const a=n.reserve(),b=n.reserve();assert.deepEqual([a,b],[5n,6n]);assert.throws(()=>n.reserve());
  assert.throws(()=>n.releaseUnsent(a));n.releaseUnsent(b);n.submitted(a,hash(9));
  assert.throws(()=>n.releaseUnsent(a));assert.throws(()=>n.bootstrap({latest:5,pending:6}));
  n.uncertain();assert.throws(()=>n.reserve());n.included(a,hash(9));assert.throws(()=>n.reserve());
});
test('external pending nonce and wrong receipt are not silently adopted', () => {
  const n=new NonceCoordinator();assert.throws(()=>n.bootstrap({latest:1,pending:2}));
  n.bootstrap({latest:1,pending:1});n.submitted(n.reserve(),hash(10));assert.throws(()=>n.included(1,hash(11)));
});
test('deduplication is bounded and key does not depend on trial size', () => {
  const d=new OpportunityDedupe(2);assert.equal(d.take('a',1n),true);assert.equal(d.take('a',1n),false);
  d.take('b',2n);d.take('c',3n);assert.equal(d.map.size,2);
  assert.equal(fingerprint({a:1n,b:2n}),fingerprint({b:2n,a:1n}));
});
test('dry-run pipeline finds an opportunity without signing or any network dependency', async () => {
  const {book,state}=fixture();let called=0;
  const engine=new NativeEngine({book,state,costs:costs(),live:false,wire:()=>called++,broadcaster:{broadcast:()=>called++}});
  await engine.onFrame(frame(100,reserves()));
  const result=await engine.onFrame(frame(101,[{poolId:'p1',reserve0:'999999',reserve1:'2000000'}]));
  assert.ok(result.grossProfit>0n);assert.equal(called,0);
});
test('new block arriving during signing makes old signed work unsendable', async () => {
  const {book,state}=fixture();let release;const pending=new Promise(resolve=>release=resolve);let sent=0;
  const nonces=new NonceCoordinator();nonces.bootstrap({latest:0,pending:0});
  const engine=new NativeEngine({book,state,costs:costs(),live:true,nonces,
    wire:async()=>{await pending;return {raw:'0x01',hash:hash(999)};},broadcaster:{broadcast:async()=>{sent++;return {path:'mock'};}}});
  await engine.onFrame(frame(100,reserves()));
  const work=engine.onFrame(frame(101,[{poolId:'p1',reserve0:'999999',reserve1:'2000000'}]));
  await engine.onFrame(frame(102));release();assert.equal(await work,null);assert.equal(sent,0);assert.equal(nonces.next,0n);
});
test('ambiguous broadcast halts new nonce allocation rather than resyncing backwards', async () => {
  const {book,state}=fixture();const nonces=new NonceCoordinator();nonces.bootstrap({latest:0,pending:0});
  const engine=new NativeEngine({book,state,costs:costs(),live:true,nonces,
    wire:async()=>({raw:'0x01',hash:hash(999)}),broadcaster:{broadcast:async()=>{throw new Error('timeout');}}});
  await engine.onFrame(frame(100,reserves()));
  await assert.rejects(engine.onFrame(frame(101,[{poolId:'p1',reserve0:'999999',reserve1:'2000000'}])),/timeout/);
  assert.equal(nonces.next,1n);assert.equal(nonces.blocked,true);assert.throws(()=>nonces.reserve());
});
test('ordinary in-flight nonce backpressure is not a fatal reconciliation fault', async () => {
  const {book,state}=fixture(), nonces=new NonceCoordinator();nonces.bootstrap({latest:0,pending:0});
  let sent=0;
  const engine=new NativeEngine({book,state,costs:costs(),live:true,nonces,
    wire:async()=>({raw:'0x01',hash:hash(999+sent)}),broadcaster:{broadcast:async()=>{sent++;return {path:'mock'};}}});
  await engine.onFrame(frame(100,reserves())); await engine.onFrame(frame(101));
  const result=await engine.onFrame(frame(102,[{poolId:'p1',reserve0:'999998',reserve1:'2000000'}]));
  assert.equal(result,null);assert.equal(nonces.blocked,false);assert.equal(state.healthy(),true);assert.equal(sent,1);
  nonces.included(0,hash(999));
  await engine.onFrame(frame(103,[{poolId:'p1',reserve0:'999997',reserve1:'2000000'}]));
  assert.equal(sent,2);assert.equal(nonces.next,2n);
});
