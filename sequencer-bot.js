// sequencer-bot.js — one strategy: verified feed -> next-L2-block Morpho flash arb.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import {
  Contract, Interface, JsonRpcProvider, Network, Wallet, ZeroHash, formatEther, parseEther,
} from 'ethers';
import { CURVE, V4, TOKEN, POOLS, WETH } from './config.js';
import { bpsDown, buildGrid, envInteger } from './risk.js';
import {
  buildFlashIntent, randomNonce192, signFlashIntent,
} from './flash-intent.js';
import { signAndBroadcast } from './broadcast.js';
import {
  buildExactStateChecks, buildRouteLegs, opportunityKey, poolKeyTuple,
} from './sequencer-strategy.js';
import {
  expectedValueGate, NonceCoordinator, OpportunityDedupe, Telemetry, waitForExactL2Block,
} from './sequencer/runtime.js';

const EXECUTOR_ABI = [
  'function executeFlashArb((address settlementToken,uint256 borrowAmount,uint256 minProfit,uint256 maxGasPrice,uint64 anchorBlock,bytes32 anchorBlockHash,uint64 validAfterBlock,uint64 validUntilBlock,uint64 deadline,uint256 nonce,bytes32 triggerTxHash,bytes32 routeHash,bytes32 stateChecksHash) intent,(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes data)[] legs,(uint8 mode,address target,bytes callData,bytes32 expectedReturnHash)[] checks,bytes signature)',
  'function strategySigner() view returns (address)',
  'function relayers(address) view returns (bool)',
  'function adapters(address) view returns (bool)',
  'function borrowCaps(address) view returns (uint256)',
  'function paused() view returns (bool)',
  'function maxBlockWindow() view returns (uint64)',
  'function maxAnchorDelay() view returns (uint64)',
];
const CURVE_ADAPTER_ABI = ['function allowedTokens(address) view returns (bool)'];
const V4_ADAPTER_ABI = ['function allowedPools(bytes32) view returns (bool)'];
const ROUTE_QUOTER_ABI = [
  'function quoteCurveToV4(address token,uint128 wethIn,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key) returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate)',
  'function quoteV4ToCurve(address token,uint128 wethIn,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key) returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate)',
];

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const bigintEnv = (name, fallback) => {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  return BigInt(raw);
};

const LIVE = process.argv.includes('--live') || process.env.LIVE === '1';
const ONCE = process.argv.includes('--once');
const CFG = {
  localRpc: required('LOCAL_RPC_URL'),
  executor: required('SEQUENCER_EXECUTOR_ADDR'),
  curveAdapter: required('ROBIN_FUN_WETH_ADAPTER'),
  v4Adapter: required('UNISWAP_V4_WETH_ADAPTER'),
  routeQuoter: required('ROUTE_QUOTER_ADDR'),
  minSize: parseEther(process.env.MIN_SIZE_ETH || '0.002'),
  maxSize: parseEther(process.env.MAX_SIZE_ETH || '0.25'),
  gridPoints: envInteger('GRID_POINTS', 8, { min: 2, max: 32 }),
  slippageBps: BigInt(envInteger('SLIPPAGE_BPS', 50, { min: 0, max: 2000 })),
  gasUnits: bigintEnv('FLASH_GAS_UNITS', 850000),
  revertGasUnits: bigintEnv('REVERT_GAS_UNITS', 180000),
  maxGasPrice: bigintEnv('MAX_GAS_PRICE_WEI', 500000000),
  modelGasPrice: bigintEnv('MODEL_GAS_PRICE_WEI', process.env.MAX_GAS_PRICE_WEI || 500000000),
  priorityFee: bigintEnv('MAX_PRIORITY_FEE_PER_GAS_WEI', 0),
  loseRaceBps: BigInt(envInteger('LOSE_RACE_BPS', 0, { min: 0, max: 10000 })),
  minExpectedWei: bigintEnv('MIN_EXPECTED_VALUE_WEI', 0),
  onchainMinProfit: bigintEnv('ONCHAIN_MIN_PROFIT_WEI', 0),
  ttlSeconds: envInteger('INTENT_TTL_SECONDS', 2, { min: 1, max: 30 }),
};
if (CFG.maxSize < CFG.minSize) throw new Error('MAX_SIZE_ETH < MIN_SIZE_ETH');

const network = new Network('robinhood', 4663);
const provider = new JsonRpcProvider(CFG.localRpc, network, {
  staticNetwork: network,
  batchMaxCount: 100,
  batchStallTime: 0,
});
const relayer = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : null;
const strategyKey = process.env.STRATEGY_PRIVATE_KEY || null;
const strategyWallet = strategyKey ? new Wallet(strategyKey) : null;
if (LIVE && (!relayer || !strategyWallet)) {
  throw new Error('LIVE requires PRIVATE_KEY and STRATEGY_PRIVATE_KEY');
}

const executor = new Contract(CFG.executor, EXECUTOR_ABI, relayer || provider);
const curveAdapter = new Contract(CFG.curveAdapter, CURVE_ADAPTER_ABI, provider);
const v4Adapter = new Contract(CFG.v4Adapter, V4_ADAPTER_ABI, provider);
const routeI = new Interface(ROUTE_QUOTER_ABI);
const sizes = buildGrid(CFG.minSize, CFG.maxSize, CFG.gridPoints);
const dedupe = new OpportunityDedupe();
const telemetry = new Telemetry();
const txNonces = relayer ? new NonceCoordinator(provider, relayer.address) : null;

const max = (a, b) => a > b ? a : b;

async function startupChecks() {
  const chain = await provider.getNetwork();
  if (Number(chain.chainId) !== 4663) throw new Error('LOCAL_RPC_URL is not chain 4663');

  const addresses = [
    CFG.executor, CFG.curveAdapter, CFG.v4Adapter, CFG.routeQuoter,
    CURVE.address, V4.stateView, V4.quoter, WETH.address,
  ];
  const codes = await Promise.all(addresses.map(address => provider.getCode(address)));
  if (codes.some(code => code === '0x')) throw new Error('configured strategy address has no code');

  if (relayer && strategyWallet) {
    const [signer, relayerAllowed, curveAllowed, adapterA, adapterB, cap, paused, window, delay] =
      await Promise.all([
        executor.strategySigner(),
        executor.relayers(relayer.address),
        curveAdapter.allowedTokens(TOKEN.address),
        executor.adapters(CFG.curveAdapter),
        executor.adapters(CFG.v4Adapter),
        executor.borrowCaps(WETH.address),
        executor.paused(),
        executor.maxBlockWindow(),
        executor.maxAnchorDelay(),
      ]);

    if (signer.toLowerCase() !== strategyWallet.address.toLowerCase()) {
      throw new Error('STRATEGY_PRIVATE_KEY does not match strategySigner');
    }
    if (!relayerAllowed) throw new Error('relayer is not enabled');
    if (!curveAllowed) throw new Error('RobinFun adapter token is not allowed');
    if (!adapterA || !adapterB) throw new Error('executor adapters are not enabled');
    if (cap < CFG.maxSize) throw new Error('WETH borrow cap is below MAX_SIZE_ETH');
    if (paused) throw new Error('executor is paused');
    if (Number(window) !== 1 || Number(delay) !== 1) {
      throw new Error('production next-block mode requires maxBlockWindow=maxAnchorDelay=1');
    }
    for (const pool of POOLS) {
      if (!(await v4Adapter.allowedPools(pool.id))) {
        throw new Error(`V4 pool not allowed: ${pool.id}`);
      }
    }
    await txNonces.init();
  }
}

async function rpcBatch(blockNumber, calls) {
  const blockTag = '0x' + BigInt(blockNumber).toString(16);
  const payload = calls.map((call, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'eth_call',
    params: [{ to: CFG.routeQuoter, data: call.data }, blockTag],
  }));
  const response = await fetch(CFG.localRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'keep-alive' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error('local quote RPC did not return a batch');
  return new Map(body.map(item => [item.id, item]));
}

async function bestOpportunity(anchorBlock) {
  const calls = [];
  for (const pool of POOLS) {
    for (const size of sizes) {
      calls.push({
        direction: 'curve->v4',
        pool,
        size,
        functionName: 'quoteCurveToV4',
        data: routeI.encodeFunctionData('quoteCurveToV4', [
          TOKEN.address, size, poolKeyTuple(pool.key),
        ]),
      });
      calls.push({
        direction: 'v4->curve',
        pool,
        size,
        functionName: 'quoteV4ToCurve',
        data: routeI.encodeFunctionData('quoteV4ToCurve', [
          TOKEN.address, size, poolKeyTuple(pool.key),
        ]),
      });
    }
  }

  const results = await rpcBatch(anchorBlock, calls);
  const successGasCost = CFG.gasUnits * CFG.modelGasPrice;
  const revertGasCost = CFG.revertGasUnits * CFG.modelGasPrice;
  let best = null;

  for (let i = 0; i < calls.length; i++) {
    const item = results.get(i + 1);
    if (!item || item.error || typeof item.result !== 'string') continue;
    let decoded;
    try {
      decoded = routeI.decodeFunctionResult(calls[i].functionName, item.result);
    } catch {
      continue;
    }
    const q = {
      direction: calls[i].direction,
      pool: calls[i].pool,
      size: calls[i].size,
      tokenOut: decoded[0],
      wethOut: decoded[1],
      quoteGas: decoded[2],
    };
    if (q.wethOut <= q.size) continue;

    const grossProfit = q.wethOut - q.size;
    if (grossProfit < CFG.onchainMinProfit) continue;
    const gate = expectedValueGate({
      grossProfit,
      successGasCost,
      revertGasCost,
      loseRaceBps: CFG.loseRaceBps,
      minExpectedValue: CFG.minExpectedWei,
    });
    if (!gate.pass) continue;
    const candidate = { ...q, grossProfit, ...gate };
    if (!best || candidate.expectedValue > best.expectedValue) best = candidate;
  }
  return best;
}

async function buildExecution(anchor, best) {
  const stateChecks = await buildExactStateChecks({
    rpcUrl: CFG.localRpc,
    anchorBlock: anchor.blockNumber,
    curve: CURVE.address,
    stateView: V4.stateView,
    token: TOKEN.address,
    poolId: best.pool.id,
  });
  const minTokenOut = bpsDown(best.tokenOut, CFG.slippageBps);
  const minWethOut = max(
    bpsDown(best.wethOut, CFG.slippageBps),
    best.size + CFG.onchainMinProfit,
  );
  const legs = buildRouteLegs({
    direction: best.direction,
    weth: WETH.address,
    token: TOKEN.address,
    curveAdapter: CFG.curveAdapter,
    v4Adapter: CFG.v4Adapter,
    poolKey: best.pool.key,
    minTokenOut,
    minWethOut,
  });
  const intent = buildFlashIntent({
    settlementToken: WETH.address,
    borrowAmount: best.size,
    minProfit: CFG.onchainMinProfit,
    maxGasPrice: CFG.maxGasPrice,
    anchorBlock: BigInt(anchor.blockNumber),
    anchorBlockHash: anchor.blockHash,
    validAfterBlock: BigInt(anchor.blockNumber + 1),
    validUntilBlock: BigInt(anchor.blockNumber + 1),
    deadline: BigInt(Math.floor(Date.now() / 1000) + CFG.ttlSeconds),
    nonce: randomNonce192(),
    triggerTxHash: ZeroHash,
    legs,
    stateChecks,
  });
  const signature = await signFlashIntent({
    privateKey: strategyKey,
    executor: CFG.executor,
    intent,
  });
  return { intent, legs, stateChecks, signature };
}

async function submit(anchor, best) {
  const key = opportunityKey({
    anchorHash: anchor.blockHash,
    poolId: best.pool.id,
    direction: best.direction,
    size: best.size,
  });
  if (!dedupe.take(key, anchor.blockNumber)) return;

  const buildStart = process.hrtime.bigint();
  const built = await buildExecution(anchor, best);
  telemetry.record('intent_built', {
    anchorBlock: anchor.blockNumber,
    anchorHash: anchor.blockHash,
    direction: best.direction,
    poolId: best.pool.id,
    size: best.size.toString(),
    grossProfit: best.grossProfit.toString(),
    expectedValue: best.expectedValue.toString(),
    buildUs: Number((process.hrtime.bigint() - buildStart) / 1000n),
  });

  if (!LIVE) {
    console.log(
      'DRY', anchor.blockNumber, best.direction, best.pool.name,
      'size', formatEther(best.size),
      'gross', formatEther(best.grossProfit),
      'EV', formatEther(best.expectedValue),
    );
    return;
  }

  const nonce = txNonces.reserve();
  const tx = await executor.executeFlashArb.populateTransaction(
    built.intent, built.legs, built.stateChecks, built.signature,
  );
  Object.assign(tx, {
    chainId: 4663,
    type: 2,
    nonce,
    gasLimit: CFG.gasUnits,
    maxFeePerGas: CFG.maxGasPrice,
    maxPriorityFeePerGas: CFG.priorityFee,
    value: 0,
  });

  const signStart = process.hrtime.bigint();
  try {
    const sent = await signAndBroadcast(relayer, tx, { populate: false });
    telemetry.record('broadcast', {
      txHash: sent.txHash,
      anchorBlock: anchor.blockNumber,
      nonce,
      signToBroadcastUs: Number((process.hrtime.bigint() - signStart) / 1000n),
      paths: sent.results.map(result => ({
        url: result.url,
        ok: result.ok,
        latencyUs: result.latencyUs,
      })),
    });
    console.log('SENT', sent.txHash, 'anchor', anchor.blockNumber, best.direction, best.pool.name);
  } catch (error) {
    await txNonces.resync();
    telemetry.record('broadcast_failed', {
      anchorBlock: anchor.blockNumber,
      nonce,
      error: error?.message || String(error),
    });
    throw error;
  }
}

let working = false;
let latest = null;

async function drain() {
  if (working) return;
  working = true;
  try {
    while (latest) {
      const event = latest;
      latest = null;
      const anchor = {
        blockNumber: Number(event.blockNumber),
        blockHash: event.blockHash,
      };
      const catchupStart = process.hrtime.bigint();
      try {
        await waitForExactL2Block(provider, anchor.blockNumber, anchor.blockHash);
        telemetry.record('local_caught_up', {
          anchorBlock: anchor.blockNumber,
          feedToLocalUs: Number((process.hrtime.bigint() - catchupStart) / 1000n),
        });
        const quoteStart = process.hrtime.bigint();
        const best = await bestOpportunity(anchor.blockNumber);
        telemetry.record('quoted', {
          anchorBlock: anchor.blockNumber,
          quoteUs: Number((process.hrtime.bigint() - quoteStart) / 1000n),
          found: Boolean(best),
        });
        if (best) await submit(anchor, best);
      } catch (error) {
        telemetry.record('anchor_skipped', {
          anchorBlock: anchor.blockNumber,
          error: error?.shortMessage || error?.message || String(error),
        });
      }
      if (ONCE) return shutdown();
    }
  } finally {
    working = false;
  }
}

function onFeedEvent(event) {
  if (event.type === 'invalidate_from_sequence') {
    dedupe.invalidateFrom(Number(event.sequence));
    telemetry.record('feed_reorg', {
      sequence: event.sequence,
      newHash: event.newHash,
    });
    return;
  }
  if (event.type !== 'soft_confirmed_block') return;
  if (event.quality !== 'DIRECT_VERIFIED' || !event.verified || !event.blockHash) {
    telemetry.record('feed_rejected', {
      sequence: event.sequence,
      quality: event.quality,
    });
    return;
  }
  latest = event; // latest-only: never build a stale backlog
  queueMicrotask(() => drain().catch(error => console.error('drain:', error)));
}

let feedChild;
function startFeed() {
  const python = process.env.FEED_PYTHON || 'python3.11';
  feedChild = spawn(python, ['sequencer/rh_feed_edge.py'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RH_HOT_ADDRESSES: [CURVE.address, V4.universalRouter, V4.poolManager].join(','),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = readline.createInterface({ input: feedChild.stdout });
  lines.on('line', line => {
    try {
      onFeedEvent(JSON.parse(line));
    } catch (error) {
      telemetry.record('feed_decode_error', { error: error.message });
    }
  });
  feedChild.on('exit', code => {
    telemetry.record('feed_exit', { code });
    if (!ONCE) setTimeout(startFeed, 250);
  });
}

function shutdown() {
  telemetry.close();
  if (feedChild && !feedChild.killed) feedChild.kill('SIGTERM');
  provider.destroy();
  setTimeout(() => process.exit(0), 20);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await startupChecks();
console.log(
  `sequencer flash arb | ${LIVE ? 'LIVE' : 'DRY'} | ${TOKEN.symbol} | pools=${POOLS.length} | q=${sizes.length}`
);
startFeed();
