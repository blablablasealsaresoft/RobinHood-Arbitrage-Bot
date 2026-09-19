// SPDX-License-Identifier: GPL-2.0-or-later
// Integer Q64.96, single-tick exact-input math. Deliberately refuses every tick
// crossing, dynamic V4 fee and hook. No truncated tick book is treated as complete.
// TickMath's binary factors are the integer constants used by Uniswap v3-core
// (TickMath.sol, GPL-2.0-or-later); see native/README.md for source attribution.
export const Q96 = 1n << 96n;
const MAX256 = (1n << 256n) - 1n;
const factors = [
  0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
];
export function sqrtAtTick(tick) {
  if (!Number.isInteger(tick) || tick < -887272 || tick > 887272) throw new Error('invalid tick');
  let ratio = 1n << 128n, magnitude = Math.abs(tick);
  for (let bit = 0; bit < factors.length; bit++) if (magnitude & (1 << bit)) ratio = ratio * factors[bit] >> 128n;
  if (tick > 0) ratio = MAX256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
const up = (a, b) => (a + b - 1n) / b;
export function directionalFee(pool, zeroForOne) {
  if (pool.kind === 'v3') return pool.feePips;
  const protocol = zeroForOne ? pool.protocolFee & 4095n : pool.protocolFee >> 12n;
  if (protocol > 1000n) throw new Error('invalid V4 protocol fee');
  return protocol + pool.lpFee - protocol * pool.lpFee / 1_000_000n;
}
export function concentratedQuote(pool, tokenIn, amount) {
  const zeroForOne = tokenIn === pool.token0;
  if (!zeroForOne && tokenIn !== pool.token1) throw new Error('token not in pool');
  const P = pool.sqrtPriceX96, L = pool.liquidity;
  if (!L || amount < 0n) throw new Error('empty/invalid concentrated pool');
  const fee = directionalFee(pool, zeroForOne);
  if (fee >= 1_000_000n) throw new Error('unsupported swap fee');
  const net = amount * (1_000_000n - fee) / 1_000_000n;
  if (!net) return 0n;
  let next;
  if (zeroForOne) {
    const numerator = L * Q96, product = net * P;
    next = product <= MAX256 && numerator + product <= MAX256
      ? up(numerator * P, numerator + product)
      : up(numerator, numerator / P + net);
  } else next = P + net * Q96 / L;
  // This bounds execution inside a SINGLE INTEGER TICK. An added initialized
  // tick cannot appear inside this open interval. Slot0+liquidity are therefore
  // sufficient economic checks for this deliberately restricted model.
  if (next <= pool.lowerX96 || next >= pool.upperX96) throw new Error('tick crossing requires full local tick book');
  return zeroForOne ? L * (P - next) / Q96 : (L * Q96 * (next - P) / next) / P;
}
export function concentratedCoefficients(pool, tokenIn) {
  const forward = tokenIn === pool.token0, P = pool.sqrtPriceX96, L = pool.liquidity;
  const f = 1_000_000n - directionalFee(pool, forward), d = 1_000_000n;
  return forward ? [L * P * P * f, L * Q96 * Q96 * d, P * Q96 * f]
    : [L * Q96 * Q96 * f, L * P * P * d, P * Q96 * f];
}
