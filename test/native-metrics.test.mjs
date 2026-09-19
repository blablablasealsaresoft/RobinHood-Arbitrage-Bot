import test from 'node:test';
import assert from 'node:assert/strict';
import { telemetryReport } from '../native/metrics.mjs';
const event=(type,us,fields={})=>({type,monotonicNs:String(BigInt(us)*1000n),...fields});
test('telemetry joins anchors, opportunity keys and identical-hash submission paths',()=>{
  const r=telemetryReport([
    event('frame_received',10,{anchorHash:'a'}),event('state_updated',20,{anchorHash:'a'}),event('q_optimized',30,{anchorHash:'a'}),
    event('opportunity_found',31,{anchorHash:'a',key:'k'}),event('intent_signed',40,{key:'k'}),event('raw_signed',50,{key:'k'}),
    event('signed',51,{key:'k',txHash:'t'}),event('POST_started',70,{txHash:'t',path:'1'}),event('POST_started',60,{txHash:'t',path:'0'}),
    event('included',80,{txHash:'t',status:1}),event('path_accepted',90,{txHash:'t'}), // receipt before ACK is valid
  ]);
  assert.equal(r.latencyUs.frameToFirstPostUs.p50,50);assert.equal(r.latencyUs.firstPostToObservedInclusionUs.p50,20);
  assert.equal(r.latencyUs.firstPostToAckUs.p50,30);assert.equal(r.posted,1);assert.equal(r.included,1);assert.equal(r.unresolved,0);
});
test('missing telemetry stays unmeasured rather than becoming zero latency',()=>{
  const r=telemetryReport([event('POST_started',60,{txHash:'t'})]);
  assert.equal(r.latencyUs.frameToFirstPostUs.p50,null);assert.equal(r.latencyUs.frameToFirstPostUs.samples,0);assert.equal(r.unresolved,1);
});
test('P&L aggregation retains denominations and removes reorged profit',()=>{
  const profit=(txHash,token,net)=>({txHash,settlementToken:token,grossProfit:'200',gasWei:'10',gasCost:'10',net});
  const r=telemetryReport([event('realized_pnl',1,profit('a','TOKEN_A','190')),event('realized_pnl',2,profit('b','TOKEN_B','190')),
    event('accounting_invalidated',3,{removedTxHashes:['a']})]);
  assert.equal(r.provisionalSettlements.length,1);assert.equal(r.provisionalSettlements[0].settlementToken,'TOKEN_B');assert.equal(r.provisionalSettlements[0].net,190n);
});
test('non-monotonic untrusted clock fields cannot be silently used',()=>assert.throws(()=>telemetryReport([{type:'POST_started',wallMs:123}]),/monotonic/));

test('receipt-only log partitions do not create negative unresolved counts',()=>{
  const r=telemetryReport([event('included',10,{txHash:'old',status:1})]);
  assert.equal(r.unresolved,0);assert.equal(r.orphanReceiptObservations,1);
});
