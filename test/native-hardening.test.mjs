import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RouteBook, MarketState, NativeEngine, NonceCoordinator, normalizeCosts } from '../native/core.mjs';
const config=()=>JSON.parse(fs.readFileSync('native/example.json','utf8'));
const initial=()=>fs.readFileSync('native/example.ndjson','utf8').trim().split('\n').map(JSON.parse);
const H='0x'+'a'.repeat(64);
function fixture(extra={}) {
  const c=config(),book=new RouteBook(c.pools,c.routes),state=new MarketState(book);
  const nonces=new NonceCoordinator();nonces.bootstrap({latest:0,pending:0});
  const costs=new Map(c.costs.map(x=>[x.settlementToken,normalizeCosts(x,x.settlementToken)]));
  const engine=new NativeEngine({book,state,costs,nonces,live:true,wire:async()=>({hash:H,raw:'0x01'}),broadcaster:{broadcast:async()=>({path:'mock'})},...extra});
  return {c,book,state,nonces,costs,engine};
}
test('duplicate physical pool aliases are rejected despite different pool IDs',()=>{
  const c=config();c.pools[1].pair=c.pools[0].pair.toUpperCase().replace('0X','0x');
  assert.throws(()=>new RouteBook(c.pools,c.routes),/physical pool/);
});
test('cross-model aliases of the same pair are also rejected',()=>{
  const c=config();Object.assign(c.pools[1],{pair:c.pools[0].pair,kind:'v3',feePips:'3000',adapterData:'0x'});
  assert.throws(()=>new RouteBook(c.pools,c.routes),/physical pool/);
});
for (const field of ['updates','timestamp','parentHash','blockNumber']) test(`duplicate hash with conflicting ${field} is rejected`,()=>{
  const {state}=fixture(),[a,b]=initial();state.ingest(a);state.ingest(b);
  const bad=structuredClone(b);
  if(field==='updates') bad.updates=[{...a.updates[0],reserve0:'1'}];
  else if(field==='parentHash') bad.parentHash=H;
  else bad[field]=String(BigInt(bad[field])+1n);
  assert.throws(()=>state.ingest(bad),/conflicting duplicate/);assert.equal(state.healthy(),false);
});
test('frame history is bounded, and its limit is validated',()=>{
  const {book}=fixture();for(const n of [0,-1,1.5,8193])assert.throws(()=>new MarketState(book,{historySize:n}));
  const s=new MarketState(book,{historySize:1}),[a,b]=initial();s.ingest(a);s.ingest(b);
  assert.equal(s.frameDigests.size,1);assert.equal(s.history.size,1);assert.equal(s.blocks.size,1);
});
test('cost revision during signing invalidates the decision without a nonce gap',async()=>{
  let release,sent=0;const wait=new Promise(r=>release=r);
  const f=fixture({wire:async()=>{await wait;return {hash:H,raw:'0x01'};},broadcaster:{broadcast:async()=>{sent++;return {};}}});
  const [a,b]=initial();await f.engine.onFrame(a);const task=f.engine.onFrame(b);
  f.costs.set(f.c.costs[0].settlementToken,normalizeCosts({...f.c.costs[0],successGasWei:'999999'},f.c.costs[0].settlementToken));
  release();assert.equal(await task,null);assert.equal(sent,0);assert.equal(f.nonces.next,0n);
});
test('risk halt during signing also prevents dispatch',async()=>{
  let release,allowed=true,sent=0;const wait=new Promise(r=>release=r);
  const f=fixture({canTrade:()=>allowed,wire:async()=>{await wait;return {hash:H,raw:'0x01'};},broadcaster:{broadcast:async()=>{sent++;return {};}}});
  const [a,b]=initial();await f.engine.onFrame(a);const task=f.engine.onFrame(b);allowed=false;release();
  assert.equal(await task,null);assert.equal(sent,0);assert.equal(f.nonces.next,0n);
});
test('dispatch registration precedes POST so receipts may precede HTTP ACK',async()=>{
  const events=[];let nonces;
  const f=fixture({beforeDispatch:()=>{events.push('registered');assert.equal(nonces.pending.get(0n).state,'submitted');},
    broadcaster:{broadcast:async()=>{events.push('POST');nonces.included(0n,H);return {path:'mock'};}}});nonces=f.nonces;
  const [a,b]=initial();await f.engine.onFrame(a);assert.equal((await f.engine.onFrame(b)).hash,H);
  assert.deepEqual(events,['registered','POST']);assert.equal(nonces.pending.size,0);
});
test('an internal dispatch-journal failure stops nonce reuse and performs no POST',async()=>{
  let sent=0;const f=fixture({beforeDispatch:()=>{throw new Error('disk full');},broadcaster:{broadcast:async()=>sent++}});
  const [a,b]=initial();await f.engine.onFrame(a);await assert.rejects(f.engine.onFrame(b),/disk full/);
  assert.equal(sent,0);assert.equal(f.nonces.blocked,true);
});
test('phase and callback binding source regression (not an EVM execution test)',()=>{
  const s=fs.readFileSync('contracts/SequencerFlashArbExecutorV4.sol','utf8');
  assert.match(s,/pendingCallbackHash = keccak256\(callbackData\)/);
  assert.match(s,/require\(keccak256\(data\) == pendingCallbackHash, "callback payload"\)/);
  assert.match(s,/require\(phase == 3, "callback phase"\)/);
  const callback=s.slice(s.indexOf('function onMorphoFlashLoan'),s.indexOf('function isNonceUsed'));
  assert.match(callback,/phase = 3;/);assert.doesNotMatch(callback,/phase = 1;/);
});

test('cached pool fingerprints commit atomically and preserve unchanged pool identity',()=>{
  const {state}=fixture(),[a,b]=initial();state.ingest(a);state.ingest(b);
  const before=state.pools.get(a.updates[0].poolId),hashBefore=state.poolFingerprints.get(before.id);
  const next={...b,sequence:'102',blockNumber:'102',blockHash:'0x'+'c'.repeat(64),feedBlockHash:'0x'+'c'.repeat(64),parentHash:b.blockHash,updates:[{...a.updates[0],reserve0:String(before.reserve0),reserve1:String(before.reserve1)}]};
  state.ingest(next);assert.equal(state.pools.get(before.id),before);assert.equal(state.poolFingerprints.get(before.id),hashBefore);
  const hashes=state.poolFingerprints;
  assert.throws(()=>state.ingest({...next,sequence:'103',blockNumber:'103',parentHash:next.blockHash,blockHash:'0x'+'d'.repeat(64),feedBlockHash:'0x'+'d'.repeat(64),updates:[{...a.updates[0],reserve0:'bad'}]}));
  assert.equal(state.poolFingerprints,hashes);
});
