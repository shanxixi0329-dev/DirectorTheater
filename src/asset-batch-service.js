'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const disk = require('./asset-batch-storage');
const {prepareImage} = require('./asset-image-utils');

const now = () => new Date().toISOString();
const visible = (b, { includePrompts = false } = {}) => ({
  requested_model: b.plan.requested_model, provider_id: b.plan.provider_id || '', paused: b.plan.paused,
  pause_reason: b.plan.pause_reason,
  jobs: Array.from(b.jobs.values()).map(job => includePrompts ? { ...job } : (({ prompt, ...rest }) => rest)(job)),
  cards: Array.from(b.cards.values())
});
const usable = card => card?.accepted && ['staged','published'].includes(card.state);
function selected(batch, ids) {
  if (ids == null) return [...batch.jobs.keys()];
  if (!Array.isArray(ids) || ids.some(id=>!batch.jobs.has(id))) throw Error('批次中没有所选任务');
  return [...new Set(ids)];
}
async function reconcile(batch) {
  const stale = [];
  let receiptsChanged = false;
  // Queue order is topological, so a changed ancestor propagates through every level.
  for (const job of batch.jobs.values()) {
    const c = batch.cards.get(job.id);
    if (!['staged','published','stale_parent'].includes(c.state)) continue;
    const mismatch = job.references.some(id => {
      const parent = batch.cards.get(id);
      return parent.state === 'stale_parent' || !c.parent_hashes?.[id] || c.parent_hashes[id] !== parent.sha256;
    });
    if (mismatch && c.state !== 'stale_parent') await disk.saveCard(batch,{...c,state:'stale_parent',accepted:false});
    if (mismatch || c.state === 'stale_parent') {
      stale.push(job.id);
      if (await disk.flagStaleReceipt(batch,job.id)) receiptsChanged=true;
    }
  }
  if (receiptsChanged) await disk.writeManifest(batch);
  return stale;
}
async function recover(batch) {
  for (const c of batch.cards.values()) {
    if (c.state === 'submitting') await disk.saveCard(batch,{...c,state:c.provider_id?'pending':'uncertain',reason:'上次提交中断'});
  }
  await reconcile(batch);
}
async function inputFiles(batch,job) {
  const files = [], pairs = [];
  for (const id of job.references) {
    const parent = batch.cards.get(id);
    if (!usable(parent)) throw Error('母板尚未验收：'+id);
    const file = disk.within(batch.dir,parent.stage_path);
    await disk.checked(file,parent.sha256);
    files.push(file); pairs.push([id,parent.sha256]);
  }
  for (const relative of job.reference_images || []) {
    const expected = batch.plan.references.find(ref=>ref.path===relative);
    if (!expected) throw Error('参考图未登记：'+relative);
    const file = disk.within(batch.dir,relative);
    await disk.checked(file,expected.sha256); files.push(file);
  }
  return { files, parent_hashes:Object.fromEntries(pairs) };
}
async function stage(batch,job,card,prepared,model,origin) {
  const {info,bytes} = prepared;
  const version = randomUUID(), relative = 'stage/'+job.id+'/'+version+'.png';
  await disk.atomic(disk.within(batch.dir,relative),bytes);
  await disk.checked(disk.within(batch.dir,relative),info.sha256);
  if (card.stage_path && card.sha256 !== info.sha256) {
    const previous = await disk.checked(disk.within(batch.dir,card.stage_path),card.sha256);
    await disk.atomic(disk.within(batch.dir,'retakes/'+job.id+'/'+version+'.png'),previous);
  }
  // Publish the pointer only after both images are durable. A crash leaves at most an
  // unreferenced version; it never points an accepted card at replacement pixels.
  await disk.saveCard(batch,{...card,state:'staged',stage_path:relative,sha256:info.sha256,
    dimensions:[info.width,info.height],actual_model:model,origin,accepted:false,provider_id:null,
    last_provider_id:card.provider_id || card.last_provider_id || null,resume_poll:false,reason:'',updated_at:now()});
}

function createAssetBatchService({archiveLibrary, nativeImage} = {}) {
  const active = new Map();
  async function mutate(project,id,owner,action) {
    const dir = disk.batchDir(project,id), key = path.resolve(dir).toLowerCase();
    if (active.has(key)) throw Object.assign(Error('本批次正在运行'),{code:'BATCH_BUSY'});
    let finish;
    const task = {owner,stop:false,finished:new Promise(resolve=>{finish=resolve;})};
    active.set(key,task);
    try {
      return await disk.exclusive(dir,'.batch-writer.sqlite',async()=>{
        const batch = await disk.loadBatch(dir);
        await recover(batch);
        return action(batch,task);
      });
    } finally { active.delete(key); finish(); }
  }
  async function change(project,id,jobId,fn) {
    return mutate(project,id,null,async batch=>{
      selected(batch,[jobId]);
      return fn(batch,batch.cards.get(jobId),batch.jobs.get(jobId));
    });
  }
  async function run(project,id,driver,options={}) {
    if (typeof driver?.submit !== 'function' || typeof driver?.poll !== 'function') throw Error('批次需要提交和查询驱动');
    const limit = options.concurrency ?? 3;
    if (!Number.isSafeInteger(limit) || limit<1 || limit>32) throw Error('并发数应为 1–32');
    return mutate(project,id,options.owner,async (batch,task)=>{
      const {plan,cards,jobs} = batch, ids = selected(batch,options.ids);
      if (plan.paused && !options.resume) return visible(batch);
      if (plan.paused) { plan.paused=false; plan.pause_reason=''; await disk.savePlan(batch); }
      let pauseWrite;
      function trip(reason) {
        task.stop=true;
        if (!pauseWrite) {
          plan.paused=true; plan.pause_reason=reason;
          pauseWrite=disk.savePlan(batch);
        }
        return pauseWrite;
      }
      async function handleError(c,error,polling) {
        const code=error.code, reason=String(error.message || code || '图像驱动返回错误');
        const ticket=c.provider_id || error.provider_id;
        if (ticket && !c.provider_id) {
          c={...c,state:'pending',provider_id:ticket};
          await disk.saveCard(batch,c);
        }
        let state;
        if (code==='UNAUTHORIZED' || [401,403].includes(error.status)) {
          await trip('账号未授权'); state='needs_review';
        } else if (code==='MODERATION') state='needs_review';
        else if (code==='QUOTA' || error.status===429 || code===429) {
          await trip('限流或额度耗尽'); state=ticket?'pending':'deferred';
        } else state=ticket || polling ? 'pending':'uncertain';
        await disk.saveCard(batch,{...c,state,provider_id:ticket || null,reason,
          resume_poll:Boolean(ticket && state==='needs_review' && code!=='MODERATION')});
      }
      async function result(job,c,response) {
        if (c.provider_id && response?.provider_id && c.provider_id!==response.provider_id) {
          await trip('查询返回了其他任务号');
          return disk.saveCard(batch,{...c,state:'needs_review',reason:plan.pause_reason,resume_poll:true});
        }
        // A provider ticket must reach disk before decoding or handling any image data.
        if (response?.provider_id && !c.provider_id) {
          c={...c,state:'pending',provider_id:response.provider_id};
          await disk.saveCard(batch,c);
        }
        if (response?.actual_model && response.actual_model!==plan.requested_model) {
          await trip('返回模型与批次设定不符');
          return disk.saveCard(batch,{...c,state:'needs_review',actual_model:response.actual_model,reason:plan.pause_reason});
        }
        if (response?.status==='pending' && c.provider_id) return;
        if (response?.status!=='ready') return handleError(c,Error('供应端结果不明'),Boolean(c.provider_id));
        if (!response.actual_model) {
          await trip('供应端未确认实际模型');
          return disk.saveCard(batch,{...c,state:'needs_review',reason:plan.pause_reason});
        }
        let image;
        try { image=prepareImage(response.bytes,job,nativeImage); }
        catch(error) { return disk.saveCard(batch,{...c,state:'needs_review',actual_model:response.actual_model,reason:'图片校验失败：'+error.message}); }
        await stage(batch,job,c,image,response.actual_model,'provider');
      }
      async function one(jobId,polling) {
        const job=jobs.get(jobId);
        let c=cards.get(jobId), response;
        if (polling) {
          try { response=await driver.poll({id:jobId,provider_id:c.provider_id,attempt_id:c.attempt_id,requested_model:plan.requested_model}); }
          catch(error){ return handleError(c,error,true); }
        } else {
          const refs=await inputFiles(batch,job);
          if (task.stop) return;
          c={...c,state:'submitting',requested_model:plan.requested_model,attempt_id:randomUUID(),started_at:now(),
            provider_id:null,reason:'',parent_hashes:refs.parent_hashes};
          await disk.saveCard(batch,c);
          if (task.stop) { await disk.saveCard(batch,{...c,state:'queued'}); return; }
          try { response=await driver.submit({...job,prompt:c.prompt_override ?? job.prompt,requested_model:plan.requested_model,
            attempt_id:c.attempt_id,reference_files:refs.files}); }
          catch(error){ return handleError(c,error,false); }
        }
        await result(job,c,response);
      }
      async function wave(group,polling) {
        const results=await Promise.allSettled(group.map(jobId=>one(jobId,polling)));
        options.onProgress?.({ batchId: id, ...visible(batch, { includePrompts: true }) });
        const failed=results.find(r=>r.status==='rejected');
        if (failed) throw failed.reason;
      }
      // Poll all durable tickets first, even if a narrower set of new jobs is selected.
      const pending=[...cards.values()].filter(c=>c.state==='pending');
      for (let i=0;i<pending.length && !task.stop;i+=limit) await wave(pending.slice(i,i+limit).map(c=>c.id),true);
      await reconcile(batch);
      while (!task.stop) {
        const ready=ids.filter(key=>cards.get(key).state==='queued' && jobs.get(key).references.every(ref=>usable(cards.get(ref)))).slice(0,limit);
        if (!ready.length) break;
        await wave(ready,false);
        await reconcile(batch);
      }
      if (task.stop) await trip(plan.pause_reason || '人工暂停');
      const finalSnapshot = visible(batch, { includePrompts: true });
      options.onProgress?.({ batchId: id, ...finalSnapshot });
      return finalSnapshot;
    });
  }
  async function inspect(project,id,options={}) {
    const includePrompts = options.includePrompts !== false;
    try { return await mutate(project,id,null,b=>visible(b,{includePrompts})); }
    catch(error){ if(error.code!=='BATCH_BUSY')throw error; return visible(await disk.loadBatch(disk.batchDir(project,id)),{includePrompts}); }
  }
  async function list(project) {
    const result = [];
    for (const id of await disk.listBatchIds(project)) {
      try { result.push({ id, ...(await inspect(project, id, { includePrompts: false })) }); }
      catch (error) { result.push({ id, error: error.message || String(error) }); }
    }
    return result;
  }
  async function preview(project, id, jobId, { thumbnail = false, maxWidth = 420 } = {}) {
    const readPreview = async batch => {
      const card = batch.cards.get(jobId);
      if (!card?.stage_path) throw Error('当前任务还没有暂存图片');
      const bytes = await disk.checked(disk.within(batch.dir, card.stage_path), card.sha256);
      if (thumbnail && nativeImage?.createFromBuffer) {
        try {
          const img = nativeImage.createFromBuffer(bytes);
          if (img && !img.isEmpty()) {
            const size = img.getSize();
            const thumb = size.width > maxWidth ? img.resize({ width: maxWidth, quality: 'good' }) : img;
            const jpeg = thumb.toJPEG(82);
            if (jpeg?.length) {
              return { dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'), sha256: card.sha256, dimensions: card.dimensions, thumbnail: true };
            }
          }
        } catch { /* Fall back to original PNG below. */ }
      }
      return { dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), sha256: card.sha256, dimensions: card.dimensions };
    };
    try { return await mutate(project, id, null, readPreview); }
    catch (error) {
      if (error.code !== 'BATCH_BUSY') throw error;
      return readPreview(await disk.loadBatch(disk.batchDir(project, id)));
    }
  }
  function accept(project,id,jobId) {
    return change(project,id,jobId,async (b,c)=>{
      if(c.state!=='staged')throw Error('仅可验收当前暂存图');
      await disk.checked(disk.within(b.dir,c.stage_path),c.sha256);
      await disk.saveCard(b,{...c,accepted:true});
    });
  }
  function acceptMany(project, id, jobIds) {
    return mutate(project, id, null, async b => {
      const targets = selected(b, jobIds);
      const accepted = [];
      for (const jobId of targets) {
        const c = b.cards.get(jobId);
        if (c?.state !== 'staged' || c.accepted) continue;
        await disk.checked(disk.within(b.dir, c.stage_path), c.sha256);
        await disk.saveCard(b, { ...c, accepted: true });
        accepted.push(jobId);
      }
      return accepted;
    });
  }
  function retryDeferred(project, id, jobIds) {
    return mutate(project, id, null, async b => {
      const targets = selected(b, jobIds);
      const retried = [];
      for (const jobId of targets) {
        const c = b.cards.get(jobId);
        if (c?.state !== 'deferred') continue;
        await disk.saveCard(b, { ...c, state: 'queued', accepted: false, provider_id: null, retry_reason: '批量重试延期项', reason: '' });
        retried.push(jobId);
      }
      return retried;
    });
  }
  function adopt(project,id,jobId,bytes,actualModel) {
    return change(project,id,jobId,async(b,c,j)=>{
      if (['pending','uncertain','submitting'].includes(c.state) || c.resume_poll) throw Error('请先核清已有提交');
      if (actualModel!==b.plan.requested_model) throw Error('替换图模型与本批不符');
      const refs=await inputFiles(b,j);
      await stage(b,j,{...c,parent_hashes:refs.parent_hashes},prepareImage(bytes,j,nativeImage),actualModel,'adopt');
      return reconcile(b);
    });
  }
  function retry(project,id,jobId,{reason,prompt}={}) {
    return change(project,id,jobId,async(b,c)=>{
      if (!['queued','uncertain','deferred','needs_review','stale_parent','staged','published'].includes(c.state)) throw Error('当前状态无法重试');
      if (c.state==='uncertain' && !reason?.trim()) throw Error('解锁提交不明任务需记录人工核对结论');
      if (c.state==='needs_review' && c.resume_poll && c.provider_id) {
        await disk.saveCard(b,{...c,state:'pending',resume_poll:false,reason:''});
        return;
      }
      await disk.saveCard(b,{...c,state:'queued',accepted:false,provider_id:null,retry_reason:reason || '',
        prompt_override:prompt === undefined ? c.prompt_override : (prompt || undefined),reason:''});
    });
  }
  async function pause(project,id) {
    const task=active.get(path.resolve(disk.batchDir(project,id)).toLowerCase());
    if(task){task.stop=true;await task.finished;}
    return mutate(project,id,null,async b=>{b.plan.paused=true;b.plan.pause_reason ||= '人工暂停';await disk.savePlan(b);});
  }
  async function stopAll() {
    const tasks=[...active.values()];
    for(const task of tasks)task.stop=true;
    await Promise.all(tasks.map(t=>t.finished));
  }
  return { create:disk.createBatch, list, inspect, preview, run, accept, acceptMany, adopt, retry, retryDeferred, pause, stopAll,
    isBusy:()=>active.size>0, isWindowBusy:owner=>[...active.values()].some(t=>t.owner===owner),
    publish:(project,id,ids,owner)=>mutate(project,id,owner,async b=>
      disk.publish(b,selected(b,ids),await archiveLibrary.outputRoot(project))),
    rebind:(project,root)=>archiveLibrary.bind(project,root) };
}
module.exports={createAssetBatchService};
