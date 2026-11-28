'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {deflateSync,crc32} = require('node:zlib');
const {createAssetBatchService} = require('../src/asset-batch-service');
const {createArchiveLibrary} = require('../src/asset-archive-library');
const {sha256,inspectPng} = require('../src/asset-image-utils');
const disk = require('../src/asset-batch-storage');

function png(seed=0,alpha=false) {
  function chunk(kind,bytes) {
    const data=Buffer.concat([Buffer.from(kind),bytes]),out=Buffer.alloc(data.length+8);
    out.writeUInt32BE(bytes.length);data.copy(out,4);out.writeUInt32BE(crc32(data),out.length-4);return out;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(3);header.writeUInt32BE(1,4);header[8]=8;header[9]=alpha?6:2;
  const pixels=alpha ? [0,0,0,0,0, 200,80,20,128, 12,34,56,255] : [0,seed,80,60, 200,70,10, 12,34,56];
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from(pixels))),chunk('IEND',Buffer.alloc(0))]);
}
const model='fixture-image', image=png(1), image2=png(2);
const ready=(bytes=image)=>({status:'ready',actual_model:model,bytes});
const provider=(submit=async()=>ready(),poll=async()=>ready())=>({submit,poll});
const job=(id,refs=[],extra={})=>({id,category:'prop',name:'样本'+id,episodes:[1,5,9],source_scenes:['1-1','5-2','9-1'],references:refs,...extra});
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function context(jobs,opts={}) {
  const root=await fs.mkdtemp(path.join(process.env.BATCH_FIXTURES || os.tmpdir(),'asset-batch-'));
  const project={projectPath:path.join(root,'项目')},id='样片';
  const archive=createArchiveLibrary({userData:()=>path.join(root,'profile'),writeAtomic:disk.atomic});
  const service=()=>createAssetBatchService({archiveLibrary:archive});
  const app=service();
  await app.create(project,id,{jobs},{model,...opts});
  const dir=disk.batchDir(project,id);
  const args=[project,id];
  return {root,project,id,args,dir,service,app,archive,card:key=>read(path.join(dir,'generation',key+'.json'))};
}
async function interrupt(ctx,mode,inside) {
  const script="const {createAssetBatchService}=require(process.argv[1]);const project={projectPath:process.argv[2]};"+
    "const hanging=()=>{process.send('in-driver');return new Promise(()=>{})};setInterval(()=>{},5000);"+
    "const driver={submit:hanging,poll:hanging};createAssetBatchService().run(project,process.argv[3],driver,{ids:['A']}).catch(e=>{console.error(e);process.exit(1)});";
  const child=spawn(process.execPath,['-e',script,require.resolve('../src/asset-batch-service'),ctx.project.projectPath,ctx.id],{stdio:['ignore','ignore','inherit','ipc']});
  const ended=once(child,'exit');
  const timer=setTimeout(()=>child.kill(),15000);
  try {
    await Promise.race([once(child,'message'),ended.then(()=>{throw Error('子进程提前退出')})]);
    assert.equal((await ctx.card('A')).state,mode);if(inside)await inside();
  } finally {clearTimeout(timer);child.kill();await ended;}
}
test('pending 进程强制退出后先查原任务，再提交其余选中任务',async()=>{
  const c=await context([job('A'),job('B')]);let count=0;
  await c.app.run(...c.args,provider(async()=>{count++;return {status:'pending',provider_id:'ticket-7'};}),{ids:['A']});
  const original=await c.card('A');
  assert.ok(original.attempt_id && original.started_at);
  await interrupt(c,'pending',async()=>assert.rejects(c.service().run(...c.args,provider()),{code:'BATCH_BUSY'}));
  const calls=[];
  await c.service().run(...c.args,provider(async j=>{count++;calls.push('submit '+j.id);return ready();},async req=>{
    assert.equal(req.attempt_id,original.attempt_id);calls.push('poll '+req.provider_id);return ready();
  }),{ids:['B']});
  assert.deepEqual(calls,['poll ticket-7','submit B']);assert.equal(count,2);
  assert.equal((await c.card('A')).state,'staged');
});
test('断网无任务号和提交中进程硬退出均进入 uncertain，仅人工解锁重提',async()=>{
  const c=await context([job('A'),job('B')]);let calls=0;
  await interrupt(c,'submitting');
  assert.equal((await c.service().inspect(...c.args)).cards[0].state,'uncertain');
  await c.app.run(...c.args,provider(async()=>{calls++;throw Error('断网');}));
  assert.equal((await c.card('B')).state,'uncertain');
  await c.service().run(...c.args,provider(async()=>{calls++;return ready();}));assert.equal(calls,1);
  await assert.rejects(c.app.retry(...c.args,'B'),/人工核对/);
  await c.app.retry(...c.args,'B',{reason:'模拟供应端已确认无任务'});
  await c.app.run(...c.args,provider(async()=>{calls++;return ready();}));assert.equal(calls,2);
  assert.equal((await c.card('A')).state,'uncertain');assert.equal((await c.card('B')).state,'staged');
});
test('明确限流整批熔断，重启保留暂停，勾选重试只补缺项',async()=>{
  const c=await context(['A','B','C','D'].map(x=>job(x)));const calls=[];
  const d=provider(async j=>{calls.push(j.id);if(j.id==='B')throw Object.assign(Error('429'),{status:429});return ready();});
  const first=await c.app.run(...c.args,d,{concurrency:1});
  assert.ok(first.paused);assert.deepEqual(first.cards.map(x=>x.state),['staged','deferred','queued','queued']);
  await c.service().run(...c.args,d);assert.deepEqual(calls,['A','B']);
  await c.app.retry(...c.args,'B');
  await c.app.run(...c.args,provider(async j=>{calls.push(j.id);return ready();}),{resume:true,ids:['B','C'],concurrency:1});
  assert.deepEqual(calls,['A','B','B','C']);assert.equal((await c.card('D')).state,'queued');
});
test('模型不符、未授权均暂停，审核或损坏 PNG 只挂起单图',async()=>{
  for(const [kind,paused] of [['model',true],['auth',true],['moderation',false],['png',false]]) {
    const c=await context([job('A'),job('B')]);
    const result=await c.app.run(...c.args,provider(async j=>{
      if(j.id==='B')return ready();
      if(kind==='model')return {...ready(),actual_model:'other-model'};
      if(kind==='auth')throw Object.assign(Error('unauthorized'),{status:401});
      if(kind==='moderation')throw Object.assign(Error('review'),{code:'MODERATION'});
      return ready(Buffer.from('bad'));
    }),{concurrency:1});
    assert.equal(result.paused,paused);assert.equal((await c.card('A')).state,'needs_review');
    assert.equal((await c.card('B')).state,paused?'queued':'staged');
  }
});
test('子孙母板指纹、旧图留存及未提交任务继承新图',async()=>{
  const c=await context([job('A'),job('B',['A']),job('C',['B']),job('D',['A'])]);
  for(const id of ['A','B','C']){
    await c.app.run(...c.args,provider(),{ids:[id]});await c.app.accept(...c.args,id);
  }
  await c.app.publish(...c.args,['B']);
  const receipt=await read(path.join(c.dir,'published/B.json'));
  assert.deepEqual(receipt.parent_hashes,{A:sha256(image)});
  assert.deepEqual(await c.app.adopt(...c.args,'A',image2,model),['B','C']);
  assert.equal((await read(path.join(c.dir,'published/B.json'))).state,'stale_parent');
  assert.equal((await read(path.join(c.dir,'图片生成与归档清单.json'))).assets[0].state,'stale_parent');
  assert.deepEqual((await c.app.inspect(...c.args)).cards.map(x=>x.state),['staged','stale_parent','stale_parent','queued']);
  const retakes=await fs.readdir(path.join(c.dir,'retakes/A'));
  assert.deepEqual(await fs.readFile(path.join(c.dir,'retakes/A',retakes[0])),image);
  await c.app.accept(...c.args,'A');
  await c.app.run(...c.args,provider(async j=>{assert.deepEqual(await fs.readFile(j.reference_files[0]),image2);return ready();}),{ids:['D']});
  assert.deepEqual((await c.card('D')).parent_hashes,{A:sha256(image2)});
  await assert.rejects(c.app.publish(...c.args,['B']),/验收/);
});
test('整批迁移、重绑、哈希回读、同名冲突预检和发布幂等',async()=>{
  const c=await context([job('A'),job('B')]);let submits=0;
  await c.app.run(...c.args,provider(async()=>{submits++;return ready();}));
  await assert.rejects(c.app.publish(...c.args,['A']),/验收/);
  for(const id of ['A','B'])await c.app.accept(...c.args,id);
  await c.app.publish(...c.args,['A']);
  const oldProjectFile=path.join(c.project.projectPath,'06 资产/images/03 道具/样本A 第1集到第9集.png');
  assert.deepEqual(await fs.readFile(oldProjectFile),image);
  const moved={projectPath:path.join(c.root,'迁移项目')},location=disk.batchDir(moved,c.id);
  await fs.mkdir(path.dirname(location),{recursive:true});await fs.cp(c.dir,location,{recursive:true});
  const root=path.join(c.root,'图库乙');await fs.mkdir(path.join(root,'03 道具'),{recursive:true});
  await c.app.rebind(moved,root);
  const file=id=>path.join(root,'03 道具','样本'+id+' 第1集到第9集.png');
  await fs.writeFile(file('B'),image2);
  await assert.rejects(c.app.publish(moved,c.id,['A','B']),/同名/);
  await assert.rejects(fs.access(file('A')));assert.deepEqual(await fs.readFile(file('B')),image2);
  await fs.rename(file('B'),file('B')+'.fixture');
  await c.app.publish(moved,c.id,['A','B']);
  const stat=await fs.stat(file('A'));await c.app.publish(moved,c.id,['A','B']);assert.equal((await fs.stat(file('A'))).mtimeMs,stat.mtimeMs);
  const summary=await read(path.join(location,'图片生成与归档清单.json'));assert.equal(summary.assets.length,2);
  for(const r of summary.assets)assert.equal(sha256(await fs.readFile(path.join(root,r.relative_path))),r.sha256);
  assert.equal(submits,2);
  for(const f of ['queue.json','plan.json','图片生成与归档清单.json']) assert.ok(!(await fs.readFile(path.join(location,f),'utf8')).includes('projectPath'));
  assert.deepEqual((await c.archive.read(moved,5,[])).images.map(x=>x.readable),[true,true]);
});
test('外部参考复制和复验，篡改时提交次数为零',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'batch-ref-'));const src=path.join(tmp,'source.png');
  await fs.writeFile(src,image);const ref='references/原图.png';
  const c=await context([job('A',[],{reference_images:[ref]})],{referenceFiles:{[ref]:src}});
  const plan=await read(path.join(c.dir,'plan.json'));
  assert.deepEqual(plan.references,[{path:ref,sha256:sha256(image)}]);assert.ok(!JSON.stringify(plan).includes(tmp));
  await fs.writeFile(path.join(c.dir,ref),image2);let calls=0;
  await assert.rejects(c.app.run(...c.args,provider(async()=>{calls++;return ready();})),/指纹/);assert.equal(calls,0);
});
test('并行只处理已开始的调用，暂停等到任务号落盘，窗口关联精确',async()=>{
  const c=await context([job('A'),job('B'),job('C')]);let release;
  const wait=new Promise(resolve=>{release=resolve;});let began;const started=new Promise(resolve=>{began=resolve;});
  let count=0;
  const running=c.app.run(...c.args,provider(async j=>{if(++count===2)began();await wait;return {status:'pending',provider_id:j.id};}),{owner:7,concurrency:2});
  await started;assert.ok(c.app.isBusy());assert.ok(c.app.isWindowBusy(7));assert.ok(!c.app.isWindowBusy(8));
  await assert.rejects(c.app.run(...c.args,provider()),{code:'BATCH_BUSY'});
  const stopped=c.app.stopAll();release();await Promise.all([running,stopped]);
  assert.ok(!c.app.isBusy());const s=await c.app.inspect(...c.args);assert.ok(s.paused);assert.deepEqual(s.cards.map(x=>x.state),['pending','pending','queued']);
});
test('PNG 截断、CRC 错误和尾随内容均拦截',()=>{
  for(const bytes of [image.subarray(0,-3),Buffer.concat([image,Buffer.from([0])]),Buffer.from(image.map((v,i)=>i===37?v^1:v))])
    assert.throws(()=>inspectPng(bytes));
  assert.equal(inspectPng(png(0,true)).hasTransparency,true);
});
test('查询阶段权限失效，解除挂起后沿用原任务号',async()=>{
  const c=await context([job('A')]);
  let submits=0;
  const submit=async()=>{submits++;return {status:'pending',provider_id:'keep-me'};};
  await c.app.run(...c.args,provider(submit));
  await c.app.run(...c.args,provider(submit,async()=>{throw Object.assign(Error('权限失效'),{status:403});}));
  assert.equal((await c.card('A')).state,'needs_review');
  await c.app.retry(...c.args,'A',{reason:'模拟权限已恢复'});
  await c.service().run(...c.args,provider(submit,async request=>{
    assert.equal(request.provider_id,'keep-me');return ready();
  }),{resume:true});
  assert.equal(submits,1);assert.equal((await c.card('A')).state,'staged');
});
test('回执写入中断后，重试只补回执并保持归档文件时间戳',async()=>{
  const c=await context([job('A')]);await c.app.run(...c.args,provider());await c.app.accept(...c.args,'A');
  const receiptDir=path.join(c.dir,'published'),saved=receiptDir+'-fixture';
  await fs.rename(receiptDir,saved);await fs.writeFile(receiptDir,'模拟回执目录暂不可用');
  await assert.rejects(c.app.publish(...c.args,['A']));
  const target=path.join(c.project.projectPath,'06 资产/images/03 道具/样本A 第1集到第9集.png');
  assert.deepEqual(await fs.readFile(target),image);const {mtimeMs}=await fs.stat(target);
  await fs.unlink(receiptDir);await fs.rename(saved,receiptDir);
  await c.service().publish(...c.args,['A']);assert.equal((await fs.stat(target)).mtimeMs,mtimeMs);
  assert.equal((await read(path.join(receiptDir,'A.json'))).sha256,sha256(image));
});
test('子图等待供应端期间母板被替换，取回的旧版本标记待重拍',async()=>{
  const c=await context([job('A'),job('B',['A'])]);
  await c.app.adopt(...c.args,'A',image,model);await c.app.accept(...c.args,'A');
  await c.app.run(...c.args,provider(async()=>({status:'pending',provider_id:'old-child'})),{ids:['B']});
  await c.app.adopt(...c.args,'A',image2,model);
  let polls=0;await c.service().run(...c.args,provider(async()=>assert.fail('不能重新提交'),async q=>{
    polls++;assert.equal(q.provider_id,'old-child');return ready();
  }));
  const child=await c.card('B');assert.equal(polls,1);assert.equal(child.state,'stale_parent');
  assert.equal(child.parent_hashes.A,sha256(image));
});
test('详情含完整提示词、运行中可预览且支持批量验收与重试延期项',async()=>{
  const c=await context([job('A',[],{prompt:'完整提示词A'}),job('B',[],{prompt:'完整提示词B'})]);
  const summary=await c.app.list(c.project);
  assert.equal('prompt' in summary[0].jobs[0],false);
  const detail=await c.app.inspect(...c.args);
  assert.equal(detail.jobs[0].prompt,'完整提示词A');

  const progress=[];
  let releaseB;
  const waitB=new Promise(resolve=>{releaseB=resolve;});
  let startedB;
  const onStartB=new Promise(resolve=>{startedB=resolve;});
  const running=c.app.run(...c.args,provider(async j=>{
    if(j.id==='A')return ready();
    startedB();
    await waitB;
    throw Object.assign(Error('429 rate limit'),{status:429});
  }),{concurrency:1,onProgress:snap=>progress.push(snap.cards.map(x=>x.state))});

  await onStartB;
  const preview=await c.app.preview(...c.args,'A');
  assert.match(preview.dataUrl,/^data:image\/png;base64,/);
  releaseB();
  const after=await running;
  assert.equal(after.paused,true);
  assert.ok(progress.length>=2);

  const accepted=await c.app.acceptMany(...c.args);
  assert.deepEqual(accepted,['A']);
  const retried=await c.app.retryDeferred(...c.args);
  assert.deepEqual(retried,['B']);
  assert.equal((await c.card('B')).state,'queued');

  const emptyRoot=await fs.mkdtemp(path.join(os.tmpdir(),'asset-batch-empty-'));
  const emptyList=await c.app.list({projectPath:emptyRoot});
  assert.deepEqual(emptyList,[]);
});
