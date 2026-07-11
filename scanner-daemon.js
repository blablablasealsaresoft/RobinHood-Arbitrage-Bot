// Long-running scheduler for PM2. Runs the read-only incremental scanner at
// startup, then at a fixed interval. Trading permissions remain manual.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.join(ROOT, 'scanner.js');

function envMs(name, fallback, min) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be >= ${min}`);
  return value;
}

const INTERVAL = envMs('SCAN_INTERVAL_MS', 6 * 60 * 60 * 1000, 60_000);
const RETRY = envMs('SCAN_RETRY_MS', 10 * 60 * 1000, 30_000);
const ONCE = process.argv.includes('--once');
let stopping = false;
let child = null;

const wait = (ms) => new Promise((resolve) => {
  const finish = () => {
    clearTimeout(timer);
    process.removeListener('SIGINT', finish);
    process.removeListener('SIGTERM', finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);
});

function runScanner() {
  return new Promise((resolve) => {
    console.log(`[scanner-daemon] starting ${new Date().toISOString()}`);
    child = spawn(process.execPath, [SCANNER], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    child.once('error', (e) => { console.error('[scanner-daemon] spawn failed:', e); child = null; resolve(1); });
    child.once('exit', (code, signal) => {
      console.log(`[scanner-daemon] finished code=${code} signal=${signal || '-'} at ${new Date().toISOString()}`);
      child = null;
      resolve(code ?? 1);
    });
  });
}

function stop() {
  stopping = true;
  if (child && !child.killed) child.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

do {
  const code = await runScanner();
  if (ONCE || stopping) break;
  const delay = code === 0 ? INTERVAL : RETRY;
  console.log(`[scanner-daemon] next scan in ${Math.round(delay / 60000)} minutes`);
  await wait(delay);
} while (!stopping);
