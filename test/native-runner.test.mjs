import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { frames } from '../native/runner.mjs';

test('framing handles split UTF-8/JSON and multiple lines', async () => {
  const bytes = Buffer.from('{"name":"é"}\n{"type":"block"}\n');
  const chunks = [...bytes].map(byte => Buffer.from([byte]));
  const found = [];
  for await (const frame of frames(Readable.from(chunks))) found.push(frame);
  assert.deepEqual(found, [{ name: 'é' }, { type: 'block' }]);
});
test('framing fails closed on oversized, malformed and truncated data', async () => {
  for (const text of ['{"oops":\n', '{}', '{"a":"xxxxxxxxxxxxxxxxxxxxx"}\n']) {
    await assert.rejects(async () => { for await (const frame of frames(Readable.from([text]), 20)) void frame; });
  }
});
test('dry CLI needs no key/provider and produces synthetic local opportunity', () => {
  const result = execFileSync(process.execPath, ['native/runner.mjs', '--config', 'native/example.json', '--replay', 'native/example.ndjson'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, LIVE: '1' } });
  const lines = result.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].mode, 'dry'); assert.equal(lines[0].txHash, null);
  assert.ok(BigInt(lines[0].grossProfit) > 0n); assert.equal(lines.at(-1).opportunities, 1);
});
test('live replay is refused before looking for secrets or network', () => {
  const result = spawnSync(process.execPath, ['native/runner.mjs', '--live', '--config', 'native/example.json', '--replay', 'native/example.ndjson'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /cannot use a replay/);
});
