// This binds a trusted local observer's identity and reviewed layout to the bot.
// It is NOT a Merkle proof or independent verification of Nitro consensus.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { address, hash32, uint } from './core.mjs';

export const NITRO_REVISION = 'a618155919315241665356fe60f3cd00d66d5e46';
const MAX_BYTES = 1_048_576;
const mapPins = entries => {
  const result = new Map();
  for (const [a, h] of Object.entries(entries || {})) {
    const key = address(a);
    if (result.has(key)) throw new Error('duplicate normalized code pin');
    result.set(key, hash32(h));
  }
  return result;
};

export function validateExecutionManifest(raw, config, book) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) throw new Error('invalid execution manifest size');
  const manifestHash = '0x' + createHash('sha256').update(raw).digest('hex');
  if (hash32(config.producerManifestHash) !== manifestHash) throw new Error('execution manifest hash mismatch');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.schema !== 1 || manifest.chainId !== 4663 || manifest.nitroRevision !== NITRO_REVISION) throw new Error('execution manifest schema/chain/revision mismatch');
  if (manifest.receiptFeeModel !== config.receiptFeeModel || config.receiptFeeModel !== 'gasUsed-times-effectiveGasPrice-inclusive') throw new Error('execution receipt fee model mismatch');
  if (!Array.isArray(manifest.pools) || manifest.pools.length !== book.pools.size) throw new Error('execution manifest pool coverage');
  const seen = new Set();
  for (const p of manifest.pools) {
    const pool = book.pools.get(p.id);
    if (!pool || seen.has(p.id) || pool.kind !== p.kind || pool.pair !== address(p.address)) throw new Error('execution pool identity mismatch');
    if (p.kind === 'v4' && hash32(p.poolKeyHash) !== pool.poolKeyHash) throw new Error('execution V4 pool key mismatch');
    seen.add(p.id);
  }
  const consumerPins = mapPins(config.codeHashes), producerPins = mapPins(manifest.codeHashes);
  // Include executor, lender, adapters, tokens and lenses in per-block code
  // checks, not just in a potentially obsolete startup RPC check.
  if (!consumerPins.size || producerPins.size !== consumerPins.size) throw new Error('execution code-pin coverage mismatch');
  for (const [a, h] of consumerPins) if (producerPins.get(a) !== h) throw new Error('execution runtime-code pin mismatch');
  const budget = manifest.gasBudget;
  if (!budget || budget.wrappedNativeReviewed !== true) throw new Error('reviewed WETH maximum-gas policy required');
  const token = address(budget.settlementToken);
  if (token !== address(config.wrappedNativeToken) || !producerPins.has(token)) throw new Error('WETH identity/code pin mismatch');
  for (const route of book.routes.values()) if (route.settlementToken !== token) throw new Error('in-process cost policy supports reviewed WETH settlement only');
  const gasLimit = uint(config.transaction?.gasLimit), maxFee = uint(config.transaction?.maxFeePerGas);
  if (!gasLimit || !maxFee || uint(budget.gasLimit) !== gasLimit || uint(budget.maxFeePerGas) !== maxFee) throw new Error('exporter gas budget does not match signed maximum');
  const maxGasCost = gasLimit * maxFee;
  uint(maxGasCost, 'maximum gas exposure');
  const loseRaceBps = uint(budget.loseRaceBps, 'loseRaceBps', 10_000n);
  const source = Object.freeze({ kind: 'nitro-in-process', revision: NITRO_REVISION, manifestHash });
  const relayer = address(manifest.relayer);
  let pendingCostBlock = null;
  return Object.freeze({
    source,
    socketPath: manifest.socketPath,
    assertRelayer(actual) { if (address(actual) !== relayer) throw new Error('exporter relayer mismatch'); },
    check(frame) {
      const s = frame?.executionSource;
      if (!s || s.kind !== source.kind || s.revision !== source.revision || s.manifestHash !== source.manifestHash) throw new Error('unrecognized execution-source provenance');
      if (frame.type === 'costs') {
        if (pendingCostBlock !== null) throw new Error('cost update without following executed block');
        if (!Array.isArray(frame.entries) || frame.entries.length !== 1) throw new Error('execution cost-policy coverage');
        const c = frame.entries[0];
        if (address(c.settlementToken) !== token || uint(c.settlementUnitsPerWeiNumerator) !== 1n || uint(c.settlementUnitsPerWeiDenominator) !== 1n || uint(c.successGasWei) !== maxGasCost || uint(c.revertGasWei) !== maxGasCost || uint(c.loseRaceBps) !== loseRaceBps) throw new Error('execution maximum-gas policy mismatch');
        pendingCostBlock = uint(c.validUntilBlock);
      } else if (frame.type === 'snapshot' || frame.type === 'block') {
        hash32(frame.stateRoot);
        if (pendingCostBlock !== uint(frame.blockNumber) + 1n) throw new Error('fresh cost policy required for each executed block');
        pendingCostBlock = null;
      } else if (frame.type === 'invalidate') {
        pendingCostBlock = null;
      } else if (frame.type === 'receipt') {
        if (pendingCostBlock !== null) throw new Error('receipt arrived before executed state');
      } else throw new Error('unsupported execution frame type');
    },
  });
}

export function loadExecutionManifest(config, book) {
  if (typeof config.executionManifest !== 'string' || !path.isAbsolute(config.executionManifest)) throw new Error('absolute executionManifest path required');
  const stat = fs.lstatSync(config.executionManifest);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) throw new Error('execution manifest must be owned regular 0600 file');
  return validateExecutionManifest(fs.readFileSync(config.executionManifest), config, book);
}

export function assertExecutionSocket(socketPath, expected) {
  if (!path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath || socketPath !== expected) throw new Error('execution socket differs from reviewed manifest');
  const parent = path.dirname(socketPath), stat = fs.lstatSync(parent);
  if (fs.realpathSync(parent) !== parent || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('execution socket parent must be owned non-symlink 0700 directory');
}
