'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function collectJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (/\.(c?js|mjs)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [
  ...collectJsFiles(path.join(root, 'src')),
  ...collectJsFiles(path.join(root, 'scripts'))
].sort();

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`CHECK_ALL_OK (${files.length} files verified)`);
