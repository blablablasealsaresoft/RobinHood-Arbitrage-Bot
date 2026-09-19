// arb.js — RobinFun curve <-> Uniswap V4 arb on Robinhood Chain (4663).
//
// Multi-token + multi-pool. By default watches the token in config.js; with
// WATCHLIST=1 it loads watchlist.json (produced by `node scanner.js`) and watches
// EVERY discovered token that has an active curve + a liquid V4 pool.
//
// For each market it quotes both directions, across every pool, at the OPTIMAL
// size (geometric grid), and fires only if net (after curve fee, V4 fee, slippage,
// gas) >= MIN_PROFIT_BPS. Event-driven: re-quotes on any V4 Swap of a watched pool.
//
// Execution:
//   ATOMIC only: one tx, reverting unless profit covers both the configured net
//   floor and the transaction's explicitly bounded maximum gas charge.
//
//   node arb.js                                        # dry-run, config token
//   WATCHLIST=1 node arb.js                             # dry-run, all discovered tokens
//   npm run live

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, JsonRpcProvider, Network, parseEther, formatEther, id as topicId, getAddress, AbiCoder, keccak256 } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE_ABI, QUOTER_ABI } from './abis.js';
import { CURVE, V4, TOKEN, POOLS } from './config.js';
import { notifyStartup, notifyAtomic, notifyError, notifyPoll, notifyNoMarkets, tg, tgEnabled } from './telegram.js';
import { bpsDown, buildGrid, envInteger, feeOverrides, serialRunner } from './risk.js';
import { SequencerFeedClient } from './sequencer-feed.js';
import { createLatencyRecorder } from './latency.js';

const EXECUTOR_ABI = [
  'function curveToV4(address token,uint256 ethIn,uint256 minTokensOut,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint128 minEthOut,uint256 minProfit)',
  'function v4ToCurve(address token,uint256 ethIn,uint128 minTokensOut,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint256 minEthOut,uint256 minProfit)',
  'function owner() view returns (address)',
  'function maxTradeSize() view returns (uint256)',
  'function allowedPools(bytes32) view returns (bool)',
  'function paused() view returns (bool)',
];

const CLI_LIVE = process.argv.includes('--live');
const CLI_DRY_RUN = process.argv.includes('--dry-run');
if (CLI_LIVE && CLI_DRY_RUN) throw new Error('cannot combine --live and --dry-run');

const CFG = {
  minSize: parseEther(process.env.MIN_SIZE_ETH || '0.002'),
  maxSize: parseEther(process.env.MAX_SIZE_ETH || '0.005'),
  minProfitBps: BigInt(envInteger('MIN_PROFIT_BPS', 150, { min: 1, max: 5000 })),
  slippageBps: BigInt(envInteger('SLIPPAGE_BPS', 100, { min: 0, max: 2000 })),
  pollMs: envInteger('POLL_MS', 45000, { min: 1000, max: 3600000 }),
  eventPollMs: envInteger('EVENT_POLL_MS', 6000, { min: 1000, max: 60000 }),
  gasUnits: BigInt(envInteger('GAS_UNITS', 700000, { min: 100000, max: 5000000 })),
  gasBufferBps: BigInt(envInteger('GAS_BUFFER_BPS', 12000, { min: 10000, max: 30000 })),
  gridPoints: envInteger('GRID_POINTS', 3, { min: 1, max: 32 }),
  live: CLI_LIVE || (!CLI_DRY_RUN && process.env.LIVE === '1'),
  executor: process.env.EXECUTOR_ADDR || null,
  watchlist: process.env.WATCHLIST === '1',
  once: process.argv.includes('--once'),
  sequencerFeed: process.env.SEQUENCER_FEED === '1',
  sequencerTriggerMinMs: envInteger('SEQUENCER_TRIGGER_MIN_MS', 500, { min: 0, max: 60000 }),
  sequencerLiveMaxAgeMs: envInteger('SEQUENCER_LIVE_MAX_AGE_MS', 5000, { min: 100, max: 60000 }),
  sequencerFilterMode: process.env.SEQUENCER_FILTER_MODE || 'targets',
};
if (CFG.minSize <= 0n || CFG.maxSize < CFG.minSize) throw new Error('invalid MIN_SIZE_ETH/MAX_SIZE_ETH');
if (!['targets','all'].includes(CFG.sequencerFilterMode)) throw new Error('SEQUENCER_FILTER_MODE must be targets or all');
const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const ABI_CODER = AbiCoder.defaultAbiCoder();
const ZERO = '0x0000000000000000000000000000000000000000';

function validateMarkets(markets) {
  if (!Array.isArray(markets)) throw new Error('market list must be an array');
  if (!markets.length) return markets;
  const seen = new Set();
  for (const market of markets) {
    const token = getAddress(market.token);
    if (!Array.isArray(market.pools) || !market.pools.length) throw new Error(`market ${token} has no pools`);
    for (const pool of market.pools) {
      const k = pool.key;
      if (getAddress(k.currency0) !== ZERO || getAddress(k.currency1) !== token || getAddress(k.hooks) !== ZERO) {
        throw new Error(`unsafe PoolKey for ${market.symbol || token}`);
      }
      if (!Number.isInteger(Number(k.fee)) || Number(k.fee) < 0 || Number(k.fee) > 1_000_000 ||
          !Number.isInteger(Number(k.tickSpacing)) || Number(k.tickSpacing) <= 0) {
        throw new Error(`invalid pool parameters for ${market.symbol || token}`);
      }
      const expected = keccak256(ABI_CODER.encode(
        ['address', 'address', 'uint24', 'int24', 'address'], keyTuple(k),
      ));
      if (expected.toLowerCase() !== String(pool.id).toLowerCase()) throw new Error(`pool id mismatch for ${market.symbol || token}`);
      if (seen.has(expected)) throw new Error(`duplicate pool ${expected}`);
      seen.add(expected);
    }
  }
  return markets;
}

function loadMarkets() {
  if (CFG.watchlist) {
    const path = new URL('./watchlist.json', import.meta.url);
    if (!fs.existsSync(path)) throw new Error('WATCHLIST=1 but watchlist.json is missing; run npm run scan first');
    const wl = JSON.parse(fs.readFileSync(path));
    return wl.map(w => ({ token: w.token, symbol: w.symbol,
      pools: w.pools.map(p => ({ name: p.feePct + '%', id: p.id, key: p.key })) }));
  }
  return [{ token: TOKEN.address, symbol: TOKEN.symbol,
    pools: POOLS.map(p => ({ name: p.name, id: p.id, key: p.key })) }];
}

async function main() {
  // If only a private execution RPC is configured, share it for monitoring too.
  // This avoids silently falling back to the less reliable public RPC while the
  // user already has a working private endpoint.
  const monitorRpcUrl = process.env.FAST_RPC_URL || process.env.RPC_URL || process.env.EXEC_RPC_URL || null;
  const provider = await makeProvider({ rpcUrl: monitorRpcUrl });
  provider.pollingInterval = CFG.eventPollMs;
  console.log(`monitor RPC: ${monitorRpcUrl ? (process.env.FAST_RPC_URL ? 'fast/local' : (process.env.RPC_URL ? 'dedicated/private' : 'shared execution RPC')) : 'pinned public'}`);
  const wallet = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : null;
  if (CFG.live && !wallet) throw new Error('LIVE requires PRIVATE_KEY');
  if (CFG.live && !CFG.executor) throw new Error('LIVE requires EXECUTOR_ADDR; unsafe EOA mode is disabled');
  const runner = provider;

  // Dedicated EXECUTION provider (e.g. Alchemy) — reliable for trade txs, keeps the
  // flaky public RPC for cheap monitoring only. Falls back to the monitor provider.
  let execProvider = provider, execWallet = wallet;
  if (process.env.EXEC_RPC_URL && wallet) {
    const enet = new Network('robinhood', 4663);
    execProvider = new JsonRpcProvider(process.env.EXEC_RPC_URL, enet, { staticNetwork: enet });
    execWallet = new Wallet(process.env.PRIVATE_KEY, execProvider);
    console.log('exec RPC: dedicated');
  }

  let markets = validateMarkets(loadMarkets());
  const sequencerTargets = new Set([
    CURVE.address,
    V4.poolManager,
    V4.universalRouter,
    ...markets.map((m) => m.token),
  ].map((x) => x.toLowerCase()));
  const curve = new Contract(CURVE.address, CURVE_ABI, runner);
  const quoter = new Contract(V4.quoter, QUOTER_ABI, provider);
  const executor = CFG.executor && execWallet ? new Contract(CFG.executor, EXECUTOR_ABI, execWallet) : null;

  if (executor) {
    const [rawChainId, code, owner, contractMax, isPaused] = await Promise.all([
      execProvider.send('eth_chainId', []), execProvider.getCode(CFG.executor), executor.owner(), executor.maxTradeSize(), executor.paused(),
    ]);
    if (Number(BigInt(rawChainId)) !== 4663) throw new Error(`execution RPC is on wrong chain ${rawChainId}`);
    if (code === '0x') throw new Error('EXECUTOR_ADDR has no contract code');
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('wallet is not executor owner');
    if (isPaused && CFG.live) throw new Error('executor is paused; run npm run unpause after review');
    if (isPaused) console.warn('WARNING: executor is paused (monitoring only)');
    if (contractMax < CFG.maxSize && CFG.live) throw new Error(`executor maxTradeSize ${formatEther(contractMax)} is below MAX_SIZE_ETH`);
    if (contractMax < CFG.maxSize) console.warn(`WARNING: executor maxTradeSize ${formatEther(contractMax)} is below MAX_SIZE_ETH`);
    const checked = await Promise.all(markets.map(async (m) => ({ ...m, pools: (await Promise.all(m.pools.map(async (p) =>
      (await executor.allowedPools(p.id).catch(() => false)) ? p : null))).filter(Boolean) })));
    markets = checked.filter(m => m.pools.length);
    if (!markets.length) console.warn('WARNING: no executor-allowlisted markets; discovery listener only');
    const capital = await execProvider.getBalance(CFG.executor);
    if (capital < CFG.minSize && CFG.live && markets.length) throw new Error(`executor balance ${formatEther(capital)} is below MIN_SIZE_ETH`);
    if (capital < CFG.minSize) console.warn(`WARNING: executor balance ${formatEther(capital)} is below MIN_SIZE_ETH`);
  }

  let gasPolicy = feeOverrides(await execProvider.getFeeData(), CFG.gasUnits, CFG.gasBufferBps);
  const latency = createLatencyRecorder();

  console.log(`\nRobinFun<->UniV4 arb | ${CFG.live ? 'LIVE' : 'DRY-RUN'} | ${executor ? 'ATOMIC' : 'MONITOR'} | ${CFG.watchlist ? 'WATCHLIST' : 'single'}`);
  console.log(`wallet: ${wallet ? wallet.address : '(monitor only)'}`);
  console.log(`markets: ${markets.map(m => `${m.symbol}(${m.pools.map(p => p.name).join('/')})`).join(', ')}`);
  console.log(`gate >= ${CFG.minProfitBps} bps | size [${formatEther(CFG.minSize)}, ${formatEther(CFG.maxSize)}] ETH\n`);

  const v4Sell = (tok, key) => quoter.quoteExactInputSingle.staticCall([keyTuple(key), false, tok, '0x']).then(r => r[0]).catch(() => 0n);
  const v4Buy  = (eth, key) => quoter.quoteExactInputSingle.staticCall([keyTuple(key), true, eth, '0x']).then(r => r[0]).catch(() => 0n);

  async function netA(m, ethIn) { // buy curve -> sell best V4 pool
    const tok = await curve.quoteBuy(m.token, ethIn).catch(() => 0n);
    if (!tok) return { net: -ethIn, tok: 0n, back: 0n, pool: null };
    const conservativeTok = bpsDown(tok, CFG.slippageBps);
    const backs = await Promise.all(m.pools.map(p => v4Sell(conservativeTok, p.key)));
    let bi = 0; for (let i = 1; i < backs.length; i++) if (backs[i] > backs[bi]) bi = i;
    return { net: backs[bi] - ethIn - gasPolicy.maxGasCost, tok, back: backs[bi], pool: m.pools[bi], gasCost: gasPolicy.maxGasCost, txOverrides: gasPolicy.overrides };
  }
  async function netB(m, ethIn) { // buy best V4 pool -> sell curve
    const toks = await Promise.all(m.pools.map(p => v4Buy(ethIn, p.key)));
    let bi = 0; for (let i = 1; i < toks.length; i++) if (toks[i] > toks[bi]) bi = i;
    const tok = toks[bi];
    if (!tok) return { net: -ethIn, tok: 0n, back: 0n, pool: null };
    const back = await curve.quoteSell(m.token, bpsDown(tok, CFG.slippageBps)).catch(() => 0n);
    return { net: back - ethIn - gasPolicy.maxGasCost, tok, back, pool: m.pools[bi], gasCost: gasPolicy.maxGasCost, txOverrides: gasPolicy.overrides };
  }
  // geometric grid of probe sizes — deterministic, RPC-friendly (vs ternary storms)
  const gridSizes = buildGrid(CFG.minSize, CFG.maxSize, CFG.gridPoints);
  async function bestDir(m, fn) {
    const rs = await Promise.all(gridSizes.map(s => fn(m, s).then(r => ({ size: s, ...r })).catch(() => null)));
    return rs.filter(Boolean).reduce((a, b) => (!a || b.net > a.net ? b : a), null);
  }
  async function scanMarket(m) {
    const [A, B] = await Promise.all([bestDir(m, netA), bestDir(m, netB)]);
    const a = { dir: 'A', tag: 'curve->V4', market: m, ...A };
    const b = { dir: 'B', tag: 'V4->curve', market: m, ...B };
    return (A && B) ? (a.net >= b.net ? a : b) : null;
  }
  async function scanAll() {
    const results = await Promise.all(markets.map(m => scanMarket(m).catch(() => null)));
    return results.filter(Boolean).sort((x, y) => (y.net > x.net ? 1 : -1));
  }

  async function execute(b) {
    const token = b.market.token;
    if (!executor) throw new Error('atomic executor unavailable');
    // Contract profit must cover desired net profit plus the transaction's maximum
    // possible gas charge. Explicit fee/gas limits make this a hard upper bound.
    const minProfit = (b.size * CFG.minProfitBps) / 10000n + b.gasCost;
    const minEth = b.size + minProfit;
    const minTok = bpsDown(b.tok, CFG.slippageBps);
    console.log(`  [atomic ${b.dir}] ${b.market.symbol} pool=${b.pool.name} size=${formatEther(b.size)}`);
    const tx = b.dir === 'A'
      ? await executor.curveToV4(token, b.size, minTok, keyTuple(b.pool.key), minEth, minProfit, b.txOverrides)
      : await executor.v4ToCurve(token, b.size, minTok, keyTuple(b.pool.key), minEth, minProfit, b.txOverrides);
    const rc = await tx.wait();
    console.log('  tx', rc.hash);
    notifyAtomic({ symbol: b.market.symbol, dir: b.dir, buyVenue: b.dir === 'A' ? 'curve' : `V4 ${b.pool.name}`, sellVenue: b.dir === 'A' ? `V4 ${b.pool.name}` : 'curve', sizeEth: b.size, receipt: rc, netEth: 0n }).catch(() => {});
  }

  let lastLog = 0;
  async function tickBody(trigger = 'poll') {
    const tickStartedAt = Date.now();
    gasPolicy = feeOverrides(await execProvider.getFeeData(), CFG.gasUnits, CFG.gasBufferBps);
    const all = await scanAll();
    if (!all.length) {
      if (trigger === 'poll' || trigger === 'boot') notifyNoMarkets(trigger).catch(() => {});
      return;
    }
    const b = all[0];
    const bps = b.size > 0n ? (b.net * 10000n) / b.size : 0n;
    if (trigger === 'sequencer') latency.record('scan', { scanMs: Date.now() - tickStartedAt, symbol: b.market.symbol, direction: b.dir, bps: bps.toString() });
    const line = `${new Date().toISOString()} [${trigger}] best=${b.market.symbol} ${b.tag}@${b.pool?.name} size=${formatEther(b.size)} net=${formatEther(b.net)} (${bps} bps)`;
    if (trigger === 'poll' || trigger === 'boot') {
      notifyPoll({ trigger, symbol: b.market.symbol, route: b.tag, pool: b.pool?.name,
        size: b.size, net: b.net, bps, gateBps: CFG.minProfitBps }).catch(() => {});
    }
    if (bps >= CFG.minProfitBps) {
      latency.record('opportunity', { trigger, symbol: b.market.symbol, direction: b.dir, bps: bps.toString(), netWei: b.net.toString(), sizeWei: b.size.toString(), scanMs: Date.now() - tickStartedAt });
      console.log('>>> OPPORTUNITY', line);
      if (!CFG.live || !wallet) { console.log('    (idle: dry-run/no wallet)'); return; }
      try {
        await execute(b);
      } catch (e) {
        console.log('    exec FAILED:', e.shortMessage || e.message);
        notifyError(`${b.market.symbol} ${b.tag}: ${e.shortMessage || e.message}`).catch(() => {});
      }
    } else if (Date.now() - lastLog > 15000 || trigger === 'swap') {
      lastLog = Date.now(); console.log('idle    ', line);
    }
  }
  const tick = serialRunner(tickBody, (e) => console.error('queued tick:', e));

  // resilience: never let a background poller rejection kill the bot
  provider.on('error', (e) => console.log('provider error (ignored):', e?.shortMessage || e?.message || e));
  let lastTransientAlert = 0;
  process.on('unhandledRejection', (e) => {
    const method = e?.payload?.method;
    const message = e?.shortMessage || e?.error?.message || e?.message || String(e);
    if (method === 'eth_getLogs' || /connection refused|temporarily unavailable|timeout/i.test(message)) {
      console.warn('transient RPC event error (will retry):', message);
      if (Date.now() - lastTransientAlert > 300000) {
        lastTransientAlert = Date.now();
        notifyError(`transient RPC event error: ${message}`).catch(() => {});
      }
      return;
    }
    console.error('unhandledRejection:', e);
    setImmediate(() => process.exit(1));
  });

  let sequencerFeed = null;
  let lastSequencerTriggerAt = 0;
  if (CFG.sequencerFeed && !CFG.once) {
    sequencerFeed = new SequencerFeedClient({
      maxLiveAgeMs: CFG.sequencerLiveMaxAgeMs,
      onBatch: (batch) => {
        const matched = batch.transactions.filter((tx) => tx.to && sequencerTargets.has(tx.to.toLowerCase()));
        latency.record('feed', {
          sequenceNumber: batch.lastSequenceNumber,
          messageCount: batch.messageCount,
          transactionCount: batch.transactions.length,
          matchedCount: matched.length,
          live: batch.live,
          messageAgeMs: batch.messageAgeMs,
          frameBytes: batch.frameBytes,
        });
        if (!batch.live) return;
        if (CFG.sequencerFilterMode === 'targets' && matched.length === 0) return;
        const now = Date.now();
        if (now - lastSequencerTriggerAt < CFG.sequencerTriggerMinMs) return;
        lastSequencerTriggerAt = now;
        latency.record('trigger', {
          sequenceNumber: batch.lastSequenceNumber,
          matched: matched.slice(0, 8).map((tx) => ({
            to: tx.to,
            selector: tx.selector,
            valueWei: tx.valueWei,
            txType: tx.txType,
          })),
        });
        tick('sequencer').catch((e) => console.error('sequencer tick:', e));
      },
      onStatus: (status) => {
        latency.record('feed-status', { type: status.type, error: status.error || null });
        if (status.type === 'connected') console.log('sequencer feed: connected');
        else if (status.type === 'disconnected') console.log('sequencer feed: disconnected; reconnecting');
        else if (status.type === 'error') console.warn('sequencer feed:', status.error);
      },
    });
    try { sequencerFeed.start(); }
    catch (e) { console.warn('sequencer feed disabled:', e.message); sequencerFeed = null; }
  }

  // event-driven: ONE subscription for all watched pools (topic1 = OR of poolIds)
  const swapTopic = topicId('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
  const watchedIds = [...new Set(markets.flatMap(m => m.pools.map(p => p.id)))];
  if (watchedIds.length) {
    try { provider.on({ address: V4.poolManager, topics: [swapTopic, watchedIds] }, () => tick('swap').catch(e => console.error('tick:', e))); }
    catch (e) { console.log('event sub failed, poll-only:', e?.message); }
  }

  // persist current markets back to watchlist.json (survives restart)
  function persistWatchlist() {
    if (!CFG.watchlist) return;
    try {
      const out = markets.map(m => ({ token: m.token, symbol: m.symbol,
        pools: m.pools.map(p => ({ id: p.id, feePct: Number(p.key.fee) / 1e6 * 100, key: p.key })) }));
      fs.writeFileSync(new URL('./watchlist.json', import.meta.url), JSON.stringify(out, null, 2));
    } catch {}
  }

  // REAL-TIME: watch for NEW native-ETH V4 pools of active-curve tokens and add them live
  const initTopic = topicId('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
  const coder = ABI_CODER;
  const knownPoolIds = new Set(watchedIds.map(x => x.toLowerCase()));
  async function onNewPool(log) {
    try {
      const poolId = log.topics[1];
      const poolIdLc = poolId.toLowerCase();
      if (knownPoolIds.has(poolIdLc)) return;
      // Reserve before the first await. Polling providers may deliver the same log
      // several times concurrently; marking it later allowed every callback to
      // pass the check and append/notify the same pool dozens of times.
      knownPoolIds.add(poolIdLc);
      const c0 = getAddress('0x' + log.topics[2].slice(26));
      if (BigInt(c0) !== 0n) return;                         // require native ETH currency0
      const c1 = getAddress('0x' + log.topics[3].slice(26));
      const [fee, tickSpacing, hooks] = coder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], log.data);
      if (BigInt(hooks) !== 0n || Number(fee) > 1_000_000 || Number(tickSpacing) <= 0) return;
      const cs = await curve.curves(c1).catch(() => null);   // token must be on an active, not-graduated curve
      if (!cs || !(cs.raiseTarget > 0n && cs.realEth < cs.raiseTarget)) return;
      const sym = await new Contract(c1, ['function symbol() view returns (string)'], provider).symbol().catch(() => '?');
      const key = { currency0: c0, currency1: c1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
      const pool = { name: (Number(fee) / 1e6 * 100) + '%', id: poolId, key };
      if (executor && !(await executor.allowedPools(poolId).catch(() => false))) {
        console.log(`NEW POOL PENDING ALLOWLIST: ${sym} @ ${pool.name} (${c1})`);
        await tg(`🛡️ <b>New pool pending approval</b>: ${sym} @ ${pool.name} — run npm run allow-pools after review`);
        return;
      }
      let m = markets.find(x => x.token.toLowerCase() === c1.toLowerCase());
      if (m) {
        if (!m.pools.some((p) => p.id.toLowerCase() === poolIdLc)) m.pools.push(pool);
      } else {
        m = { token: c1, symbol: sym, pools: [pool] }; markets.push(m);
        sequencerTargets.add(c1.toLowerCase());
      }
      provider.on({ address: V4.poolManager, topics: [swapTopic, poolId] }, () => tick('swap').catch(e => console.error('tick:', e)));
      persistWatchlist();
      console.log(`NEW POOL: ${sym} @ ${pool.name} (${c1})`);
      await tg(`🆕 <b>New token detected</b>: ${sym} @ ${pool.name} pool — now watching`);
      tick('newpool').catch(e => console.error('tick:', e));
    } catch { /* ignore malformed logs */ }
  }
  try { provider.on({ address: V4.poolManager, topics: [initTopic] }, (log) => onNewPool(log)); }
  catch (e) { console.log('init sub failed:', e?.message); }

  const mode = `${CFG.live ? 'LIVE' : 'DRY-RUN'}/${executor ? 'ATOMIC' : 'MONITOR'}`;
  console.log('telegram:', tgEnabled ? 'ON' : 'off');
  await notifyStartup(mode, markets);
  await tick('boot');
  if (CFG.once) {
    sequencerFeed?.stop();
    provider.removeAllListeners();
    provider.destroy();
    if (execProvider !== provider) execProvider.destroy();
    return;
  }
  const pollTimer = setInterval(() => tick('poll').catch(e => console.error('tick:', e)), CFG.pollMs);
  pollTimer.unref?.();
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => {
    sequencerFeed?.stop();
    clearInterval(pollTimer);
    provider.removeAllListeners();
    provider.destroy();
    if (execProvider !== provider) execProvider.destroy();
    process.exit(0);
  });
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
