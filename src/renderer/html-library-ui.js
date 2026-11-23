'use strict';
window.createHtmlLibraryUI = function ({project,view,api,toast}) {
  const labels={relationships:'人物关系网',assets:'素材可视化',post:'后期剪辑可视化',all:'其他 HTML 资料'};
  const states=new Map();
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const category=()=>({'html-relationships':'relationships','html-assets':'assets','html-post':'post','html-other':'all'}[view()]||'all');
  function current() {
    const p=project();if(!p)return null;
    if(!states.has(p.projectPath)) {
      let preferences={selected:{},extra:[]};
      try {preferences={...preferences,...JSON.parse(localStorage.getItem('director-html:'+p.projectPath)||'{}')};}catch{}
      states.set(p.projectPath,{...preferences,files:null,pending:null,error:'',filter:'',at:0});
    }
    return states.get(p.projectPath);
  }
  function remember(s) {try{localStorage.setItem('director-html:'+project().projectPath,JSON.stringify({selected:s.selected,extra:s.extra}));}catch{}}
  function filesFor(s) {return (s.files||[]).filter(file=>category()==='all'||file.category===category());}
  function selected(s) {
    const files=filesFor(s);
    return files.find(file=>file.path===s.selected[category()]) || files.find(file=>!/入口|index/i.test(file.name)) || files[0];
  }
  function renderCards() {return `<article class="card html-shortcuts"><h2>HTML 资料</h2><div>${[['html-relationships','人物关系网'],['html-assets','素材可视化'],['html-post','后期剪辑可视化'],['html-other','其他 HTML 资料']].map(([id,label])=>`<button class="button secondary" data-view="${id}">${label}</button>`).join('')}</div><p class="hint">直接打开“06 资产”里的网页资料，也可以选择其他位置的 HTML。</p></article>`;}
  function renderPage() {
    const title=labels[category()];
    return `<section class="page html-page"><article class="html-preview"><div class="html-preview-bar"><div class="html-preview-heading"><h1>${title}</h1><strong id="html-title">正在读取资料…</strong></div><div class="form-actions"><button class="button secondary small" data-action="html-files-toggle" aria-controls="html-file-panel" aria-expanded="false">文件列表</button><button class="button quiet small" data-action="html-choose">选择 HTML</button><button class="button quiet small" data-action="html-refresh">刷新文件</button><button class="button quiet small" data-action="html-reload">重新载入</button><button class="button secondary small" data-action="html-fullscreen" aria-pressed="false">专注预览</button></div></div><div class="html-workspace"><aside id="html-file-panel" class="html-file-panel" aria-label="选择 HTML 资料" hidden><div class="html-file-panel-head"><strong>HTML 资料</strong><button class="button quiet small" data-action="html-files-toggle" aria-label="收起文件列表">收起</button></div><label class="html-search">查找资料<input type="search" data-html-filter placeholder="输入文件名" value="${escape(current().filter)}"></label><div id="html-files" role="list" aria-label="HTML 文件列表"></div><p class="hint html-folder-note">项目的 06 资产及其子文件夹</p></aside><div id="html-message" class="html-message" role="status"></div><iframe id="html-frame" class="html-frame" title="HTML 资料预览" sandbox="allow-scripts allow-downloads" allow="clipboard-write" hidden></iframe></div></article></section>`;
  }
  // Keep the frame mounted while choosing files or changing the viewing layout.
  function showFiles(open, focus=false) {
    const panel=document.getElementById('html-file-panel');if(!panel)return;
    panel.hidden=!open;
    const button=document.querySelector('.html-preview-bar [data-action="html-files-toggle"]');
    button?.setAttribute('aria-expanded',String(open));
    if(focus)(open?panel.querySelector('input'):button)?.focus();
  }
  function patchList(s) {
    const list=document.getElementById('html-files');if(!list)return;
    const active=selected(s), files=filesFor(s).filter(file=>(file.name+' '+file.relative).toLowerCase().includes(s.filter.toLowerCase()));
    list.innerHTML=files.map(file=>`<button type="button" class="html-file ${file.path===active?.path?'current':''}" data-action="html-select" data-html-path="${escape(file.path)}" aria-current="${file.path===active?.path?'true':'false'}"><strong>${escape(file.name)}</strong><small>${escape(file.relative)}</small></button>`).join('') || `<p class="hint">${s.pending?'正在读取文件列表…':s.filter?'没有匹配的文件。':'这个分类还没有 HTML 资料。'}</p>`;
  }
  function patchPreview(s, force=false) {
    const frame=document.getElementById('html-frame'),title=document.getElementById('html-title'),message=document.getElementById('html-message');if(!frame)return;
    const file=selected(s);
    title.textContent=file?.name||labels[category()];
    title.title=file?.relative||file?.name||'';
    if(!file) {frame.hidden=true;if(frame.dataset.path){frame.removeAttribute('src');delete frame.dataset.path;delete frame.dataset.version;}message.hidden=false;message.textContent=s.error||'把 HTML 放入项目“06 资产”，或点击“选择 HTML”打开已有资料。';return;}
    const version=file.path+'|'+file.modifiedAt;
    if(frame.dataset.version===version&&!force)return;
    s.selected[category()]=file.path;remember(s);
    message.hidden=false;message.textContent='正在打开 '+file.name+'…';frame.hidden=false;frame.title=file.name;frame.dataset.path=file.path;frame.dataset.version=version;
    frame.onload=()=>{if(frame.dataset.path===file.path){message.textContent='';message.hidden=true;}};
    const url=new URL(file.url);url.searchParams.set('directorTheme',document.documentElement.dataset.theme||'light');if(force)url.searchParams.set('viewerReload',Date.now());
    frame.src=url.href;
  }
  async function load(force=false) {
    const p=project(),s=current();if(!p||!document.getElementById('html-frame'))return;
    if(s.pending)return s.pending;
    if(s.files&&!force&&Date.now()-s.at<30000){patchList(s);patchPreview(s);return;}
    s.pending=api.htmlList(p,{force,extra:s.extra});s.error='';patchList(s);
    try {s.files=await s.pending;s.at=Date.now();}
    catch(error){s.error=error.message;}
    finally {s.pending=null;if(project()?.projectPath===p.projectPath&&document.getElementById('html-frame')){patchList(s);patchPreview(s);if(s.error)toast(s.error);}}
  }
  function afterRender() {void load();}
  async function action(name,button) {
    if(!name?.startsWith('html-'))return false;
    const s=current(),p=project();if(!s)return true;
    try {
      if(name==='html-files-toggle')showFiles(document.getElementById('html-file-panel').hidden,true);
      else if(name==='html-select') {const file=filesFor(s).find(file=>file.path===button.dataset.htmlPath);if(file){s.selected[category()]=file.path;remember(s);patchList(s);patchPreview(s);showFiles(false,true);}}
      else if(name==='html-refresh')await load(true);
      else if(name==='html-reload')patchPreview(s,true);
      else if(name==='html-fullscreen'){const panel=document.querySelector('.html-preview');if(panel){const expanded=panel.classList.toggle('html-expanded');showFiles(false);button.textContent=expanded?'退出专注':'专注预览';button.setAttribute('aria-pressed',String(expanded));}}
      else if(name==='html-choose') {
        const file=await api.htmlChoose(p,category()==='all'?null:category());if(!file||project()?.projectPath!==p.projectPath)return true;
        s.extra=s.extra.filter(entry=>entry.path!==file.path);s.extra.push({path:file.path,category:file.category});
        s.files=(s.files||[]).filter(entry=>entry.path!==file.path);s.files.push(file);s.selected[category()]=file.path;remember(s);patchList(s);patchPreview(s);showFiles(false);
      }
    }catch(error){toast(error.message);}
    return true;
  }
  document.addEventListener('input',event=>{if(event.target.matches('[data-html-filter]')){const s=current();s.filter=event.target.value;patchList(s);}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('#modal-root .modal-overlay,.work-lock-layer')){const files=document.getElementById('html-file-panel');if(files&&!files.hidden){showFiles(false,true);return;}const panel=document.querySelector('.html-preview.html-expanded');if(panel){panel.classList.remove('html-expanded');const button=panel.querySelector('[data-action="html-fullscreen"]');button.textContent='专注预览';button.setAttribute('aria-pressed','false');button.focus();}}});
  return {renderPage,renderCards,afterRender,action};
};
