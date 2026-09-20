import test from 'node:test';
import assert from 'node:assert/strict';
import { haircutRouteQuote, tickBitmapWindow, tickBitmapWord } from '../l2-quote.js';

test('tick bitmap word matches Uniswap compressed-tick layout', () => {
  assert.equal(tickBitmapWord(191563, 5000), 0);
  assert.equal(tickBitmapWord(187729, 2000), 0);
  assert.equal(tickBitmapWord(256 * 5000, 5000), 1);
  assert.equal(tickBitmapWord(-5001, 5000), -1);
});

test('tick bitmap window stays inside int16 and the lens wordCount bound', () => {
  assert.deepEqual(tickBitmapWindow(191563, 5000), { minWord: -1, wordCount: 3 });
  assert.deepEqual(tickBitmapWindow(0, 1, 1), { minWord: -1, wordCount: 3 });
});

test('route-quoter haircut applies slippage to the ETH leg only', () => {
  assert.deepEqual(haircutRouteQuote(1_000n, 10_000n, 100n), { tok: 1_000n, back: 9_900n });
});
