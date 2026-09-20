import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import solc from 'solc';

test('SequencerFlashArbExecutorV3 compiles and exposes signed flash-arb safety controls', () => {
  const source = fs.readFileSync(new URL('../contracts/SequencerFlashArbExecutorV3.sol', import.meta.url), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'SequencerFlashArbExecutorV3.sol': { content: source } },
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  assert.deepEqual(errors, []);

  const artifact = output.contracts['SequencerFlashArbExecutorV3.sol'].SequencerFlashArbExecutorV3;
  assert.ok(artifact.evm.bytecode.object.length > 0);

  const names = new Set(artifact.abi.filter((x) => x.type === 'function').map((x) => x.name));
  for (const name of [
    'executeFlashArb',
    'onMorphoFlashLoan',
    'hashIntent',
    'hashLegs',
    'hashStateChecks',
    'setRelayer',
    'setAdapter',
    'setBorrowCap',
    'setStrategySigner',
    'setTreasury',
    'setMaxBlockWindow',
    'setPaused',
    'rescueToken',
    'transferOwnership',
    'acceptOwnership',
    'isNonceUsed',
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});

test('SequencerFlashArbExecutorV4 compiles with ArbSys L2 anchors', () => {
  const source = fs.readFileSync(new URL('../contracts/SequencerFlashArbExecutorV4.sol', import.meta.url), 'utf8');
  assert.match(source, /ARBSYS/);
  assert.match(source, /arbBlockNumber/);
  assert.doesNotMatch(source, /require\(intent\.anchorBlock < block\.number/);
  const input = {
    language: 'Solidity',
    sources: { 'SequencerFlashArbExecutorV4.sol': { content: source } },
    settings: {
      evmVersion: 'paris',
      viaIR: true,
      optimizer: { enabled: true, runs: 500 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  assert.deepEqual(errors, []);
  const artifact = output.contracts['SequencerFlashArbExecutorV4.sol'].SequencerFlashArbExecutorV4;
  assert.ok(artifact.evm.bytecode.object.length > 0);
  const names = new Set(artifact.abi.filter((x) => x.type === 'function').map((x) => x.name));
  for (const name of ['executeFlashArb', 'maxAnchorDelay', 'maxBlockWindow', 'relayers', 'adapters', 'borrowCaps']) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});
