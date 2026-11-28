'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256 } = require('./asset-image-utils');
const { relativePath, validateSegment, normalizeQueue } = require('./asset-batch-schema');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
function batchDir(project, id) {
  return path.join(project.projectPath, '.ai-director', 'asset-batches', validateSegment(id));
}
function within(directory, relative) {
  return path.join(directory, relativePath(relative));
}
async function renameWithRetry(from, to) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code) || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.' + randomUUID() + '.part');
  const fd = await fs.open(tmp, 'wx');
  try {
    try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
    await renameWithRetry(tmp, file);
  } finally { await fs.rm(tmp, {force:true}); }
}
const writeJson = (file, data) => atomic(file, JSON.stringify(data, null, 2));
async function maybe(action, fallback) {
  try { return await action(); } catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}
async function checked(file, expected) {
  const bytes = await fs.readFile(file);
  if (!expected || sha256(bytes) !== expected) throw Error('文件指纹不符：' + path.basename(file));
  return bytes;
}
// Only the OS-managed writer lock lives in SQLite. All production state is portable JSON.
// A process exit releases the lock, including a hard exit during a provider request.
async function exclusive(directory, name, action) {
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(path.join(directory, name));
  try {
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) { if (error.errcode === 5 || error.errcode === 6) throw Object.assign(Error('其他窗口或进程正在操作此目录'), {code:'BATCH_BUSY'}); throw error; }
    return await action();
  } finally { db.close(); }
}
async function createBatch(project, id, raw, options) {
  const dest = batchDir(project, id), queue = normalizeQueue(raw);
  if (!options.model || !queue.jobs.length) throw Error('需要批次模型和至少一项任务');
  const unique = new Set();
  for (const job of queue.jobs) {
    const key = job.id.normalize('NFC').toLowerCase();
    if (unique.has(key)) throw Error('任务 ID 在文件系统中重名：' + job.id);
    unique.add(key);
    if (job.requested_model && job.requested_model !== options.model) throw Error('队列与批次模型不符：' + job.id);
  }
  await fs.mkdir(path.dirname(dest), {recursive:true});
  const tmp = await fs.mkdtemp(path.join(path.dirname(dest), '.building-'));
  try {
    for (const sub of ['references','stage','retakes','generation','published']) await fs.mkdir(path.join(tmp,sub));
    const references = [];
    for (const relative of new Set(queue.jobs.flatMap(j => j.reference_images || []))) {
      if (!relative.startsWith('references/')) throw Error('外部参考应位于 references 目录：' + relative);
      const source = options.referenceFiles?.[relative] || (options.sourceDir && within(options.sourceDir, relative));
      if (!source) throw Error('缺少外部参考：' + relative);
      const bytes = await fs.readFile(source), digest = sha256(bytes);
      const file = within(tmp, relative);
      await atomic(file, bytes); await checked(file,digest);
      references.push({path:relative,sha256:digest});
    }
    await writeJson(path.join(tmp,'queue.json'),queue);
    const plan = {schemaVersion:1, requested_model:options.model, ...(options.provider_id ? { provider_id: options.provider_id } : {}), queue_sha256:sha256(await fs.readFile(path.join(tmp,'queue.json'))),
      references, paused:false, pause_reason:''};
    await writeJson(path.join(tmp,'plan.json'),plan);
    for (const job of queue.jobs) await writeJson(path.join(tmp,'generation',job.id+'.json'),{id:job.id,state:'queued'});
    await renameWithRetry(tmp,dest);
  } finally { await fs.rm(tmp,{recursive:true,force:true}); }
  return id;
}
async function loadBatch(dir) {
  const plan = await readJson(path.join(dir,'plan.json'));
  if (plan.schemaVersion !== 1) throw Error('不支持的批次版本');
  const queue = normalizeQueue(JSON.parse(await checked(path.join(dir,'queue.json'),plan.queue_sha256)));
  const jobs = new Map(queue.jobs.map(j => [j.id,j])), cards = new Map();
  for (const id of jobs.keys()) {
    const card = await readJson(path.join(dir,'generation',id+'.json'));
    if (card.id !== id) throw Error('任务状态卡与队列不符：'+id);
    cards.set(id,card);
  }
  return { dir, plan, jobs, cards };
}
async function listBatchIds(project) {
  const root = path.join(project.projectPath, '.ai-director', 'asset-batches');
  const entries = await maybe(() => fs.readdir(root, { withFileTypes: true }), []);
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const hasPlan = await maybe(() => fs.access(path.join(root, entry.name, 'plan.json')).then(() => true), false);
    if (hasPlan) ids.push(entry.name);
  }
  return ids.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
async function saveCard(batch, card) {
  await writeJson(path.join(batch.dir,'generation',card.id+'.json'),card);
  batch.cards.set(card.id,card);
}
const savePlan = batch => writeJson(path.join(batch.dir,'plan.json'),batch.plan);
const receiptFile = (b,id) => path.join(b.dir,'published',validateSegment(id)+'.json');
async function flagStaleReceipt(batch,id) {
  const file=receiptFile(batch,id), receipt=await maybe(()=>readJson(file));
  if (!receipt || receipt.state==='stale_parent') return false;
  await writeJson(file,{...receipt,state:'stale_parent'});
  return true;
}
async function writeManifest(batch) {
  const assets=[];
  for (const id of batch.jobs.keys()) {
    const receipt=await maybe(()=>readJson(receiptFile(batch,id)));
    if (receipt) assets.push(receipt);
  }
  await writeJson(path.join(batch.dir,'图片生成与归档清单.json'),{schemaVersion:1,assets});
}

async function archiveTarget(root, relative) {
  const parts = relativePath(relative).split('/');
  let base = root;
  // Creating directories one level at a time prevents a preexisting nested junction from
  // redirecting published images outside the user's chosen library.
  for (const part of parts.slice(0,-1)) {
    base = path.join(base,part);
    try { await fs.mkdir(base); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(base);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('归档目录无效：'+part);
  }
  const target = path.join(base,parts.at(-1));
  if ((await maybe(()=>fs.lstat(target)))?.isSymbolicLink()) throw Error('归档目标不能是链接');
  return target;
}
async function identical(file, hash, allowedPriorHash = '') {
  const original = await maybe(()=>fs.readFile(file));
  if (!original) return false;
  const currentHash = sha256(original);
  if (currentHash === hash) return true;
  if (allowedPriorHash && currentHash === allowedPriorHash) return false;
  throw Error('归档同名文件内容不同：'+path.basename(file));
}
async function publish(batch, ids, root) {
  await fs.mkdir(root,{recursive:true});
  return exclusive(root,'.director-publish.sqlite', async ()=>{
    const pending = [];
    for (const id of ids) {
      const card = batch.cards.get(id), job = batch.jobs.get(id);
      if (!card?.accepted || !['staged','published'].includes(card.state)) throw Error('需先验收当前版本：'+id);
      const target = await archiveTarget(root,job.relative_path);
      await checked(within(batch.dir,card.stage_path),card.sha256);
      const priorReceipt = await maybe(() => readJson(receiptFile(batch, job.id)));
      const allowedPriorHash = priorReceipt?.relative_path === job.relative_path ? (priorReceipt.sha256 || '') : '';
      pending.push({job,card,target,allowedPriorHash,exists:await identical(target,card.sha256,allowedPriorHash)});
    }
    for (const {job,card,target,allowedPriorHash,exists} of pending) {
      if (!exists) {
        const temp = path.join(path.dirname(target),'.'+randomUUID()+'.part');
        try {
          await fs.copyFile(within(batch.dir,card.stage_path),temp,fs.constants.COPYFILE_EXCL);
          await checked(temp,card.sha256);
          if (!await identical(target,card.sha256,allowedPriorHash)) await renameWithRetry(temp,target);
        } finally { await fs.rm(temp,{force:true}); }
      }
      await checked(target,card.sha256);
      const receipt = {id:job.id, state:'published', category:job.category, name:job.name, look:job.look, view:job.view,
        episodes:job.episodes, source_scenes:job.source_scenes, relative_path:job.relative_path,
        sha256:card.sha256, dimensions:card.dimensions, requested_model:batch.plan.requested_model,
        actual_model:card.actual_model,parent_hashes:card.parent_hashes || {},checked_at:new Date().toISOString()};
      await writeJson(receiptFile(batch,job.id),receipt);
      await saveCard(batch,{...card,state:'published'});
    }
    await writeManifest(batch);
    return ids;
  });
}
module.exports = { batchDir, within, atomic, writeJson, checked, exclusive, createBatch, loadBatch, listBatchIds, saveCard, savePlan, publish, flagStaleReceipt, writeManifest };
