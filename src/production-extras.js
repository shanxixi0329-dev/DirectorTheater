const crypto=require('crypto');
const fs=require('fs/promises');
const path=require('path');
const qa=require('./production-qa');
const library=require('./production-library');
const id=()=>crypto.randomUUID();
const time=()=>new Date().toISOString();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function shape(db){db.assets ||= [];db.relations ||= [];db.media ||= [];db.cues ||= [];db.rules ||= {};db.library ||= library;return db;}
function range(input){const from=Number(input.from),to=Number(input.to);if(!Number.isInteger(from)||from<1||!Number.isInteger(to)||to<from)throw Error('请输入有效适用集数。');return {from,to};}
function required(input,keys){for(const key of keys)if(!String(input[key]??'').trim())throw Error('请填写完整信息与来源证据：'+key);}
function currentDocuments(ep){const approved=role=>{const t=ep.tasks.find(t=>t.id===role);return t?.status==='approved'?t.versions.at(-1)?.content:'';};return {script:ep.documents.script?.content||'',shotlist:approved('shotlist')||ep.documents.shotlist?.content||'',prompt:approved('prompt')||ep.documents.storyboard?.content||''};}
async function apply(db,ep,input,project){shape(db);
 switch(input.action){
 case 'rules': {
   const r=input.rules||{};const checked={};
   for(const key of ['maxGroupSeconds','minGroupSeconds','speechCharsPerSecond']) if(r[key]!==''&&r[key]!=null){const n=Number(r[key]);if(!Number.isFinite(n)||n<0||n>10000)throw Error('规则数值无效。');checked[key]=n;}
   if(checked.maxGroupSeconds!=null&&checked.minGroupSeconds!=null&&checked.maxGroupSeconds<=checked.minGroupSeconds)throw Error('时长上限必须大于下限。');
   for(const key of ['sizes','cameras','angles','compositions']) checked[key]=String(r[key]||'').split(/[、,，\n]/).map(s=>s.trim()).filter(Boolean);
   db.rules=checked;ep.qa=null;break;
 }
 case 'qa': ep.qa=qa.check({...currentDocuments(ep),rules:db.rules});break;
 case 'asset': {
   required(input,['name','kind','detail','evidence']);const scope=range(input);if(!['role','scene','prop'].includes(input.kind))throw Error('资产类型无效。');
   let asset=db.assets.find(a=>a.id===input.id);if(!asset)asset=db.assets.find(a=>a.name===input.name.trim()&&a.kind===input.kind);
   if(!asset){asset={id:id(),name:input.name.trim(),kind:input.kind,versions:[]};db.assets.push(asset);}
   asset.versions.push({id:id(),...scope,detail:input.detail,evidence:input.evidence,at:time(),certainty:input.certainty==='confirmed'?'confirmed':'pending'});break;
 }
 case 'relation': {
   required(input,['fromName','toName','relation','evidence']);const scope=range(input);
   for(const name of [input.fromName,input.toName])if(!db.assets.some(a=>a.kind==='role'&&a.name===name))throw Error('关系两端须先登记为人物资产：'+name);
   if(input.fromName===input.toName)throw Error('关系两端不能是同一人物。');
   db.relations.push({id:id(),...scope,fromName:input.fromName,toName:input.toName,relation:input.relation,evidence:input.evidence,certainty:input.certainty==='confirmed'?'confirmed':'pending',at:time()});break;
 }
 case 'media': {
   const meta=input.probed;if(!meta?.hash||!Number.isFinite(meta.duration)||meta.duration<=0)throw Error('未获得有效视频探测结果。');
   db.media.push({...meta,id:id(),episode:ep.number,at:time()});break;
 }
 case 'cue': {
   required(input,['mediaId','text','group','shot','before','after','evidence']);const media=db.media.find(m=>m.id===input.mediaId&&m.episode===ep.number);if(!media)throw Error('请先绑定本集真实视频。');
   const start=Number(input.start),end=Number(input.end),offset=Number(input.offset);
   if(![start,end,offset].every(Number.isFinite)||start<0||end<=start||end>media.duration||offset<0)throw Error('点位时间无效或超过真实视频时长。');
   db.cues.push({id:id(),episode:ep.number,mediaId:media.id,mediaHash:media.hash,type:input.type||'字幕',text:input.text,group:input.group,shot:input.shot,offset,start,end,before:input.before,after:input.after,position:input.position||'待确定',evidence:input.evidence,note:input.note||'',at:time()});break;
 }
 case 'library-prompt': {
   const item=db.library.find(t=>t.id===input.id);if(!item)throw Error('未找到历史流程。');
   return {text:`本次复用流程：${item.name}\n${item.text}\n\n请以本项目的正式资料和规则为准，不继承历史项目的人物或时长事实。`};
 }
 case 'save-library':required(input,['name','text']);db.library.push({id:id(),name:input.name,text:input.text,origin:'本项目自定义流程',task:'qc'});break;
 case 'export-rich': {
   const dir=path.join(project.projectPath,'10 制作任务与交接',`制作资料-${Date.now()}-${id().slice(0,6)}`);await fs.mkdir(dir,{recursive:true});
   const subset={assets:db.assets,relations:db.relations,media:db.media,cues:db.cues,qa:ep.qa,rules:db.rules,episode:ep.number};
   await fs.writeFile(path.join(dir,'制作资料.json'),JSON.stringify(subset,null,2));
   const table=(heads,rows)=>`<table><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
   const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(project.title)}制作资料</title><style>body{font:15px/1.8 'Microsoft YaHei',sans-serif;margin:32px;background:#f4f3ee;color:#25352e}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{border:1px solid #bbc4ba;padding:10px;text-align:left;white-space:pre-wrap}h2{margin-top:40px}input{padding:12px;width:60%}tr[hidden]{display:none}</style><h1>${esc(project.title)} · 制作资料</h1><p>完整静态正文。时间码为人工绑定的实测视频点位，文本检查不等于语义验收。</p><input id="search" placeholder="搜索人物、集数、证据或文案"><h2>资产全部版本</h2>${table(['名称','类型','集数','状态与服饰','确定性','依据'],db.assets.flatMap(a=>a.versions.map(v=>[a.name,a.kind,`${v.from}—${v.to}`,v.detail,v.certainty,v.evidence])))}<h2>人物关系</h2>${table(['人物','关系','人物','集数','确定性','依据'],db.relations.map(r=>[r.fromName,r.relation,r.toName,`${r.from}—${r.to}`,r.certainty,r.evidence]))}<h2>后期点位</h2>${table(['集','类型','文案','视频','实测起止秒','组/镜/组内秒','前镜/后镜','画面位置','依据','备注'],db.cues.map(c=>[c.episode,c.type,c.text,db.media.find(m=>m.id===c.mediaId)?.path,`${c.start}—${c.end}`,`${c.group}/${c.shot}/${c.offset}`,`${c.before}/${c.after}`,c.position,c.evidence,c.note]))}<h2>文本质检候选</h2>${table(['类别','级别','位置','问题','证据'],(ep.qa?.findings||[]).map(f=>[f.category,f.level,f.location,f.detail,f.evidence]))}<script>document.getElementById('search').oninput=function(){for(const row of document.querySelectorAll('tbody tr'))row.hidden=!row.textContent.toLowerCase().includes(this.value.toLowerCase())}</script></html>`;
   await fs.writeFile(path.join(dir,'制作资料.html'),html,'utf8');
   const tc=n=>{const ms=Math.round(n*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
   for(const media of db.media){const cues=db.cues.filter(c=>c.mediaId===media.id).sort((a,b)=>a.start-b.start);if(cues.length)await fs.writeFile(path.join(dir,`第${media.episode}集-${media.id.slice(0,8)}.srt`),cues.map((c,i)=>`${i+1}\n${tc(c.start)} --> ${tc(c.end)}\n${c.text}\n`).join('\n'));}
   return {outputPath:dir};
 }
 default:return null;
 }return {};
}
module.exports={shape,apply,currentDocuments};
