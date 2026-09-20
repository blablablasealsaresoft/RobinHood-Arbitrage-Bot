// Compile every Solidity source under contracts/ into build/*.json.
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

fs.mkdirSync('build', { recursive: true });

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile() && entry.name.endsWith('.sol')) {
      out.push({
        name: path.relative(base, full).replaceAll(path.sep, '/'),
        content: fs.readFileSync(full, 'utf8'),
      });
    }
  }
  return out;
}

const sources = Object.fromEntries(
  walk('contracts').map((x) => [x.name, { content: x.content }]),
);

const input = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'paris',
    viaIR: true,
    optimizer: { enabled: true, runs: 500 },
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
let hard = false;
for (const error of output.errors || []) {
  console.log(error.severity.toUpperCase(), error.formattedMessage.split('\n')[0]);
  if (error.severity === 'error') hard = true;
}
if (hard) {
  console.error('COMPILE FAILED');
  process.exit(1);
}

let written = 0;
for (const [source, contracts] of Object.entries(output.contracts || {})) {
  for (const [name, artifact] of Object.entries(contracts)) {
    const bytecode = artifact.evm?.bytecode?.object || '';
    if (!bytecode) continue;
    fs.writeFileSync(
      path.join('build', name + '.json'),
      JSON.stringify({ source, abi: artifact.abi, bytecode: '0x' + bytecode }, null, 2),
    );
    console.log('wrote', `build/${name}.json`, '|', bytecode.length / 2, 'bytes');
    written++;
  }
}
if (!written) throw new Error('no deployable contracts compiled');
