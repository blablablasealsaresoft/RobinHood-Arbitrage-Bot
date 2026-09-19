import { AbiCoder, Interface, keccak256 } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();

export const FLASH_TYPES = {
  FlashArbIntent: [
    { name: 'settlementToken', type: 'address' },
    { name: 'borrowAmount', type: 'uint256' },
    { name: 'minProfit', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'anchorBlock', type: 'uint64' },
    { name: 'anchorBlockHash', type: 'bytes32' },
    { name: 'validUntilBlock', type: 'uint64' },
    { name: 'validUntilTimestamp', type: 'uint64' },
    { name: 'maxGasPrice', type: 'uint256' },
    { name: 'legsHash', type: 'bytes32' },
    { name: 'checksHash', type: 'bytes32' },
  ],
};

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
  return abi.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
    [poolKeyTuple(key)],
  );
}

export function hashLegs(legs) {
  return keccak256(abi.encode(
    ['tuple(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes data)[]'],
    [legs],
  ));
}

export function hashChecks(checks) {
  return keccak256(abi.encode(
    ['tuple(uint8 mode,address target,uint32 gasLimit,bytes callData,bytes32 expectedReturnHash)[]'],
    [checks],
  ));
}

export function opportunityNonce({ anchorBlockHash, poolId, direction, borrowAmount }) {
  const dir = direction === 'curve->v4' ? 1 : 2;
  return BigInt(keccak256(abi.encode(
    ['bytes32', 'bytes32', 'uint8', 'uint256'],
    [anchorBlockHash, poolId, dir, borrowAmount],
  )));
}

export function buildLegs({
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
  throw new Error('unknown direction');
}

export async function buildExactStateChecks({
  provider,
  rpcUrl,
  anchorBlock,
  curve,
  stateView,
  token,
  poolId,
}) {
  const calls = [
    { target: curve, callData: CURVE_I.encodeFunctionData('curves', [token]), gasLimit: 120_000 },
    { target: stateView, callData: STATE_I.encodeFunctionData('getSlot0', [poolId]), gasLimit: 120_000 },
    { target: stateView, callData: STATE_I.encodeFunctionData('getLiquidity', [poolId]), gasLimit: 120_000 },
  ];

  let raw;
  if (rpcUrl) {
    const blockTag = '0x' + BigInt(anchorBlock).toString(16);
    const payload = calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'eth_call',
      params: [{ to: c.target, data: c.callData }, blockTag],
    }));
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const values = await response.json();
    const byId = new Map(values.map(x => [x.id, x]));
    raw = calls.map((_, i) => {
      const item = byId.get(i + 1);
      if (!item || item.error || typeof item.result !== 'string') {
        throw new Error('state-check batch call failed');
      }
      return item.result;
    });
  } else {
    raw = await Promise.all(calls.map(c =>
      provider.send('eth_call', [{ to: c.target, data: c.callData }, '0x' + BigInt(anchorBlock).toString(16)])
    ));
  }

  return calls.map((c, i) => ({
    mode: 0,
    target: c.target,
    gasLimit: c.gasLimit,
    callData: c.callData,
    expectedReturnHash: keccak256(raw[i]),
  }));
}

export async function signFlashIntent(strategyWallet, executor, intent) {
  const domain = {
    name: 'RobinhoodSequencerFlashArb',
    version: '4',
    chainId: 4663,
    verifyingContract: executor,
  };
  return strategyWallet.signTypedData(domain, FLASH_TYPES, intent);
}
