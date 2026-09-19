import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RouteBook } from '../native/core.mjs';
import { NITRO_REVISION, validateExecutionManifest, loadExecutionManifest, assertExecutionSocket } from '../native/execution-provenance.mjs';
const a = n => '0x' + n.toString(16).padStart(40, '0');
const h = n => '0x' + n.toString(16).padStart(64, '0');
function fixture() {
  const config = JSON.parse(fs.readFileSync('native/example.json', 'utf8'));
  config.receiptFeeModel = 'gasUsed-times-effectiveGasPrice-inclusive';
  config.wrappedNativeToken = a(1); config.transaction = { gasLimit: '100', maxFeePerGas: '10' };
  config.codeHashes = Object.fromEntries([1, 2, 10, 11, 20, 21].map(n => [a(n), h(n)]));
  const book = new RouteBook(config.pools, config.routes);
  const manifest = { schema: 1, chainId: 4663, nitroRevision: NITRO_REVISION, receiptFeeModel: config.receiptFeeModel,
    relayer: a(99), socketPath: '/tmp/synthetic/not-live.sock', codeHashes: config.codeHashes,
    pools: config.pools.map(p => ({ id: p.id, kind: p.kind, address: p.pair, fields: [] })),
    gasBudget: { settlementToken: a(1), gasLimit: '100', maxFeePerGas: '10', loseRaceBps: 2000, wrappedNativeReviewed: true } };
  const approve = () => { const raw = Buffer.from(JSON.stringify(manifest)); config.producerManifestHash = '0x' + createHash('sha256').update(raw).digest('hex'); return raw; };
  return { config, book, manifest, approve };
}
const costs = guard => ({ type: 'costs', executionSource: guard.source, entries: [{ settlementToken: a(1), settlementUnitsPerWeiNumerator: '1', settlementUnitsPerWeiDenominator: '1', successGasWei: '1000', revertGasWei: '1000', loseRaceBps: '2000', validUntilBlock: '102' }] });
const block = guard => ({ type: 'block', executionSource: guard.source, blockNumber: '101', stateRoot: h(1000) });

test('manifest identity binds relayer, reviewed layout bytes and every runtime code pin', () => {
  const f = fixture(), raw = f.approve(); const guard = validateExecutionManifest(raw, f.config, f.book);
  guard.assertRelayer(a(99)); assert.throws(() => guard.assertRelayer(a(98)), /relayer/);
  assert.throws(() => validateExecutionManifest(Buffer.concat([raw, Buffer.from('\n')]), f.config, f.book), /hash mismatch/);
  assert.equal(guard.source.revision, NITRO_REVISION);
});
test('approved bytes still cannot alter chain, pools, code, fee or signed gas policy', () => {
  const changes = [
    f => { f.manifest.chainId = 1; }, f => { f.manifest.nitroRevision = 'main'; }, f => { f.manifest.pools.pop(); },
    f => { f.manifest.pools[0].address = a(22); }, f => { f.manifest.receiptFeeModel = 'guessed'; },
    f => { f.manifest.codeHashes = {}; }, f => { f.manifest.codeHashes = { ...f.manifest.codeHashes, [a(1)]: h(999) }; },
    f => { f.manifest.gasBudget.gasLimit = '99'; }, f => { f.manifest.gasBudget.maxFeePerGas = '9'; },
    f => { f.manifest.gasBudget.wrappedNativeReviewed = false; }, f => { f.manifest.gasBudget.loseRaceBps = 10001; },
    f => { f.manifest.gasBudget.settlementToken = a(2); }, f => { delete f.manifest.gasBudget; },
  ];
  for (const change of changes) { const f = fixture(); change(f); const raw = f.approve(); assert.throws(() => validateExecutionManifest(raw, f.config, f.book)); }
});
test('every live message requires pinned source, not just complete=true', () => {
  const f = fixture(), guard = validateExecutionManifest(f.approve(), f.config, f.book);
  for (const type of ['snapshot', 'block', 'receipt', 'invalidate', 'costs']) {
    assert.throws(() => guard.check({ type, complete: true }), /provenance/);
    assert.throws(() => guard.check({ type, executionSource: { ...guard.source, manifestHash: h(1) } }), /provenance/);
  }
});
test('each executed block needs fresh conservative WETH costs before state and receipts', () => {
  const f = fixture(), guard = validateExecutionManifest(f.approve(), f.config, f.book);
  assert.throws(() => guard.check(block(guard)), /fresh cost/);
  guard.check(costs(guard)); assert.throws(() => guard.check({ type: 'receipt', executionSource: guard.source }), /before executed/);
  guard.check(block(guard)); guard.check({ type: 'receipt', executionSource: guard.source });
  assert.throws(() => guard.check(block(guard)), /fresh cost/);
});
test('optimistic fee caches, arbitrary FX and stale budget horizons are rejected', () => {
  for (const field of ['successGasWei', 'revertGasWei', 'settlementUnitsPerWeiNumerator', 'settlementUnitsPerWeiDenominator', 'loseRaceBps']) {
    const f = fixture(), guard = validateExecutionManifest(f.approve(), f.config, f.book), frame = costs(guard);
    frame.entries[0][field] = '2'; assert.throws(() => guard.check(frame), /policy mismatch/);
  }
  const f = fixture(), guard = validateExecutionManifest(f.approve(), f.config, f.book), frame = costs(guard);
  frame.entries[0].validUntilBlock = '103'; guard.check(frame); assert.throws(() => guard.check(block(guard)), /fresh cost/);
});
test('reorg resets unpaired cost frames and zero/missing state roots are rejected', () => {
  const f = fixture(), guard = validateExecutionManifest(f.approve(), f.config, f.book);
  guard.check(costs(guard)); assert.throws(() => guard.check(costs(guard)), /without following/);
  guard.check({ type: 'invalidate', executionSource: guard.source });
  guard.check(costs(guard)); assert.throws(() => guard.check({ ...block(guard), stateRoot: h(0) }), /nonzero/);
});
test('live manifest loader requires owned 0600 regular file', () => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  try {
    f.config.executionManifest = path.join(dir, 'manifest.json'); fs.writeFileSync(f.config.executionManifest, f.approve(), { mode: 0o644 });
    assert.throws(() => loadExecutionManifest(f.config, f.book), /0600/);
    fs.chmodSync(f.config.executionManifest, 0o600); assert.ok(loadExecutionManifest(f.config, f.book));
    const link = path.join(dir, 'link'); fs.symlinkSync(f.config.executionManifest, link); f.config.executionManifest = link;
    assert.throws(() => loadExecutionManifest(f.config, f.book), /0600/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('live socket is bound to reviewed path and owned private directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-socket-')), sock = path.join(dir, 'export.sock');
  try {
    fs.chmodSync(dir, 0o700); assertExecutionSocket(sock, sock);
    assert.throws(() => assertExecutionSocket(sock, sock + 'x'), /differs/);
    fs.chmodSync(dir, 0o755); assert.throws(() => assertExecutionSocket(sock, sock), /0700/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V4 tick-window producer and consumer must agree on every coverage bound', () => {
  const source = JSON.parse(fs.readFileSync('test/fixtures/v4-window-bridge.json', 'utf8'));
  const prepare = () => {
    const config = structuredClone(source.consumerConfig);
    config.receiptFeeModel = 'gasUsed-times-effectiveGasPrice-inclusive';
    config.wrappedNativeToken = config.routes[0].settlementToken;
    config.transaction = { gasLimit: '100', maxFeePerGas: '10' };
    const book = new RouteBook(config.pools, config.routes);
    const pins = Object.fromEntries([...new Set([...book.pools.values()].flatMap(p => [p.pair, p.adapter, p.token0, p.token1, p.tickWindow?.lens].filter(Boolean)))].map((a, i) => [a, h(i + 1)]));
    config.codeHashes = pins;
    const manifest = { schema: 1, chainId: 4663, nitroRevision: NITRO_REVISION,
      receiptFeeModel: config.receiptFeeModel, relayer: a(99), socketPath: '/tmp/synthetic/not-live.sock', codeHashes: pins,
      pools: [...book.pools.values()].map(p => ({ id: p.id, kind: p.kind, address: p.pair, ...(p.poolKeyHash ? { poolKeyHash: p.poolKeyHash } : {}), ...(p.tickWindow ? { tickWindow: { tickSpacing: p.tickWindow.tickSpacing, minWord: p.tickWindow.minWord, maxWord: p.tickWindow.maxWord } } : {}) })),
      gasBudget: { settlementToken: config.wrappedNativeToken, gasLimit: '100', maxFeePerGas: '10', loseRaceBps: 0, wrappedNativeReviewed: true } };
    const check = () => { const raw = Buffer.from(JSON.stringify(manifest)); config.producerManifestHash = '0x' + createHash('sha256').update(raw).digest('hex'); return validateExecutionManifest(raw, config, book); };
    return { config, book, manifest, check };
  };
  assert.ok(prepare().check());
  for (const field of ['tickSpacing', 'minWord', 'maxWord']) {
    const f = prepare(); f.manifest.pools[0].tickWindow[field]++;
    assert.throws(f.check, /tick-window bounds/);
  }
  const missing = prepare(); delete missing.manifest.pools[0].tickWindow;
  assert.throws(missing.check, /tick-window coverage/);
  const unpinned = prepare(), lens = unpinned.book.pools.values().next().value.tickWindow.lens;
  delete unpinned.config.codeHashes[lens]; delete unpinned.manifest.codeHashes[lens];
  assert.throws(unpinned.check, /tick lens missing code pin/);
});
