// scripts/compile.js — compile all executor/adapters into build/*.json
import fs from 'node:fs';
import solc from 'solc';

fs.mkdirSync('build', { recursive: true });

const sources = {
  'ArbExecutor.sol': { content: fs.readFileSync('contracts/ArbExecutor.sol', 'utf8') },
  'SequencerFlashArbExecutorV3.sol': { content: fs.readFileSync('contracts/SequencerFlashArbExecutorV3.sol', 'utf8') },
  'RobinFunWethAdapter.sol': { content: fs.readFileSync('contracts/adapters/RobinFunWethAdapter.sol', 'utf8') },
  'UniswapV4WethAdapter.sol': { content: fs.readFileSync('contracts/adapters/UniswapV4WethAdapter.sol', 'utf8') },
};

const input = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
let hard = false;
for (const e of out.errors || []) {
  console.log(e.severity.toUpperCase(), e.formattedMessage.split('\n')[0]);
  if (e.severity === 'error') hard = true;
}
if (hard) {
  console.error('COMPILE FAILED');
  process.exit(1);
}

const artifacts = [
  ['ArbExecutor.sol', 'ArbExecutor'],
  ['SequencerFlashArbExecutorV3.sol', 'SequencerFlashArbExecutorV3'],
  ['RobinFunWethAdapter.sol', 'RobinFunWethAdapter'],
  ['UniswapV4WethAdapter.sol', 'UniswapV4WethAdapter'],
];

for (const [source, name] of artifacts) {
  const contract = out.contracts?.[source]?.[name];
  if (!contract?.evm?.bytecode?.object) {
    console.error('missing artifact', source, name);
    process.exit(1);
  }
  fs.writeFileSync(
    `build/${name}.json`,
    JSON.stringify({ abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object }, null, 2),
  );
  console.log(`wrote build/${name}.json | ${contract.evm.bytecode.object.length / 2} bytes`);
}
