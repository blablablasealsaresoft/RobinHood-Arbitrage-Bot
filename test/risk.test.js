import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { bpsDown, buildGrid, feeOverrides, serialRunner } from '../risk.js';

test('bpsDown applies a basis-point floor', () => {
  assert.equal(bpsDown(10_000n, 100n), 9_900n);
  assert.throws(() => bpsDown(1n, 10_000n));
});

test('buildGrid includes exact configured boundaries', () => {
  const lo = parseEther('0.002');
  const hi = parseEther('0.005');
  const grid = buildGrid(lo, hi, 5);
  assert.equal(grid[0], lo);
  assert.equal(grid.at(-1), hi);
  assert.ok(grid.every((x, i) => i === 0 || x > grid[i - 1]));
});

test('feeOverrides bounds maximum transaction gas cost', () => {
  const r = feeOverrides({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }, 700_000n, 12_000n);
  assert.equal(r.overrides.maxFeePerGas, 120n);
  assert.equal(r.maxGasCost, 84_000_000n);
});

test('serialRunner never overlaps work and coalesces queued triggers', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = serialRunner(async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await gate;
    active--;
  });
  const first = run('first');
  assert.equal(await run('second'), false);
  assert.equal(await run('third'), false);
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 1);
  assert.equal(calls, 2);
});
