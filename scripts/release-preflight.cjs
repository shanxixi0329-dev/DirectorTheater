'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const failures = [];
const checks = [];

function pass(label, detail = '') {
  checks.push({ ok: true, label, detail });
  console.log(`PASS ${label}${detail ? ' — ' + detail : ''}`);
}

function fail(label, detail) {
  checks.push({ ok: false, label, detail });
  failures.push(`${label}: ${detail}`);
  console.error(`FAIL ${label} — ${detail}`);
}

function walkFiles(dir, skipDirs = new Set(['node_modules', '.git', 'installer-output', 'outputs'])) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full, skipDirs));
    else results.push(full);
  }
  return results;
}

// 1. Full syntax check across src/ and scripts/
try {
  execFileSync(process.execPath, [path.join(__dirname, 'check-all.cjs')], { stdio: 'inherit' });
  pass('Syntax check (src/ + scripts/)');
} catch (err) {
  fail('Syntax check', err.message || String(err));
}

// 2. All unit test suites
try {
  execFileSync(process.execPath, [path.join(__dirname, 'run-tests.cjs')], { stdio: 'inherit' });
  pass('Unit test suites');
} catch (err) {
  fail('Unit test suites', err.message || String(err));
}

// 3. Forbidden / private file scan across repository
const allowedPems = new Set([
  'src/licensing/director-theater-public.pem',
  'src/licensing/director-theater-public-v013.pem'
]);
const repoFiles = walkFiles(root, new Set(['node_modules', '.git', 'installer-output', 'outputs', '.agents']));
const forbiddenFiles = [];
for (const file of repoFiles) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const base = path.basename(file);
  if (/\.(dtlicense|dtp|pfx|key)$/i.test(base)) forbiddenFiles.push(rel);
  else if (/\.pem$/i.test(base) && !allowedPems.has(rel)) forbiddenFiles.push(rel);
  else if (/^\.env(\.|$)/i.test(base)) forbiddenFiles.push(rel);
  else if (/^(membership\.json|director-theater-store\.json|ai-runner-secrets\.json|image-runner-config\.json)/i.test(base)) forbiddenFiles.push(rel);
  else if (rel.startsWith('src/templates/')) forbiddenFiles.push(rel);
}
if (forbiddenFiles.length) fail('Public repo file hygiene', `Forbidden files found: ${forbiddenFiles.join(', ')}`);
else pass('Public repo file hygiene', 'zero private keys, licenses, templates, or user data');

// 4. Secret / personal path scan across tracked source & docs
const secretPatterns = [
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'OpenAI/Anthropic key literal', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub PAT literal', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Personal Windows user path', re: /[A-Za-z]:\\Users\\27384\\/i },
  { name: 'Internal LAN share path', re: /\\\\10\.23\.100\.119\\/i }
];
const scanTargets = repoFiles.filter(file => {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (rel === 'scripts/release-preflight.cjs' || rel === 'scripts/test-release-security.cjs') return false;
  return /\.(js|cjs|mjs|json|html|css|md|txt)$/i.test(file);
});
const leaks = [];
for (const file of scanTargets) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  for (const { name, re } of secretPatterns) {
    if (re.test(text)) leaks.push(`${rel} (${name})`);
  }
}
if (leaks.length) fail('Sensitive string scan', leaks.join('; '));
else pass('Sensitive string scan', `${scanTargets.length} files clean`);

// 5. Dual public keys integrity
try {
  for (const rel of allowedPems) {
    const pem = fs.readFileSync(path.join(root, rel), 'utf8');
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error(`${rel} is not an RSA public key`);
  }
  pass('Dual public key verification', 'legacy + v013 RSA public keys valid');
} catch (err) {
  fail('Dual public key verification', err.message || String(err));
}

// 6. Version parity check
const versionChecks = [
  { file: 'src/renderer/index.html', re: new RegExp(`<title>导演台剧场 V${version.replace(/\./g, '\\.')}</title>`) },
  { file: 'src/renderer/app.js', re: new RegExp(`'${version.replace(/\./g, '\\.')}'`) },
  { file: 'src/renderer/production-ui.js', re: new RegExp(`'${version.replace(/\./g, '\\.')}'`) },
  { file: 'README.md', re: new RegExp(`V${version.replace(/\./g, '\\.')}`) },
  { file: 'docs/faq.md', re: new RegExp(`DirectorTheater-Setup-${version.replace(/\./g, '\\.')}-win-x64\\.exe`) },
  { file: 'CHANGELOG.md', re: new RegExp(`^##\\s+V${version.replace(/\./g, '\\.')}\\b`, 'm') }
];
const versionMismatches = [];
for (const item of versionChecks) {
  const full = path.join(root, item.file);
  if (!fs.existsSync(full) || !item.re.test(fs.readFileSync(full, 'utf8'))) {
    versionMismatches.push(item.file);
  }
}
if (versionMismatches.length) fail('Version parity', `Missing V${version} in: ${versionMismatches.join(', ')}`);
else pass('Version parity', `all release files aligned to V${version}`);

// 7. Required launch docs & markdown local link/image verification
const requiredDocs = ['README.md', 'CHANGELOG.md', 'PRIVACY.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'docs/quickstart.md', 'docs/activation.md', 'docs/faq.md', 'docs/windows-release.md'];
const missingDocs = requiredDocs.filter(rel => !fs.existsSync(path.join(root, rel)));
if (missingDocs.length) fail('Required release docs', `Missing: ${missingDocs.join(', ')}`);
else pass('Required release docs', `${requiredDocs.length} documents present`);

const brokenLinks = [];
const mdLinkRe = /!?\[[^\]]*\]\(([^)]+)\)|<img[^>]+src="([^"]+)"/gi;
for (const rel of requiredDocs) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  let match;
  while ((match = mdLinkRe.exec(text)) !== null) {
    const rawTarget = (match[1] || match[2] || '').trim().split(/\s+/)[0];
    if (!rawTarget || /^(https?:|mailto:|#)/i.test(rawTarget)) continue;
    const cleanTarget = rawTarget.split('#')[0].split('?')[0];
    if (!cleanTarget) continue;
    const resolved = path.resolve(path.dirname(full), cleanTarget);
    if (!fs.existsSync(resolved)) brokenLinks.push(`${rel} -> ${rawTarget}`);
  }
}
if (brokenLinks.length) fail('Markdown local links & images', brokenLinks.join('; '));
else pass('Markdown local links & images', 'all relative docs & screenshots exist');

// 8. Packaging exclusion & CSP safety check
const buildFiles = pkg.build?.files || [];
if (!buildFiles.includes('!src/**/*.dtlicense') || !buildFiles.includes('!src/templates/**')) {
  fail('Packaging exclusions', 'package.json build.files must exclude !src/**/*.dtlicense and !src/templates/**');
} else {
  pass('Packaging exclusions', 'licenses and private templates excluded from public installer');
}

const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
if (!/Content-Security-Policy/i.test(indexHtml) || !/script-src 'self'/i.test(indexHtml)) {
  fail('Renderer CSP', 'strict script-src self CSP missing from index.html');
} else {
  pass('Renderer CSP', "strict script-src 'self' active");
}

if (failures.length) {
  console.error(`\nRELEASE_PREFLIGHT_FAILED (${failures.length} issues)`);
  process.exit(1);
}
console.log(`\nRELEASE_PREFLIGHT_OK (V${version}, ${checks.length}/${checks.length} gates passed)`);
