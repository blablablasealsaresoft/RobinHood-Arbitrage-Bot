// SPDX-License-Identifier: MIT
// Bounded, exact-input simulation of hookless static-fee Uniswap V4 pools.
// Matches the integer algorithms in v4-core 46c6834698c48bc4a463a86d8420f4eb1d7f3b75.
// This module has no RPC/signing dependencies. A complete bitmap WINDOW is not
// a complete global tick book: an input needing an unread word fails closed.
import { Q96, sqrtAtTick, directionalFee } from './concentrated.mjs';

const U128 = (1n << 128n) - 1n, U160 = (1n << 160n) - 1n, U256 = (1n << 256n) - 1n;
const I128 = (1n << 127n) - 1n;
const MILLION = 1_000_000n;
export const MIN_TICK = -887272, MAX_TICK = 887272;
export const MIN_SQRT = sqrtAtTick(MIN_TICK), MAX_SQRT = sqrtAtTick(MAX_TICK);
export const MAX_WINDOW_WORDS = 8, MAX_WINDOW_TICKS = 256, MAX_SWAP_STEPS = 512;
const up = (n, d) => (n + d - 1n) / d;
function integer(v, label, lo, hi) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`invalid ${label}`);
  return v;
}
function big(v, label, lo, hi) {
  if (!['string', 'number', 'bigint'].includes(typeof v) || (typeof v === 'number' && !Number.isSafeInteger(v)) || !/^-?\d+$/.test(String(v))) throw new Error(`invalid ${label}`);
  const n = BigInt(v);
  if (n < lo || n > hi) throw new Error(`invalid ${label}`);
  return n;
}
export function windowSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('tick window required');
  const tickSpacing = integer(input.tickSpacing, 'tick spacing', 1, 32767);
  const minWord = integer(input.minWord, 'minimum word', -32768, 32767);
  const maxWord = integer(input.maxWord, 'maximum word', minWord, 32767);
  if (maxWord - minWord + 1 > MAX_WINDOW_WORDS) throw new Error('tick window exceeds word budget');
  return Object.freeze({ tickSpacing, minWord, maxWord });
}

// The raw word array is ordered from minWord, INCLUDING zero bitmap words.
// Every set bit must have precisely one matching liquidity record. There is no
// implicit zero for an absent word/tick, and no mutation of caller-owned data.
export function compileTickWindow(spec, data) {
  spec = windowSpec(spec);
  if (!data || !Array.isArray(data.words) || data.words.length !== spec.maxWord - spec.minWord + 1 || !Array.isArray(data.ticks) || data.ticks.length > MAX_WINDOW_TICKS) throw new Error('incomplete/bounded tick coverage required');
  const words = data.words.map(v => big(v, 'bitmap word', 0n, U256));
  const expected = [];
  for (let w = 0; w < words.length; w++) {
    let bits = words[w];
    while (bits) {
      const low = bits & -bits, bit = low.toString(2).length - 1;
      const tick = ((spec.minWord + w) * 256 + bit) * spec.tickSpacing;
      if (tick < MIN_TICK || tick > MAX_TICK) throw new Error('initialized tick outside global range');
      expected.push(tick); bits ^= low;
      if (expected.length > MAX_WINDOW_TICKS) throw new Error('initialized tick budget exceeded');
    }
  }
  if (expected.length !== data.ticks.length) throw new Error('bitmap/tick coverage mismatch');
  const ticks = data.ticks.map((entry, i) => {
    if (!entry || entry.tick !== expected[i]) throw new Error('tick order/bitmap mismatch');
    const liquidityGross = big(entry.liquidityGross, 'liquidity gross', 1n, U128);
    const liquidityNet = big(entry.liquidityNet, 'liquidity net', -I128 - 1n, I128);
    if (liquidityNet > liquidityGross || -liquidityNet > liquidityGross || (liquidityGross + liquidityNet) % 2n) throw new Error('inconsistent tick liquidity');
    return Object.freeze({ tick: expected[i], liquidityGross, liquidityNet });
  });
  // A frozen plain object avoids the writable Map hidden inside Object.freeze.
  const byTick = Object.freeze(Object.fromEntries(ticks.map(t => [t.tick, t])));
  return Object.freeze({ ...spec, words: Object.freeze(words), ticks: Object.freeze(ticks), byTick });
}

export function tickAtSqrt(price) {
  price = big(price, 'sqrt price', MIN_SQRT, MAX_SQRT - 1n);
  let lo = MIN_TICK, hi = MAX_TICK - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (sqrtAtTick(mid) <= price) lo = mid; else hi = mid - 1;
  }
  return lo;
}
export function nextTickInWord(book, tick, zeroForOne) {
  let compressed = Math.floor(tick / book.tickSpacing);
  if (!zeroForOne) compressed++;
  const pos = Math.floor(compressed / 256), bit = compressed - pos * 256;
  if (pos < book.minWord || pos > book.maxWord) throw new Error('tick window exhausted; recovery required');
  const word = book.words[pos - book.minWord];
  if (zeroForOne) {
    const masked = word & ((1n << BigInt(bit + 1)) - 1n);
    return { tick: (pos * 256 + (masked ? masked.toString(2).length - 1 : 0)) * book.tickSpacing, initialized: masked !== 0n };
  }
  const masked = word & (U256 ^ ((1n << BigInt(bit)) - 1n));
  const nextBit = masked ? (masked & -masked).toString(2).length - 1 : 255;
  return { tick: (pos * 256 + nextBit) * book.tickSpacing, initialized: masked !== 0n };
}

export function amount0Delta(a, b, liquidity, roundUp = false) {
  if (a > b) [a, b] = [b, a];
  if (a <= 0n) throw new Error('zero sqrt price');
  const n = liquidity * Q96 * (b - a);
  const out = roundUp ? up(up(n, b), a) : n / b / a;
  if (out > U256) throw new Error('amount delta overflow');
  return out;
}
export function amount1Delta(a, b, liquidity, roundUp = false) {
  if (a > b) [a, b] = [b, a];
  const n = liquidity * (b - a), out = roundUp ? up(n, Q96) : n / Q96;
  if (out > U256) throw new Error('amount delta overflow');
  return out;
}
function nextFromInput(price, liquidity, amount, zeroForOne) {
  if (!amount) return price;
  if (!liquidity || !price) throw new Error('invalid swap state');
  let next;
  if (zeroForOne) {
    const n = liquidity * Q96, product = amount * price;
    next = product <= U256 && n + product <= U256 ? up(n * price, n + product) : up(n, n / price + amount);
  } else next = price + amount * Q96 / liquidity;
  if (next <= 0n || next > U160) throw new Error('sqrt price overflow');
  return next;
}

// Positive remaining input is our API convention; V4's Solidity function takes
// negative amountRemaining for exact input. Not a V3 fee/dust-accounting port.
export function v4SwapStep(price, target, liquidity, remaining, feePips) {
  price = big(price, 'sqrt price', 1n, U160); target = big(target, 'target price', 1n, U160);
  liquidity = big(liquidity, 'liquidity', 0n, U128); remaining = big(remaining, 'input', 0n, (1n << 255n) - 1n);
  feePips = big(feePips, 'fee', 0n, MILLION - 1n); // 100% fee is deliberately unsupported.
  const zero = price >= target;
  const net = remaining * (MILLION - feePips) / MILLION;
  const needed = zero ? amount0Delta(target, price, liquidity, true) : amount1Delta(price, target, liquidity, true);
  const reached = net >= needed;
  const next = reached ? target : nextFromInput(price, liquidity, net, zero);
  // In V4, a partial step consumes ALL net input, not a recomputed rounded delta.
  const amountIn = reached ? needed : net;
  const feeAmount = reached ? up(amountIn * feePips, MILLION - feePips) : remaining - amountIn;
  const amountOut = zero ? amount1Delta(next, price, liquidity) : amount0Delta(price, next, liquidity);
  if (amountIn + feeAmount > remaining) throw new Error('swap step input invariant');
  return { sqrtPriceX96: next, amountIn, amountOut, feeAmount };
}

export function quoteV4Window(pool, tokenIn, amount, { maxSteps = MAX_SWAP_STEPS } = {}) {
  if (pool.kind !== 'v4' || !pool.tickBook) throw new Error('compiled V4 tick window required');
  amount = big(amount, 'V4 exact input', 0n, I128);
  integer(maxSteps, 'swap step budget', 1, MAX_SWAP_STEPS);
  const zero = tokenIn === pool.token0;
  if (!zero && tokenIn !== pool.token1) throw new Error('token not in pool');
  const fee = directionalFee(pool, zero);
  if (fee < 0n || fee >= MILLION) throw new Error('unsupported fee');
  let price = pool.sqrtPriceX96, tick = pool.tick, liquidity = pool.liquidity;
  const limit = zero ? MIN_SQRT + 1n : MAX_SQRT - 1n;
  let remaining = amount, out = 0n, feePaid = 0n, steps = 0, crossings = 0;
  while (remaining > 0n && price !== limit) {
    if (++steps > maxSteps) throw new Error('swap step budget exceeded');
    const startPrice = price, startTick = tick;
    const found = nextTickInWord(pool.tickBook, tick, zero);
    const nextTick = Math.max(MIN_TICK, Math.min(MAX_TICK, found.tick));
    const nextPrice = sqrtAtTick(nextTick);
    const target = zero ? (nextPrice < limit ? limit : nextPrice) : (nextPrice > limit ? limit : nextPrice);
    const step = v4SwapStep(price, target, liquidity, remaining, fee);
    remaining -= step.amountIn + step.feeAmount;
    out += step.amountOut; feePaid += step.feeAmount; price = step.sqrtPriceX96;
    if (price === nextPrice) {
      if (found.initialized) {
        const record = pool.tickBook.byTick[nextTick];
        if (!record) throw new Error('missing initialized tick');
        liquidity += zero ? -record.liquidityNet : record.liquidityNet;
        if (liquidity < 0n || liquidity > U128) throw new Error('liquidity crossing overflow/underflow');
        crossings++;
      }
      tick = zero ? nextTick - 1 : nextTick;
    } else if (price !== startPrice) tick = tickAtSqrt(price);
    if (remaining && price === startPrice && tick === startTick) throw new Error('swap made no progress');
  }
  if (remaining) throw new Error('partial V4 fill is not an executable route quote');
  if (out > I128) throw new Error('V4 output delta overflow');
  return { amount, out, sqrtPriceX96: price, tick, liquidity, feePaid, steps, crossings };
}
