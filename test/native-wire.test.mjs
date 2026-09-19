// These tests require the repository's pinned ethers/solc dependencies (npm ci).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import solc from 'solc';
import { AbiCoder, Interface, Transaction, TypedDataEncoder, Wallet, keccak256, verifyTypedData } from 'ethers';
import { RouteBook, MarketState, NativeEngine, normalizeCosts } from '../native/core.mjs';
import { createWire, stateChecks, decodeReceipt, REPOSITORY_V4_ABI, FINAL_V4_TYPES, finalDomain, finalLegsHash, finalChecksHash } from '../native/wire.mjs';
import { FLASH_INTENT_TYPES, hashLegs, hashStateChecks, intentDomain } from '../flash-intent.js';
const executor = '0x' + 'a'.repeat(40);
// PUBLIC TEST KEYS ONLY. Never fund or use them outside these offline tests.
const strategyKey = '0x' + '11'.repeat(32), relayerKey = '0x' + '22'.repeat(32);
async function opportunity() {
  const cfg = JSON.parse(fs.readFileSync('native/example.json', 'utf8'));
  const book = new RouteBook(cfg.pools, cfg.routes), state = new MarketState(book, { maxAgeMs: 10000 });
  const costs = new Map(cfg.costs.map(c => [c.settlementToken, normalizeCosts(c, c.settlementToken)]));
  const engine = new NativeEngine({ book, state, costs });
  let found;
  for (const line of fs.readFileSync('native/example.ndjson', 'utf8').trim().split('\n')) found = await engine.onFrame(JSON.parse(line));
  return found;
}
test('wire signs a detached type-2 transaction and exact repository V4 intent', async () => {
  const q = await opportunity();
  const signer = createWire({ executor, strategyKey, relayerKey, gasLimit: 800000n, maxFeePerGas: 100n });
  const signed = await signer.wire(q, 7n), tx = Transaction.from(signed.raw);
  assert.equal(tx.chainId, 4663n); assert.equal(tx.nonce, 7); assert.equal(tx.type, 2);
  assert.equal(tx.from, new Wallet(relayerKey).address); assert.equal(tx.hash, signed.hash);
  assert.equal(signed.hash, keccak256(signed.raw)); assert.equal(tx.value, 0n);
  const [intent, legs, checks, signature] = new Interface(REPOSITORY_V4_ABI).decodeFunctionData('executeFlashArb', tx.data);
  assert.equal(intent.anchorBlock, 101n); assert.equal(intent.validAfterBlock, 102n); assert.equal(intent.validUntilBlock, 102n);
  assert.equal(intent.nonce % (1n << 64n), 7n);
  assert.equal(intent.routeHash, hashLegs(legs)); assert.equal(intent.stateChecksHash, hashStateChecks(checks));
  assert.ok(legs.at(-1).minOut >= q.amount + q.route.minProfit);
  assert.equal(verifyTypedData(intentDomain(executor), FLASH_INTENT_TYPES, signed.intent, signature), new Wallet(strategyKey).address);
});
test('wire ABI selector matches compiler ABI of the checked-in ArbSys V4 executor', () => {
  const source = fs.readFileSync('contracts/SequencerFlashArbExecutorV4.sol', 'utf8');
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Executor.sol': { content: source } }, settings: { outputSelection: { '*': { '*': ['abi'] } } } })));
  assert.equal((output.errors || []).filter(e => e.severity === 'error').length, 0);
  const abi = output.contracts['Executor.sol'].SequencerFlashArbExecutorV4.abi;
  assert.equal(new Interface(abi).getFunction('executeFlashArb').selector, new Interface(REPOSITORY_V4_ABI).getFunction('executeFlashArb').selector);
  assert.match(source, /ARBSYS\.arbBlockNumber\(/); assert.match(source, /ARBSYS\.arbBlockHash\(/);
});
test('reserve checks ignore timestamp but bind both economic reserves', async () => {
  const q = await opportunity(), coder = AbiCoder.defaultAbiCoder();
  const check = stateChecks(q.pools)[0], p = q.pools[0];
  assert.equal(check.expectedReturnHash, keccak256(coder.encode(['uint112', 'uint112'], [p.reserve0, p.reserve1])));
  assert.equal(check.mode, 1); assert.equal(check.callData, '0x0902f1ac');
});
test('uploaded final ABI is explicitly separate, including state-check gas limit', async () => {
  const q = await opportunity(), legs = q.route.legs.map((leg, i) => ({ ...leg, minOut: q.outputs[i] }));
  const checks = stateChecks(q.pools).map(c => ({ ...c, gasLimit: 50000 }));
  assert.notEqual(finalLegsHash(legs), hashLegs(legs));
  assert.notEqual(finalChecksHash(checks), finalChecksHash(checks.map(c => ({ ...c, gasLimit: 50001 }))));
  assert.notEqual(TypedDataEncoder.hashDomain(finalDomain(executor)), TypedDataEncoder.hashDomain(intentDomain(executor)));
  assert.equal(FINAL_V4_TYPES.FlashArbIntent.length, 11);
  assert.equal(finalDomain(executor).version, '4');
});

test('receipt decoder binds the executor emitter and decodes the real event', () => {
  const iface = new Interface(REPOSITORY_V4_ABI);
  const encoded = iface.encodeEventLog(iface.getEvent('FlashArbitrage'), [
    '0x'+'1'.repeat(64),101n,'0x'+'2'.repeat(64),'0x'+'0'.repeat(64),executor,100n,3n,new Wallet(relayerKey).address,
  ]);
  const decoded = decodeReceipt({ logs: [{ address: executor, ...encoded }], arbitrageEvents: ['untrusted'] },executor);
  assert.equal(decoded.arbitrageEvents.length,1);assert.equal(decoded.arbitrageEvents[0].profit,3n);
  assert.equal(decodeReceipt({logs:[{address:'0x'+'b'.repeat(40),...encoded}]},executor).arbitrageEvents.length,0);
  assert.throws(()=>decodeReceipt({logs:[{address:executor,removed:true,...encoded}]},executor),/removed/);
});
test('wire exports signed limits and EIP-712 digest for receipt/risk matching', async () => {
  const q=await opportunity(), signer=createWire({executor,strategyKey,relayerKey,gasLimit:800000n,maxFeePerGas:100n});
  const signed=await signer.wire(q,9n);
  assert.equal(signed.intentDigest,TypedDataEncoder.hash(intentDomain(executor),FLASH_INTENT_TYPES,signed.intent));
  assert.equal(signed.gasLimit,800000n);assert.equal(signed.maxFeePerGas,100n);
});
