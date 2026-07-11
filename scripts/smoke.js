// Read-only production smoke test: validates chain, dependency bytecode, curve
// quote, and both V4 quote directions. It never loads or uses a private key.
import 'dotenv/config';
import fs from 'node:fs';
import { Contract, formatEther, parseEther } from 'ethers';
import { makeProvider } from '../provider.js';
import { CURVE_ABI, QUOTER_ABI, STATEVIEW_ABI } from '../abis.js';
import { CHAIN, CURVE, POOLS, TOKEN, V4 } from '../config.js';

const provider = await makeProvider();
const network = await provider.getNetwork();
if (Number(network.chainId) !== CHAIN.id) throw new Error(`wrong chain ${network.chainId}`);

for (const [name, address] of Object.entries({
  curve: CURVE.address,
  poolManager: V4.poolManager,
  universalRouter: V4.universalRouter,
  quoter: V4.quoter,
  permit2: V4.permit2,
  stateView: V4.stateView,
})) {
  if (await provider.getCode(address) === '0x') throw new Error(`${name} has no code at ${address}`);
}

const size = parseEther(process.env.MIN_SIZE_ETH || '0.002');
const curve = new Contract(CURVE.address, CURVE_ABI, provider);
const quoter = new Contract(V4.quoter, QUOTER_ABI, provider);
const stateView = new Contract(V4.stateView, STATEVIEW_ABI, provider);
const tuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const watchlistPath = new URL('../watchlist.json', import.meta.url);
const markets = fs.existsSync(watchlistPath)
  ? JSON.parse(fs.readFileSync(watchlistPath, 'utf8'))
  : [{ token: TOKEN.address, symbol: TOKEN.symbol, pools: POOLS }];
if (!markets.length) throw new Error('watchlist has no active curve + liquid V4 markets; wait for a new pool and run npm run scan');

let usableDirections = 0;
for (const market of markets) {
  const curveTokens = await curve.quoteBuy(market.token, size);
  if (curveTokens <= 0n) throw new Error(`${market.symbol} curve quoteBuy returned zero`);
  for (const pool of market.pools) {
    const label = `${market.symbol}@${pool.name || pool.feePct + '%'}`;
    const liquidity = await stateView.getLiquidity(pool.id);
    console.log(`${label}: liquidity ${liquidity}`);
    let sell = null, buy = null;
    try { sell = await quoter.quoteExactInputSingle.staticCall([tuple(pool.key), false, curveTokens, '0x']); }
    catch (e) { console.log(`${label}: token->ETH unavailable (${e.shortMessage || e.message})`); }
    try { buy = await quoter.quoteExactInputSingle.staticCall([tuple(pool.key), true, size, '0x']); }
    catch (e) { console.log(`${label}: ETH->token unavailable (${e.shortMessage || e.message})`); }
    if (sell?.[0] > 0n) usableDirections++;
    if (buy?.[0] > 0n) usableDirections++;
    if (sell?.[0] > 0n || buy?.[0] > 0n) {
      console.log(`${label}: curve->V4 ${sell?.[0] > 0n ? formatEther(sell[0]) + ' ETH' : 'n/a'} | V4 buy ${buy?.[0] > 0n ? formatEther(buy[0]) + ' tokens' : 'n/a'}`);
    }
  }
}
if (!usableDirections) throw new Error('all configured V4 pool directions are currently unavailable; run npm run scan and review config/watchlist');
console.log(`smoke: chain ${network.chainId}, dependencies OK, ${usableDirections} V4 directions executable`);
provider.destroy();
