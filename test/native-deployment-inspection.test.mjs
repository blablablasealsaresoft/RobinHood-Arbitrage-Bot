import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { exactWords, decodeV4Storage, decodeV4View, inspectLegacyCurve, inspectDeploymentSample, collectDeploymentSample, inspectionRpc } from '../native/deployment-inspection.mjs';
import { concentratedQuote } from '../native/concentrated.mjs';
const file='test/fixtures/robinhood-mainnet-67237585.json';
const sample=()=>JSON.parse(fs.readFileSync(file,'utf8'));
const w=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
test('captured mainnet sample matches storage/lens and remains explicitly blocked',()=>{
  const r=inspectDeploymentSample(sample());
  assert.equal(r.anchorBlock,67237585n); assert.equal(r.arbSysVersionRaw,116n); assert.equal(r.arbOSVersion,61n);
  assert.equal(r.morphoWethBalanceBaseUnits,20463785044587264454n);
  assert.equal(r.wethDecimals,18n); assert.equal(r.curve.returnedWords,12);
  assert.equal(r.curve.exactLegacyShape,false); assert.equal(r.curve.declaredFeeWordInBpsRange,false);
  assert.equal(r.productionReady,false);assert.equal(r.headerStableDuringCollection,true);
  assert.equal(r.issues.length,5); assert.ok(r.issues.includes('LEGACY_CURVE_ABI_REQUIRES_REVIEW'));
});
for(const p of sample().pools)test(`captured zero active liquidity cannot enter single-tick quote: ${p.key.fee}`,()=>{
  const state=decodeV4Storage(p.slot0.storage,p.liquidity.storage);
  assert.deepEqual(state,decodeV4View(p.slot0.viewResult,p.liquidity.viewResult));
  assert.equal(state.liquidity,0n);
  assert.throws(()=>concentratedQuote({...state,kind:'v4',token0:'native',token1:'token'},'native',2000000000000000n),/empty/);
});
for(const field of ['hash','stateRoot','number','timestamp'])test(`reject changed boundary header ${field}`,()=>{
  const s=sample();s.anchorAfter[field]=field==='number'||field==='timestamp'?'0x1':w(1);
  assert.throws(()=>inspectDeploymentSample(s),/anchor changed/);
});
test('reject mixed-block evidence, not merely compare final header',()=>{
  const s=sample();s.pools[1].blockTag='0x1';assert.throws(()=>inspectDeploymentSample(s),/mixed-block/);
});
test('reject raw storage/lens mismatches and unreviewed upper storage bits',()=>{
  const s=sample();s.pools[0].liquidity.storage=w(1);assert.throws(()=>inspectDeploymentSample(s),/storage\/lens mismatch/);
  assert.throws(()=>decodeV4Storage(w(1n<<232n),w(0)),/unreviewed/);
  assert.throws(()=>decodeV4Storage(w(1),w(1n<<128n)),/unreviewed/);
});
test('decode signed int24 exactly and reject noncanonical ABI sign extension',()=>{
  const packed=w(((1n<<24n)-1n)<<160n);
  const abi=w(0)+w((1n<<256n)-1n).slice(2)+w(0).slice(2)+w(0).slice(2);
  assert.deepEqual(decodeV4Storage(packed,w(0)),decodeV4View(abi,w(0)));
  assert.equal(decodeV4Storage(packed,w(0)).tick,-1);
  assert.throws(()=>decodeV4View(w(0)+w((1n<<24n)-1n).slice(2)+w(0).slice(2)+w(0).slice(2),w(0)),/noncanonical/);
});
test('never silently truncate ABI results or infer trailing curve field names',()=>{
  assert.throws(()=>exactWords(sample().curve.getterResult,6),/shape/);
  assert.throws(()=>exactWords(w(1),2),/shape/);
  assert.equal(inspectLegacyCurve(w(0)).exactLegacyShape,false);
  assert.equal(inspectLegacyCurve('0x'+'0'.repeat(6*64)).exactLegacyShape,true);
  assert.equal(inspectLegacyCurve('0x'+'0'.repeat(5*64)+w(10001).slice(2)).declaredFeeWordInBpsRange,false);
});
test('bind declared quote amounts and curve token to exact call bytes',()=>{
  const s=sample();s.pools[0].quote.amountIn='1';assert.throws(()=>inspectDeploymentSample(s),/calldata binding/);
  const t=sample();t.curve.token='0x'+'1'.repeat(40);assert.throws(()=>inspectDeploymentSample(t),/calldata binding/);
});
test('reject ambiguous quotes, transport errors disguised as reverts, and duplicate evidence',()=>{
  const a=sample();a.pools[0].quote.result=w(0)+w(0).slice(2);assert.throws(()=>inspectDeploymentSample(a),/ambiguous/);
  const b=sample();b.pools[0].quote.error.code=-32000;assert.throws(()=>inspectDeploymentSample(b),/not a revert/);
  const c=sample();c.pools[1]=structuredClone(c.pools[0]);assert.throws(()=>inspectDeploymentSample(c),/duplicate/);
});
function responder(s,seen){
 return async(method,params)=>{
  seen.push([method,params]);
  if(method==='eth_chainId')return s.chainId;
  if(method==='eth_getBlockByNumber')return s.anchorBefore;
  if(method==='eth_getStorageAt')for(const p of s.pools)for(const name of ['slot0','liquidity'])if(params[1]===p[name].slot)return p[name].storage;
  if(method==='eth_call'){
   const {to,data}=params[0];
   if(to===s.weth.address)return data==='0x313ce567'?s.weth.decimalsResult:s.weth.morphoBalanceResult;
   if(to===s.arbSys.address)return s.arbSys.versionResult;
   if(to===s.curve.address)return data===s.curve.getterData?s.curve.getterResult:s.curve.quoteBuy.result;
   for(const p of s.pools){
    if(data===p.quote.data)throw Object.assign(new Error('simulated RPC revert'),{code:3});
    if(data.endsWith(p.poolId.slice(2)))return data.startsWith('0xc815641c')?p.slot0.viewResult:p.liquidity.viewResult;
   }
  }
  throw new Error('unexpected request');
 };
}
test('recollection is read-only, pins every state read, and drops old auxiliary observations',async()=>{
  const s=sample(),seen=[],out=await collectDeploymentSample(s,responder(s,seen));
  assert.equal(inspectDeploymentSample(out).issues.length,5);
  assert.equal(out.testnet,undefined);assert.equal(out.stateProof,undefined);assert.equal(out.referenceRevert,undefined);
  for(const [method,params] of seen)if(['eth_call','eth_getStorageAt'].includes(method))assert.equal(params.at(-1),s.anchorBefore.number);
  assert.ok(seen.every(([m])=>['eth_chainId','eth_getBlockByNumber','eth_call','eth_getStorageAt'].includes(m)));
});
test('recollection aborts on network failure rather than recording a quote revert',async()=>{
  const s=sample(),send=responder(s,[]);
  await assert.rejects(collectDeploymentSample(s,(m,p)=>m==='eth_call'&&p[0].to===s.pools[0].quote.target?Promise.reject(new Error('offline')):send(m,p)),/offline/);
});
test('RPC client refuses writes before any request and never exposes credentials',async()=>{
  let called=0;const rpc=inspectionRpc('https://example.test/private-api-key',{fetchImpl:async()=>{called++;throw new Error('https://example.test/private-api-key');}});
  await assert.rejects(rpc('eth_sendRawTransaction',['0x01']),/refused/);assert.equal(called,0);
  await assert.rejects(rpc('eth_chainId',[]),e=>!e.message.includes('private-api-key'));
  assert.throws(()=>inspectionRpc('http://example.test'),/TLS/);
});
test('RPC client enforces envelope, byte cap and normalized revert code',async()=>{
  const make=body=>inspectionRpc('https://example.test',{fetchImpl:async()=>new Response(JSON.stringify(body))});
  assert.equal(await make({jsonrpc:'2.0',id:1,result:'0x1237'})('eth_chainId',[]),'0x1237');
  await assert.rejects(make({jsonrpc:'2.0',id:2,result:'0x1237'})('eth_chainId',[]),/envelope/);
  await assert.rejects(make({jsonrpc:'2.0',id:1,error:{code:3,message:'secret'}})('eth_chainId',[]),e=>e.code===3&&!e.message.includes('secret'));
  const rpc=inspectionRpc('https://example.test',{maxBytes:1,fetchImpl:async()=>new Response('xx')});
  await assert.rejects(rpc('eth_chainId',[]),/transport failed/);
});
test('historical inspection CLI exits blocked; it is never a live-trading input',()=>{
  const r=spawnSync(process.execPath,['native/deployment-inspection.mjs','--sample',file],{encoding:'utf8'});
  assert.equal(r.status,2,r.stderr);assert.equal(JSON.parse(r.stdout).inspection.productionReady,false);
});
test('inspection cannot accept a testnet sample as mainnet evidence',()=>{
  const s=sample();s.chainId='0xb626';assert.throws(()=>inspectDeploymentSample(s),/schema\/chain/);
});
test('collector aborts on testnet before reading any contracts',async()=>{
  let calls=0;await assert.rejects(collectDeploymentSample(sample(),async method=>{calls++;assert.equal(method,'eth_chainId');return '0xb626';}),/not mainnet/);
  assert.equal(calls,1);
});
test('captured failed transaction fee arithmetic matches its block balance delta',()=>{
  const r=inspectDeploymentSample(sample()).referenceRevert;
  assert.equal(r.gasUsed,89790n);assert.equal(r.effectiveGasPrice,66628000n);
  assert.equal(r.receiptGasCharge,5982528120000n);assert.equal(r.balanceChange,r.receiptGasCharge);
  assert.equal(r.nonceIncrement,1n);assert.equal(r.gasUsedForL1,0n);
  assert.equal(r.arithmeticMatches,true);assert.equal(r.transactionScopedStateDiffVerified,false);
});
test('failed fee evidence is not silently accepted after balance, nonce or receipt mutation',()=>{
  const a=sample();a.referenceRevert.balanceAfter='0x0';
  assert.ok(inspectDeploymentSample(a).issues.includes('REFERENCE_REVERT_FEE_ARITHMETIC_MISMATCH'));
  const b=sample();b.referenceRevert.nonceAfter=b.referenceRevert.nonceBefore;assert.throws(()=>inspectDeploymentSample(b),/nonces/);
  const c=sample();c.referenceRevert.receipt.status='0x1';assert.throws(()=>inspectDeploymentSample(c),/failed type-2/);
  const d=sample();d.referenceRevert.receipt.blockHash=w(1);assert.throws(()=>inspectDeploymentSample(d),/identity mismatch/);
});
