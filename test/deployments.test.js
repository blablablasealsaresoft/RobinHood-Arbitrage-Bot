import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { CURVE, POOLS, TOKEN, V4 } from '../config.js';
import {
  DEPLOYER, DEPLOYMENTS, LIVE_STACK, MORPHO_BLUE, WETH, envOrDeployed,
} from '../deployments.js';
import { evaluateLiveSnapshot } from '../scripts/live-status.js';
import { FLASH_EXECUTOR_ABI, nextBlockValidity } from '../l2-clock.js';

test('live stack pins five checksummed Robinhood mainnet contracts', () => {
  assert.equal(LIVE_STACK.length, 5);
  assert.equal(DEPLOYMENTS.chainId, 4663);
  assert.equal(getAddress(DEPLOYER), DEPLOYER);
  for (const item of LIVE_STACK) {
    assert.equal(getAddress(item.address), item.address);
    assert.equal(DEPLOYMENTS[item.key], item.address);
  }
  assert.equal(getAddress(WETH), WETH);
  assert.equal(getAddress(MORPHO_BLUE), MORPHO_BLUE);
});

test('N+1 validity window is a single L2 block after the feed anchor', () => {
  assert.deepEqual(nextBlockValidity(100n), { validAfterBlock: 101n, validUntilBlock: 101n });
});

test('live-status reports ready when the deployed permissions are enabled', () => {
  const snapshot = {
    chainId: 4663,
    executor: {
      paused: false,
      maxBlockWindow: 1n,
      maxAnchorDelay: 1n,
      morpho: MORPHO_BLUE,
      curveAdapterEnabled: true,
      v4AdapterEnabled: true,
      wethBorrowCap: 2_000_000_000_000_000n,
      strategySigner: DEPLOYER,
    },
    contracts: LIVE_STACK.map((c) => ({ ...c, hasCode: true })),
    curveAdapter: { tokenAllowed: true },
    v4Adapter: { pools: POOLS.map((p) => ({ name: p.name, allowed: true, liquidity: 1n })) },
    routeQuoter: { curve: CURVE.address, v4Quoter: V4.quoter },
    tickLens: { poolManager: V4.poolManager },
    morphoWeth: 1n,
    relayer: { address: DEPLOYER, isRelayer: true, eth: 1n },
    strategy: { address: DEPLOYER },
  };
  const ready = evaluateLiveSnapshot(snapshot);
  assert.equal(ready.productionReady, true);
  assert.equal(ready.liveReady, true);
  assert.deepEqual(ready.issues, []);
});

test('live-status fails closed on missing code, pause, or disabled borrow', () => {
  const base = {
    chainId: 4663,
    executor: {
      paused: true,
      maxBlockWindow: 2n,
      maxAnchorDelay: 1n,
      morpho: MORPHO_BLUE,
      curveAdapterEnabled: false,
      v4AdapterEnabled: true,
      wethBorrowCap: 0n,
      strategySigner: DEPLOYER,
    },
    contracts: LIVE_STACK.map((c, i) => ({ ...c, hasCode: i !== 0 })),
    curveAdapter: { tokenAllowed: false },
    v4Adapter: { pools: POOLS.map((p) => ({ name: p.name, allowed: false })) },
    routeQuoter: { curve: CURVE.address, v4Quoter: V4.quoter },
    tickLens: { poolManager: V4.poolManager },
    morphoWeth: 0n,
    relayer: null,
    strategy: null,
  };
  const verdict = evaluateLiveSnapshot(base);
  assert.equal(verdict.productionReady, false);
  assert.ok(verdict.issues.some((x) => x.includes('no code')));
  assert.ok(verdict.issues.some((x) => x.includes('paused')));
  assert.ok(verdict.issues.some((x) => x.includes('borrow cap')));
  assert.ok(TOKEN.symbol);
});

test('live-status notes zero V4 liquidity without blocking the contracts themselves', () => {
  const snapshot = {
    chainId: 4663,
    executor: {
      paused: false,
      maxBlockWindow: 1n,
      maxAnchorDelay: 1n,
      morpho: MORPHO_BLUE,
      curveAdapterEnabled: true,
      v4AdapterEnabled: true,
      wethBorrowCap: 2_000_000_000_000_000n,
      strategySigner: DEPLOYER,
    },
    contracts: LIVE_STACK.map((c) => ({ ...c, hasCode: true })),
    curveAdapter: { tokenAllowed: true },
    v4Adapter: { pools: POOLS.map((p) => ({ name: p.name, allowed: true, liquidity: 0n })) },
    routeQuoter: { curve: CURVE.address, v4Quoter: V4.quoter },
    tickLens: { poolManager: V4.poolManager },
    morphoWeth: 1n,
    relayer: null,
    strategy: null,
  };
  const verdict = evaluateLiveSnapshot(snapshot);
  assert.equal(verdict.productionReady, true);
  assert.equal(verdict.liveReady, false);
  assert.ok(verdict.notes.some((x) => x.includes('zero active V4 liquidity')));
});

test('envOrDeployed prefers a live env override over the pinned stack', () => {
  const original = process.env.SEQUENCER_EXECUTOR_ADDR;
  process.env.SEQUENCER_EXECUTOR_ADDR = '0x1111111111111111111111111111111111111111';
  try {
    assert.equal(
      envOrDeployed('SEQUENCER_EXECUTOR_ADDR', DEPLOYMENTS.sequencerExecutor),
      '0x1111111111111111111111111111111111111111',
    );
  } finally {
    if (original === undefined) delete process.env.SEQUENCER_EXECUTOR_ADDR;
    else process.env.SEQUENCER_EXECUTOR_ADDR = original;
  }
  assert.equal(envOrDeployed('SEQUENCER_EXECUTOR_ADDR', DEPLOYMENTS.sequencerExecutor), DEPLOYMENTS.sequencerExecutor);
});

test('flash executor ABI binds ArbSys N+1 anchors on executeFlashArb', () => {
  const execute = FLASH_EXECUTOR_ABI.find((line) => line.includes('executeFlashArb'));
  assert.ok(execute);
  assert.match(execute, /anchorBlock/);
  assert.match(execute, /anchorBlockHash/);
  assert.match(execute, /validAfterBlock/);
  assert.match(execute, /validUntilBlock/);
});
