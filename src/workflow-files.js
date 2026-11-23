'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inside(project, relative) {
  const root = path.resolve(project.projectPath), dest = path.resolve(root, relative);
  if (!dest.startsWith(root + path.sep)) throw Error('文件必须保存在当前项目内。');
  return dest;
}
async function read(file) { try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(temp, content, 'utf8'); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
async function publish(project, file, content) {
  inside(project, path.relative(project.projectPath, file));
  const before = await read(file);
  let backup = '';
  if (before && before !== content) {
    backup = inside(project, `.ai-director/制作备份/${Date.now()}-${crypto.randomUUID()}/${path.relative(project.projectPath, file)}`);
    await write(backup, before);
  }
  if (before !== content) await write(file, content);
  return { file, backup, hash: hash(content) };
}
function parseJSON(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch { throw Error('模型返回的数据不完整，请重试本步骤。原稿没有被替换。'); }
}
async function listFiles(root) {
  let entries; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(file));
    else if (/\.(txt|md|markdown|docx)$/i.test(entry.name)) out.push(file);
  }
  return out.sort((a,b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}
module.exports = { hash, inside, read, write, publish, parseJSON, listFiles, escapeHTML };
