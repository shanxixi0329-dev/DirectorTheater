'use strict';
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

function categoryFor(name) {
  if (/后期|剪辑|配乐|音效|音乐|post.?production|editing/i.test(name)) return 'post';
  if (/素材|资产|服饰|服装|状态|场景|道具|asset/i.test(name)) return 'assets';
  if (/人物关系|关系网|家谱|谱系|relationship/i.test(name)) return 'relationships';
  return 'other';
}
function createHtmlLibrary({ ttl = 30000 } = {}) {
  const cache = new Map();
  async function describe(file, root, category) {
    if (!/\.html?$/i.test(file)) throw Error('请选择 HTML 文件。');
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw Error('选择的路径不是文件。');
    return {name:path.basename(file),path:path.resolve(file),url:pathToFileURL(path.resolve(file)).href,
      relative:root ? path.relative(root,file) : path.basename(file),category:category || categoryFor(path.basename(file)),
      modifiedAt:stat.mtime.toISOString(),size:stat.size};
  }
  async function list(project, {force = false, extra = []} = {}) {
    if (!project?.projectPath) throw Error('请先打开项目。');
    const root = path.resolve(project.projectPath, '06 资产');
    let record = cache.get(root);
    if (!record || (force && !record.pending) || (!record.pending && Date.now()-record.at > ttl)) {
      record = {at:Date.now(),pending:null,files:null};
      record.pending = (async () => {
        const files=[];
        async function visit(folder) {
          let entries;
          try {entries=await fs.readdir(folder,{withFileTypes:true});}
          catch(error) {if(error.code==='ENOENT')return;throw error;}
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const target = path.join(folder,entry.name);
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile() && /\.html?$/i.test(entry.name)) files.push(await describe(target,root));
          }
        }
        await visit(root);
        return files.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN') || a.relative.localeCompare(b.relative,'zh-CN'));
      })();
      cache.set(root,record);
      record.pending.then(files=>{record.files=files;record.pending=null;record.at=Date.now();},()=>{if(cache.get(root)===record)cache.delete(root);});
    }
    const files = [...(record.pending ? await record.pending : record.files)];
    // Extra files are UI preferences from explicitly chosen local HTML files.
    for (const entry of extra) {
      if (!entry?.path) continue;
      const existing=files.findIndex(file=>file.path.toLowerCase()===String(entry.path).toLowerCase());
      if (existing>=0) {if(['relationships','assets','post','other'].includes(entry.category)) files[existing]={...files[existing],category:entry.category};continue;}
      try {files.push(await describe(entry.path,null,entry.category));}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
    }
    return files;
  }
  return {list,describe,categoryFor};
}
module.exports = {createHtmlLibrary,categoryFor};
