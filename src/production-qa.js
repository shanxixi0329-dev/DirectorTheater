const clean = value => String(value || '').replace(/\*\*/g, '').trim();
const normalized = value => clean(value).replace(/\s/g, '');
const marker = value => /V\.?\s*O\.?/i.test(value) ? 'VO' : /O\.?\s*S\.?/i.test(value) ? 'OS' : 'dialogue';
function dialogues(text) {
  const result=[];
  String(text||'').split(/\r?\n/).forEach((line,index)=>{
    const value=clean(line);
    if (/^[△#|【]|^(第\d+|场景|场号|音效|字幕|时长|总时长|参考|任务|镜头)/.test(value)) return;
    const match=value.match(/^([\p{L}\p{N}_·]{1,16})(\s*(?:[（(][^）)]*[）)]|V\.?O\.?|O\.?S\.?))?\s*[：:]\s*(.+)$/u);
    if (!match) return;
    const spoken=match[3].replace(/^[（(][^）)]*[）)]\s*/, '').replace(/^[“「]|[”」]$/g,'');
    if (spoken) result.push({speaker:match[1],mode:marker((match[2]||'')+match[3].match(/^[（(][^）)]*[）)]/)?.[0]),text:spoken,line:index+1});
  });
  return result;
}
function tableRows(text) {
  return String(text||'').split(/\r?\n/).map((line,i)=>({line:i+1,cells:line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(clean),raw:line})).filter(r=>/^\s*\|/.test(r.raw));
}
function timeline(text) {
  const shots=[]; let group=1;
  String(text||'').split(/\r?\n/).forEach((line,i)=>{
    const header=line.match(/第\s*(\d+)\s*组/); if(header) group=Number(header[1]);
    const m=line.match(/镜头\s*([\d-]+)\s*[：:]?\s*[\[【（(]?\s*(\d+(?:\.\d+)?)\s*秒?\s*[-—–~～]\s*(\d+(?:\.\d+)?)\s*秒/);
    if(m) shots.push({group,shot:m[1],start:Number(m[2]),end:Number(m[3]),line:i+1,raw:line});
  }); return shots;
}
function check({script='',shotlist='',prompt='',rules={}}) {
  const findings=[];
  const add=(category,level,location,detail,evidence)=>findings.push({category,level,location,detail,evidence});
  const source=dialogues(script), rows=tableRows(shotlist), shots=timeline(prompt);
  const checkSpeakers=(text,where)=>{
    const spoken=dialogues(text);if(!spoken.length)return;
    for(const d of source){const match=spoken.find(x=>normalized(x.text)===normalized(d.text));
      if(match&&match.speaker!==d.speaker)add('发声人','warning',`${where} / 剧本第${d.line}行`,'相同台词标在不同发声人名下，请核对。',`剧本：${d.speaker}；目标：${match.speaker}；台词：${d.text}`);
      if(match&&match.mode!==d.mode)add('V.O./O.S.','warning',`${where} / 剧本第${d.line}行`,'发声方式与剧本标记不一致。',`剧本：${d.mode}；目标：${match.mode}；台词：${d.text}`);
    }
    for(const d of spoken)if(!source.some(x=>normalized(x.text)===normalized(d.text)))add('额外对白','warning',where,'目标中有未逐字匹配剧本的对白，请核对拆句、增写或改写。',`${d.speaker}：${d.text}`);
  };
  if(!source.length) add('对白','notice','剧本','未识别出支持格式的对白，请人工核对；不判定为零对白。','支持“角色（O.S.）：台词”等独立行。');
  const body=rows.filter(r=>r.cells.length===12 && !r.cells.every(c=>/^:?-+:?$/.test(c)) && r.cells[0]!=='镜号');
  if(shotlist.trim()) {
    if(rows.length<3) add('结构','error','分镜','未检测到完整12列表格。',shotlist.slice(0,150));
    rows.forEach(r=>{if(r.cells.length!==12)add('结构','error',`分镜第${r.line}行`,`列数为${r.cells.length}，应为12。`,r.raw);});
    body.forEach(r=>{for(const [column,key] of [[2,'sizes'],[3,'cameras'],[4,'angles'],[5,'compositions']]) {if(Array.isArray(rules[key])&&rules[key].length&&!rules[key].includes(r.cells[column]))add('白名单','error',`镜${r.cells[0]} / 第${r.line}行`,`${r.cells[column]}不在项目白名单中。`,rules[key].join('、'));}});
    const ordered=body.map(r=>r.cells[7]).join('\n');let cursor=0;
    checkSpeakers(ordered,'分镜台词列');
    source.forEach(d=>{const q=normalized(d.text),content=normalized(ordered);const index=content.indexOf(q,cursor); if(index<0)add('对白','warning',`剧本第${d.line}行`,'分镜未找到按原顺序逐字对应的对白；请核对拆句或改写。',`${d.speaker}：${d.text}`);else cursor=index+q.length;});
  }
  if(prompt.trim()) {
    let cursor=0;const audio=[...prompt.matchAll(/[｛{]([^{}｛｝]+)[｝}]/g)].map(m=>m[1]).join('\n');
    checkSpeakers(audio,'提示词音频');
    if(source.length&&!audio) add('对白','notice','提示词','未识别出花括号音频文本，请按本项目音频格式人工核对。','不会用全文提及的台词冒充音频对白。');
    source.forEach(d=>{if(!audio)return;const index=normalized(audio).indexOf(normalized(d.text),cursor);if(index<0)add('对白','warning',`剧本第${d.line}行`,'提示词音频未找到按原顺序逐字对应的对白。',`${d.speaker}（${d.mode}）：${d.text}`);else cursor=index+normalized(d.text).length;});
    if(!shots.length) add('时间轴','notice','提示词','没有识别出支持的镜头时间码；需人工核对。','支持：镜头1：[0秒-5秒]');
    const groups=new Map();shots.forEach(s=>{const list=groups.get(s.group)||[];list.push(s);groups.set(s.group,list);});
    for(const [group,list] of groups) {
      let prior=0;for(const s of list){if(s.start!==prior)add('时间轴','error',`第${group}组 / 镜${s.shot} / 第${s.line}行`,s.start<prior?'时间码重叠。':'时间码有空档或未从0开始。',s.raw);if(s.end<=s.start)add('时间轴','error',`第${group}组 / 镜${s.shot}`,'结束时间必须大于开始时间。',s.raw);prior=s.end;}
      if(Number.isFinite(rules.maxGroupSeconds)&&prior>rules.maxGroupSeconds)add('分组','error',`第${group}组`,`组长${prior}秒超过项目上限${rules.maxGroupSeconds}秒。`,list.at(-1).raw);
      if(Number.isFinite(rules.minGroupSeconds)&&prior<=rules.minGroupSeconds)add('分组','error',`第${group}组`,`组长${prior}秒未大于项目下限${rules.minGroupSeconds}秒。`,list.at(-1).raw);
    }
    for(const s of shots){const spoken=[...s.raw.matchAll(/[｛{]([^{}｛｝]+)[｝}]/g)].map(m=>m[1]).join('');const chars=spoken.replace(/[\s\p{P}\p{S}]/gu,'').length;const speed=Number(rules.speechCharsPerSecond)||4;if(chars/(s.end-s.start)>speed)add('口播','warning',`第${s.group}组 / 镜${s.shot}`,`约${chars}字安排${s.end-s.start}秒，超过参考语速${speed}字/秒；需试听判断。`,spoken);}
  }
  return {at:new Date().toISOString(),counts:{dialogues:source.length,tableRows:body.length,timedShots:shots.length},findings,scope:'结构和文本候选检查；没有执行语义或画面验收。'};
}
module.exports={dialogues,tableRows,timeline,check};
