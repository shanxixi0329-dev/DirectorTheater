'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const slots = require('./episode-slots');
const { spreadsheet, esc } = require('./review-export');
const EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.ts', '.mts', '.m2ts']);
const stamp = () => new Date().toISOString();
const timeLabel = (n) => { n = Math.max(0, Number(n) || 0); return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${(n % 60).toFixed(2).padStart(5, '0')}`; };
function identifyEpisode(project, filename) {
  const name = filename.replace(/\.[^.]+$/, '');
  const match = name.match(/(?:第\s*|EP[\s_-]*)(\d{1,4})\s*(?:集|话)?\s*(上|下)?/i)
    || name.match(/^(\d{1,4})\s*(?:集|话)\s*(上|下)?/)
    || name.match(/^(\d{1,4})\s*(?:集|话)?\s*(上|下)?(?:$|[\s_\-（(])/);
  if (!match) return null;
  const key = Number(match[1]) + (match[2] === '下' ? 0.5 : 0);
  // 视频文件名可以先于项目拆集：保留“第17集下”的归类，用户之后仍可在项目中拆分或手动调整。
  // 审片视频可能先于项目集数计划生成，文件名本身仍是可靠的集数来源。
  // 先按项目已有集数校验，校验不到时保留正整数及其“下”半集，避免整批视频变成未匹配。
  return key > 0 ? key : null;
}
function createReviewService() {
  const queues = new Map();
  const preferredRootOf = (project) => {
    if (!project?.projectPath || !path.isAbsolute(project.projectPath)) throw Error('请先打开项目。');
    return path.join(project.projectPath, '07 AI规则与记忆', '审片意见');
  };
  const legacyRootOf = (project) => path.join(project.projectPath, '审片意见');
  const rootOf = (project) => {
    const preferred = preferredRootOf(project);
    try { if (fsSync.existsSync(preferred)) return preferred; } catch {}
    try { if (fsSync.existsSync(legacyRootOf(project))) return legacyRootOf(project); } catch {}
    return preferred;
  };
  async function read(project) {
    const roots = [...new Set([rootOf(project), preferredRootOf(project), legacyRootOf(project)])];
    for (const root of roots) {
      try {
        const db = JSON.parse(await fs.readFile(path.join(root, '审片记录.json'), 'utf8'));
        if (!Array.isArray(db.videos) || !Array.isArray(db.notes)) throw Error('记录格式不正确');
        return { ...db, storageRoot: root };
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw Error(`审片记录读取失败，请保留文件并检查：${e.message}`);
      }
    }
    return { version: 1, folder: '', videos: [], notes: [], storageRoot: preferredRootOf(project) };
  }
  async function write(project, db) {
    const root = preferredRootOf(project), sourceRoot = db.storageRoot || rootOf(project);
    await fs.mkdir(root, { recursive: true });
    if (sourceRoot !== root) {
      for (const note of db.notes || []) {
        if (!note.screenshot) continue;
        const from = path.join(sourceRoot, note.screenshot), to = path.join(root, note.screenshot);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    db.storageRoot = root;
    db.updatedAt = new Date(Math.max(Date.now(), (Date.parse(db.updatedAt) || 0) + 1)).toISOString();
    const persisted = { ...db }; delete persisted.storageRoot;
    const dest = path.join(root, '审片记录.json'), temp = `${dest}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(persisted, null, 2), 'utf8');
    await fs.copyFile(dest, `${dest}.bak`).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    await fs.rename(temp, dest);
  }
  function present(project, db) {
    const root = db.storageRoot || rootOf(project);
    return { ...db, root, videos: db.videos.map((v) => ({ ...v, url: pathToFileURL(v.path).href,
      needsRevision: v.status === 'issues' && !db.notes.some((n) => !n.deleted && n.videoId === v.id),
      openCount: db.notes.filter((n) => !n.deleted && n.videoId === v.id && !n.resolved).length })),
    notes: db.notes.filter((n) => !n.deleted).map((n) => ({ ...n, screenshotUrl: n.screenshot ? pathToFileURL(path.join(root, n.screenshot)).href : '' })) };
  }
  async function load(project) { return present(project, await read(project)); }
  async function scan(project, db, folder) {
    const directory = path.resolve(folder), found = [], warnings = [];
    const info = await fs.stat(directory); if (!info.isDirectory()) throw Error('请选择视频文件夹。');
    async function visit(current) {
      let entries;
      try { entries = await fs.readdir(current, { withFileTypes: true }); }
      catch (e) { warnings.push(`无法读取 ${current}：${e.message}`); return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (EXTENSIONS.has(path.extname(file).toLowerCase())) {
          const id = crypto.createHash('sha256').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 24);
          const prior = db.videos.find((v) => v.id === id);
          const detectedEpisode = identifyEpisode(project, entry.name);
          found.push({ id, path: file, name: entry.name, relative: path.relative(directory, file), status: 'pending', ...prior,
            // 手动归类优先；旧记录仍是 null 时，允许新规则按文件名补回集数。
            episode: prior?.episode != null ? prior.episode : detectedEpisode, missing: false });
        }
      }
    }
    await visit(directory);
    if (warnings.length && !found.length) throw Error(warnings.join('\n'));
    const ids = new Set(found.map((v) => v.id));
    // Keep records for previous versions, including their screenshots and decisions.
    db.videos = [...found, ...db.videos.filter((v) => !ids.has(v.id)).map((v) => ({ ...v, missing: true }))]
      .sort((a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    db.folder = directory; db.warnings = warnings;
  }
  async function mutate(project, input) {
    const db = await read(project), video = db.videos.find((v) => v.id === input.videoId);
    if (input.action === 'scan') await scan(project, db, input.folder || db.folder);
    else if (input.action === 'assign') {
      if (!video) throw Error('视频不存在。');
      const episode = input.episode === '' || input.episode == null ? null : Number(input.episode);
      if (episode != null && (!Number.isFinite(episode) || episode <= 0)) throw Error('请选择有效的集数。');
      video.episode = episode;
    } else if (input.action === 'status') {
      if (!video || !['pending', 'passed', 'issues'].includes(input.status)) throw Error('审核状态不正确。');
      if (input.status === 'passed' && db.notes.some((n) => !n.deleted && n.videoId === video.id && !n.resolved)) throw Error('还有未解决的意见。请先逐条确认已解决，再审核通过。');
      video.status = input.status; video.reviewedAt = stamp();
    } else if (input.action === 'note') {
      if (!video) throw Error('请先选择视频。');
      const text = String(input.text || '').trim(), prompt = String(input.prompt || '').trim();
      if (!text && !prompt) throw Error('请填写问题描述或提示词修改意见。');
      const current = input.id ? db.notes.find((n) => n.id === input.id && !n.deleted && n.videoId === video.id) : null;
      if (input.id && !current) throw Error('这条意见不存在。');
      if (current && input.updatedAt && input.updatedAt !== current.updatedAt) throw Error('这条审片意见已在其他窗口更新。本窗草稿已保留，请重新打开最新意见后核对。');
      const note = current || { id: crypto.randomUUID(), videoId: video.id, createdAt: stamp(), resolved: false };
      const seconds = Number(input.seconds); if (!Number.isFinite(seconds) || seconds < 0) throw Error('时间点不正确。');
      note.seconds = seconds; note.text = text; note.prompt = prompt;
      if(input.shotId!==undefined){note.shotId=String(input.shotId||'');note.shotLabel=String(input.shotLabel||'');note.shotFile=String(input.shotFile||'');}
      note.category = ['画面', '剧情', '台词', '声音', '字幕', '提示词', '其他'].includes(input.category) ? input.category : '其他';
      note.updatedAt = new Date(Math.max(Date.now(), (Date.parse(note.updatedAt) || 0) + 1)).toISOString();
      if (input.screenshot) {
        const data = String(input.screenshot);
        if (!data.startsWith('data:image/png;base64,') || data.length > 24 * 1024 * 1024) throw Error('截图格式不正确或过大。');
        const png = Buffer.from(data.slice(22), 'base64');
        if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('截图不是 PNG。');
        const dir = path.join(rootOf(project), '截图'); await fs.mkdir(dir, { recursive: true });
        note.screenshot = path.join('截图', `${note.id}.png`);
        await fs.writeFile(path.join(rootOf(project), note.screenshot), png);
      }
      if (!current) db.notes.push(note);
      if (!note.resolved) video.status = 'issues';
    } else if (input.action === 'resolve' || input.action === 'delete') {
      const note = db.notes.find((n) => n.id === input.id && !n.deleted);
      if (!note) throw Error('这条意见不存在。');
      if (input.action === 'delete') note.deleted = true; else note.resolved = Boolean(input.resolved);
      note.updatedAt = stamp();
      const linked = db.videos.find((v) => v.id === note.videoId);
      if (linked && !note.resolved && !note.deleted) linked.status = 'issues';
    } else throw Error('未知审片操作。');
    await write(project, db); return present(project, db);
  }
  function act(project, input) {
    const key = rootOf(project), prior = queues.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(() => mutate(project, input));
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  }
  async function exportReport(project, options = {}) {
    const scope = options.scope || 'issues';
    if (!['issues', 'passed', 'all'].includes(scope)) throw Error('请选择正确的审片导出范围。');
    const db = await read(project), scopeLabel = { issues: '待整改', passed: '已通过', all: '全部视频' }[scope];
    const videos = db.videos.filter((video) => {
      if (video.missing && options.includeHistory !== true) return false;
      const hasOpen = db.notes.some((note) => !note.deleted && !note.resolved && note.videoId === video.id);
      return scope === 'all' || (scope === 'issues' ? hasOpen || video.status === 'issues' : video.status === 'passed' && !hasOpen);
    }).sort((a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    if (!videos.length) return { empty: true, directory: null, count: 0, videoCount: 0, scope, scopeLabel };
    const directory = path.join(rootOf(project), '导出', `审片意见-${scopeLabel}-${stamp().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
    await fs.mkdir(directory, { recursive: true });
    const rows = [['集数', '视频文件', '审核状态', '时间点', '问题描述', '提示词修改意见', '截图文件', '意见状态', '记录时间']];
    const cards = [];
    for (const video of videos) {
      const notes = db.notes.filter((n) => !n.deleted && n.videoId === video.id).sort((a, b) => a.seconds - b.seconds);
      const label = video.episode == null ? '未匹配集数' : `第${slots.label(project, video.episode)}集`;
      const status = notes.some((n) => !n.resolved) ? '有待解决意见' : ({ pending: '待审', passed: '审核通过', issues: notes.length ? '待复核' : '需修改' }[video.status] || '待审');
      const includedNotes = scope === 'issues' ? notes.filter((note) => !note.resolved) : notes;
      const summary = scope === 'issues' ? (notes.length ? '已记录的意见已解决，请复核视频后确认通过。' : '已标记需修改，尚未添加详细意见。') : '';
      for (const note of includedNotes.length ? includedNotes : [null]) {
        let image = '';
        if (note?.screenshot) {
          image = `截图/${note.id}.png`;
          await fs.mkdir(path.join(directory, '截图'), { recursive: true });
          await fs.copyFile(path.join(rootOf(project), note.screenshot), path.join(directory, image));
        }
        rows.push([label, video.relative || video.name, status + (video.missing ? ' · 历史版本' : ''), note ? timeLabel(note.seconds) : '', (note?.shotLabel?'【镜头 '+note.shotLabel+'】\n':'')+(note?.text || summary), note?.prompt || '', image, note ? (note.resolved ? '已解决' : '待解决') : '', note?.createdAt || video.reviewedAt || '']);
        cards.push(`<article><h2>${esc(label)} · ${esc(video.relative || video.name)}</h2><p>${esc(status)}${video.missing ? ' · 历史版本' : ''}${note ? ` · ${timeLabel(note.seconds)} · ${note.resolved ? '已解决' : '待解决'}` : ''}</p>${image ? `<img src="${image}" alt="视频截图"/>` : ''}<h3>问题描述</h3><pre>${esc((note?.shotLabel?'【镜头 '+note.shotLabel+'】\n':'')+(note?.text || summary || '无'))}</pre>${note?.prompt ? `<h3>提示词修改意见</h3><pre>${esc(note.prompt)}</pre>` : ''}</article>`);
      }
    }
    await fs.writeFile(path.join(directory, '审片意见.xlsx'), spreadsheet(rows));
    await fs.writeFile(path.join(directory, '审片意见.csv'), '\uFEFF' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""').replace(/^[=+@-]/, "'$&")}"`).join(',')).join('\r\n'), 'utf8');
    await fs.writeFile(path.join(directory, '审片意见.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(project.title)} 审片意见 · ${scopeLabel}</title><style>body{font:16px/1.6 system-ui;background:#f4f5f7;color:#19212b;max-width:1100px;margin:32px auto;padding:0 20px}article{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}img{max-width:100%;max-height:460px}pre{white-space:pre-wrap;font:inherit}h2{font-size:20px}@media print{article{break-inside:avoid}}</style><h1>${esc(project.title)} · 审片意见 · ${scopeLabel}</h1><p>导出时间：${esc(stamp())} · ${videos.length} 个视频 · ${rows.length - 1} 条记录 · ${options.includeHistory === true ? '包含历史版本' : '仅当前视频'}；可打印为 PDF。</p>${cards.join('')}</html>`, 'utf8');
    return { directory, count: rows.length - 1, videoCount: videos.length, scope, scopeLabel, empty: false };
  }
  return { load, act, exportReport, rootOf };
}
module.exports = { createReviewService, identifyEpisode, timeLabel, EXTENSIONS };
