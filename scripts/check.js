import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['.', 'scripts', 'test', 'sequencer'];
const files = roots.flatMap((root) => fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:c?js|mjs)$/.test(entry.name))
  .map((entry) => path.join(root, entry.name)));

for (const file of [...new Set(files)]) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`syntax: ${files.length} source files passed`);
