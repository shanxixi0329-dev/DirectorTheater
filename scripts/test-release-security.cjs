'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createLocalSecrets } = require('../src/local-secrets');
const membershipCore = require('../src/membership-core');

const root = path.resolve(__dirname, '..');

test('local-secrets strips API keys from project.json and restores them only on the local userData machine', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-secrets-'));
  try {
    const userDataA = path.join(tmp, 'machine-a');
    const userDataB = path.join(tmp, 'machine-b');
    const projectPath = path.join(tmp, 'shared-project');
    const mockSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from('ENC:' + text, 'utf8'),
      decryptString: buf => {
        const s = buf.toString('utf8');
        if (!s.startsWith('ENC:')) throw new Error('bad cipher');
        return s.slice(4);
      }
    };
    const secretsA = createLocalSecrets({ userData: () => userDataA, safeStorage: mockSafeStorage });
    const project = {
      projectPath,
      aiRunner: { provider: 'deepseek', apiKey: 'sk-secret-active-123456', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      aiProfiles: {
        deepseek: { provider: 'deepseek', apiKey: 'sk-secret-active-123456' },
        openai: { provider: 'openai', apiKey: 'sk-secret-openai-999999' }
      }
    };

    await secretsA.saveProjectSecrets(project);
    const stripped = secretsA.stripProjectSecrets(project);
    const persistedJson = JSON.stringify(stripped);
    assert.ok(!persistedJson.includes('sk-secret-active-123456'), 'project.json must never contain active API key');
    assert.ok(!persistedJson.includes('sk-secret-openai-999999'), 'project.json must never contain profile API key');
    assert.equal(project.aiRunner.apiKey, 'sk-secret-active-123456', 'in-memory project must stay intact');

    // Stored secrets on disk must be encrypted when safeStorage is available
    const diskSecrets = await fs.readFile(secretsA.secretsFilePath(), 'utf8');
    assert.ok(!diskSecrets.includes('sk-secret-active-123456'), 'secrets file should use safeStorage ciphertext');

    // Reopen on Machine A restores keys
    const reopenedA = JSON.parse(persistedJson);
    await secretsA.hydrateProjectSecrets(reopenedA);
    assert.equal(reopenedA.aiRunner.apiKey, 'sk-secret-active-123456');
    assert.equal(reopenedA.aiProfiles.openai.apiKey, 'sk-secret-openai-999999');

    // Reopen on Machine B (different userData) gets zero leaked keys
    const secretsB = createLocalSecrets({ userData: () => userDataB, safeStorage: mockSafeStorage });
    const reopenedB = JSON.parse(persistedJson);
    await secretsB.hydrateProjectSecrets(reopenedB);
    assert.equal(reopenedB.aiRunner.apiKey, '');
    assert.equal(reopenedB.aiProfiles.openai.apiKey, '');

    // Legacy project.json with inline key migrates cleanly into Machine B userData
    const legacy = {
      projectPath,
      aiRunner: { provider: 'deepseek', apiKey: 'sk-legacy-inline-777' },
      aiProfiles: {}
    };
    await secretsB.hydrateProjectSecrets(legacy);
    const afterMigrate = secretsB.stripProjectSecrets(legacy);
    await secretsB.hydrateProjectSecrets(afterMigrate);
    assert.equal(afterMigrate.aiRunner.apiKey, 'sk-legacy-inline-777');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('dual RSA public keys are valid and reject tampered license tokens', async () => {
  const licensingDir = path.join(root, 'src', 'licensing');
  const keys = await Promise.all([
    fs.readFile(path.join(licensingDir, 'director-theater-public.pem'), 'utf8'),
    fs.readFile(path.join(licensingDir, 'director-theater-public-v013.pem'), 'utf8')
  ]);
  for (const pem of keys) {
    const keyObj = crypto.createPublicKey(pem);
    assert.equal(keyObj.asymmetricKeyType, 'rsa');
  }
  const fakePayload = Buffer.from(JSON.stringify({ product: 'director-theater', plan: 'lifetime', machineCode: '*' })).toString('base64url');
  const forged = `DT1.${fakePayload}.${Buffer.from('forged-sig').toString('base64url')}`;
  const res = membershipCore.verifyLicenseToken(forged, keys, 'DT-AAAAAA-BBBBBB-CCCCCC-DDDDDD');
  assert.equal(res.valid, false);
});

test('index.html enforces strict script-src self CSP with zero inline scripts', async () => {
  const html = await fs.readFile(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy"/i);
  assert.match(html, /script-src\s+'self'/i);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'index.html must not contain inline <script> blocks');
});
