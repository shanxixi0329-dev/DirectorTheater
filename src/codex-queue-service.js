'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { promisify } = require('node:util');
const { normalizeQueue } = require('./asset-batch-schema');
const aiCore = require('./ai-core');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_SCRIPT_CHARS = 36000;
const MAX_SKILL_CHARS = 14000;
const MAX_EXISTING_PROMPTS_CHARS = 12000;
const MAX_MEMORY_CHARS = 4000;

const queueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'jobs'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    jobs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'category', 'name', 'look', 'view',
          'episodes', 'source_scenes', 'prompt', 'references',
          'background', 'desired_aspect_ratio', 'scale'
        ],
        properties: {
          id: { type: 'string', minLength: 1 },
          category: { type: 'string', enum: ['character', 'scene', 'prop'] },
          name: { type: 'string', minLength: 1 },
          look: { type: 'string' },
          view: { type: 'string' },
          episodes: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
          source_scenes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          prompt: { type: 'string', minLength: 1 },
          references: { type: 'array', items: { type: 'string' } },
          background: { type: 'string', enum: ['opaque', 'transparent', 'auto'] },
          desired_aspect_ratio: { type: 'string', enum: ['9:16', '16:9', '1:1', '3:4', '4:3'] },
          scale: { type: 'string' }
        }
      }
    }
  }
};

function addCandidate(list, seen, value) {
  const candidate = String(value || '').trim();
  if (!candidate) return;
  const key = candidate.toLocaleLowerCase();
  if (seen.has(key) || !fsSync.existsSync(candidate)) return;
  seen.add(key);
  list.push(candidate);
}

async function scanUserCodexCandidates() {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    : path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  let entries = [];
  try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { return []; }
  const candidates = [];
  for (const entry of entries.filter(item => item.isDirectory())) {
    const file = path.join(base, entry.name, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try {
      const stat = await fs.stat(file);
      candidates.push({ file, modifiedAt: stat.mtimeMs });
    } catch { /* An incomplete version directory is ignored. */ }
  }
  return candidates.sort((a, b) => b.modifiedAt - a.modifiedAt).map(item => item.file);
}

async function discoverCodex({ preferredPath = '' } = {}) {
  const candidates = [];
  const seen = new Set();
  addCandidate(candidates, seen, preferredPath);
  const pathValue = process.env.Path || process.env.PATH || '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    addCandidate(candidates, seen, path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'));
    if (process.platform !== 'win32') addCandidate(candidates, seen, path.join(directory, 'codex'));
  }
  for (const file of await scanUserCodexCandidates()) addCandidate(candidates, seen, file);
  if (!candidates.length) throw Error('未找到 codex.exe，请先安装 Codex Desktop 或在设置中手动指定路径。');
  const versions = [];
  for (const file of candidates) {
    let version = '';
    let ok = false;
    try {
      const result = await execFileAsync(file, ['--version'], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
      version = String(result.stdout || result.stderr || '').trim();
      ok = Boolean(version);
    } catch (error) {
      version = `版本读取失败：${error.message || error}`;
    }
    versions.push({ path: file, version, ok });
  }
  const selected = versions.find(item => item.ok)?.path || candidates[0];
  return { selected, candidates: versions.map(({ path: p, version }) => ({ path: p, version })) };
}

function truncateText(text, maxChars) {
  const value = String(text || '').replace(/^\uFEFF/, '').trim();
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + `\n...[已截断，原文共 ${value.length} 字]`;
}

function matchEpisodeFileName(fileName, episode) {
  const target = Number(episode);
  if (!Number.isSafeInteger(target) || target < 1) return -1;
  const stem = path.basename(String(fileName || ''), path.extname(String(fileName || ''))).trim();
  const patterns = [
    new RegExp(`^第?0*${target}(?:集|话|章)(?:$|[^0-9])`, 'i'),
    new RegExp(`^(?:EP|E)[_\\-\\s]*0*${target}(?:$|[^0-9])`, 'i'),
    new RegExp(`^0*${target}(?:$|[^0-9])`),
    new RegExp(`(?:^|[^0-9])第?0*${target}(?:集|话|章)(?:$|[^0-9])`, 'i'),
    new RegExp(`(?:^|[^0-9])(?:EP|E)[_\\-\\s]*0*${target}(?:$|[^0-9])`, 'i')
  ];
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(stem)) return i;
  }
  return -1;
}

async function resolveEpisodeScriptFile(scriptDir, episode, preferredFile = '', { forcePreferred = false } = {}) {
  if (preferredFile && fsSync.existsSync(preferredFile)) {
    if (forcePreferred || matchEpisodeFileName(path.basename(preferredFile), episode) >= 0) {
      return { filePath: preferredFile, fileName: path.basename(preferredFile) };
    }
  }
  let entries = [];
  try { entries = await fs.readdir(scriptDir, { withFileTypes: true }); } catch { return { filePath: '', fileName: '' }; }
  const files = entries.filter(entry => entry.isFile() && /\.(?:txt|md|markdown|docx)$/i.test(entry.name));
  const scored = files
    .map(entry => ({
      name: entry.name,
      score: matchEpisodeFileName(entry.name, episode),
      extRank: /\.txt$/i.test(entry.name) ? 0 : /\.md|markdown$/i.test(entry.name) ? 1 : 2
    }))
    .filter(item => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.extRank - b.extRank || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  if (!scored.length) return { filePath: '', fileName: '' };
  return { filePath: path.join(scriptDir, scored[0].name), fileName: scored[0].name };
}

async function readEpisodeFile(scriptDir, episode, preferredFile = '') {
  const resolved = await resolveEpisodeScriptFile(scriptDir, episode, preferredFile);
  return resolved.fileName;
}

async function readDramaAssetSkill(skillRoots) {
  const roots = skillRoots || [
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'drama-asset-production'),
    path.join(os.homedir(), '.agents', 'skills', 'drama-asset-production')
  ];
  for (const root of roots) {
    const skillFile = path.join(root, 'SKILL.md');
    if (!fsSync.existsSync(skillFile)) continue;
    const skillText = await fs.readFile(skillFile, 'utf8').catch(() => '');
    const promptReview = await fs.readFile(path.join(root, 'references', 'prompt-review.md'), 'utf8').catch(() => '');
    const combined = [skillText.trim(), promptReview.trim()].filter(Boolean).join('\n\n---\n\n');
    if (combined) return { path: skillFile, content: truncateText(combined, MAX_SKILL_CHARS) };
  }
  return { path: '', content: '' };
}

function summarizeExistingPrompts(library) {
  if (!library?.categories) return '';
  const lines = [];
  for (const [category, info] of Object.entries(library.categories)) {
    const entries = info?.entries || [];
    if (!entries.length) continue;
    lines.push(`### 现有${info.label || category}提示词（${info.fileName || '本集'}）`);
    for (const entry of entries) {
      const head = [entry.id, entry.name, entry.variant].filter(Boolean).join('｜');
      lines.push(`- ${head}${entry.appliesTo ? `（${entry.appliesTo}）` : ''}：${String(entry.prompt || '').replace(/\s+/g, ' ').slice(0, 260)}`);
    }
  }
  return truncateText(lines.join('\n'), MAX_EXISTING_PROMPTS_CHARS);
}

function buildPrompt({ episode, episodeFile, projectTitle, scriptText = '', skillText = '', existingPrompts = '', projectMemory = '' }) {
  const embedded = Boolean(scriptText);
  const focus = episodeFile
    ? `本次重点处理文件 ${episodeFile}，只整理第 ${episode} 集实际入画或明确需要的资产。`
    : `本次重点整理第 ${episode} 集实际入画或明确需要的资产。`;
  const parts = [
    '执行短剧资产队列准备任务。',
    embedded
      ? '所需剧本正文与 drama-asset-production 规范已完整附在下方。禁止调用任何命令、Shell、脚本、浏览器、MCP 或子代理，也禁止读写任何文件；请直接根据下方材料分析并输出 JSON。'
      : '请使用 drama-asset-production Skill，并读取其中的 SKILL.md 作为资产提示词和归档规则依据。当前工作目录是剧本目录。只读取剧本和 Skill，禁止创建、修改、删除、重命名任何文件，禁止生成图片，禁止使用浏览器、MCP 或子代理。',
    `项目名称：${projectTitle || '当前项目'}。${focus}`,
    '最终只返回符合输出 schema 的 JSON 对象，不要输出 Markdown 代码块或解释文字。',
    '输出 schemaVersion 为 1，并返回 jobs 数组。每个 job 必须包含：id、category、name、look、view、episodes、source_scenes、prompt、references、background、desired_aspect_ratio、scale。',
    '字段规范：',
    '- id：简短稳定的英文/数字/连字符唯一 ID（如 CH01-identity、CH01-outdoor、SC01-front、SC01-four、PR01-cup），不得含非法文件名字符。',
    '- category：只能是 character、scene、prop。',
    '- name：观众可识别的中文名称，不含内部编号前缀，也不含「第X集」。同一分类下名称+造型+视角组合不得重名。',
    '- look：人物造型名或场景状态名（如 身份母板、外出换装、日间常态）；无则填空字符串 ""。',
    '- view：人物写 白底三联，场景正打写 正打，场景四视图写 空间四视图，道具写 道具特写。',
    `- episodes：至少包含 ${episode} 的正整数数组（如 [${episode}]）。`,
    `- source_scenes：每项必须以数字集号开头，例如 "${episode}-1"、"${episode}-2"；若剧本无场号可写 "${episode}-资产"。`,
    '- prompt：可直接投喂给生图模型的完整中文提示词（每条控制在 100–240 字，信息密度高、不重复套话）。人物写清性别、年龄、五官骨相、性格神态、服装鞋帽与白底三联构图（左正面全身、中正面头肩特写、右严格90°侧脸）；场景写清时代、空间布局、光线、机位与固定陈设（四视图需注明图1为正打参考并制作2×2正打/反打/左右侧平视）；道具写清材质、年代、磨损、文字细节与尺度参照。',
    '- references：有母板依赖时填写前面已经出现的 job id（例如人物换装引用身份母板，场景四视图引用同场景正打母板）；无依赖填 []。队列顺序必须保证母板排在派生图前面。',
    '- background：人物与普通场景道具统一填 "opaque"（纯白底或实体背景）；仅明确需要透明底时填 "transparent"。',
    '- desired_aspect_ratio：人物三联推荐 "9:16" 或 "16:9"，场景推荐 "16:9"，道具推荐 "1:1"。',
    '- scale：道具填写尺度参照说明（如 手掌参照、高约10厘米）；非道具填空字符串 ""。',
    '只根据剧本和项目资料中有依据的内容整理资产，禁止为了填数量虚构人物、场景或道具。'
  ];
  if (skillText) {
    parts.push('', '=== 资产生产规范（drama-asset-production） ===', skillText);
  }
  if (projectMemory) {
    parts.push('', '=== 项目记忆与固定设定 ===', projectMemory);
  }
  if (existingPrompts) {
    parts.push('', '=== 现有本集资产提示词（供沿用、校订与查缺补漏） ===', existingPrompts);
  }
  if (scriptText) {
    parts.push('', `=== 第 ${episode} 集剧本正文（${episodeFile || '当前集'}） ===`, scriptText);
  }
  return parts.join('\n');
}

function parseJson(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!value) return null;
  try { return JSON.parse(value); } catch { /* Try locating outer JSON object below. */ }
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(value.slice(first, last + 1)); } catch { return null; }
  }
  return null;
}

function sanitizeQueueSegment(value, fallback = 'item') {
  const clean = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '·')
    .replace(/[. ]+$/, '')
    .trim();
  return clean || fallback;
}

function buildQueueFromAssetsRegistry(registry, { projectTitle = '', episode = null } = {}) {
  const assets = Array.isArray(registry?.assets) ? registry.assets : [];
  const targetEp = Number(episode);
  const filterEp = Number.isSafeInteger(targetEp) && targetEp >= 1 ? targetEp : null;
  const jobs = [];
  const usedIds = new Set();
  const usedTargets = new Set();
  const makeUniqueId = (raw, fallback) => {
    const base = sanitizeQueueSegment(raw || fallback, fallback).replace(/\s+/g, '-').slice(0, 72);
    let id = base;
    let n = 2;
    while (usedIds.has(id.toLowerCase())) id = `${base}-${n++}`;
    usedIds.add(id.toLowerCase());
    return id;
  };
  for (const [assetIndex, asset] of assets.entries()) {
    const cat = asset?.type === 'role' ? 'character' : asset?.type;
    if (!['character', 'scene', 'prop'].includes(cat)) continue;
    const variants = Array.isArray(asset.variants) && asset.variants.length
      ? asset.variants
      : [{ name: cat === 'character' ? '身份母板' : cat === 'scene' ? '日间常态' : '标准外观', prompt: asset.prompt || '', episodes: asset.episodes || [] }];
    const baseName = sanitizeQueueSegment(asset.name, `${cat}-${assetIndex + 1}`);
    const assetEpsAll = (asset.episodes || []).map(Number).filter(n => Number.isSafeInteger(n) && n >= 1);
    if (filterEp && assetEpsAll.length && !assetEpsAll.includes(filterEp)) continue;
    let parentId = '';
    for (const [variantIndex, variant] of variants.entries()) {
      const variantEps = (variant.episodes || assetEpsAll || (filterEp ? [filterEp] : [1]))
        .map(Number).filter(n => Number.isSafeInteger(n) && n >= 1);
      if (filterEp && variantEps.length && !variantEps.includes(filterEp)) {
        if (variantIndex === 0) {
          // Keep L0 parent if any later variant matches this episode.
          const laterMatches = variants.slice(1).some(v => (v.episodes || assetEpsAll).map(Number).includes(filterEp));
          if (!laterMatches) continue;
        } else {
          continue;
        }
      }
      const eps = variantEps.length ? [...new Set(variantEps)].sort((a, b) => a - b) : [filterEp || 1];
      const look = sanitizeQueueSegment(variant.name || (variantIndex === 0 ? (cat === 'character' ? '身份母板' : '常态') : `造型${variantIndex + 1}`), '');
      const view = cat === 'character'
        ? '白底三联'
        : cat === 'scene'
          ? (/四视/.test(look) ? '空间四视图' : '正打')
          : '道具特写';
      const id = makeUniqueId(
        `${asset.id || `${cat.slice(0, 2).toUpperCase()}${assetIndex + 1}`}-${variantIndex === 0 ? 'base' : `v${variantIndex + 1}`}`,
        `${cat}-${assetIndex + 1}-${variantIndex + 1}`
      );
      let name = baseName;
      let dedup = 2;
      const targetKeyOf = (candidateName) => `${cat}|${candidateName}|${look}|${view}|${eps[0]}-${eps.at(-1)}`.toLowerCase();
      while (usedTargets.has(targetKeyOf(name))) {
        name = `${baseName}（版本${dedup++}）`;
      }
      usedTargets.add(targetKeyOf(name));
      const references = (variantIndex > 0 && parentId && cat !== 'prop') ? [parentId] : [];
      if (variantIndex === 0) parentId = id;
      jobs.push({
        id,
        category: cat,
        name,
        look: variantIndex === 0 && cat === 'prop' ? '' : look,
        view,
        episodes: eps,
        source_scenes: eps.map(n => `${n}-资产`),
        prompt: String(variant.prompt || '').trim() || `${baseName}，${look}，${view}`,
        references,
        background: 'opaque',
        desired_aspect_ratio: cat === 'character' ? '9:16' : cat === 'scene' ? '16:9' : '1:1',
        scale: cat === 'prop' ? '标准尺度参照' : ''
      });
    }
  }
  if (!jobs.length) throw Error(filterEp ? `自动制作资产库中还没有第 ${filterEp} 集的资产提示词。` : '自动制作资产库为空，请先运行自动制作或导入提示词。');
  return normalizeQueue(prepareRawQueueForNormalize({ schemaVersion: 1, project: projectTitle, jobs }, { episode: filterEp || undefined, projectTitle }));
}

async function detectMagpieGateway(baseUrl = process.env.MAGPIE_ADDR || 'http://127.0.0.1:3425') {
  const clean = String(baseUrl || 'http://127.0.0.1:3425').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const probe = await aiCore.fetchGatewayModels(`${clean}/v1`, { timeoutMs: 2500 });
  const models = probe.models || [];
  const preferredOrder = [
    'codex/gpt-6.2-sol', 'codex/gpt-6.2-astra', 'group/smart-split',
    'auto/gpt-6.2-sol', 'auto/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro'
  ];
  const recommended = preferredOrder.find(m => models.includes(m))
    || models.find(m => /^codex\//i.test(m))
    || models.find(m => /^group\//i.test(m))
    || models[0]
    || '';
  return {
    online: probe.online,
    baseUrl: clean,
    v1BaseUrl: `${clean}/v1`,
    textModels: models,
    recommendedModel: recommended,
    error: probe.error || ''
  };
}

function parseJsonlEvents(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function extractFinalPayload(lastMessage, events) {
  const direct = parseJson(lastMessage);
  if (direct) return direct;
  for (const event of [...events].reverse()) {
    if (event.type !== 'item.completed' || event.item?.type !== 'agent_message') continue;
    const parsed = parseJson(event.item.text);
    if (parsed) return parsed;
  }
  return null;
}

function eventThreadIds(events) {
  return [...new Set(events.filter(event => event.type === 'thread.started').map(event => event.thread_id).filter(Boolean))];
}

function eventFailureDetail(events) {
  for (const event of [...events].reverse()) {
    if (event.type === 'turn.failed' && event.error?.message) return String(event.error.message);
    if (event.type === 'error' && event.message) return String(event.message);
  }
  return '';
}

function errorDiagnosticsOf(attempt, attemptEvents = []) {
  const parts = [attempt.result?.stderr || '', attempt.error?.message || ''];
  for (const event of attemptEvents) {
    if (event.type === 'turn.failed' && event.error?.message) parts.push(String(event.error.message));
    else if (event.type === 'error' && event.message) parts.push(String(event.message));
  }
  // If no JSONL events were parsed, stdout may contain raw CLI error text.
  if (!attemptEvents.length && attempt.result?.stdout) parts.push(attempt.result.stdout);
  return parts.filter(Boolean).join('\n');
}

function knownReadOnlyFailure(text) {
  return /registered Core process has no package identity|MCP tool call requires approval|Rejected by policy while creating unified exec process/i.test(String(text || ''));
}

function usageLimitFailure(text) {
  return /usage limit|insufficient_quota|\bquota\b|额度耗尽|使用上限|rate[_\s-]*limit|too many requests|http\s*429|status\s*429/i.test(String(text || ''));
}

function authFailure(text) {
  return /unauthorized|invalid[_\s-]*api[_\s-]*key|authentication failed|not logged in|http\s*401|status\s*401/i.test(String(text || ''));
}

function prepareRawQueueForNormalize(raw, { episode, projectTitle } = {}) {
  if (!raw || !Array.isArray(raw.jobs)) return raw;
  const cleaned = raw.jobs.map(item => {
    const job = { ...item };
    if (typeof job.id === 'string') job.id = job.id.trim();
    if (typeof job.name === 'string') job.name = job.name.trim().replace(/[. ]+$/, '');
    if (typeof job.look === 'string') {
      job.look = job.look.trim();
      if (!job.look) delete job.look;
    }
    if (typeof job.view === 'string') {
      job.view = job.view.trim();
      if (!job.view) delete job.view;
    }
    if (typeof job.scale === 'string') {
      job.scale = job.scale.trim();
      if (!job.scale) delete job.scale;
    }
    if (job.background === 'white') job.background = 'opaque';
    if (!job.background) job.background = 'opaque';
    if (!Array.isArray(job.references)) job.references = [];
    else job.references = job.references.map(ref => String(ref || '').trim()).filter(Boolean);
    if (Array.isArray(job.source_scenes)) {
      job.source_scenes = job.source_scenes.map(s => String(s || '').trim()).filter(Boolean);
    }
    if (!job.source_scenes?.length && Number.isSafeInteger(episode) && episode >= 1) {
      job.source_scenes = [`${episode}-资产`];
    }
    if (!Array.isArray(job.episodes) || !job.episodes.length) {
      if (Number.isSafeInteger(episode) && episode >= 1) job.episodes = [episode];
    }
    return job;
  });

  // Topologically reorder valid acyclic references so minor LLM ordering quirks do not waste a valid run.
  const byId = new Map();
  let canSort = true;
  for (const job of cleaned) {
    if (!job.id || byId.has(job.id)) { canSort = false; break; }
    byId.set(job.id, job);
  }
  if (canSort) {
    const visited = new Set();
    const visiting = new Set();
    const ordered = [];
    let validGraph = true;
    const visit = job => {
      if (visited.has(job.id)) return;
      if (visiting.has(job.id)) { validGraph = false; return; }
      visiting.add(job.id);
      for (const ref of job.references) {
        const parent = byId.get(ref);
        if (!parent) { validGraph = false; return; }
        visit(parent);
        if (!validGraph) return;
      }
      visiting.delete(job.id);
      visited.add(job.id);
      ordered.push(job);
    };
    for (const job of cleaned) {
      visit(job);
      if (!validGraph) break;
    }
    if (validGraph && ordered.length === cleaned.length) {
      return { schemaVersion: 1, project: raw.project || projectTitle || '', jobs: ordered };
    }
  }
  return { schemaVersion: 1, project: raw.project || projectTitle || '', jobs: cleaned };
}

function runProcess(file, args, { timeoutMs = DEFAULT_TIMEOUT_MS, input = '', onEvent, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(Object.assign(Error('已取消 Codex 队列准备任务'), { code: 'CODEX_CANCELLED', stdout: '', stderr: '' }));
    }
    const child = spawn(file, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const killChild = () => {
      try { child.kill(); } catch { /* ignore */ }
      if (process.platform === 'win32' && child.pid) {
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.unref();
        } catch { /* ignore */ }
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      reject(Object.assign(Error('已取消 Codex 队列准备任务'), { code: 'CODEX_CANCELLED', stdout, stderr }));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      reject(Object.assign(Error(`Codex 只读任务超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`), { code: 'CODEX_TIMEOUT', stdout, stderr }));
    }, timeoutMs);
    const parseLine = line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { onEvent?.(JSON.parse(trimmed)); } catch { /* Non-JSON diagnostics remain in the raw log. */ }
    };
    const emitLines = text => {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) parseLine(line);
    };
    child.stdout.on('data', chunk => {
      const text = stdoutDecoder.write(chunk);
      stdout += text;
      emitLines(text);
    });
    child.stderr.on('data', chunk => { stderr += stderrDecoder.write(chunk); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once('close', code => {
      const restOut = stdoutDecoder.end();
      if (restOut) { stdout += restOut; emitLines(restOut); }
      stderr += stderrDecoder.end();
      if (buffer.trim()) parseLine(buffer);
      buffer = '';
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout, stderr });
    });
    if (input && child.stdin) {
      child.stdin.on('error', () => { /* Ignore EPIPE if process exits early. */ });
      child.stdin.end(input, 'utf8');
    }
  });
}

async function createRunDirectory(userData, runId) {
  const directory = path.join(userData(), 'codex-queue-runs', runId);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

function createCodexQueueService({
  userData,
  discover = discoverCodex,
  processRunner = runProcess,
  readDocument = file => fs.readFile(file, 'utf8'),
  loadPromptLibrary = null,
  skillRoots = null,
  getConfig = () => ({})
} = {}) {
  if (typeof userData !== 'function') throw Error('Codex 队列服务缺少本机数据目录');
  const activeRuns = new Map();

  function cancel(runId) {
    if (runId) {
      const entry = activeRuns.get(runId);
      if (entry) { entry.controller.abort(); return true; }
      return false;
    }
    let cancelled = false;
    for (const entry of activeRuns.values()) {
      entry.controller.abort();
      cancelled = true;
    }
    return cancelled;
  }

  function isBusy() { return activeRuns.size > 0; }
  function isWindowBusy(owner) {
    return [...activeRuns.values()].some(entry => entry.owner === owner);
  }

  async function prepare(project, options = {}) {
    const episode = Number(options.episode || project.currentEpisode || 1);
    if (!Number.isSafeInteger(episode) || episode < 1) throw Error('请先选择有效的目标集数。');
    const scriptDir = project.folders?.script || path.join(project.projectPath, '03 剧本');
    const explicitScript = String(options.scriptFile || '').trim();
    const preferredScript = explicitScript || project.activeFiles?.script || '';
    const resolvedScript = await resolveEpisodeScriptFile(scriptDir, episode, preferredScript, { forcePreferred: Boolean(explicitScript) });
    const episodeFile = resolvedScript.fileName;
    let scriptText = '';
    if (resolvedScript.filePath) {
      try {
        scriptText = truncateText(await readDocument(resolvedScript.filePath), MAX_SCRIPT_CHARS);
      } catch (error) {
        throw Object.assign(Error(`无法读取第 ${episode} 集剧本文件（${episodeFile}）：${error.message}`), { code: 'SCRIPT_READ_ERROR', cause: error });
      }
    } else if (!options.allowMissingScript) {
      throw Object.assign(Error(`未在剧本目录中找到第 ${episode} 集的剧本文件（${scriptDir}）。`), { code: 'SCRIPT_NOT_FOUND' });
    }

    const skill = await readDramaAssetSkill(skillRoots);
    let existingPrompts = '';
    if (typeof loadPromptLibrary === 'function') {
      try {
        existingPrompts = summarizeExistingPrompts(await loadPromptLibrary(project, episode));
      } catch { /* Existing prompt lookup is optional context. */ }
    }
    const memoryParts = [
      project.memory?.project && `【项目记忆】\n${project.memory.project}`,
      project.memory?.characters && `【角色与素材记忆】\n${project.memory.characters}`,
      project.memory?.continuity && `【剧情连续性】\n${project.memory.continuity}`
    ].filter(Boolean);
    const projectMemory = truncateText(memoryParts.join('\n\n'), MAX_MEMORY_CHARS);

    const runId = `codex-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    activeRuns.set(runId, { owner: options.owner || null, controller });

    const events = [];
    const notify = payload => options.onEvent?.({ runId, ...payload });
    let directory = '';

    try {
      directory = await createRunDirectory(userData, runId);
      const schemaPath = path.join(directory, 'queue-schema.json');
      const lastPath = path.join(directory, 'last-message.json');
      const prompt = buildPrompt({
        episode, episodeFile, projectTitle: project.title,
        scriptText, skillText: skill.content, existingPrompts, projectMemory
      });
      await fs.writeFile(schemaPath, JSON.stringify(queueSchema, null, 2), 'utf8');
      const config = (await getConfig?.()) || {};
      const discovered = await discover({ preferredPath: options.codexPath || config.codexPath || '' });
      const selectedModel = String(options.model || config.codexModel || '').trim();
      const reasoningEffort = String(options.reasoningEffort || config.reasoningEffort || 'low').trim();
      const useUserConfig = options.ignoreUserConfig !== true;

      const buildExecArgs = ({ ignoreUserConfig = false, extraArgs = [] } = {}) => {
        const args = [
          'exec', '--json', '--skip-git-repo-check', '--ephemeral',
          '-s', 'read-only',
          '-c', 'approval_policy="never"',
          '-c', 'mcp_servers={}',
          '-c', 'notify=[]'
        ];
        if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
        if (ignoreUserConfig) args.push('--ignore-user-config');
        if (selectedModel) args.push('-m', selectedModel);
        args.push(
          '-C', scriptDir,
          '--output-schema', schemaPath,
          '-o', lastPath,
          ...extraArgs,
          '-'
        );
        return args;
      };

      const run = async (mode, file, runOptions = {}) => {
        const args = buildExecArgs(runOptions);
        const attemptEvents = [];
        await fs.rm(lastPath, { force: true }).catch(() => {});
        notify({ phase: `${mode}-started`, mode, codexPath: file, scriptDir, episode, episodeFile });
        let result;
        try {
          result = await processRunner(file, args, {
            timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
            input: prompt,
            signal: controller.signal,
            onEvent: event => { attemptEvents.push(event); events.push(event); notify({ phase: 'event', mode, event }); }
          });
        } catch (err) {
          err.attemptEvents = attemptEvents;
          throw err;
        }
        const rawLast = await fs.readFile(lastPath, 'utf8').catch(() => '');
        const parsed = extractFinalPayload(rawLast, attemptEvents);
        const raw = { mode, file, args, result, parsed, attemptEvents };
        await fs.writeFile(path.join(directory, `${mode}-stdout.jsonl`), result.stdout || '', 'utf8');
        await fs.writeFile(path.join(directory, `${mode}-stderr.log`), result.stderr || '', 'utf8');
        await fs.writeFile(path.join(directory, `${mode}-result.json`), JSON.stringify({
          mode, file, exitCode: result.code, parsed, threadIds: eventThreadIds(attemptEvents)
        }, null, 2), 'utf8');
        notify({ phase: `${mode}-finished`, mode, exitCode: result.code, threadIds: eventThreadIds(attemptEvents) });
        return raw;
      };

      const classifyAndThrow = (attempt, error, prefix) => {
        if (attempt.error?.code === 'CODEX_CANCELLED' || error?.code === 'CODEX_CANCELLED') {
          throw Object.assign(Error('已取消 Codex 队列准备任务。'), { code: 'CODEX_CANCELLED', runId });
        }
        const diagnostics = errorDiagnosticsOf(attempt, attempt.attemptEvents || []);
        if (attempt.error?.code === 'CODEX_TIMEOUT') {
          throw Object.assign(Error(attempt.error.message), { code: 'CODEX_TIMEOUT', cause: error, runId, diagnostics });
        }
        if (usageLimitFailure(diagnostics)) {
          throw Object.assign(Error('Codex 当前入口已达到使用上限，请等待额度恢复或在 Codex 设置中切换可用模型后再试。'), {
            code: 'CODEX_QUOTA', cause: error, runId, diagnostics
          });
        }
        if (authFailure(diagnostics)) {
          throw Object.assign(Error('Codex 当前入口认证失败，请检查本机 Codex 登录状态或网关配置。'), {
            code: 'CODEX_AUTH', cause: error, runId, diagnostics
          });
        }
        const eventError = eventFailureDetail(attempt.attemptEvents || events);
        const detail = eventError && !attempt.parsed ? eventError : error.message;
        throw Object.assign(Error(`${prefix}：${detail}`), { cause: error, runId, diagnostics });
      };

      let standard;
      try {
        standard = await run('read-only', discovered.selected, { ignoreUserConfig: !useUserConfig });
      } catch (error) {
        if (error.code === 'CODEX_CANCELLED') throw error;
        standard = {
          mode: 'read-only', file: discovered.selected,
          result: { code: -1, stdout: error.stdout || '', stderr: error.stderr || error.message },
          parsed: null, error, attemptEvents: error.attemptEvents || []
        };
      }

      let queue;
      try {
        queue = normalizeQueue(prepareRawQueueForNormalize(standard.parsed, { episode, projectTitle: project.title }));
      } catch (error) {
        const diagnostics = errorDiagnosticsOf(standard, standard.attemptEvents || []);
        if (standard.error?.code === 'CODEX_CANCELLED' || standard.error?.code === 'CODEX_TIMEOUT' || usageLimitFailure(diagnostics) || authFailure(diagnostics)) {
          classifyAndThrow(standard, error, 'Codex 标准只读入口失败');
        }
        const alternateFile = discovered.candidates.find(item => item.path.toLocaleLowerCase() !== discovered.selected.toLocaleLowerCase())?.path;
        const canRetryCompat = Boolean(options.allowCompatibilityFallback && knownReadOnlyFailure(diagnostics));
        if (!canRetryCompat) {
          classifyAndThrow(standard, error, 'Codex 标准只读入口失败');
        }
        const fallbackFile = discovered.candidates.find(item => !item.path.toLocaleLowerCase().includes('windowsapps'))?.path || alternateFile || discovered.selected;
        notify({ phase: 'compatibility-warning', message: '标准只读入口被 Windows 统一进程策略阻塞，已切换到备用只读入口重试（仍保持 -s read-only）。' });
        let fallback;
        try {
          fallback = await run('compatibility-read-only', fallbackFile, { ignoreUserConfig: !useUserConfig });
        } catch (fallbackErr) {
          if (fallbackErr.code === 'CODEX_CANCELLED') throw fallbackErr;
          fallback = {
            mode: 'compatibility-read-only', file: fallbackFile,
            result: { code: -1, stdout: fallbackErr.stdout || '', stderr: fallbackErr.stderr || fallbackErr.message },
            parsed: null, error: fallbackErr, attemptEvents: fallbackErr.attemptEvents || []
          };
        }
        try {
          queue = normalizeQueue(prepareRawQueueForNormalize(fallback.parsed, { episode, projectTitle: project.title }));
        } catch (fallbackNormErr) {
          classifyAndThrow(fallback, fallbackNormErr, 'Codex 备用只读入口失败');
        }
        return {
          runId, mode: 'compatibility-read-only',
          warning: '标准只读入口未成功返回，本次已通过备用只读入口完成队列准备。',
          codexPath: fallbackFile, versions: discovered.candidates,
          scriptDir, episode, episodeFile, skillPath: skill.path,
          queue, threadIds: eventThreadIds(events), logDirectory: directory
        };
      }

      return {
        runId, mode: 'read-only', warning: '',
        codexPath: discovered.selected, versions: discovered.candidates,
        scriptDir, episode, episodeFile, skillPath: skill.path,
        queue, threadIds: eventThreadIds(events), logDirectory: directory
      };
    } finally {
      activeRuns.delete(runId);
      if (events.length && directory) {
        await fs.writeFile(path.join(directory, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8').catch(() => {});
      }
    }
  }

  async function prepareViaAi(project, options = {}) {
    const episode = Number(options.episode || project.currentEpisode || 1);
    if (!Number.isSafeInteger(episode) || episode < 1) throw Error('请先选择有效的目标集数。');
    const scriptDir = project.folders?.script || path.join(project.projectPath, '03 剧本');
    const explicitScript = String(options.scriptFile || '').trim();
    const preferredScript = explicitScript || project.activeFiles?.script || '';
    const resolvedScript = await resolveEpisodeScriptFile(scriptDir, episode, preferredScript, { forcePreferred: Boolean(explicitScript) });
    const episodeFile = resolvedScript.fileName;
    let scriptText = '';
    if (resolvedScript.filePath) {
      scriptText = truncateText(await readDocument(resolvedScript.filePath), MAX_SCRIPT_CHARS);
    } else if (project.script?.content?.trim()) {
      scriptText = truncateText(project.script.content, MAX_SCRIPT_CHARS);
    } else if (!options.allowMissingScript) {
      throw Object.assign(Error(`未在剧本目录中找到第 ${episode} 集的剧本文件（${scriptDir}）。`), { code: 'SCRIPT_NOT_FOUND' });
    }

    const skill = await readDramaAssetSkill(skillRoots);
    let existingPrompts = '';
    if (typeof loadPromptLibrary === 'function') {
      try { existingPrompts = summarizeExistingPrompts(await loadPromptLibrary(project, episode)); } catch {}
    }
    const memoryParts = [
      project.memory?.project && `【项目记忆】\n${project.memory.project}`,
      project.memory?.characters && `【角色与素材记忆】\n${project.memory.characters}`,
      project.memory?.continuity && `【剧情连续性】\n${project.memory.continuity}`
    ].filter(Boolean);
    const projectMemory = truncateText(memoryParts.join('\n\n'), MAX_MEMORY_CHARS);

    const runId = `aiq-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    activeRuns.set(runId, { owner: options.owner || null, controller });
    const notify = payload => options.onEvent?.({ runId, ...payload });
    let directory = '';

    try {
      directory = await createRunDirectory(userData, runId);
      const cfg = (await getConfig?.()) || {};
      const preferredSource = String(options.source || 'auto').trim(); // 'magpie' | 'project-api' | 'auto'
      const magpieBaseUrl = String(options.magpieBaseUrl || cfg.magpieBaseUrl || process.env.MAGPIE_ADDR || 'http://127.0.0.1:3425').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');

      let runnerConfig = null;
      let modeLabel = '';

      if (preferredSource === 'magpie' || preferredSource === 'auto') {
        notify({ phase: 'magpie-detect', message: `正在检测本机 Magpie 网关（${magpieBaseUrl}）…` });
        const magpieInfo = await detectMagpieGateway(magpieBaseUrl);
        if (magpieInfo.online) {
          const chosenModel = String(options.model || cfg.magpieTextModel || magpieInfo.recommendedModel || 'group/smart-split').trim();
          runnerConfig = aiCore.normalizeRunnerConfig({
            aiRunner: {
              provider: 'magpie',
              baseUrl: magpieInfo.v1BaseUrl,
              model: chosenModel,
              apiKey: '',
              timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
              maxTokens: 16384,
              temperature: 0.3
            }
          });
          modeLabel = `Magpie 网关 (${chosenModel})`;
        } else if (preferredSource === 'magpie') {
          throw Error(`未能连接本机 Magpie 网关（${magpieBaseUrl}）：${magpieInfo.error || '服务未启动'}。请确认 Magpie 正在运行，或切换为项目 LLM API。`);
        }
      }

      if (!runnerConfig) {
        const projectCfg = aiCore.normalizeRunnerConfig(project);
        const problems = aiCore.configProblems(projectCfg);
        if (problems.length) {
          throw Error(`本机 Magpie 网关未启动，且当前项目 LLM API 未配置完整（${problems.join(' ')}）。请启动 Magpie 或到「生成」页配置 API。`);
        }
        runnerConfig = {
          ...projectCfg,
          model: String(options.model || projectCfg.model).trim(),
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          maxTokens: Math.max(12288, Math.min(32768, projectCfg.maxTokens || 16384))
        };
        modeLabel = `项目 API (${runnerConfig.model})`;
      }

      const prompt = buildPrompt({
        episode, episodeFile, projectTitle: project.title,
        scriptText, skillText: skill.content, existingPrompts, projectMemory
      });
      notify({ phase: 'ai-started', mode: modeLabel, episode, episodeFile, detail: `正在通过 ${modeLabel} 分析第 ${episode} 集剧本并生成分层出图队列…` });

      let receivedChars = 0;
      let lastEmit = 0;
      const result = await aiCore.chatCompletion(
        runnerConfig,
        [
          { role: 'system', content: '你是中文短剧与AI漫剧资产制片专家。严格只输出符合要求的纯 JSON 对象（{"schemaVersion":1,"jobs":[...]}），禁止输出任何额外说明或 Markdown 围栏。' },
          { role: 'user', content: prompt }
        ],
        {
          signal: controller.signal,
          temperature: 0.25,
          reasoningEffort: cfg.reasoningEffort || 'low',
          onDelta: (delta) => {
            receivedChars += String(delta || '').length;
            const now = Date.now();
            if (now - lastEmit > 350) {
              lastEmit = now;
              notify({ phase: 'ai-progress', mode: modeLabel, detail: `${modeLabel} 生成中（已接收 ${receivedChars} 字）…` });
            }
          }
        }
      );

      await fs.writeFile(path.join(directory, 'ai-raw.txt'), String(result.content || ''), 'utf8');
      const parsed = parseJson(result.content);
      if (!parsed || !Array.isArray(parsed.jobs) || !parsed.jobs.length) {
        throw Error(`${modeLabel} 返回内容不是有效的资产队列 JSON（缺少 jobs 数组），请重试或切换模型。`);
      }
      const queue = normalizeQueue(prepareRawQueueForNormalize(parsed, { episode, projectTitle: project.title }));
      // Save readable copy inside project .ai-director/asset-queues for traceability.
      let savedQueuePath = '';
      if (project.projectPath) {
        try {
          const queueDir = path.join(project.projectPath, '.ai-director', 'asset-queues');
          await fs.mkdir(queueDir, { recursive: true });
          savedQueuePath = path.join(queueDir, `ep${episode}-queue.json`);
          await fs.writeFile(savedQueuePath, JSON.stringify(queue, null, 2), 'utf8');
        } catch { /* Optional project copy failure does not block queue return. */ }
      }
      notify({ phase: 'ai-finished', mode: modeLabel, detail: `已完成第 ${episode} 集队列整理（共 ${queue.jobs.length} 项）` });
      return {
        runId,
        mode: modeLabel,
        actualModel: result.responseModel || runnerConfig.model,
        warning: '',
        scriptDir,
        episode,
        episodeFile,
        skillPath: skill.path,
        savedQueuePath,
        queue,
        threadIds: [],
        logDirectory: directory
      };
    } finally {
      activeRuns.delete(runId);
    }
  }

  return {
    prepare, prepareViaAi, cancel, isBusy, isWindowBusy,
    discover: discoverCodex, detectMagpie: detectMagpieGateway,
    buildQueueFromRegistry: buildQueueFromAssetsRegistry,
    buildPrompt, schema: queueSchema
  };
}

module.exports = {
  createCodexQueueService, discoverCodex, detectMagpieGateway, buildQueueFromAssetsRegistry,
  buildPrompt, readEpisodeFile, resolveEpisodeScriptFile,
  prepareRawQueueForNormalize, parseJsonlEvents, extractFinalPayload,
  knownReadOnlyFailure, usageLimitFailure, authFailure, queueSchema
};
