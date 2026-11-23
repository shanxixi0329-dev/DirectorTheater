// MCP releases expose either JSON nodes (uid or id) or a text snapshot.
function uploadUid(response) {
  const nodes=[];
  function visit(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}nodes.push(n);(n.children||[]).forEach(visit);}
  visit(response?.structuredContent?.snapshot);
  const text=(response?.content||[]).map(c=>c.text||'').join('\n');
  for(const m of text.matchAll(/uid=([^\s]+)\s+(\S+)(?:\s+"([^"\r\n]*)")?/g))nodes.push({uid:m[1],role:m[2],name:m[3]||''});
  const concrete=/add photos|photos and files|upload from computer|添加照片和文件|添加照片与文件|从电脑上传|上传文件|选择文件/i;
  return nodes.filter(n=>(n.uid||n.id)&&concrete.test(n.name||'')&&!/资料库|library/i.test(n.name||'')&&!n.disabled)
    .sort((a,b)=>Number(!/从电脑上传|upload from computer/i.test(a.name||''))-Number(!/从电脑上传|upload from computer/i.test(b.name||'')))
    .map(n=>n.uid||n.id)[0]||'';
}
module.exports={uploadUid};
