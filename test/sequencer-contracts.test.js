import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

function compileSequencerContracts() {
  const dir = new URL('../contracts/', import.meta.url);
  const names = fs.readdirSync(dir).filter(x => x.endsWith('.sol')).sort();
  const sources = Object.fromEntries(names.map(name => [
    name,
    { content: fs.readFileSync(new URL('../contracts/' + name, import.meta.url), 'utf8') },
  ]));
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 500 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  return JSON.parse(solc.compile(JSON.stringify(input)));
}

test('all strategy Solidity sources compile together without errors', () => {
  const output = compileSequencerContracts();
  const errors = (output.errors || []).filter(x => x.severity === 'error');
  assert.deepEqual(errors, []);
  for (const name of [
    'SequencerFlashArbExecutorV4',
    'RobinFunWethAdapter',
    'UniswapV4WethAdapter',
    'SequencerRouteQuoter',
  ]) {
    const artifact = Object.values(output.contracts)
      .map(group => group[name])
      .find(Boolean);
    assert.ok(artifact, 'missing compiled ' + name);
    assert.ok(artifact.evm.bytecode.object.length > 0, 'empty bytecode for ' + name);
  }
});

test('flash executor ABI exposes the intended single-strategy safety surface', () => {
  const output = compileSequencerContracts();
  const artifact = output.contracts['SequencerFlashArbExecutorV4.sol'].SequencerFlashArbExecutorV4;
  const names = new Set(artifact.abi.filter(x => x.type === 'function').map(x => x.name));
  for (const name of [
    'executeFlashArb',
    'onMorphoFlashLoan',
    'setAdapter',
    'setBorrowCap',
    'setRelayer',
    'setMaxAnchorDelay',
    'setPaused',
    'cancelNonceWord',
    'isNonceUsed',
  ]) assert.ok(names.has(name), 'missing ' + name);
});

test('executor source uses ArbSys L2 anchoring, not Solidity block.number', () => {
  const src = fs.readFileSync(new URL('../contracts/SequencerFlashArbExecutorV4.sol', import.meta.url), 'utf8');
  assert.match(src, /arbBlockNumber\(\)/);
  assert.match(src, /arbBlockHash\(uint256/);
  assert.doesNotMatch(src, /\bblock\.number\b/);
  assert.doesNotMatch(src, /\bblockhash\s*\(/);
});
