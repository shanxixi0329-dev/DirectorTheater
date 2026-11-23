const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { TRIAL_DAYS, PLANS, resolveMembership, verifyLicenseToken } = require('./membership-core');
const { listBuiltinTemplates } = require('./template-library');

const execFileAsync = promisify(execFile);

async function windowsMachineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('reg.exe', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
    ], { windowsHide: true, encoding: 'utf8' });
    return String(stdout).match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

async function createMachineCode() {
  const stable = await windowsMachineGuid() || `${os.hostname()}|${os.platform()}|${os.arch()}`;
  const digest = crypto.createHash('sha256').update(`director-theater|${stable}`).digest('hex').toUpperCase().slice(0, 24);
  return `DT-${digest.match(/.{1,6}/g).join('-')}`;
}

async function readRegistryValue(name) {
  if (process.platform !== 'win32' || process.env.DIRECTOR_THEATER_DISABLE_REGISTRY === '1') return '';
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Software\\DirectorTheater', '/v', name], { windowsHide: true, encoding: 'utf8' });
    return String(stdout).match(new RegExp(`${name}\\s+REG_\\w+\\s+([^\\r\\n]+)`, 'i'))?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

async function writeRegistryValue(name, value) {
  if (process.platform !== 'win32' || !value || process.env.DIRECTOR_THEATER_DISABLE_REGISTRY === '1') return;
  try {
    await execFileAsync('reg.exe', ['add', 'HKCU\\Software\\DirectorTheater', '/v', name, '/t', 'REG_SZ', '/d', String(value), '/f'], { windowsHide: true, encoding: 'utf8' });
  } catch {
    // The normal user-data copy still keeps membership state when registry access is restricted.
  }
}

function createMembershipService({ app, dialog, mainWindow: getMainWindow }) {
  let statePath = '';
  let licensePath = '';
  let publicKey = '';
  let bundledToken = '';
  let machineCode = '';
  let state = null;
  let persistPending = null;
  let lastPersistedAt = 0;
  let registryStartedAtWritten = '';

  async function persist() {
    if (persistPending) return persistPending;
    persistPending = persistState().finally(() => { persistPending = null; });
    return persistPending;
  }

  async function persistState() {
    const current = Date.now();
    const previous = Date.parse(state.lastSeenAt || '');
    if (!Number.isFinite(previous) || current > previous) state.lastSeenAt = new Date(current).toISOString();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    const snapshot = { ...state };
    await fs.writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), 'utf8');
    try {
      await fs.rename(temporaryPath, statePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      await fs.copyFile(temporaryPath, statePath);
      await fs.unlink(temporaryPath).catch(() => {});
    }
    await Promise.all([
      registryStartedAtWritten === snapshot.startedAt ? Promise.resolve() : writeRegistryValue('TrialStartedAt', snapshot.startedAt),
      writeRegistryValue('TrialLastSeenAt', snapshot.lastSeenAt)
    ]);
    registryStartedAtWritten = snapshot.startedAt;
    lastPersistedAt = Date.now();
  }

  async function init() {
    statePath = path.join(app.getPath('userData'), 'membership.json');
    licensePath = path.join(app.getPath('userData'), 'membership.dtlicense');
    publicKey = await fs.readFile(path.join(__dirname, 'licensing', 'director-theater-public.pem'), 'utf8');
    // Only permanent-edition packages contain this signed, machine-independent license.
    // A missing or invalid bundled license leaves the regular membership rules in effect.
    bundledToken = await fs.readFile(path.join(__dirname, 'licensing', 'bundled-lifetime.dtlicense'), 'utf8').then(value => value.trim()).catch(() => '');
    machineCode = await createMachineCode();
    try {
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch {
      const startedAt = new Date().toISOString();
      state = {
        schemaVersion: 1,
        installId: crypto.randomUUID(),
        startedAt,
        expiresAt: new Date(Date.parse(startedAt) + TRIAL_DAYS * 86400000).toISOString(),
        lastSeenAt: startedAt
      };
    }
    const [registryStartedAt, registryLastSeenAt] = await Promise.all([
      readRegistryValue('TrialStartedAt'), readRegistryValue('TrialLastSeenAt')
    ]);
    const storedStart = Date.parse(state.startedAt || '');
    const registryStart = Date.parse(registryStartedAt || '');
    if (Number.isFinite(registryStart) && (!Number.isFinite(storedStart) || registryStart < storedStart)) {
      state.startedAt = new Date(registryStart).toISOString();
      state.expiresAt = new Date(registryStart + TRIAL_DAYS * 86400000).toISOString();
    }
    const storedLast = Date.parse(state.lastSeenAt || '');
    const registryLast = Date.parse(registryLastSeenAt || '');
    if (Number.isFinite(registryLast) && (!Number.isFinite(storedLast) || registryLast > storedLast)) {
      state.lastSeenAt = new Date(registryLast).toISOString();
    }
    await persist();
    return status();
  }

  async function readToken() {
    try {
      return (await fs.readFile(licensePath, 'utf8')).trim();
    } catch {
      return '';
    }
  }

  async function status() {
    if (!state) await init();
    const token = await readToken();
    let result = resolveMembership({ trial: state, token, publicKey, machineCode });
    const bundledVerification = bundledToken && verifyLicenseToken(bundledToken, publicKey, machineCode);
    if (bundledVerification?.valid && bundledVerification.plan.id === 'lifetime' && bundledVerification.payload.machineCode === '*') {
      if (!result.active || !result.permanent) {
        result = {
          ...resolveMembership({ trial: state, token: bundledToken, publicKey, machineCode }),
          source: 'bundled-license',
          priceLabel: '随安装包附带 · 永久'
        };
      }
      result.bundledEdition = true;
    }
    const nowMs = Date.now();
    const lastSeenAtMs = Date.parse(state.lastSeenAt || '');
    // All signatures, expiration and rollback checks still run on every call.
    // Coalesce the persistence heartbeat instead of launching reg.exe twice
    // for each protected IPC call (and racing on the same .tmp file).
    if (!Number.isFinite(lastSeenAtMs) || nowMs > lastSeenAtMs) {
      state.lastSeenAt = new Date(nowMs).toISOString();
      if (nowMs - lastPersistedAt >= 60000) await persist();
      else if (persistPending) await persistPending;
    }
    const builtinTemplatesAvailable = listBuiltinTemplates().length > 0;
    return {
      ...result,
      builtinTemplatesAvailable,
      canUseBuiltinTemplates: result.canUseBuiltinTemplates && builtinTemplatesAvailable,
      plans: PLANS,
      version: app.getVersion?.() || require('../package.json').version
    };
  }

  async function activateToken(token) {
    const compact = String(token || '').trim();
    const verification = verifyLicenseToken(compact, publicKey, machineCode);
    if (!verification.valid) throw new Error(verification.reason || '授权无法激活。');
    await fs.mkdir(path.dirname(licensePath), { recursive: true });
    await fs.writeFile(licensePath, compact, 'utf8');
    return status();
  }

  async function importLicense() {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '导入导演台剧场授权文件',
      filters: [{ name: '导演台剧场授权', extensions: ['dtlicense', 'txt'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    return activateToken(await fs.readFile(result.filePaths[0], 'utf8'));
  }

  async function removeLicense() {
    if (fsSync.existsSync(licensePath)) await fs.unlink(licensePath);
    return status();
  }

  async function assertCanEdit() {
    const current = await status();
    if (!current.canEdit) {
      const error = new Error(`${current.reason || '会员已到期。'} 当前只能阅读，请续费或导入有效授权。`);
      error.code = 'MEMBERSHIP_EXPIRED';
      throw error;
    }
    return current;
  }

  async function assertCanUseBuiltinTemplates() {
    const current = await assertCanEdit();
    if (!current.builtinTemplatesAvailable) throw new Error('当前版本请使用自行导入的要求文件。');
    if (!current.canUseBuiltinTemplates) {
      const error = new Error('内置提示词仅向 Plus、Pro、永久会员、开发者和管理员开放。免费会员可以使用自己导入的要求文件。');
      error.code = 'MEMBERSHIP_TEMPLATE_REQUIRED';
      throw error;
    }
    return current;
  }

  return { init, status, activateToken, importLicense, removeLicense, assertCanEdit, assertCanUseBuiltinTemplates, machineCode: () => machineCode };
}

module.exports = { createMachineCode, createMembershipService };
