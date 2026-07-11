// Explicitly approve reviewed watchlist pools on the executor. This is never run
// automatically by the trading process: discovery and permission stay separate.
import 'dotenv/config';
import fs from 'node:fs';
import { AbiCoder, Contract, Wallet, getAddress, keccak256 } from 'ethers';
import { makeProvider } from './provider.js';
import { tg, telegramEscape } from './telegram.js';

const ABI = [
  'function owner() view returns(address)',
  'function allowedPools(bytes32) view returns(bool)',
  'function approved(address) view returns(bool)',
  'function approve(address token)',
  'function setPoolAllowed((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool allowed)',
];
const ZERO = '0x0000000000000000000000000000000000000000';
const tuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const coder = AbiCoder.defaultAbiCoder();

function reviewedPools() {
  if (!fs.existsSync(new URL('./watchlist.json', import.meta.url))) {
    throw new Error('watchlist.json missing; run npm run scan and review it first');
  }
  const wl = JSON.parse(fs.readFileSync(new URL('./watchlist.json', import.meta.url)));
  return wl.flatMap((m) => m.pools.map((p) => ({ name: `${m.symbol}@${p.feePct}%`, id: p.id, key: p.key })));
}

async function main() {
  if (!process.env.PRIVATE_KEY || !process.env.EXECUTOR_ADDR) throw new Error('set PRIVATE_KEY and EXECUTOR_ADDR');
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const exec = new Contract(process.env.EXECUTOR_ADDR, ABI, wallet);
  if ((await exec.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error('wallet is not executor owner');

  const pools = reviewedPools();
  if (!pools.length) throw new Error('no pools found');
  const tokens = new Set();
  let configured = 0;
  let alreadyAllowed = 0;
  for (const pool of pools) {
    const k = pool.key;
    if (getAddress(k.currency0) !== ZERO || getAddress(k.hooks) !== ZERO ||
        !Number.isInteger(Number(k.fee)) || Number(k.fee) > 1_000_000 ||
        !Number.isInteger(Number(k.tickSpacing)) || Number(k.tickSpacing) <= 0) {
      console.log('SKIP unsafe pool (native currency0 and zero hooks required):', pool.name);
      continue;
    }
    const expected = keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], tuple(k)));
    if (expected.toLowerCase() !== String(pool.id).toLowerCase()) throw new Error(`PoolKey/id mismatch: ${pool.name}`);
    tokens.add(getAddress(k.currency1));
    if (await exec.allowedPools(expected)) {
      console.log('SKIP already allowed', pool.name, pool.id);
      alreadyAllowed++;
      continue;
    }
    console.log('ALLOW', pool.name, pool.id);
    await (await exec.setPoolAllowed(tuple(k), true)).wait();
    configured++;
  }
  for (const token of tokens) {
    if (!(await exec.approved(token))) {
      console.log('APPROVE token', token);
      await (await exec.approve(token)).wait();
    }
  }
  await tg(`✅ <b>Pool allowlist complete</b>\nNew pools: ${configured}\nAlready allowed: ${alreadyAllowed}\nTokens checked: ${tokens.size}\n${pools.slice(0, 10).map((p) => telegramEscape(p.name)).join(', ')}`);
  console.log(`configured ${configured} new pools; skipped ${alreadyAllowed} already allowed; checked ${tokens.size} tokens`);
}

main().catch(async (e) => {
  console.error('FAILED:', e.shortMessage || e.message);
  await tg(`❌ <b>Pool allowlist failed</b>\n<code>${telegramEscape(String(e.shortMessage || e.message).slice(0, 300))}</code>`);
  process.exit(1);
});
