// scanner.js — auto-discover every RH-style token that is BOTH live on a RobinFun
// curve AND has a liquid Uniswap V4 pool. Uses Multicall3 to stay fast. Writes
// watchlist.json (consumed by arb.js when WATCHLIST=1).
//
//   node scanner.js
//
// Method (no API, pure on-chain):
//  1. read all PoolManager `Initialize` events -> every V4 pool + PoolKey
//  2. keep pools with currency0 == native ETH; token = currency1
//  3. Multicall curves(token): keep tokens with an active, not-graduated curve
//  4. Multicall getLiquidity(poolId): keep pools with liquidity > 0

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Interface, AbiCoder, id as topicId, getAddress, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE, V4 } from './config.js';
import { tg, telegramEscape } from './telegram.js';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const coder = AbiCoder.defaultAbiCoder();
const CURVE_I = new Interface(['function curves(address) view returns (uint256 virtualEth,uint256 realEth,uint256 tokenReserve,uint256 raiseTarget,uint256 lpEth,uint256 tradingFeeBps)']);
const ERC20_I = new Interface(['function symbol() view returns (string)']);
const SV_I = new Interface(['function getLiquidity(bytes32) view returns (uint128)']);
const INIT_TOPIC = topicId('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const CACHE_PATH = new URL('./scanner-cache.json', import.meta.url);
const LOCK_PATH = new URL('./scanner.lock', import.meta.url);
const CHAIN_ID = 4663;
let lockHeld = false;

function envInt(name, fallback, min, max) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`);
  return n;
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (value.version !== 1 || value.chainId !== CHAIN_ID ||
        value.poolManager?.toLowerCase() !== V4.poolManager.toLowerCase() ||
        !Number.isSafeInteger(value.lastScannedBlock) || !Array.isArray(value.pools)) return null;
    return value;
  } catch { return null; }
}

function saveCache(lastScannedBlock, pools) {
  const tmp = new URL('./scanner-cache.json.tmp', import.meta.url);
  fs.writeFileSync(tmp, JSON.stringify({
    version: 1, chainId: CHAIN_ID, poolManager: V4.poolManager,
    lastScannedBlock, updatedAt: new Date().toISOString(), pools,
  }));
  fs.renameSync(tmp, CACHE_PATH);
}

function acquireLock() {
  const staleMs = envInt('SCAN_LOCK_STALE_MS', 1800000, 60000, 86400000);
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    lockHeld = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    if (age > staleMs) {
      fs.unlinkSync(LOCK_PATH);
      return acquireLock();
    }
    throw new Error(`scanner already running (lock age ${Math.round(age / 1000)}s)`);
  }
}

function releaseLock() {
  if (!lockHeld) return;
  try { fs.unlinkSync(LOCK_PATH); } catch {}
  lockHeld = false;
}
process.on('exit', releaseLock);

async function getLogsChunked(provider, filter, from, to, step) {
  const out = [];
  if (from > to) return out;
  for (let s = from; s <= to; s += step) {
    const e = Math.min(s + step - 1, to);
    process.stdout.write(`\r  logs ${s}-${e} / ${to}   `);
    try { out.push(...await provider.getLogs({ ...filter, fromBlock: s, toBlock: e })); }
    catch (err) {
      if (e > s) { const m = (s + e) >> 1;
        out.push(...await getLogsChunked(provider, filter, s, m, m - s + 1));
        out.push(...await getLogsChunked(provider, filter, m + 1, e, e - m));
      } else throw err;
    }
  }
  process.stdout.write('\n');
  return out;
}

async function main() {
  acquireLock();
  let previous = [];
  try {
    if (fs.existsSync('watchlist.json')) previous = JSON.parse(fs.readFileSync('watchlist.json', 'utf8'));
  } catch { previous = []; }
  // Historical eth_getLogs often has different limits from trading RPC calls.
  // Use a dedicated SCAN_RPC_URL when provided; otherwise use the built-in pinned
  // public provider instead of consuming/stalling the private execution endpoint.
  const provider = await makeProvider({ rpcUrl: process.env.SCAN_RPC_URL || null });
  const mc = new Contract(MULTICALL3,
    ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])'],
    provider);
  const multicall = async (calls, size = 400) => {
    const res = [];
    for (let i = 0; i < calls.length; i += size) {
      const chunk = calls.slice(i, i + size).map(c => ({ target: c.target, allowFailure: true, callData: c.callData }));
      res.push(...await mc.aggregate3(chunk));
    }
    return res;
  };

  const head = await provider.getBlockNumber();
  const confirmations = envInt('SCAN_CONFIRMATIONS', 12, 0, 10000);
  const overlap = envInt('SCAN_REORG_OVERLAP', 64, 0, 10000);
  const chunk = envInt('SCAN_BLOCK_CHUNK', 1000000, 1000, 2000000);
  const safeHead = Math.max(0, head - confirmations);
  const cache = process.env.SCAN_FULL === '1' ? null : loadCache();
  const configuredFrom = envInt('SCAN_FROM_BLOCK', 0, 0, safeHead);
  const fromBlock = cache ? Math.max(configuredFrom, cache.lastScannedBlock + 1 - overlap) : configuredFrom;
  console.log('head', head, '| finalized', safeHead, '| scanning V4 Initialize events', `${fromBlock}-${safeHead}`);
  if (cache) console.log(`cache: ${cache.pools.length} pools through block ${cache.lastScannedBlock}`);
  else console.log('cache: cold scan (first run only)');
  const raw = await getLogsChunked(provider, { address: V4.poolManager, topics: [INIT_TOPIC] }, fromBlock, safeHead, chunk);
  console.log('new/overlap Initialize events:', raw.length);

  // decode + keep native-ETH pools
  // Drop the overlapped tail from cache before re-reading it, so a short chain
  // reorg cannot leave orphaned Initialize events permanently cached.
  const cachedPools = (cache?.pools || []).filter((p) =>
    !Number.isSafeInteger(p.blockNumber) || p.blockNumber < fromBlock);
  const poolMap = new Map(cachedPools.map((p) => [p.id.toLowerCase(), p]));
  for (const lg of raw) {
    const c0 = getAddress('0x' + lg.topics[2].slice(26));
    if (BigInt(c0) !== 0n) continue;
    const c1 = getAddress('0x' + lg.topics[3].slice(26));
    const [fee, tickSpacing, hooks] = coder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], lg.data);
    if (BigInt(hooks) !== 0n || Number(fee) > 1_000_000 || Number(tickSpacing) <= 0) continue;
    const p = { id: lg.topics[1], blockNumber: lg.blockNumber, currency0: c0, currency1: c1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
    poolMap.set(p.id.toLowerCase(), p);
  }
  const pools = [...poolMap.values()];
  saveCache(safeHead, pools);
  console.log('cached native-ETH pools:', pools.length);
  const tokens = [...new Set(pools.map(p => p.currency1.toLowerCase()))];
  console.log(`native-ETH pools: ${pools.length} across ${tokens.length} tokens`);

  // 1) which tokens have an active, not-graduated curve?
  console.log('multicall curves()...');
  const curveRes = await multicall(tokens.map(t => ({ target: CURVE.address, callData: CURVE_I.encodeFunctionData('curves', [getAddress(t)]) })));
  const active = new Map(); // tokenLc -> {realEth, raiseTarget}
  tokens.forEach((t, i) => {
    const r = curveRes[i];
    if (!r.success || r.returnData === '0x') return;
    try {
      const d = CURVE_I.decodeFunctionResult('curves', r.returnData);
      if (d.raiseTarget > 0n && d.realEth < d.raiseTarget) active.set(t, { realEth: d.realEth, raiseTarget: d.raiseTarget });
    } catch {}
  });
  console.log('tokens with active curve:', active.size);

  // 2) which of their pools have liquidity?
  const candPools = pools.filter(p => active.has(p.currency1.toLowerCase()));
  console.log('multicall getLiquidity()...');
  const liqRes = await multicall(candPools.map(p => ({ target: V4.stateView, callData: SV_I.encodeFunctionData('getLiquidity', [p.id]) })));
  candPools.forEach((p, i) => {
    const r = liqRes[i];
    p.liquidity = 0n;
    if (r.success && r.returnData !== '0x') { try { p.liquidity = SV_I.decodeFunctionResult('getLiquidity', r.returnData)[0]; } catch {} }
  });
  const livePools = candPools.filter(p => p.liquidity > 0n);

  // 3) symbols
  const liveTokens = [...new Set(livePools.map(p => p.currency1.toLowerCase()))];
  const symRes = await multicall(liveTokens.map(t => ({ target: getAddress(t), callData: ERC20_I.encodeFunctionData('symbol') })));
  const symbols = new Map();
  liveTokens.forEach((t, i) => { let s = '?'; try { if (symRes[i].success) s = ERC20_I.decodeFunctionResult('symbol', symRes[i].returnData)[0]; } catch {} symbols.set(t, s); });

  // build watchlist
  const byToken = new Map();
  for (const p of livePools) {
    const t = p.currency1.toLowerCase();
    if (!byToken.has(t)) byToken.set(t, []);
    byToken.get(t).push(p);
  }
  const watchlist = [];
  for (const [t, tPools] of byToken) {
    const a = active.get(t);
    watchlist.push({
      token: getAddress(t), symbol: symbols.get(t) || '?',
      graduationPct: Number(a.realEth * 10000n / a.raiseTarget) / 100,
      pools: tPools.sort((x, y) => (y.liquidity > x.liquidity ? 1 : -1)).map(p => ({
        id: p.id, fee: p.fee, feePct: p.fee / 1e6 * 100, tickSpacing: p.tickSpacing, hooks: p.hooks,
        liquidity: p.liquidity.toString(),
        key: { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks },
      })),
    });
  }
  watchlist.sort((a, b) => b.pools.length - a.pools.length || b.graduationPct - a.graduationPct);
  fs.writeFileSync('watchlist.json', JSON.stringify(watchlist, null, 2));

  console.log(`\narbitrable tokens (active curve + liquid V4 pool): ${watchlist.length}`);
  for (const w of watchlist) console.log(`  ${w.symbol.padEnd(12)} ${w.token}  grad ${w.graduationPct}%  pools ${w.pools.map(p => p.feePct + '%').join(',')}`);
  console.log('\nwrote watchlist.json');
  if (process.env.TELEGRAM_SCAN_ALERTS !== '0') {
    const oldPools = new Map(previous.flatMap((w) => (w.pools || []).map((p) => [String(p.id).toLowerCase(), `${w.symbol}@${p.feePct}%`])));
    const newPools = new Map(watchlist.flatMap((w) => (w.pools || []).map((p) => [String(p.id).toLowerCase(), `${w.symbol}@${p.feePct}%`])));
    const added = [...newPools].filter(([id]) => !oldPools.has(id)).map(([, name]) => name);
    const removed = [...oldPools].filter(([id]) => !newPools.has(id)).map(([, name]) => name);
    const intervalMin = Math.round(Number(process.env.SCAN_INTERVAL_MS || 21600000) / 60000);
    await tg([
      `🔎 <b>Scheduled scan complete</b>`,
      `Head: <code>${head}</code> • cached pools: ${pools.length}`,
      `Active curves: ${active.size} • arbitrable markets: ${watchlist.length}`,
      added.length ? `✅ Added: ${added.map(telegramEscape).join(', ')}` : `Added: none`,
      removed.length ? `➖ Removed: ${removed.map(telegramEscape).join(', ')}` : `Removed: none`,
      `Next scheduled scan: ~${intervalMin} minutes`,
    ].join('\n'));
  }
  releaseLock();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('FATAL', e.shortMessage || e.message);
  await tg(`❌ <b>Scanner failed</b>\n<code>${telegramEscape(e.shortMessage || e.message).slice(0, 500)}</code>`);
  process.exit(1);
});
