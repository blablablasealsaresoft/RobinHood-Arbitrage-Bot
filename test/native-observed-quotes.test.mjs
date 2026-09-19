import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replayObservedQuotes } from '../native/observed-quote-parity.mjs';
const original=JSON.parse(fs.readFileSync(new URL('./fixtures/robinhood-v4-quotes-67287800.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(original);
for(const q of original.quotes)test(`captured V4 quote parity ${q.zeroForOne?'0->1':'1->0'} ${q.amountIn} base units`,()=>{
 const s=copy();s.quotes=[structuredClone(q)];const result=replayObservedQuotes(s);
 assert.equal(result.allExact,true);assert.equal(result.productionReady,false);assert.equal(result.fullCrossTickValidated,false);
});
test('captured parity covers both directions without authorizing a route',()=>{
 const r=replayObservedQuotes(copy());assert.equal(r.bothDirectionsSampled,true);assert.equal(r.closedLoopProfitValidated,false);assert.equal(r.codeIdentityVerified,false);
 assert.equal(r.anchorBlock,67287800n);assert.equal(r.liquidity,86928024356806040n);
});
test('one-unit reference discrepancy is a failed parity report',()=>{
 const s=copy(),q=s.quotes[0];q.result='0x'+(BigInt('0x'+q.result.slice(2,66))+1n).toString(16).padStart(64,'0')+q.result.slice(66);
 assert.equal(replayObservedQuotes(s).allExact,false);
});
test('mixed blocks, wrong emitter and calldata amounts are rejected',()=>{
 for(const mutate of[s=>s.quotes[0].blockTag='0x402baf7',s=>s.quotes[0].amountIn='10001',s=>s.slot0.to=s.quoter,s=>s.headerAfter.hash='0x'+'1'.repeat(64),s=>s.key.fee=9999]){
  const s=copy();mutate(s);assert.throws(()=>replayObservedQuotes(s));
 }
});
test('missing or noncanonical return words are not silently decoded',()=>{
 for(const mutate of[s=>s.slot0.result+='00',s=>s.liquidity.result='0x0',s=>s.quotes[0].result=s.quotes[0].result.slice(0,66)]){
  const s=copy();mutate(s);assert.throws(()=>replayObservedQuotes(s));
 }
});
test('zero liquidity, hooks and duplicate samples remain unsupported',()=>{
 for(const mutate of[s=>s.liquidity.result='0x'+'0'.repeat(64),s=>s.key.hooks=s.quoter,s=>s.quotes.push(s.quotes[0])]){
  const s=copy();mutate(s);assert.throws(()=>replayObservedQuotes(s));
 }
});
