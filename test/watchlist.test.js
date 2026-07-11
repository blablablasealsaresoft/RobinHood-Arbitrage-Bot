import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('scanner output, when present, is valid JSON array data', () => {
  const path = new URL('../watchlist.json', import.meta.url);
  if (!fs.existsSync(path)) return;
  const value = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(value));
});
