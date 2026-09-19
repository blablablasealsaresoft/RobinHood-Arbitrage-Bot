import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expectedValueGate, OpportunityDedupe } from '../sequencer/runtime.js';

test('expected-value gate includes successful and losing-race gas', () => {
  const result = expectedValueGate({
    grossProfit: 1_000n,
    successGasCost: 100n,
    revertGasCost: 50n,
    loseRaceBps: 1_000n,
    minExpectedValue: 0n,
  });
  assert.equal(result.expectedValue, 805n);
  assert.equal(result.pass, true);
});

test('expected-value gate rejects negative EV despite positive gross profit', () => {
  assert.equal(expectedValueGate({
    grossProfit: 100n,
    successGasCost: 90n,
    revertGasCost: 500n,
    loseRaceBps: 5_000n,
    minExpectedValue: 0n,
  }).pass, false);
});

test('reorg invalidation permits recalculation from replaced L2 height', () => {
  const d = new OpportunityDedupe();
  assert.equal(d.take('a', 100), true);
  assert.equal(d.take('a', 100), false);
  assert.equal(d.take('b', 101), true);
  d.invalidateFrom(101);
  assert.equal(d.take('a', 100), false);
  assert.equal(d.take('b', 101), true);
});

test('V4 executor anchors sequencer state through ArbSys, not block.number', () => {
  const source = fs.readFileSync(
    new URL('../contracts/SequencerFlashArbExecutorV4.sol', import.meta.url),
    'utf8',
  );
  assert.match(source, /arbBlockNumber\(\)/);
  assert.match(source, /arbBlockHash\(uint256/);
  assert.doesNotMatch(source, /\bblock\.number\b/);
  assert.doesNotMatch(source, /\bblockhash\s*\(/);
  assert.doesNotMatch(source, /borrowAmount > 0 && intent\.minProfit > 0/);
});
