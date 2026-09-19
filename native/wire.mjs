// Ethers is confined to ABI/signing/preflight, never exploratory hot-path reads.
import { AbiCoder, Interface, Wallet, keccak256, getAddress, ZeroHash, TypedDataEncoder } from 'ethers';
import { FLASH_INTENT_TYPES, hashLegs, hashStateChecks, intentDomain } from '../flash-intent.js';
import { uint } from './core.mjs';

const coder = AbiCoder.defaultAbiCoder();
const legTuple = 'tuple(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes data)';
const finalCheckTuple = 'tuple(uint8 mode,address target,uint32 gasLimit,bytes callData,bytes32 expectedReturnHash)';
export const REPOSITORY_V4_ABI = [
  'function executeFlashArb((address settlementToken,uint256 borrowAmount,uint256 minProfit,uint256 maxGasPrice,uint64 anchorBlock,bytes32 anchorBlockHash,uint64 validAfterBlock,uint64 validUntilBlock,uint64 deadline,uint256 nonce,bytes32 triggerTxHash,bytes32 routeHash,bytes32 stateChecksHash) intent,(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes data)[] legs,(uint8 mode,address target,bytes callData,bytes32 expectedReturnHash)[] checks,bytes signature)',
  'function strategySigner() view returns (address)', 'function relayers(address) view returns (bool)',
  'function adapters(address) view returns (bool)', 'function borrowCaps(address) view returns (uint256)',
  'function paused() view returns (bool)', 'function maxBlockWindow() view returns (uint64)',
  'function maxAnchorDelay() view returns (uint64)', 'function domainSeparator() view returns (bytes32)',
  'function morpho() view returns (address)',
  'event FlashArbitrage(bytes32 indexed digest,uint64 indexed anchorBlock,bytes32 indexed anchorBlockHash,bytes32 triggerTxHash,address settlementToken,uint256 borrowed,uint256 profit,address relayer)',
];
const execI = new Interface(REPOSITORY_V4_ABI);
const v3I = new Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)']);
const v4I = new Interface(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)']);
const windowI = new Interface(['function hashV4State(bytes32 poolId,int16 minWord,uint16 wordCount,int24[] ticks) view returns (bytes32)']);
export function hashV4WindowState(p) {
  if (!p.tickBook || !p.tickWindow || keccak256(p.adapterData) !== p.poolKeyHash) throw new Error('V4 window/PoolKey identity mismatch');
  const packed = p.sqrtPriceX96 | (BigInt.asUintN(24, BigInt(p.tick)) << 160n) | (p.protocolFee << 184n) | (p.lpFee << 208n);
  const ticks = p.tickBook.ticks.map(t => t.tick);
  const tickData = p.tickBook.ticks.map(t => t.liquidityGross | (BigInt.asUintN(128, t.liquidityNet) << 128n));
  return keccak256(coder.encode(['bytes32','uint256','uint256','int16','uint256[]','int24[]','uint256[]'],
    [p.poolKeyHash, packed, p.liquidity, p.tickBook.minWord, p.tickBook.words, ticks, tickData]));
}
const generic = (target, callData, returnData) => ({ mode: 0, target, callData, expectedReturnHash: keccak256(returnData) });

export function stateChecks(pools) {
  return pools.flatMap(p => {
    if (p.kind === 'v2') return [{ mode: 1, target: p.pair, callData: '0x0902f1ac',
      expectedReturnHash: keccak256(coder.encode(['uint112', 'uint112'], [p.reserve0, p.reserve1])) }];
    if (p.kind === 'v4' && p.tickWindow) {
      const digest = hashV4WindowState(p);
      return [generic(p.tickWindow.lens,
        windowI.encodeFunctionData('hashV4State', [p.poolKeyHash, p.tickBook.minWord, p.tickBook.words.length, p.tickBook.ticks.map(t => t.tick)]),
        coder.encode(['bytes32'], [digest]))];
    }
    if (p.kind === 'v3') return [
      generic(p.pair, v3I.encodeFunctionData('slot0'), v3I.encodeFunctionResult('slot0', [p.sqrtPriceX96, p.tick,
        p.observationIndex, p.observationCardinality, p.observationCardinalityNext, p.feeProtocol, p.unlocked])),
      generic(p.pair, v3I.encodeFunctionData('liquidity'), v3I.encodeFunctionResult('liquidity', [p.liquidity])),
    ];
    if (p.kind === 'v4') return [
      generic(p.stateView, v4I.encodeFunctionData('getSlot0', [p.poolKeyHash]),
        v4I.encodeFunctionResult('getSlot0', [p.sqrtPriceX96, p.tick, p.protocolFee, p.lpFee])),
      generic(p.stateView, v4I.encodeFunctionData('getLiquidity', [p.poolKeyHash]), v4I.encodeFunctionResult('getLiquidity', [p.liquidity])),
    ];
    throw new Error('unsupported state check model');
  });
}

export function createWire({ executor, strategyKey, relayerKey, gasLimit, maxFeePerGas, maxPriorityFeePerGas = 0n, ttlSeconds = 2, record = () => {} }) {
  executor = getAddress(executor);
  const strategy = new Wallet(strategyKey), relayer = new Wallet(relayerKey); // detached, warmed ONCE
  const domain = intentDomain(executor, 4663);
  gasLimit = uint(gasLimit); maxFeePerGas = uint(maxFeePerGas);
  maxPriorityFeePerGas = uint(maxPriorityFeePerGas, 'priority fee', maxFeePerGas);
  ttlSeconds = uint(ttlSeconds, 'ttlSeconds', 5n);
  if (!gasLimit || !maxFeePerGas || !ttlSeconds) throw new Error('positive transaction limits required');
  const skeleton = Object.freeze({ to: executor, chainId: 4663, type: 2, value: 0n, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
  const wire = async (opportunity, nonce) => {
    const { route, amount, outputs, head, key } = opportunity;
    const legs = route.legs.map((leg, i) => {
      let minOut = outputs[i] * (10_000n - route.slippageBps) / 10_000n;
      if (i === route.legs.length - 1 && minOut < amount + route.minProfit) minOut = amount + route.minProfit;
      if (!minOut) throw new Error('zero minOut');
      return { adapter: leg.adapter, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, minOut, data: leg.data };
    });
    const checks = stateChecks(opportunity.pools);
    if (!checks.length || checks.length > 8) throw new Error('invalid state-check count');
    // EOA ownership+durable journal make this session's sequential intent nonces
    // non-repeating. The upper 192-bit namespace is random once per warm signer.
    const intent = { settlementToken: route.settlementToken, borrowAmount: amount, minProfit: route.minProfit,
      maxGasPrice: maxFeePerGas, anchorBlock: head.number, anchorBlockHash: head.hash,
      validAfterBlock: head.number + 1n, validUntilBlock: head.number + 1n,
      deadline: head.timestamp + ttlSeconds, nonce: namespace + nonce, triggerTxHash: ZeroHash,
      routeHash: hashLegs(legs), stateChecksHash: hashStateChecks(checks) };
    const signature = await strategy.signTypedData(domain, FLASH_INTENT_TYPES, intent);
    record('intent_signed', { key });
    const data = execI.encodeFunctionData('executeFlashArb', [intent, legs, checks, signature]);
    const raw = await relayer.signTransaction({ ...skeleton, nonce: Number(uint(nonce, 'EOA nonce', BigInt(Number.MAX_SAFE_INTEGER))), data });
    record('raw_signed', { key });
    return { raw, hash: keccak256(raw), intent, intentDigest: TypedDataEncoder.hash(domain, FLASH_INTENT_TYPES, intent), gasLimit, maxFeePerGas };
  };
  // A fresh namespace avoids colliding with signatures from a different relayer
  // or a prior process while consuming adjacent nonce-bitmap bits in this session.
  const namespace = BigInt(keccak256(Wallet.createRandom().privateKey)) & (((1n << 192n) - 1n) << 64n);
  return { wire, strategyAddress: strategy.address, relayerAddress: relayer.address, domainSeparator: TypedDataEncoder.hashDomain(domain) };
}

// Compatibility tooling for the UPLOADED ABI. Not selected by the live runner:
// its unpatched block.number/blockhash anchor is not an L2 ArbSys anchor.
export const FINAL_V4_TYPES = { FlashArbIntent: [
  { name: 'settlementToken', type: 'address' }, { name: 'borrowAmount', type: 'uint256' },
  { name: 'minProfit', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
  { name: 'anchorBlock', type: 'uint64' }, { name: 'anchorBlockHash', type: 'bytes32' },
  { name: 'validUntilBlock', type: 'uint64' }, { name: 'validUntilTimestamp', type: 'uint64' },
  { name: 'maxGasPrice', type: 'uint256' }, { name: 'legsHash', type: 'bytes32' }, { name: 'checksHash', type: 'bytes32' },
] };
export const finalDomain = executor => ({ name: 'RobinhoodSequencerFlashArb', version: '4', chainId: 4663, verifyingContract: getAddress(executor) });
export const finalLegsHash = legs => keccak256(coder.encode([`${legTuple}[]`], [legs]));
export const finalChecksHash = checks => keccak256(coder.encode([`${finalCheckTuple}[]`], [checks]));

// Decode only this executor's event from full receipt logs. An upstream arbitrary
// `profit` field is never accepted as realized P&L by the live runner.
export function decodeReceipt(receipt, executor) {
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 4096) throw new Error('bounded full receipt logs required');
  executor = getAddress(executor);
  const topic = execI.getEvent('FlashArbitrage').topicHash;
  const arbitrageEvents = [];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== executor || log.topics?.[0]?.toLowerCase() !== topic.toLowerCase()) continue;
    if (log.removed === true) throw new Error('removed executor log');
    const parsed = execI.parseLog(log), e = parsed.args;
    arbitrageEvents.push({ emitter: executor, digest: e.digest, anchorBlock: e.anchorBlock,
      anchorBlockHash: e.anchorBlockHash, settlementToken: e.settlementToken,
      borrowed: e.borrowed, profit: e.profit, relayer: e.relayer });
  }
  return { ...receipt, arbitrageEvents };
}
