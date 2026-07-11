import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import solc from 'solc';
import { AbiCoder, keccak256 } from 'ethers';
import { POOLS } from '../config.js';

test('ArbExecutor compiles without Solidity errors and exposes safety controls', () => {
  const source = fs.readFileSync(new URL('../contracts/ArbExecutor.sol', import.meta.url), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'ArbExecutor.sol': { content: source } },
    settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  assert.deepEqual(errors, []);
  const artifact = output.contracts['ArbExecutor.sol'].ArbExecutor;
  assert.ok(artifact.evm.bytecode.object.length > 0);
  const names = new Set(artifact.abi.filter((x) => x.type === 'function').map((x) => x.name));
  for (const name of ['allowedPools', 'maxTradeSize', 'setPoolAllowed', 'setPaused', 'revokeToken', 'transferOwnership', 'acceptOwnership']) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});

test('configured pool ids match their PoolKeys and safety policy', () => {
  const coder = AbiCoder.defaultAbiCoder();
  for (const pool of POOLS) {
    const k = pool.key;
    assert.equal(BigInt(k.currency0), 0n);
    assert.equal(BigInt(k.hooks), 0n);
    assert.ok(k.fee <= 1_000_000);
    assert.ok(k.tickSpacing > 0);
    const actual = keccak256(coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ));
    assert.equal(actual.toLowerCase(), pool.id.toLowerCase());
  }
});
