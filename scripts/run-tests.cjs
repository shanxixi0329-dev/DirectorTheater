'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scriptsDir = __dirname;
const tests = fs.readdirSync(scriptsDir)
  .filter(name => /^test-.*\.cjs$/i.test(name))
  .sort();

if (!tests.length) {
  console.error('No unit test files found in scripts/.');
  process.exit(1);
}

for (const name of tests) {
  console.log(`\n=== ${name} ===`);
  execFileSync(process.execPath, [path.join(scriptsDir, name)], { stdio: 'inherit' });
}

console.log(`\nALL_UNIT_TESTS_OK (${tests.length} suites passed)`);
