import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedValueGate, OpportunityDedupe } from '../sequencer/runtime.js';
import { buildLegs, hashChecks, hashLegs, opportunityNonce } from '../flash-intent.js';

test('EV gate prices losing-race revert cost instead of using a fixed bps threshold', () => {
  const g = expectedValueGate({
    grossProfit: 1_000n,
    successGasCost: 100n,
    revertGasCost: 50n,
    loseRaceBps: 1_000n,
    minExpectedValue: 0n,
  });
  // 90% * 900 - 10% * 50 = 805
  assert.equal(g.expectedValue, 805n);
  assert.equal(g.pass, true);
});

test('EV gate rejects negative expected value', () => {
  const g = expectedValueGate({
    grossProfit: 100n,
    successGasCost: 90n,
    revertGasCost: 500n,
    loseRaceBps: 5_000n,
    minExpectedValue: 0n,
  });
  assert.equal(g.pass, false);
});

test('dedupe invalidates opportunities from a replaced L2 sequence onward', () => {
  const d = new OpportunityDedupe();
  assert.equal(d.take('a', 100), true);
  assert.equal(d.take('a', 100), false);
  assert.equal(d.take('b', 101), true);
  d.invalidateFrom(101);
  assert.equal(d.take('a', 100), false);
  assert.equal(d.take('b', 101), true);
});

test('flash leg/check hashes are deterministic and direction-specific', () => {
  const key = {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x0000000000000000000000000000000000000011',
    fee: 3000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000',
  };
  const common = {
    weth: '0x0000000000000000000000000000000000000022',
    token: key.currency1,
    curveAdapter: '0x0000000000000000000000000000000000000033',
    v4Adapter: '0x0000000000000000000000000000000000000044',
    poolKey: key,
    minTokenOut: 100n,
    minWethOut: 101n,
  };
  const a = buildLegs({ direction: 'curve->v4', ...common });
  const b = buildLegs({ direction: 'v4->curve', ...common });
  assert.notEqual(hashLegs(a), hashLegs(b));

  const checks = [{
    mode: 0,
    target: '0x0000000000000000000000000000000000000055',
    gasLimit: 100000,
    callData: '0x1234',
    expectedReturnHash: '0x' + '11'.repeat(32),
  }];
  assert.match(hashChecks(checks), /^0x[0-9a-f]{64}$/);
});

test('opportunity nonce changes with anchor hash and route', () => {
  const base = {
    anchorBlockHash: '0x' + '01'.repeat(32),
    poolId: '0x' + '02'.repeat(32),
    direction: 'curve->v4',
    borrowAmount: 1n,
  };
  const n1 = opportunityNonce(base);
  const n2 = opportunityNonce({ ...base, direction: 'v4->curve' });
  const n3 = opportunityNonce({ ...base, anchorBlockHash: '0x' + '03'.repeat(32) });
  assert.notEqual(n1, n2);
  assert.notEqual(n1, n3);
});
