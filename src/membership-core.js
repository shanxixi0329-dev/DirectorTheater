const crypto = require('crypto');

const LICENSE_PREFIX = 'DT1';
const TRIAL_DAYS = 7;
const CLOCK_ROLLBACK_TOLERANCE_MS = 6 * 60 * 60 * 1000;

const PLANS = Object.freeze({
  free: { id: 'free', label: '免费会员', price: 0, duration: '7天试用', permanent: false },
  plus: { id: 'plus', label: 'Plus会员', price: 7, duration: '1个月', permanent: false },
  pro: { id: 'pro', label: 'Pro会员', price: 50, duration: '1年', permanent: false, billingPeriod: 'year' },
  lifetime: { id: 'lifetime', label: '永久会员', price: 99, duration: '永久', permanent: true },
  developer: { id: 'developer', label: '开发者', price: 0, duration: '永久', permanent: true, internal: true },
  admin: { id: 'admin', label: '管理员', price: 0, duration: '永久', permanent: true, internal: true }
});

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function normalizeMachineCode(value) {
  return String(value || '').trim().toUpperCase();
}

function signLicensePayload(payload, privateKey) {
  const body = toBase64Url(JSON.stringify(payload));
  const signature = crypto.sign('sha256', Buffer.from(body), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  });
  return `${LICENSE_PREFIX}.${body}.${signature.toString('base64url')}`;
}

function parseLicenseToken(token) {
  const compact = String(token || '').replace(/\s+/g, '');
  const parts = compact.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) throw new Error('授权码格式不正确。');
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
  } catch {
    throw new Error('授权码内容无法读取。');
  }
  return { compact, body: parts[1], signature: fromBase64Url(parts[2]), payload };
}

function verifyLicenseToken(token, publicKey, machineCode, at = Date.now()) {
  try {
    const parsed = parseLicenseToken(token);
    const signatureValid = crypto.verify('sha256', Buffer.from(parsed.body), {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }, parsed.signature);
    if (!signatureValid) return { valid: false, reason: '授权签名无效。' };
    const payload = parsed.payload || {};
    const plan = PLANS[payload.plan];
    if (!plan || payload.product !== 'director-theater') return { valid: false, reason: '授权不属于导演台剧场。' };
    const boundMachine = normalizeMachineCode(payload.machineCode);
    const currentMachine = normalizeMachineCode(machineCode);
    if (!boundMachine || (boundMachine !== '*' && boundMachine !== currentMachine)) {
      return { valid: false, reason: '授权文件与当前电脑不匹配。', payload };
    }
    const startsAtMs = Date.parse(payload.startsAt || payload.issuedAt || '');
    if (Number.isFinite(startsAtMs) && at < startsAtMs) return { valid: false, reason: '授权尚未生效。', payload };
    if (!plan.permanent) {
      const expiresAtMs = Date.parse(payload.expiresAt || '');
      if (!Number.isFinite(expiresAtMs)) return { valid: false, reason: '授权缺少有效期。', payload };
      if (at >= expiresAtMs) return { valid: false, expired: true, reason: '会员已经到期。', payload };
    }
    return { valid: true, payload, plan };
  } catch (error) {
    return { valid: false, reason: error.message || '授权码无法验证。' };
  }
}

function daysRemaining(expiresAt, at = Date.now()) {
  const expiresAtMs = Date.parse(expiresAt || '');
  if (!Number.isFinite(expiresAtMs)) return null;
  return Math.max(0, Math.ceil((expiresAtMs - at) / 86400000));
}

function trialStatus(trial, machineCode, at = Date.now()) {
  const startedAt = trial?.startedAt || new Date(at).toISOString();
  const expiresAt = trial?.expiresAt || new Date(Date.parse(startedAt) + TRIAL_DAYS * 86400000).toISOString();
  const lastSeenAtMs = Date.parse(trial?.lastSeenAt || startedAt);
  const clockTampered = Number.isFinite(lastSeenAtMs) && at + CLOCK_ROLLBACK_TOLERANCE_MS < lastSeenAtMs;
  const active = !clockTampered && at < Date.parse(expiresAt);
  return {
    plan: 'free',
    planLabel: PLANS.free.label,
    active,
    canEdit: active,
    canUseBuiltinTemplates: false,
    permanent: false,
    price: 0,
    priceLabel: '免费试用',
    source: 'trial',
    startedAt,
    expiresAt,
    remainingDays: active ? daysRemaining(expiresAt, at) : 0,
    machineCode: normalizeMachineCode(machineCode),
    clockTampered,
    reason: clockTampered ? '检测到系统时间回退，试用编辑功能已暂停。' : active ? '' : '7天免费试用已经结束。'
  };
}

function licensedStatus(verification, machineCode, at = Date.now()) {
  const payload = verification.payload || {};
  const plan = PLANS[payload.plan] || PLANS.free;
  const active = Boolean(verification.valid);
  return {
    plan: plan.id,
    planLabel: plan.label,
    active,
    canEdit: active,
    canUseBuiltinTemplates: active,
    permanent: plan.permanent,
    price: plan.price,
    priceLabel: plan.internal ? '内部永久授权' : plan.permanent ? `¥${plan.price} 永久` : plan.billingPeriod === 'year' ? `¥${plan.price}/年` : `¥${plan.price}/月`,
    source: 'license',
    licenseId: payload.licenseId || '',
    memberName: payload.memberName || '',
    issuedAt: payload.issuedAt || '',
    startedAt: payload.startsAt || payload.issuedAt || '',
    expiresAt: plan.permanent ? null : payload.expiresAt || null,
    remainingDays: active && !plan.permanent ? daysRemaining(payload.expiresAt, at) : plan.permanent ? null : 0,
    machineCode: normalizeMachineCode(machineCode),
    reason: active ? '' : verification.reason || '会员授权不可用。'
  };
}

function resolveMembership({ trial, token, publicKey, machineCode, at = Date.now() }) {
  const trialResult = trialStatus(trial, machineCode, at);
  if (!token) return trialResult;
  const verification = verifyLicenseToken(token, publicKey, machineCode, at);
  if (verification.valid) return licensedStatus(verification, machineCode, at);
  if (trialResult.active) return { ...trialResult, licenseWarning: verification.reason || '已保存的授权不可用。' };
  return licensedStatus(verification, machineCode, at);
}

module.exports = {
  LICENSE_PREFIX,
  TRIAL_DAYS,
  PLANS,
  normalizeMachineCode,
  signLicensePayload,
  parseLicenseToken,
  verifyLicenseToken,
  trialStatus,
  resolveMembership
};
