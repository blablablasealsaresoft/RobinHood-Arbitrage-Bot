// Owner-only path checks. POSIX uses uid + mode bits. Windows Unix modes are
// not authoritative (chmod is a no-op; uid is 0), so NTFS ACLs are inspected
// instead. Extra group/world trustees remain a hard failure on both platforms.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SYSTEM = new Set(['nt authority\\system', 'system']);
const WORLD = [
  /^everyone$/i,
  /^authenticated users$/i,
  /^builtin\\users$/i,
  /^users$/i,
  /^guests$/i,
  /^builtin\\guests$/i,
  /^s-1-1-0$/i,
  /^s-1-5-11$/i,
  /^s-1-5-32-545$/i,
  /^s-1-5-32-546$/i,
];

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}

function windowsAccount() {
  const user = os.userInfo().username;
  if (!user) throw new Error('windows user required');
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

function windowsOwnerNames() {
  const account = windowsAccount();
  const names = new Set([account.toLowerCase(), os.userInfo().username.toLowerCase()]);
  try {
    const sid = run('whoami', ['/user']).match(/S-1-5-[0-9-]+/);
    if (sid) names.add(sid[0].toLowerCase());
  } catch { /* identity names are still sufficient when whoami is unavailable */ }
  return { account, names };
}

function parseIcacls(target) {
  const out = run('icacls', [target]);
  const prefix = path.resolve(target).replaceAll('/', '\\').toLowerCase();
  const aces = [];
  for (const raw of out.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^successfully processed/i.test(line)) continue;
    if (line.toLowerCase().startsWith(prefix)) line = line.slice(prefix.length).trim();
    const match = line.match(/^(.+):\((.*)\)$/);
    if (match) aces.push({ identity: match[1], flags: match[2] });
  }
  return aces;
}

function isWorldIdentity(identity) {
  return WORLD.some((pattern) => pattern.test(identity));
}

function assertWindowsOwnerOnly(target, message) {
  const { names } = windowsOwnerNames();
  const aces = parseIcacls(target);
  if (!aces.length) throw new Error(message);
  let ownerAllow = false;
  for (const ace of aces) {
    const identity = ace.identity.toLowerCase();
    const flags = ace.flags.toLowerCase();
    if (/\bdeny\b/.test(flags) || /(^|,)n($|,)/.test(flags)) continue;
    if (SYSTEM.has(identity)) continue;
    if (isWorldIdentity(identity) || ![...names].some((name) => identity === name || identity.endsWith(`\\${name}`))) {
      throw new Error(message);
    }
    ownerAllow = true;
  }
  if (!ownerAllow) throw new Error(message);
}

export function applyOwnedPrivate(target, { kind } = {}) {
  if (kind !== 'file' && kind !== 'directory') throw new Error('owned-private kind required');
  const resolved = path.resolve(target);
  if (process.platform !== 'win32') {
    fs.chmodSync(resolved, kind === 'file' ? 0o600 : 0o700);
    return;
  }
  const { account, names } = windowsOwnerNames();
  run('icacls', [resolved, '/inheritance:r']);
  for (const ace of parseIcacls(resolved)) {
    const identity = ace.identity.toLowerCase();
    if ([...names].some((name) => identity === name || identity.endsWith(`\\${name}`))) continue;
    run('icacls', [resolved, '/remove', ace.identity]);
  }
  run('icacls', [resolved, '/grant:r', kind === 'directory' ? `${account}:(OI)(CI)(F)` : `${account}:(F)`]);
}

export function assertOwnedPrivate(target, {
  kind,
  posixExactMode,
  posixForbidGroupWorld = false,
  message,
} = {}) {
  if (typeof message !== 'string' || !message) throw new Error('owned-private message required');
  const resolved = path.resolve(target);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(message);
  if (kind === 'file' && !stat.isFile()) throw new Error(message);
  if (kind === 'directory' && !stat.isDirectory()) throw new Error(message);
  if (kind === 'socket' && !stat.isSocket()) throw new Error(message);
  if (process.platform === 'win32') {
    assertWindowsOwnerOnly(resolved, message);
    return;
  }
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) throw new Error(message);
  if (posixExactMode != null && (stat.mode & 0o777) !== posixExactMode) throw new Error(message);
  if (posixForbidGroupWorld && (stat.mode & 0o077)) throw new Error(message);
}
