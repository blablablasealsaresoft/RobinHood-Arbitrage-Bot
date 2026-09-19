// sequencer-bot.js — single-strategy verified-feed -> next-L2-block flash arb runtime.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import {
  Contract, JsonRpcProvider, Network, Wallet, formatEther, parseEther, keccak256,
} from 'ethers';
import { CURVE, V4, TOKEN, POOLS, WETH } from './config.js';
import { bpsDown, buildGrid, envInteger } from './risk.js';
import { signAndBroadcast } from './broadcast.js';
import {
  buildExactStateChecks, buildLegs, hashChecks, hashLegs,
  opportunityNonce, poolKeyTuple, signFlashIntent,
} from './flash-intent.js';
import {
  expectedValueGate, NonceCoordinator, OpportunityDedupe, Telemetry,
  waitForExactL2Block,
} from './sequencer/runtime.js';

const EXECUTOR_ABI = [
  'function executeFlashArb((address settlementToken,uint256 borrowAmount,uint256 minProfit,uint256 nonce,uint64 anchorBlock,bytes32 anchorBlockHash,uint64 validUntilBlock,uint64 validUntilTimestamp,uint256 maxGasPrice,bytes32 legsHash,bytes32 checksHash) intent,(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes data)[] legs,(uint8 mode,address target,uint32 gasLimit,bytes callData,bytes32 expectedReturnHash)[] checks,bytes signature) returns (uint256 profit)',
  'function strategySigner() view returns (address)',
  'function relayer(address) view returns (bool)',
  'function borrowCap(address) view returns (uint256)',
  'function paused() view returns (bool)',
  'function maxAnchorDelay() view returns (uint64)',
];
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
  executor: required('FLASH_EXECUTOR_ADDR'),
  routeQuoter: required('ROUTE_QUOTER_ADDR'),
  curveAdapter: required('CURVE_ADAPTER_ADDR'),
  v4Adapter: required('V4_ADAPTER_ADDR'),
  minSize: parseEther(process.env.MIN_SIZE_ETH || '0.002'),
  maxSize: parseEther(process.env.MAX_SIZE_ETH || '0.25'),
  gridPoints: envInteger('GRID_POINTS', 8, { min: 2, max: 32 }),
  slippageBps: BigInt(envInteger('SLIPPAGE_BPS', 50, { min: 0, max: 2000 })),
  gasUnits: bigintEnv('FLASH_GAS_UNITS', 850000),
  revertGasUnits: bigintEnv('REVERT_GAS_UNITS', 180000),
  maxGasPrice: bigintEnv('MAX_GAS_PRICE_WEI', 500000000n),
  modelGasPrice: bigintEnv('MODEL_GAS_PRICE_WEI', process.env.MAX_GAS_PRICE_WEI || 500000000n),
  priorityFee: bigintEnv('MAX_PRIORITY_FEE_PER_GAS_WEI', 0),
  loseRaceBps: BigInt(envInteger('LOSE_RACE_BPS', 0, { min: 0, max: 10000 })),
  minExpectedWei: bigintEnv('MIN_EXPECTED_VALUE_WEI', 0),
  onchainMinProfit: bigintEnv('ONCHAIN_MIN_PROFIT_WEI', 0),
  intentTtlSeconds: envInteger('INTENT_TTL_SECONDS', 2, { min: 1, max: 30 }),
};
if (CFG.maxSize < CFG.minSize) throw new Error('MAX_SIZE_ETH < MIN_SIZE_ETH');

const net = new Network('robinhood', 4663);
const provider = new JsonRpcProvider(CFG.localRpc, net, {
  staticNetwork: net,
  batchMaxCount: 100,
  batchStallTime: 0,
});
const relayerWallet = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : null;
const strategyWallet = process.env.STRATEGY_PRIVATE_KEY
  ? new Wallet(process.env.STRATEGY_PRIVATE_KEY)
  : null;
if (LIVE && (!relayerWallet || !strategyWallet)) {
  throw new Error('LIVE requires PRIVATE_KEY and STRATEGY_PRIVATE_KEY');
}

const executor = new Contract(CFG.executor, EXECUTOR_ABI, relayerWallet || provider);
const routeQuoter = new Contract(CFG.routeQuoter, ROUTE_QUOTER_ABI, provider);
const sizes = buildGrid(CFG.minSize, CFG.maxSize, CFG.gridPoints);
const dedupe = new OpportunityDedupe();
const telemetry = new Telemetry();
const nonceCoordinator = relayerWallet ? new NonceCoordinator(provider, relayerWallet.address) : null;

const max = (a, b) => a > b ? a : b;

async function startupChecks() {
  const chain = await provider.getNetwork();
  if (Number(chain.chainId) !== 4663) throw new Error('LOCAL_RPC_URL is not Robinhood Chain 4663');
  const codes = await Promise.all([
    CFG.executor, CFG.routeQuoter, CFG.curveAdapter, CFG.v4Adapter, CURVE.address, V4.stateView,
  ].map(a => provider.getCode(a)));
  if (codes.some(x => x === '0x')) throw new Error('one or more configured strategy contracts have no code');

  if (relayerWallet && strategyWallet) {
    const [signer, allowed, cap, paused, delay] = await Promise.all([
      executor.strategySigner(),
      executor.relayer(relayerWallet.address),
      executor.borrowCap(WETH.address),
      executor.paused(),
      executor.maxAnchorDelay(),
    ]);
    if (String(signer).toLowerCase() !== strategyWallet.address.toLowerCase()) {
      throw new Error('STRATEGY_PRIVATE_KEY does not match executor strategySigner');
    }
    if (!allowed) throw new Error('relayer wallet is not allowlisted');
    if (paused) throw new Error('flash executor is paused');
    if (cap < CFG.maxSize) throw new Error('WETH borrow cap is below MAX_SIZE_ETH');
    if (Number(delay) !== 1) throw new Error('production sequencer mode requires maxAnchorDelay=1');
    await nonceCoordinator.init();
  }
}

async function quoteAnchor(anchorBlock) {
  const tasks = [];
  for (const pool of POOLS) {
    for (const size of sizes) {
      tasks.push(
        routeQuoter.quoteCurveToV4.staticCall(
          TOKEN.address, size, poolKeyTuple(pool.key), { blockTag: anchorBlock },
        ).then(r => ({
          direction: 'curve->v4', pool, size,
          tokenOut: r[0], wethOut: r[1], quoteGas: r[2],
        })).catch(() => null)
      );
      tasks.push(
        routeQuoter.quoteV4ToCurve.staticCall(
          TOKEN.address, size, poolKeyTuple(pool.key), { blockTag: anchorBlock },
        ).then(r => ({
          direction: 'v4->curve', pool, size,
          tokenOut: r[0], wethOut: r[1], quoteGas: r[2],
        })).catch(() => null)
      );
    }
  }

  const quoted = (await Promise.all(tasks)).filter(Boolean);
  let best = null;
  const successGasCost = CFG.gasUnits * CFG.modelGasPrice;
  const revertGasCost = CFG.revertGasUnits * CFG.modelGasPrice;
  for (const q of quoted) {
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
  const checks = await buildExactStateChecks({
    provider,
    anchorBlock: anchor.blockNumber,
    curve: CURVE.address,
    stateView: V4.stateView,
    token: TOKEN.address,
    poolId: best.pool.id,
  });

  const minTokenOut = bpsDown(best.tokenOut, CFG.slippageBps);
  const modeledFloor = bpsDown(best.wethOut, CFG.slippageBps);
  const principalFloor = best.size + CFG.onchainMinProfit;
  const minWethOut = max(modeledFloor, principalFloor);

  const legs = buildLegs({
    direction: best.direction,
    weth: WETH.address,
    token: TOKEN.address,
    curveAdapter: CFG.curveAdapter,
    v4Adapter: CFG.v4Adapter,
    poolKey: best.pool.key,
    minTokenOut,
    minWethOut,
  });

  const nonce = opportunityNonce({
    anchorBlockHash: anchor.blockHash,
    poolId: best.pool.id,
    direction: best.direction,
    borrowAmount: best.size,
  });
  const intent = {
    settlementToken: WETH.address,
    borrowAmount: best.size,
    minProfit: CFG.onchainMinProfit,
    nonce,
    anchorBlock: anchor.blockNumber,
    anchorBlockHash: anchor.blockHash,
    validUntilBlock: anchor.blockNumber + 1,
    validUntilTimestamp: Math.floor(Date.now() / 1000) + CFG.intentTtlSeconds,
    maxGasPrice: CFG.maxGasPrice,
    legsHash: hashLegs(legs),
    checksHash: hashChecks(checks),
  };
  const signature = await signFlashIntent(strategyWallet, CFG.executor, intent);
  return { intent, legs, checks, signature };
}

async function submit(anchor, best) {
  const key = keccak256(Buffer.from([
    anchor.blockHash.toLowerCase(),
    best.pool.id.toLowerCase(),
    best.direction,
    best.size.toString(),
  ].join('|')));
  if (!dedupe.take(key, anchor.blockNumber)) return;

  const t0 = process.hrtime.bigint();
  const built = await buildExecution(anchor, best);
  telemetry.record('intent_built', {
    anchorBlock: anchor.blockNumber,
    anchorHash: anchor.blockHash,
    pool: best.pool.id,
    direction: best.direction,
    size: best.size.toString(),
    grossProfit: best.grossProfit.toString(),
    expectedValue: best.expectedValue.toString(),
    buildUs: Number((process.hrtime.bigint() - t0) / 1000n),
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

  const txNonce = nonceCoordinator.reserve();
  const txReq = await executor.executeFlashArb.populateTransaction(
    built.intent, built.legs, built.checks, built.signature,
  );
  Object.assign(txReq, {
    chainId: 4663,
    type: 2,
    nonce: txNonce,
    gasLimit: CFG.gasUnits,
    maxFeePerGas: CFG.maxGasPrice,
    maxPriorityFeePerGas: CFG.priorityFee,
    value: 0,
  });

  const signedAt = process.hrtime.bigint();
  try {
    const sent = await signAndBroadcast(relayerWallet, txReq, { populate: false });
    telemetry.record('broadcast', {
      txHash: sent.txHash,
      anchorBlock: anchor.blockNumber,
      nonce: txNonce,
      signToBroadcastUs: Number((process.hrtime.bigint() - signedAt) / 1000n),
      paths: sent.results.map(x => ({ url: x.url, ok: x.ok, latencyUs: x.latencyUs })),
    });
    console.log('SENT', sent.txHash, 'anchor', anchor.blockNumber, best.direction, best.pool.name);
  } catch (e) {
    await nonceCoordinator.resync();
    telemetry.record('broadcast_failed', {
      anchorBlock: anchor.blockNumber,
      nonce: txNonce,
      error: e?.message || String(e),
    });
    throw e;
  }
}

let active = false;
let latest = null;

async function drain() {
  if (active) return;
  active = true;
  try {
    while (latest) {
      const event = latest;
      latest = null;
      const anchor = { blockNumber: Number(event.blockNumber), blockHash: event.blockHash };
      const start = process.hrtime.bigint();

      try {
        await waitForExactL2Block(provider, anchor.blockNumber, anchor.blockHash);
        telemetry.record('local_caught_up', {
          anchorBlock: anchor.blockNumber,
          feedToLocalUs: Number((process.hrtime.bigint() - start) / 1000n),
        });

        const q0 = process.hrtime.bigint();
        const best = await quoteAnchor(anchor.blockNumber);
        telemetry.record('quoted', {
          anchorBlock: anchor.blockNumber,
          quoteUs: Number((process.hrtime.bigint() - q0) / 1000n),
          found: Boolean(best),
        });
        if (best) await submit(anchor, best);
      } catch (e) {
        telemetry.record('anchor_skipped', {
          anchorBlock: anchor.blockNumber,
          error: e?.shortMessage || e?.message || String(e),
        });
      }
      if (ONCE) {
        shutdown();
        return;
      }
    }
  } finally {
    active = false;
  }
}

function onFeedEvent(event) {
  if (event.type === 'invalidate_from_sequence') {
    dedupe.invalidateFrom(Number(event.sequence));
    telemetry.record('feed_reorg', { sequence: event.sequence, newHash: event.newHash });
    return;
  }
  if (event.type !== 'soft_confirmed_block') return;
  if (event.quality !== 'DIRECT_VERIFIED' || !event.verified || !event.blockHash) {
    telemetry.record('feed_rejected', { sequence: event.sequence, quality: event.quality });
    return;
  }
  latest = event; // latest-only queue: never build a stale backlog
  queueMicrotask(() => drain().catch(e => console.error('drain:', e)));
}

let child;
function startFeed() {
  const python = process.env.FEED_PYTHON || 'python3.11';
  child = spawn(python, ['sequencer/rh_feed_edge.py'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RH_HOT_ADDRESSES: [CURVE.address, V4.universalRouter, V4.poolManager].join(','),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => {
    try { onFeedEvent(JSON.parse(line)); }
    catch (e) { telemetry.record('feed_decode_error', { error: e.message }); }
  });
  child.on('exit', code => {
    telemetry.record('feed_exit', { code });
    if (!ONCE) setTimeout(startFeed, 250);
  });
}

function shutdown() {
  telemetry.close();
  if (child && !child.killed) child.kill('SIGTERM');
  provider.destroy();
  setTimeout(() => process.exit(0), 20);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await startupChecks();
console.log(
  `sequencer bot | ${LIVE ? 'LIVE' : 'DRY'} | token=${TOKEN.symbol} | pools=${POOLS.length} | sizes=${sizes.length}`
);
console.log(
  `WETH=${WETH.address} maxGas=${CFG.maxGasPrice} loseRaceBps=${CFG.loseRaceBps} onchainMin=${CFG.onchainMinProfit}`
);
startFeed();
