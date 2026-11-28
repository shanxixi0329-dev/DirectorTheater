const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { TRIAL_DAYS, PLANS, resolveMembership, verifyLicenseToken, signLicensePayload, normalizeMachineCode } = require('./membership-core');
const { listBuiltinTemplates } = require('./template-library');

const execFileAsync = promisify(execFile);

function extractLicenseToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const match = text.match(/DT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  return match ? match[0] : text.replace(/\s+/g, '');
}

function addCalendarMonths(iso, months) {
  const value = new Date(iso);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const finalDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, finalDay));
  return value.toISOString();
}

function addCalendarYears(iso, years) {
  const value = new Date(iso);
  const month = value.getUTCMonth();
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCFullYear(value.getUTCFullYear() + years);
  const finalDay = new Date(Date.UTC(value.getUTCFullYear(), month + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, finalDay));
  return value.toISOString();
}

function defaultLocalSigningKeyPath() {
  return path.resolve(
    process.env.DIRECTOR_THEATER_SIGNING_KEY
    || path.join(process.env.LOCALAPPDATA || os.homedir(), 'DirectorTheater', 'Licensing', 'director-theater-v013-private.pem')
  );
}

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
  let publicKeys = [];
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
    const licensingDir = path.join(__dirname, 'licensing');
    publicKeys = await Promise.all(['director-theater-public.pem', 'director-theater-public-v013.pem']
      .map(file => fs.readFile(path.join(licensingDir, file), 'utf8')));
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
    let result = resolveMembership({ trial: state, token, publicKey: publicKeys, machineCode });
    const bundledVerification = bundledToken && verifyLicenseToken(bundledToken, publicKeys, machineCode);
    if (bundledVerification?.valid && bundledVerification.plan.id === 'lifetime' && bundledVerification.payload.machineCode === '*') {
      if (!result.active || !result.permanent) {
        result = {
          ...resolveMembership({ trial: state, token: bundledToken, publicKey: publicKeys, machineCode }),
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
    const compact = extractLicenseToken(token);
    if (!compact) throw new Error('没有检测到有效的激活码。');
    const verification = verifyLicenseToken(compact, publicKeys, machineCode);
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

  async function readVerifiedLocalSigningKey() {
    const keyPath = defaultLocalSigningKeyPath();
    if (!fsSync.existsSync(keyPath)) return null;
    try {
      const privateKey = crypto.createPrivateKey(await fs.readFile(keyPath));
      const v013PublicPem = await fs.readFile(path.join(__dirname, 'licensing', 'director-theater-public-v013.pem'), 'utf8');
      const v013PublicKey = crypto.createPublicKey(v013PublicPem);
      if (!crypto.createPublicKey(privateKey).equals(v013PublicKey)) return null;
      return { privateKey, publicKey: v013PublicKey };
    } catch {
      return null;
    }
  }

  async function localAdminStatus() {
    if (!state) await init();
    const verified = await readVerifiedLocalSigningKey();
    return {
      available: Boolean(verified),
      machineCode
    };
  }

  async function adminIssueLicense(input = {}) {
    if (!state) await init();
    const verified = await readVerifiedLocalSigningKey();
    if (!verified) throw new Error('本机未检测到配套的管理员签发私钥，无法在当前电脑签发授权。');
    const planId = String(input.plan || 'lifetime').trim().toLowerCase();
    const plan = PLANS[planId];
    if (!plan || planId === 'free') throw new Error('请选择有效的会员计划（Plus / Pro / 永久 / 开发者 / 管理员）。');
    const rawMachine = String(input.machineCode || machineCode || '').trim();
    const normalizedMachine = rawMachine === '*' ? '*' : normalizeMachineCode(rawMachine);
    if (normalizedMachine !== '*' && !/^DT-(?:[0-9A-F]{6}-){3}[0-9A-F]{6}$/.test(normalizedMachine)) {
      throw new Error('电脑识别码格式不正确，请粘贴完整的 DT-XXXXXX-XXXXXX-XXXXXX-XXXXXX。');
    }
    const memberName = String(input.memberName || '导演台剧场会员').trim() || '导演台剧场会员';
    const issuedAt = new Date().toISOString();
    const startsAt = issuedAt;
    const months = Math.max(1, Math.min(120, Math.trunc(Number(input.months) || 1)));
    const years = Math.max(1, Math.min(20, Math.trunc(Number(input.years) || 1)));
    const expiresAt = plan.permanent ? null : planId === 'pro' ? addCalendarYears(startsAt, years) : addCalendarMonths(startsAt, months);
    const payload = {
      product: 'director-theater',
      version: 1,
      licenseId: crypto.randomUUID(),
      plan: planId,
      memberName,
      machineCode: normalizedMachine,
      issuedAt,
      startsAt,
      expiresAt,
      note: String(input.note || '').trim(),
      issuer: '导演台剧场管理员'
    };
    const token = signLicensePayload(payload, verified.privateKey);
    const check = verifyLicenseToken(token, verified.publicKey, normalizedMachine === '*' ? machineCode : normalizedMachine, Date.parse(startsAt) + 1);
    if (!check.valid) throw new Error(`授权自检失败：${check.reason}`);
    const machineTag = normalizedMachine === '*' ? 'ALL' : normalizedMachine.replace(/[^A-Z0-9-]/g, '');
    const suggestedFileName = `${planId}-${machineTag}-${payload.licenseId.slice(0, 8)}.dtlicense`;
    return {
      token,
      payload,
      planLabel: plan.label,
      suggestedFileName
    };
  }

  async function adminSelfActivate(plan = 'admin') {
    const issued = await adminIssueLicense({
      plan: PLANS[plan] && plan !== 'free' ? plan : 'admin',
      machineCode,
      memberName: '本机管理员'
    });
    const nextStatus = await activateToken(issued.token);
    return { status: nextStatus, issued };
  }

  async function adminSaveLicenseFile({ token, suggestedFileName = 'director-theater.dtlicense' } = {}) {
    const compact = extractLicenseToken(token);
    if (!compact) throw new Error('没有可导出的授权内容。');
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: '导出导演台剧场授权文件',
      defaultPath: suggestedFileName,
      filters: [{ name: '导演台剧场授权', extensions: ['dtlicense'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, compact, 'utf8');
    return { filePath: result.filePath, fileName: path.basename(result.filePath) };
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

  return {
    init, status, activateToken, importLicense, removeLicense,
    localAdminStatus, adminIssueLicense, adminSelfActivate, adminSaveLicenseFile,
    assertCanEdit, assertCanUseBuiltinTemplates, machineCode: () => machineCode
  };
}

module.exports = { createMachineCode, createMembershipService, extractLicenseToken };
