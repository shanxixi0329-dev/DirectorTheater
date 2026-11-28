'use strict';
const { win32 } = require('node:path');

const folders = { character: '01 人物', scene: '02 场景', prop: '03 道具' };
function fail(code, detail) {
  throw Object.assign(new Error(detail), { code });
}
function segment(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(value))
    fail('INVALID_NAME', '无效的文件名或目录名：' + value);
  if (/^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9]) *(?:\.|$)/i.test(value))
    fail('RESERVED_NAME', 'Windows 保留名：' + value);
  if (value.length > 255) fail('INVALID_NAME', '文件名超过 255 个字符：' + value);
  return value;
}
function relative(value) {
  return String(value).split(/[\\/]/).map(segment).join('/');
}
function categoryOf(row) {
  const category = row.category || row.kind;
  if (!Object.hasOwn(folders, category)) fail('CATEGORY', '未识别的资产分类：' + category);
  return category;
}
function pathInArchive(file, category) {
  const parts = String(file).split(/[\\/]/);
  const index = parts.lastIndexOf(folders[category]);
  return relative((index < 0 ? parts.slice(-1) : parts.slice(index)).join('/'));
}
function coverage(row) {
  const scenes = row.source_scenes ?? [];
  if (!Array.isArray(scenes) || scenes.some(s => typeof s !== 'string' || !s.trim()))
    fail('SOURCE_SCENES', '分场格式无效：' + row.id);
  const values = row.episodes ?? scenes.map(s => Number(/^(\d+)-/.exec(s)?.[1]));
  if (!Array.isArray(values) || !values.length || values.some(n => !Number.isSafeInteger(n) || n < 1))
    fail('EPISODES', '请填写精确的适用集数：' + row.id);
  return { episodes: [...new Set(values)].sort((a, b) => a - b), source_scenes: [...new Set(scenes)] };
}
function displayName(row, category, file) {
  let name = row.name;
  if (!name && file) {
    name = win32.basename(file).replace(/\.png$/i, '').replace(/\s+第\d+集(?:到第\d+集)?$/, '');
  }
  if (!name) name = row.asset;
  segment(name);
  if (!file && !row.relative_path) {
    const details = [row.look, row.view].filter(value => value && !name.includes(value) &&
      !['空场正打', '白底三联', '带尺度道具特写', '道具特写'].includes(value));
    if (details.length) name += '（' + [...new Set(details)].join('·') + '）';
  }
  // Legacy exports sometimes prefix the public name with the internal job or asset ID.
  for (const id of [row.id, row.asset_id].filter(Boolean).sort((a,b) => b.length-a.length)) {
    if (name.startsWith(id) && /^[\s_·-]/.test(name.slice(id.length))) name = name.slice(id.length).replace(/^[\s_·-]+/, '');
  }
  name = name.replace(/^(?:CH|PR|SC)\d+(?:_A\d+)?[\s_·-]+/i, '');
  return segment(name);
}
function targetName(name, episodes) {
  const first = episodes[0], last = episodes.at(-1);
  return segment(name + ' 第' + first + '集' + (last === first ? '' : '到第' + last + '集') + '.png');
}
function validateGraph(jobs) {
  const order = new Map();
  for (const [i, job] of jobs.entries()) {
    if (order.has(job.id)) fail('DUPLICATE_ID', '任务 ID 重复：' + job.id);
    order.set(job.id, i);
  }
  const done = new Set(), visiting = new Set();
  function visit(job) {
    if (done.has(job.id)) return;
    if (visiting.has(job.id)) fail('CYCLE', '母板引用成环：' + job.id);
    visiting.add(job.id);
    for (const ref of job.references) {
      if (!order.has(ref)) fail('MISSING_PARENT', job.id + ' 缺少母板：' + ref);
      visit(jobs[order.get(ref)]);
    }
    visiting.delete(job.id);
    done.add(job.id);
  }
  jobs.forEach(visit);
  for (const job of jobs) for (const ref of job.references) {
    if (order.get(ref) >= order.get(job.id)) fail('PARENT_ORDER', job.id + ' 的母板应排在前面：' + ref);
  }
}
function checkVersion(raw) {
  if (raw?.schemaVersion != null && raw.schemaVersion !== 1) fail('VERSION', '不支持的资产协议版本：' + raw.schemaVersion);
}
function normalizeQueue(raw) {
  checkVersion(raw);
  if (!Array.isArray(raw?.jobs)) fail('QUEUE', '队列需要 jobs 数组');
  const directories = Object.fromEntries(Object.entries(folders).map(([key, fallback]) =>
    [key, relative(raw.folders?.[key] ?? fallback)]));
  const jobs = raw.jobs.map(row => {
    const id = segment(row.id), category = categoryOf(row);
    const { episodes, source_scenes } = coverage(row);
    const name = displayName(row, category, row.output_path);
    const fileName = targetName(name, episodes);
    let directory = directories[category];
    if (!raw.folders?.[category] && row.output_path) {
      const legacy = pathInArchive(row.output_path, category);
      if (legacy.includes('/')) directory = legacy.slice(0, legacy.lastIndexOf('/'));
    }
    if (row.relative_path) {
      const supplied = relative(row.relative_path);
      if (win32.basename(supplied) !== fileName) fail('TARGET_NAME', '目标文件名与名称、集数不符：' + id);
      directory = supplied.split('/').slice(0, -1).join('/');
    }
    const references = row.references ?? [];
    if (!Array.isArray(references)) fail('REFERENCE', '母板引用需要数组：' + id);
    const job = { id, category, name, episodes, source_scenes, references: references.map(segment),
      prompt: row.prompt || '', relative_path: [directory, fileName].filter(Boolean).join('/') };
    for (const key of ['asset', 'asset_id', 'look', 'view', 'scale', 'age', 'gender', 'requested_model', 'size',
      'desired_aspect_ratio', 'background', 'scene_keys', 'expected_sha256', 'actual_model']) {
      if (row[key] != null) job[key] = row[key];
    }
    if (row.reference_images) job.reference_images = row.reference_images.map(relative);
    if (row.existing_name) job.existing_name = segment(row.existing_name);
    return job;
  });
  validateGraph(jobs);
  const targets = new Set();
  for (const job of jobs) {
    const key = job.relative_path.normalize('NFC').toLowerCase();
    if (targets.has(key)) fail('DUPLICATE_TARGET', '归档目标重名：' + job.relative_path);
    targets.add(key);
  }
  return { schemaVersion: 1, project: raw.project || '', folders: directories, jobs };
}
function normalizeManifest(raw) {
  checkVersion(raw);
  const rows = Array.isArray(raw) ? raw : raw?.assets ?? (raw?.id ? [raw] : null);
  if (!Array.isArray(rows)) fail('MANIFEST', '请选择归档清单或已发布的单图回执');
  const seen = new Set(), targets = new Set();
  return rows.map(row => {
    const id = segment(row.id), category = categoryOf(row);
    if (seen.has(id)) fail('DUPLICATE_ID', '归档清单 ID 重复：' + id);
    seen.add(id);
    const location = row.path || row.relative_path;
    if (!location || !/\.png$/i.test(location)) fail('ARCHIVE_PATH', '缺少 PNG 归档路径：' + id);
    const relative_path = row.relative_path ? relative(row.relative_path) :
      win32.isAbsolute(location) ? pathInArchive(location, category) : relative(location);
    if (!/\.png$/i.test(relative_path)) fail('ARCHIVE_PATH', '归档相对路径应指向 PNG：' + id);
    const target = relative_path.normalize('NFC').toLowerCase();
    if (targets.has(target)) fail('DUPLICATE_TARGET', '归档清单目标重名：' + relative_path);
    targets.add(target);
    const name = displayName(row, category, location);
    return { id, category, name, look: row.look || '', view: row.view || '', ...coverage(row),
      state: row.state || 'published', checked_at: row.checked_at || '',
      relative_path, path: row.path && win32.isAbsolute(row.path) ? row.path : '',
      actual_model: row.actual_model || '', sha256: row.sha256 || row.sha256_readback || '' };
  });
}
module.exports = { normalizeQueue, normalizeManifest, validateSegment: segment, relativePath: relative };
