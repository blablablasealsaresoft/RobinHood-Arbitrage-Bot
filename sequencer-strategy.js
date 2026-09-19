import { AbiCoder, Interface, keccak256 } from 'ethers';
import { genericStateCheck } from './flash-intent.js';

const coder = AbiCoder.defaultAbiCoder();
const CURVE_I = new Interface([
  'function curves(address) view returns (uint256 virtualEth,uint256 realEth,uint256 tokenReserve,uint256 raiseTarget,uint256 lpEth,uint256 tradingFeeBps)',
]);
const STATE_I = new Interface([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export function poolKeyTuple(key) {
  return [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
}

export function encodePoolKey(key) {
  return coder.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
    [poolKeyTuple(key)],
  );
}

export function buildRouteLegs({
  direction,
  weth,
  token,
  curveAdapter,
  v4Adapter,
  poolKey,
  minTokenOut,
  minWethOut,
}) {
  const v4Data = encodePoolKey(poolKey);
  if (direction === 'curve->v4') {
    return [
      { adapter: curveAdapter, tokenIn: weth, tokenOut: token, minOut: minTokenOut, data: '0x' },
      { adapter: v4Adapter, tokenIn: token, tokenOut: weth, minOut: minWethOut, data: v4Data },
    ];
  }
  if (direction === 'v4->curve') {
    return [
      { adapter: v4Adapter, tokenIn: weth, tokenOut: token, minOut: minTokenOut, data: v4Data },
      { adapter: curveAdapter, tokenIn: token, tokenOut: weth, minOut: minWethOut, data: '0x' },
    ];
  }
  throw new Error('unknown route direction');
}

export function opportunityKey({ anchorHash, poolId, direction, size }) {
  return keccak256(coder.encode(
    ['bytes32','bytes32','uint8','uint256'],
    [anchorHash, poolId, direction === 'curve->v4' ? 1 : 2, size],
  ));
}

async function batchCalls(rpcUrl, blockNumber, calls) {
  const blockTag = '0x' + BigInt(blockNumber).toString(16);
  const payload = calls.map((call, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: 'eth_call',
    params: [{ to: call.target, data: call.callData }, blockTag],
  }));
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'keep-alive' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!Array.isArray(result)) throw new Error('state batch did not return an array');
  const byId = new Map(result.map(item => [item.id, item]));
  return calls.map((_, i) => {
    const item = byId.get(i + 1);
    if (!item || item.error || typeof item.result !== 'string') {
      throw new Error('state batch call failed');
    }
    return item.result;
  });
}

export async function buildExactStateChecks({
  rpcUrl,
  anchorBlock,
  curve,
  stateView,
  token,
  poolId,
}) {
  const calls = [
    { target: curve, callData: CURVE_I.encodeFunctionData('curves', [token]) },
    { target: stateView, callData: STATE_I.encodeFunctionData('getSlot0', [poolId]) },
    { target: stateView, callData: STATE_I.encodeFunctionData('getLiquidity', [poolId]) },
  ];
  const raw = await batchCalls(rpcUrl, anchorBlock, calls);
  return calls.map((call, i) => genericStateCheck(call.target, call.callData, raw[i]));
}
