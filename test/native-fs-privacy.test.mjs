import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyOwnedPrivate, assertOwnedPrivate } from '../native/fs-privacy.mjs';

const message = 'private owned runtime directory required';
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arb-privacy-'));

function makeWorldReadable(target) {
  if (process.platform === 'win32') {
    execFileSync('icacls', [target, '/grant', 'Everyone:(R)'], { encoding: 'utf8', windowsHide: true });
  } else {
    fs.chmodSync(target, 0o755);
  }
}

test('owner-only directory is accepted and a world-readable directory is rejected', () => {
  const dir = directory();
  try {
    makeWorldReadable(dir);
    assert.throws(() => assertOwnedPrivate(dir, { kind: 'directory', posixForbidGroupWorld: true, posixExactMode: 0o700, message }), /private.*directory/);
    applyOwnedPrivate(dir, { kind: 'directory' });
    assertOwnedPrivate(dir, { kind: 'directory', posixForbidGroupWorld: true, posixExactMode: 0o700, message });
    makeWorldReadable(dir);
    assert.throws(() => assertOwnedPrivate(dir, { kind: 'directory', posixForbidGroupWorld: true, posixExactMode: 0o700, message }), /private.*directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owner-only file is accepted and a group-readable file is rejected', () => {
  const dir = directory();
  const file = path.join(dir, 'manifest.json');
  try {
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    assert.throws(() => assertOwnedPrivate(file, { kind: 'file', posixExactMode: 0o600, message: 'execution manifest must be owned regular 0600 file' }), /0600/);
    applyOwnedPrivate(file, { kind: 'file' });
    assertOwnedPrivate(file, { kind: 'file', posixExactMode: 0o600, message: 'execution manifest must be owned regular 0600 file' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('symlink is never treated as an owned private file', () => {
  const dir = directory();
  const file = path.join(dir, 'real.json');
  const link = path.join(dir, 'link.json');
  try {
    fs.writeFileSync(file, '{}');
    applyOwnedPrivate(file, { kind: 'file' });
    fs.symlinkSync(file, link);
    assert.throws(() => assertOwnedPrivate(link, { kind: 'file', posixExactMode: 0o600, message: 'execution manifest must be owned regular 0600 file' }), /0600/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
