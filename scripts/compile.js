// scripts/compile.js — compile every standalone Solidity source in contracts/.
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

fs.mkdirSync('build', { recursive: true });
const dir = 'contracts';
const names = fs.readdirSync(dir).filter((x) => x.endsWith('.sol')).sort();
const sources = Object.fromEntries(
  names.map((name) => [name, { content: fs.readFileSync(path.join(dir, name), 'utf8') }])
);

const input = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 500 },
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
let hard = false;
for (const e of out.errors || []) {
  console.log(e.severity.toUpperCase(), e.formattedMessage);
  if (e.severity === 'error') hard = true;
}
if (hard) {
  console.error('COMPILE FAILED');
  process.exit(1);
}

let written = 0;
for (const [sourceName, contracts] of Object.entries(out.contracts || {})) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    const bytecode = artifact.evm?.bytecode?.object || '';
    if (!bytecode) continue; // interfaces / abstract helpers
    const target = path.join('build', contractName + '.json');
    fs.writeFileSync(target, JSON.stringify({
      source: sourceName,
      abi: artifact.abi,
      bytecode: '0x' + bytecode,
    }, null, 2));
    console.log('wrote', target, '|', bytecode.length / 2, 'bytes');
    written++;
  }
}
if (!written) {
  console.error('COMPILE FAILED: no deployable contracts');
  process.exit(1);
}
