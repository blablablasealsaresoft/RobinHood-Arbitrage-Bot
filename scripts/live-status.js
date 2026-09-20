// scripts/live-status.js — read-only check that the five deployed contracts
// still have code and the fail-closed permissions required for sequencer flash live.
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { Contract, Wallet, formatEther, getAddress } from 'ethers';
import { makeProvider } from '../provider.js';
import { CURVE, POOLS, TOKEN, V4 } from '../config.js';
import {
  ARBSYS, DEPLOYER, DEPLOYMENTS, LIVE_STACK, MORPHO_BLUE, WETH, envOrDeployed,
} from '../deployments.js';
import { FLASH_EXECUTOR_ABI, arbSysContract } from '../l2-clock.js';
import { STATEVIEW_ABI } from '../abis.js';

const ERC20 = ['function balanceOf(address) view returns (uint256)'];

export function evaluateLiveSnapshot(s) {
  const issues = [];
  const notes = [];
  if (Number(s.chainId) !== 4663) issues.push(`wrong chain ${s.chainId}`);
  for (const c of s.contracts) {
    if (!c.hasCode) issues.push(`${c.name} has no code at ${c.address}`);
  }
  if (s.executor.paused) issues.push('executor is paused');
  if (s.executor.maxBlockWindow !== 1n) issues.push(`maxBlockWindow is ${s.executor.maxBlockWindow}, expected 1`);
  if (s.executor.maxAnchorDelay !== 1n) issues.push(`maxAnchorDelay is ${s.executor.maxAnchorDelay}, expected 1`);
  if (s.executor.morpho.toLowerCase() !== MORPHO_BLUE.toLowerCase()) issues.push('executor Morpho address mismatch');
  if (!s.executor.curveAdapterEnabled) issues.push('RobinFun adapter is not enabled on the executor');
  if (!s.executor.v4AdapterEnabled) issues.push('Uniswap V4 adapter is not enabled on the executor');
  if (s.executor.wethBorrowCap === 0n) issues.push('WETH borrow cap is 0 (flash borrow disabled)');
  if (!s.curveAdapter.tokenAllowed) issues.push(`${TOKEN.symbol} is not allowlisted on RobinFunWethAdapter`);
  for (const pool of s.v4Adapter.pools) {
    if (!pool.allowed) issues.push(`pool ${pool.name} is not allowlisted on UniswapV4WethAdapter`);
    else if (pool.liquidity === 0n) notes.push(`allowlisted pool ${pool.name} currently has zero active V4 liquidity`);
  }
  if (s.routeQuoter.curve.toLowerCase() !== CURVE.address.toLowerCase()) issues.push('route quoter curve mismatch');
  if (s.routeQuoter.v4Quoter.toLowerCase() !== V4.quoter.toLowerCase()) issues.push('route quoter V4 quoter mismatch');
  if (s.tickLens.poolManager.toLowerCase() !== V4.poolManager.toLowerCase()) issues.push('tick lens PoolManager mismatch');
  if (s.morphoWeth === 0n) issues.push('Morpho WETH balance is 0; flash liquidity unavailable');
  if (s.relayer) {
    if (!s.relayer.isRelayer) issues.push(`wallet ${s.relayer.address} is not an enabled relayer`);
    if (s.relayer.eth === 0n) issues.push('relayer ETH balance is 0; cannot pay gas');
  } else {
    notes.push('PRIVATE_KEY not set; relayer/gas check skipped');
  }
  if (s.strategy) {
    if (s.strategy.address.toLowerCase() !== s.executor.strategySigner.toLowerCase()) {
      issues.push(`STRATEGY_PRIVATE_KEY ${s.strategy.address} is not the on-chain strategy signer`);
    }
  } else {
    notes.push('STRATEGY_PRIVATE_KEY not set; signer check skipped');
  }
  if (s.executor.wethBorrowCap > 0n) {
    notes.push(`WETH borrow cap is ${formatEther(s.executor.wethBorrowCap)} ETH; size trades at or below that cap`);
  }
  return {
    productionReady: issues.length === 0,
    liveReady: issues.length === 0 && Boolean(s.relayer) && Boolean(s.strategy),
    issues,
    notes,
  };
}

async function collectSnapshot(provider) {
  const chainId = Number(BigInt(await provider.send('eth_chainId', [])));
  const executorAddr = envOrDeployed('SEQUENCER_EXECUTOR_ADDR', DEPLOYMENTS.sequencerExecutor);
  const curveAdapter = envOrDeployed('ROBIN_FUN_WETH_ADAPTER', DEPLOYMENTS.robinFunWethAdapter);
  const v4Adapter = envOrDeployed('UNISWAP_V4_WETH_ADAPTER', DEPLOYMENTS.uniswapV4WethAdapter);
  const routeQuoter = envOrDeployed('ROUTE_QUOTER_ADDR', DEPLOYMENTS.routeQuoter);
  const tickLens = envOrDeployed('V4_TICK_STATE_LENS', DEPLOYMENTS.v4TickStateLens);

  const addrs = {
    sequencerExecutor: executorAddr,
    robinFunWethAdapter: curveAdapter,
    uniswapV4WethAdapter: v4Adapter,
    routeQuoter,
    v4TickStateLens: tickLens,
  };
  const contracts = [];
  for (const item of LIVE_STACK) {
    const address = addrs[item.key];
    const code = await provider.getCode(address);
    contracts.push({ ...item, address, hasCode: code !== '0x', codeBytes: code === '0x' ? 0 : (code.length - 2) / 2 });
  }

  const exec = new Contract(executorAddr, FLASH_EXECUTOR_ABI, provider);
  const curveA = new Contract(curveAdapter, [
    'function owner() view returns (address)',
    'function curve() view returns (address)',
    'function weth() view returns (address)',
    'function allowedTokens(address) view returns (bool)',
  ], provider);
  const v4A = new Contract(v4Adapter, [
    'function owner() view returns (address)',
    'function weth() view returns (address)',
    'function allowedPools(bytes32) view returns (bool)',
  ], provider);
  const quoter = new Contract(routeQuoter, [
    'function curve() view returns (address)',
    'function v4Quoter() view returns (address)',
  ], provider);
  const lens = new Contract(tickLens, ['function poolManager() view returns (address)'], provider);
  const weth = new Contract(WETH, ERC20, provider);
  const clock = arbSysContract(provider);
  const stateView = new Contract(V4.stateView, STATEVIEW_ABI, provider);

  const [
    owner, paused, strategySigner, treasury, morpho, window, delay,
    curveEnabled, v4Enabled, cap, tokenAllowed, qCurve, qV4, lensPm, morphoWeth, l2, version,
  ] = await Promise.all([
    exec.owner(), exec.paused(), exec.strategySigner(), exec.treasury(), exec.morpho(),
    exec.maxBlockWindow(), exec.maxAnchorDelay(),
    exec.adapters(curveAdapter), exec.adapters(v4Adapter), exec.borrowCaps(WETH),
    curveA.allowedTokens(TOKEN.address),
    quoter.curve(), quoter.v4Quoter(), lens.poolManager(),
    weth.balanceOf(MORPHO_BLUE), clock.arbBlockNumber(), clock.arbOSVersion(),
  ]);

  const pools = await Promise.all(POOLS.map(async (pool) => {
    const [allowed, liquidity] = await Promise.all([
      v4A.allowedPools(pool.id),
      stateView.getLiquidity(pool.id).then((value) => BigInt(value)).catch(() => 0n),
    ]);
    return { name: pool.name, id: pool.id, allowed, liquidity };
  }));

  let relayer = null;
  if (process.env.PRIVATE_KEY) {
    const wallet = new Wallet(process.env.PRIVATE_KEY);
    relayer = {
      address: wallet.address,
      isRelayer: await exec.relayers(wallet.address),
      eth: await provider.getBalance(wallet.address),
    };
  }
  let strategy = null;
  if (process.env.STRATEGY_PRIVATE_KEY) {
    strategy = { address: new Wallet(process.env.STRATEGY_PRIVATE_KEY).address };
  } else if (relayer) {
    strategy = null;
  }

  return {
    chainId,
    deployer: DEPLOYER,
    arbSys: ARBSYS,
    l2Block: l2,
    arbOSVersion: version,
    contracts,
    executor: {
      address: executorAddr,
      owner: getAddress(owner),
      paused,
      strategySigner: getAddress(strategySigner),
      treasury: getAddress(treasury),
      morpho: getAddress(morpho),
      maxBlockWindow: BigInt(window),
      maxAnchorDelay: BigInt(delay),
      curveAdapterEnabled: curveEnabled,
      v4AdapterEnabled: v4Enabled,
      wethBorrowCap: BigInt(cap),
    },
    curveAdapter: { address: curveAdapter, tokenAllowed },
    v4Adapter: { address: v4Adapter, pools },
    routeQuoter: { address: routeQuoter, curve: getAddress(qCurve), v4Quoter: getAddress(qV4) },
    tickLens: { address: tickLens, poolManager: getAddress(lensPm) },
    morphoWeth: BigInt(morphoWeth),
    relayer,
    strategy,
  };
}

function printReport(snapshot, verdict) {
  console.log(`Robinhood Chain ${snapshot.chainId} | L2 ${snapshot.l2Block} | ArbOS raw ${snapshot.arbOSVersion}`);
  console.log(`deployer ${snapshot.deployer}`);
  console.log('');
  for (const c of snapshot.contracts) {
    console.log(`${c.hasCode ? 'OK ' : 'NO '} ${c.name} ${c.address} (${c.codeBytes} bytes)`);
  }
  console.log('');
  console.log(`executor paused=${snapshot.executor.paused} window=${snapshot.executor.maxBlockWindow} delay=${snapshot.executor.maxAnchorDelay}`);
  console.log(`owner=${snapshot.executor.owner} signer=${snapshot.executor.strategySigner} treasury=${snapshot.executor.treasury}`);
  console.log(`relayer-ready adapters curve=${snapshot.executor.curveAdapterEnabled} v4=${snapshot.executor.v4AdapterEnabled}`);
  console.log(`WETH borrow cap ${formatEther(snapshot.executor.wethBorrowCap)} | Morpho WETH ${formatEther(snapshot.morphoWeth)}`);
  console.log(`${TOKEN.symbol} allowed=${snapshot.curveAdapter.tokenAllowed}`);
  for (const pool of snapshot.v4Adapter.pools) {
    const liq = pool.liquidity == null ? 'unknown' : pool.liquidity.toString();
    console.log(`pool ${pool.name} allowed=${pool.allowed} liquidity=${liq}`);
  }
  if (snapshot.relayer) {
    console.log(`relayer ${snapshot.relayer.address} enabled=${snapshot.relayer.isRelayer} eth=${formatEther(snapshot.relayer.eth)}`);
  }
  if (snapshot.strategy) console.log(`strategy key ${snapshot.strategy.address}`);
  console.log('');
  if (verdict.notes.length) {
    for (const note of verdict.notes) console.log('NOTE', note);
  }
  if (verdict.issues.length) {
    for (const issue of verdict.issues) console.log('BLOCKER', issue);
    console.log('\nlive-status: NOT READY');
    return 2;
  }
  console.log(verdict.liveReady
    ? 'live-status: contracts live and this wallet can submit'
    : 'live-status: contracts live (keys not present in this environment)');
  return 0;
}

async function main() {
  const provider = await makeProvider();
  try {
    const snapshot = await collectSnapshot(provider);
    const verdict = evaluateLiveSnapshot(snapshot);
    process.exitCode = printReport(snapshot, verdict);
  } finally {
    provider.destroy?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('FATAL', error?.shortMessage || error?.message || error);
    process.exit(1);
  });
}
