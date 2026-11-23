(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.DirectorCore=factory();})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const STAGES=[
    {id:'source',label:'小说原文',view:'project',hint:'选择本集原文；已有剧本的项目可以从剧本开始。'},
    {id:'outline',label:'大纲',view:'outline',optional:true,hint:'核对分集目标、事件和结尾；没有大纲也可继续。'},
    {id:'script',label:'剧本',view:'script',hint:'先确认剧情、人物和台词，再拆镜。'},
    {id:'assets',label:'人物与场景',view:'shot-studio',optional:true,hint:'为人物、场景和道具记录统一名称与参考。'},
    {id:'shotlist',label:'分镜',view:'shot-studio',hint:'逐镜调整画面、时长与摄影参数。'},
    {id:'storyboard',label:'视频提示词',view:'storyboard',hint:'依据已确认分镜制作，修改镜头后复核对应提示词。'},
    {id:'quality',label:'内容复核',view:'quality-center',hint:'按自己的检查项核对事实、台词、连续性和时长。'},
    {id:'review',label:'审片与交付',view:'review',hint:'播放成片，定位问题；审片意见默认只导出有问题的视频。'}
  ];
  const DEPENDENCIES={source:[],outline:['source'],script:['source','outline'],assets:['script'],shotlist:['script','assets'],storyboard:['script','shotlist','assets'],quality:['source','outline','script','shotlist','storyboard','assets'],review:['shotlist','storyboard']};
  const locked=header=>/镜号|镜头编号|镜头号|序号|编号|台词|对白|说话|音色|声线/.test(header);
  function cells(line){
    const pipes=[];let slash=0;
    for(let i=0;i<line.length;i++){const c=line[i];if(c==='|'&&slash%2===0)pipes.push(i);slash=c==='\\'?slash+1:0;}
    if(!pipes.length)return null;
    const limits=[-1,...pipes,line.length],out=[];
    for(let i=0;i<limits.length-1;i++){const start=limits[i]+1,end=limits[i+1];out.push({start,end,raw:line.slice(start,end),value:line.slice(start,end).trim()});}
    if(!out[0].value)out.shift();if(out.length&&!out.at(-1).value)out.pop();return out;
  }
  function lines(text){const result=[];let start=0;for(const match of String(text).matchAll(/\r\n|\n|\r/g)){result.push({text:text.slice(start,match.index),start,end:match.index});start=match.index+match[0].length;}result.push({text:text.slice(start),start,end:text.length});return result;}
  function parse(text){
    const source=lines(String(text)),shots=[],warnings=[];let table=0,heading='',fence='';
    for(let i=0;i<source.length;i++){
      const marker=source[i].text.match(/^\s*(`{3,}|~{3,})/);if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence='';continue;}if(fence)continue;
      if(/^\s*#{1,6}\s+/.test(source[i].text))heading=source[i].text.replace(/^\s*#{1,6}\s+/,'').trim();
      const header=cells(source[i].text),separator=cells(source[i+1]?.text||'');
      if(!header||!separator||header.length!==separator.length||!separator.every(c=>/^:?-{2,}:?$/.test(c.value.replace(/\s/g,''))))continue;
      if(!header.some(c=>/镜号|镜头编号|镜头号|序号/.test(c.value))||!header.some(c=>/画面|内容|动作|景别/.test(c.value)))continue;
      table++;let occurrence={};
      const idColumn=header.findIndex(c=>/镜号|镜头编号|镜头号|序号/.test(c.value));
      let j=i+2;
      for(;j<source.length;j++){
        const row=cells(source[j].text);if(!row)break;
        if(row.length!==header.length){warnings.push(`第 ${j+1} 行有 ${row.length} 列，表头有 ${header.length} 列；请在文件编辑中核对。`);continue;}
        if(!row.some(c=>c.value))continue;
        const label=row[idColumn].value;if(!label){warnings.push(`第 ${j+1} 行缺少镜号。`);continue;}
        occurrence[label]=(occurrence[label]||0)+1;
        shots.push({id:`${table}:${encodeURIComponent(label)}:${occurrence[label]}`,table,label,heading,line:j+1,start:source[j].start,end:source[j].end,raw:source[j].text,
          columns:header.map((c,index)=>({index,name:c.value,locked:locked(c.value)})),cells:row.map(c=>c.value)});
      }
      i=j-1;
    }
    return {shots,warnings};
  }
  function patch(text,id,fields){
    const shot=parse(text).shots.find(s=>s.id===id);if(!shot)throw Error('镜头位置已变化，请刷新后重新选择。');
    const spans=cells(shot.raw),edits=[];
    for(const [indexString,value]of Object.entries(fields||{})){
      const index=Number(indexString),column=shot.columns[index];if(!Number.isInteger(index)||!column)throw Error('镜头列不存在。');
      if(column.locked&&String(value)!==shot.cells[index])throw Error(`“${column.name}”受保护，请在原文件编辑中核对后修改。`);
      if(String(value)===shot.cells[index])continue;
      if(/[\r\n]/.test(String(value)))throw Error('单个表格单元格不能包含换行；可使用 <br>。');
      const span=spans[index],leading=span.raw.match(/^\s*/)[0],trailing=span.raw.match(/\s*$/)[0];
      const escaped=String(value).replace(/(?<!\\)\|/g,'\\|');
      edits.push({start:span.start,end:span.end,value:leading+escaped+trailing});
    }
    let raw=shot.raw;for(const edit of edits.sort((a,b)=>b.start-a.start))raw=raw.slice(0,edit.start)+edit.value+raw.slice(edit.end);
    return {content:String(text).slice(0,shot.start)+raw+String(text).slice(shot.end),before:shot.raw,after:raw,shot};
  }
  function field(shot,regex){const index=shot.columns.findIndex(c=>regex.test(c.name));return index<0?'':shot.cells[index];}
  function fingerprint(stage,hashes){return JSON.stringify([stage,hashes[stage]||'',...(DEPENDENCIES[stage]||[]).map(k=>[k,hashes[k]||''])]);}
  function stageStatus(stage,hashes,record){
    if(record?.skipped)return record.fingerprint===fingerprint(stage,hashes)?'skipped':'stale';
    if(record?.fingerprint)return record.fingerprint===fingerprint(stage,hashes)?'confirmed':'stale';
    return hashes[stage]?'ready':'missing';
  }
  function conflicts(assets){const seen=new Map(),out=[];for(const asset of assets){for(const name of [asset.name,...(asset.aliases||[])]){const key=asset.type+':'+String(name).trim();if(!String(name).trim())continue;if(seen.has(key)&&seen.get(key)!==asset.id)out.push(name);else seen.set(key,asset.id);}}return [...new Set(out)];}
  return {STAGES,DEPENDENCIES,parse,patch,field,locked,fingerprint,stageStatus,conflicts};
});
