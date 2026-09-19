import 'dotenv/config';
import { Contract, Wallet } from 'ethers';
import { makeProvider } from './provider.js';
import { tg, telegramEscape } from './telegram.js';

const ABI = [
  'function owner() view returns(address)',
  'function paused() view returns(bool)',
  'function setPaused(bool)',
];

async function main() {
  const executorAddress = process.env.SEQUENCER_EXECUTOR_ADDR || process.env.EXECUTOR_ADDR;
  if (!process.env.PRIVATE_KEY || !executorAddress) throw new Error('set PRIVATE_KEY and SEQUENCER_EXECUTOR_ADDR');
  const action = process.argv[2];
  if (!['pause', 'unpause'].includes(action)) throw new Error('usage: node executor-admin.js pause|unpause');
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const exec = new Contract(executorAddress, ABI, wallet);
  if ((await exec.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error('wallet is not executor owner');
  const value = action === 'pause';
  if ((await exec.paused()) === value) {
    console.log(`executor already ${action}d`);
    await tg(`ℹ️ <b>Executor already ${value ? 'paused' : 'unpaused'}</b>`);
    return;
  }
  const tx = await exec.setPaused(value);
  await tx.wait();
  console.log(`executor ${action}d:`, tx.hash);
  await tg(`${value ? '⏸️' : '▶️'} <b>Executor ${value ? 'paused' : 'unpaused'}</b>\nTx: <code>${tx.hash}</code>`);
}

main().catch(async (e) => {
  console.error('FAILED:', e.shortMessage || e.message);
  await tg(`❌ <b>Executor admin failed</b>\n<code>${telegramEscape(String(e.shortMessage || e.message).slice(0, 300))}</code>`);
  process.exit(1);
});
