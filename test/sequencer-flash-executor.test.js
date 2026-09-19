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
