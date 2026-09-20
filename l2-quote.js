import { bpsDown } from './risk.js';

export const ROUTE_QUOTER_ABI = [
  'function curve() view returns (address)',
  'function v4Quoter() view returns (address)',
  'function quoteCurveToV4(address token,uint128 wethIn,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key) returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate)',
  'function quoteV4ToCurve(address token,uint128 wethIn,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key) returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate)',
];

export const TICK_LENS_ABI = [
  'function poolManager() view returns (address)',
  'function hashV4State(bytes32 poolId,int16 minWord,uint16 wordCount,int24[] ticks) view returns (bytes32)',
];

export function tickBitmapWord(tick, tickSpacing) {
  const t = BigInt(tick);
  const spacing = BigInt(tickSpacing);
  if (spacing <= 0n) throw new Error('invalid tickSpacing');
  let compressed = t / spacing;
  if (t < 0n && t % spacing !== 0n) compressed -= 1n;
  const word = compressed >> 8n;
  if (word < -32768n || word > 32767n) throw new Error('tick bitmap word out of int16 range');
  return Number(word);
}

export function tickBitmapWindow(tick, tickSpacing, radius = 1) {
  const word = tickBitmapWord(tick, tickSpacing);
  let minWord = word - radius;
  let wordCount = radius * 2 + 1;
  if (minWord < -32768) {
    wordCount -= (-32768 - minWord);
    minWord = -32768;
  }
  if (minWord + wordCount - 1 > 32767) wordCount = 32767 - minWord + 1;
  if (wordCount > 8) wordCount = 8;
  if (wordCount < 1) wordCount = 1;
  return { minWord, wordCount };
}

export function haircutRouteQuote(tokenOut, wethOut, slippageBps) {
  return { tok: BigInt(tokenOut), back: bpsDown(BigInt(wethOut), slippageBps) };
}
