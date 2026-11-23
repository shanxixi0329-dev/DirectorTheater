const fs=require('fs/promises');
const path=require('path');
const crypto=require('crypto');
const digest=x=>crypto.createHash('sha256').update(Buffer.isBuffer(x)?x:String(x)).digest('hex');
function createJournal(){
 const active=new Set(), pauses=new Set();
 const folder=p=>path.join(p.projectPath,'.ai-director','execution-v21');
 const file=(p,key)=>path.join(folder(p),digest(key)+'.json');
 async function load(p,key){try{return JSON.parse(await fs.readFile(file(p,key),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function save(p,key,r){await fs.mkdir(folder(p),{recursive:true});const target=file(p,key),tmp=target+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(r,null,2));await fs.rename(tmp,target);}
 async function list(p){try{const names=await fs.readdir(folder(p));const rows=[];for(const n of names.filter(n=>n.endsWith('.json'))){const r=JSON.parse(await fs.readFile(path.join(folder(p),n),'utf8'));rows.push({...r,content:undefined,prompt:undefined,live:active.has(path.resolve(p.projectPath))});}return rows.sort((a,b)=>b.at.localeCompare(a.at));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 async function run(p,request,transport){
   const pk=path.resolve(p.projectPath);if(active.has(pk))throw Error('本项目已有网页任务运行，请等待或暂停。');active.add(pk);pauses.delete(pk);
   const key=request.key;
   let record, inputValidated=false;
   try{
     record=await load(p,key);
     const fingerprints=[];for(const name of request.files||[])fingerprints.push([name,digest(await fs.readFile(name))]);
     const inputHash=digest(JSON.stringify([request.prompt,fingerprints]));
     if(record&&record.inputHash!==inputHash)throw Error('任务输入文件已变化，请重新准备任务；不会续接旧输入。');
     inputValidated=true;
     if(record?.phase==='completed')return record;
     if(!record){record={key,token:crypto.randomUUID(),name:request.name,episode:p.currentEpisode,inputHash,files:fingerprints,phase:'prepared',sendAttempted:false,at:new Date().toISOString()};await save(p,key,record);}
     const begin=`BEGIN_RESULT_${record.token}`,end=`END_RESULT_${record.token}`;
     const prompt=`${request.prompt}\n\n【结果回收约定】请只在最终回复正文首行写 ${begin}，正文输出完整成品，末行写 ${end}。两行之间不得用摘要替代成品。`;
     const control={isPaused:()=>pauses.has(pk),checkpoint:async(phase,data={})=>{Object.assign(record,data,{phase,at:new Date().toISOString()});if(phase==='send-intent')record.sendAttempted=true;await save(p,key,record);}};
     const result=await transport({prompt,uploadPaths:request.files,rawOnly:true,replyMode:'message',resume:record.sendAttempted,previousReply:record.previousReply||'',chatUrl:record.chatUrl||'',control});
     if(!result?.ok){record.phase=result?.paused?'paused':'needs-attention';record.reason=result?.reason||'网页任务未完成。';await save(p,key,record);return record;}
     const raw=String(result.content||'');const start=raw.indexOf(begin),finish=raw.lastIndexOf(end);
     if(start<0||finish<=start) {record.phase='needs-attention';record.reason='回复缺少本轮结果标识，已保留原始回复，请人工核对后回收。';record.raw=raw;await save(p,key,record);return record;}
     record.content=raw.slice(start+begin.length,finish).trim();if(!record.content)throw Error('回收正文为空。');record.phase='completed';record.reason='';record.completedAt=new Date().toISOString();await save(p,key,record);return record;
   }catch(e){if(record&&inputValidated){record.reason=e.message;record.phase='needs-attention';await save(p,key,record);}throw e;}finally{active.delete(pk);}
 }
 return {run,load,list,save,pause:p=>{pauses.add(path.resolve(p.projectPath));return true;}};
}
module.exports={createJournal};
