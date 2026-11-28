'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

function createLocalSecrets({ userData, safeStorage, keyFn = (p) => String(p || '').toLowerCase(), writeAtomic }) {
  let cache = null;
  let cachePath = '';

  const secretsFilePath = () => path.join(userData(), 'ai-runner-secrets.json');

  function canEncrypt() {
    try {
      return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  function encodeSecret(plain) {
    const value = String(plain || '').trim();
    if (!value) return '';
    if (canEncrypt()) {
      try {
        return { enc: 'safeStorage', data: safeStorage.encryptString(value).toString('base64') };
      } catch {
        // Fallback to plain only when OS keystore refuses encryption.
      }
    }
    return { enc: 'plain', data: value };
  }

  function decodeSecret(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry.trim();
    if (typeof entry !== 'object') return '';
    const data = String(entry.data || '');
    if (!data) return '';
    if (entry.enc === 'safeStorage') {
      if (!canEncrypt()) return '';
      try {
        return safeStorage.decryptString(Buffer.from(data, 'base64')).trim();
      } catch {
        return '';
      }
    }
    if (entry.enc === 'plain') return data.trim();
    return '';
  }

  function loadStoreSync() {
    const file = secretsFilePath();
    if (cache && cachePath === file) return cache;
    cachePath = file;
    try {
      const raw = fsSync.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      cache = parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object'
        ? parsed
        : { schemaVersion: 1, projects: {} };
    } catch {
      cache = { schemaVersion: 1, projects: {} };
    }
    return cache;
  }

  async function persistStore(store) {
    const file = secretsFilePath();
    const content = JSON.stringify(store, null, 2);
    if (typeof writeAtomic === 'function') {
      await writeAtomic(file, content, 'utf8');
    } else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
    }
    cache = store;
    cachePath = file;
  }

  function stripProjectSecrets(project) {
    if (!project || typeof project !== 'object') return project;
    const clone = { ...project };
    if (clone.aiRunner && typeof clone.aiRunner === 'object') {
      clone.aiRunner = { ...clone.aiRunner, apiKey: '' };
    }
    if (clone.aiProfiles && typeof clone.aiProfiles === 'object') {
      const cleanProfiles = {};
      for (const [provider, profile] of Object.entries(clone.aiProfiles)) {
        cleanProfiles[provider] = profile && typeof profile === 'object'
          ? { ...profile, apiKey: '' }
          : profile;
      }
      clone.aiProfiles = cleanProfiles;
    }
    return clone;
  }

  async function saveProjectSecrets(project) {
    if (!project?.projectPath) return false;
    const pKey = keyFn(project.projectPath);
    if (!pKey) return false;
    const store = loadStoreSync();
    const prev = store.projects[pKey] && typeof store.projects[pKey] === 'object'
      ? store.projects[pKey]
      : { activeKey: '', profiles: {} };
    const nextProfiles = { ...(prev.profiles || {}) };
    let changed = false;

    const activeProvider = String(project.aiRunner?.provider || '').trim();
    if (project.aiRunner && Object.prototype.hasOwnProperty.call(project.aiRunner, 'apiKey')) {
      const activePlain = String(project.aiRunner.apiKey || '').trim();
      const prevActivePlain = decodeSecret(prev.activeKey);
      if (activePlain !== prevActivePlain) changed = true;
      prev.activeKey = activePlain ? encodeSecret(activePlain) : '';
      if (activeProvider) {
        const prevProvPlain = decodeSecret(nextProfiles[activeProvider]);
        if (activePlain !== prevProvPlain) changed = true;
        if (activePlain) nextProfiles[activeProvider] = encodeSecret(activePlain);
        else delete nextProfiles[activeProvider];
      }
    }

    if (project.aiProfiles && typeof project.aiProfiles === 'object') {
      for (const [provider, profile] of Object.entries(project.aiProfiles)) {
        if (!profile || typeof profile !== 'object' || !Object.prototype.hasOwnProperty.call(profile, 'apiKey')) continue;
        const plain = String(profile.apiKey || '').trim();
        const prevPlain = decodeSecret(nextProfiles[provider]);
        if (plain !== prevPlain) changed = true;
        if (plain) nextProfiles[provider] = encodeSecret(plain);
        else delete nextProfiles[provider];
      }
    }

    if (!changed) return false;
    const nextEntry = { activeKey: prev.activeKey || '', profiles: nextProfiles, updatedAt: new Date().toISOString() };
    if (!nextEntry.activeKey && !Object.keys(nextEntry.profiles).length) {
      delete store.projects[pKey];
    } else {
      store.projects[pKey] = nextEntry;
    }
    await persistStore(store);
    return true;
  }

  async function hydrateProjectSecrets(project) {
    if (!project?.projectPath) return project;
    const pKey = keyFn(project.projectPath);
    if (!pKey) return project;

    // Migrate legacy inline keys from older project.json files into local userData.
    const hasLegacyInline = Boolean(String(project.aiRunner?.apiKey || '').trim())
      || Object.values(project.aiProfiles || {}).some(profile => Boolean(String(profile?.apiKey || '').trim()));
    if (hasLegacyInline) {
      await saveProjectSecrets(project).catch(() => {});
    }

    const store = loadStoreSync();
    const entry = store.projects[pKey];
    if (!entry || typeof entry !== 'object') return project;

    const profiles = entry.profiles && typeof entry.profiles === 'object' ? entry.profiles : {};
    const activeProvider = String(project.aiRunner?.provider || '').trim();
    if (project.aiRunner && !String(project.aiRunner.apiKey || '').trim()) {
      const restored = (activeProvider && decodeSecret(profiles[activeProvider])) || decodeSecret(entry.activeKey);
      if (restored) project.aiRunner.apiKey = restored;
    }
    for (const [provider, encoded] of Object.entries(profiles)) {
      const restored = decodeSecret(encoded);
      if (!restored) continue;
      if (!project.aiProfiles || typeof project.aiProfiles !== 'object') project.aiProfiles = {};
      if (!project.aiProfiles[provider] || typeof project.aiProfiles[provider] !== 'object') {
        project.aiProfiles[provider] = { provider, apiKey: restored };
      } else if (!String(project.aiProfiles[provider].apiKey || '').trim()) {
        project.aiProfiles[provider].apiKey = restored;
      }
    }
    return project;
  }

  return {
    encodeSecret,
    decodeSecret,
    stripProjectSecrets,
    saveProjectSecrets,
    hydrateProjectSecrets,
    secretsFilePath
  };
}

module.exports = { createLocalSecrets };
