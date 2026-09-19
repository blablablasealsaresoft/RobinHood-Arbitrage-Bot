import test from 'node:test';
import assert from 'node:assert/strict';
import { SettlementLedger } from '../native/accounting.mjs';
const addr=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const hash=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const A=addr(1), B=addr(2), EXEC=addr(3), REL=addr(4);
function fixture({ maxLoss=10000n, maxReceipts=8192 }={}) {
  const ledger=new SettlementLedger({executor:EXEC,relayer:REL,lossLimits:[{settlementToken:A,maxLoss},{settlementToken:B,maxLoss}],maxReceipts});
  const signed={hash:hash(10),nonce:0n,intentDigest:hash(11),gasLimit:1000n,maxFeePerGas:2n};
  const op={route:{settlementToken:A,minProfit:0n,id:'loop'},head:{number:100n,hash:hash(100)},amount:100n,grossProfit:300n,key:'candidate',
    costs:{settlementUnitsPerWeiNumerator:1n,settlementUnitsPerWeiDenominator:1n}};
  const receipt={txHash:signed.hash,nonce:'0',blockNumber:'101',blockHash:hash(101),status:1,gasUsed:'50',effectiveGasPrice:'2',
    feeModel:'gasUsed-times-effectiveGasPrice-inclusive',arbitrageEvents:[{emitter:EXEC,relayer:REL,digest:signed.intentDigest,anchorBlock:100n,
      anchorBlockHash:hash(100),settlementToken:A,borrowed:100n,profit:300n}]};
  return {ledger,signed,op,receipt};
}
const canonical=(n,h)=>h===hash(n);
test('successful receipt binds intent and records actual gross minus inclusive gas',()=>{
  const {ledger,signed,op,receipt}=fixture();ledger.register(signed,op);
  const r=ledger.settle(receipt,canonical);assert.equal(r.net,200n);assert.equal(r.gasWei,100n);assert.equal(r.modelError,0n);
  assert.equal(r.provisional,true);assert.equal(ledger.pending.size,0);assert.equal(ledger.summary().settlements[0].net,200n);
});
test('a reverted stale transaction still consumes gas outside N+1',()=>{
  const {ledger,signed,op,receipt}=fixture();ledger.register(signed,op);
  const r=ledger.settle({...receipt,status:0,blockNumber:'105',blockHash:hash(105),arbitrageEvents:[]},canonical);
  assert.equal(r.grossProfit,0n);assert.equal(r.net,-100n);assert.equal(ledger.summary().settlements[0].reverts,1n);
});
test('receipt is idempotent, but a conflicting duplicate is fatal',()=>{
  const {ledger,signed,op,receipt}=fixture();ledger.register(signed,op);ledger.settle(receipt,canonical);
  assert.equal(ledger.settle(receipt,canonical),null);assert.throws(()=>ledger.settle({...receipt,gasUsed:'51'},canonical),/conflicting/);
});
for (const [name, mutate] of [
  ['wrong emitter',r=>r.arbitrageEvents[0].emitter=addr(9)],
  ['wrong relayer',r=>r.arbitrageEvents[0].relayer=addr(9)],
  ['wrong intent digest',r=>r.arbitrageEvents[0].digest=hash(9)],
  ['wrong anchor',r=>r.arbitrageEvents[0].anchorBlockHash=hash(9)],
  ['wrong settlement units',r=>r.arbitrageEvents[0].settlementToken=B],
  ['wrong borrowed principal',r=>r.arbitrageEvents[0].borrowed=101n],
  ['wrong nonce',r=>r.nonce='2'],
  ['excess gas',r=>r.gasUsed='1001'],
  ['excess gas price',r=>r.effectiveGasPrice='3'],
  ['missing cost convention',r=>delete r.feeModel],
  ['unrelated successful transaction',r=>r.arbitrageEvents=[]],
  ['duplicate profit events',r=>r.arbitrageEvents.push({...r.arbitrageEvents[0]})],
  ['late successful execution',r=>{r.blockNumber='102';r.blockHash=hash(102);}],
]) test(`receipt rejects ${name} without consuming registration`,()=>{
  const {ledger,signed,op,receipt}=fixture();ledger.register(signed,op);mutate(receipt);
  assert.throws(()=>ledger.settle(receipt,canonical));assert.equal(ledger.pending.size,1);assert.equal(ledger.receipts.size,0);
});
test('wrong branch and unknown transaction are not accepted',()=>{
  const {ledger,signed,op,receipt}=fixture();ledger.register(signed,op);
  assert.throws(()=>ledger.settle(receipt,()=>false),/observed/);assert.throws(()=>ledger.settle({...receipt,txHash:hash(90)},canonical),/unregistered/);
});
test('gas conversion rounds upward and freezes the decision price',()=>{
  const {ledger,signed,op,receipt}=fixture();op.costs={settlementUnitsPerWeiNumerator:1n,settlementUnitsPerWeiDenominator:3n};
  ledger.register(signed,op);op.costs.settlementUnitsPerWeiNumerator=999n;
  assert.equal(ledger.settle({...receipt,gasUsed:'1',effectiveGasPrice:'1'},canonical).gasCost,1n);
});
test('pending transactions reserve full maximum gas loss, not expected gas',()=>{
  const {ledger,signed,op}=fixture({maxLoss:2500n});ledger.register(signed,op);
  assert.throws(()=>ledger.register({...signed,hash:hash(12),nonce:1n},op),/remaining session loss budget/);
  assert.equal(ledger.pending.size,1);
});
test('session stop-loss blocks fresh trades even after a successful break-even route',()=>{
  const {ledger,signed,op,receipt}=fixture({maxLoss:2000n});ledger.register(signed,op);
  receipt.gasUsed='1000';receipt.arbitrageEvents[0].profit=0n;ledger.settle(receipt,canonical);
  assert.equal(ledger.canTrade(A),false);assert.equal(ledger.canTrade(B),true);
});
test('bounded receipts require checkpoint rather than silently forgetting P&L',()=>{
  const {ledger,signed,op,receipt}=fixture({maxReceipts:1});ledger.register(signed,op);ledger.settle(receipt,canonical);
  assert.equal(ledger.canTrade(A),false);assert.throws(()=>ledger.register({...signed,hash:hash(12),nonce:1n},op),/risk/);
});
test('reorg removes provisional P&L and halts all new risk',()=>{
  const {ledger,signed,op,receipt}=fixture();ledger.register(signed,op);ledger.settle(receipt,canonical);
  assert.deepEqual(ledger.invalidateFrom(101n),[hash(10)]);assert.equal(ledger.summary().settlements[0].net,0n);assert.equal(ledger.canTrade(A),false);
});
test('profit floor and reverted event fabrication fail closed',()=>{
  let f=fixture();f.op.route.minProfit=301n;f.ledger.register(f.signed,f.op);assert.throws(()=>f.ledger.settle(f.receipt,canonical),/floor/);
  f=fixture();f.ledger.register(f.signed,f.op);assert.throws(()=>f.ledger.settle({...f.receipt,status:0},canonical),/reverted/);
});
