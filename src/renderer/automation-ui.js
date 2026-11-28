'use strict';
window.createAutomationUI = function ({project,api,render,toast,save,refresh,canEdit,openLibrary,openAssetBatch,onSettings}) {
  const cache=new Map(),stages=[['outline','大纲'],['script','剧本'],['relationships','人物关系网'],['assets','资产与图片提示词'],['assetImages','资产自动生图'],['shotlist','分镜'],['storyboard','视频提示词'],['check','检查']];
  const items=[['structure','格式与完整性'],['dialogue','台词与说话人'],['content','原文事实'],['logic','因果与人物动机'],['continuity','前后连续性'],['scenes','场景、时间与道具'],['assets','统一资产名称'],['timing','时长与可拍性']];
  const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function current() {
    const p=project();if(!p)return null;
    if(!cache.has(p.projectPath))cache.set(p.projectPath,{draft:{start:1,end:Math.max(1,...(p.episodes||[]).map(x=>Math.floor(x.number))),stages:stages.map(x=>x[0]).filter(id=>id!=='assetImages'),chaptersPerEpisode:1,firstEpisode:1,skipExisting:true,stopOnProblems:true,imageProvider:'magpie',imageModel:'codex/gpt-image-2',imageConcurrency:2,...p.automationOptions},quality:{items:items.map(x=>x[0]),semantic:true,strictness:'normal',protectDialogue:true,...p.qualityOptions},kind:'script',job:null,preview:null,report:null,candidate:null,busy:false,qualityBusy:false,error:''});
    return cache.get(p.projectPath);
  }
  function settingsHTML(s,prefix) {
    return `<div class="flow-check-grid">${items.map(([id,label])=>`<label><input type="checkbox" data-flow-setting="${prefix}.items.${id}" ${s.items?.includes(id)?'checked':''}>${label}</label>`).join('')}</div><div class="flow-grid"><label>检查尺度<select data-flow-setting="${prefix}.strictness">${[['lenient','宽松：关注实质错误'],['normal','标准：错误阻断，提示供参考'],['strict','严格：提示也暂停流程']].map(([id,label])=>`<option value="${id}" ${s.strictness===id?'selected':''}>${label}</option>`).join('')}</select></label><label><input type="checkbox" data-flow-setting="${prefix}.semantic" ${s.semantic?'checked':''}>使用 API 审查内容与逻辑</label><label><input type="checkbox" data-flow-setting="${prefix}.protectDialogue" ${s.protectDialogue?'checked':''}>优化时保护台词和说话人顺序</label></div>`;
  }
  function scopeHTML(s){return `<label class="flow-block">优化范围<select data-flow-setting="quality.optimizationScope">${[['format','只调整格式，保持正文'],['clarity','改善描写与表达'],['continuity','修补场景与前后衔接'],['custom','按我的优化要求']].map(([id,label])=>`<option value="${id}" ${(s.optimizationScope||'clarity')===id?'selected':''}>${label}</option>`).join('')}</select></label>`;}
  function statusHTML(s) {
    const job=s.job,status={running:'正在制作',paused:'已暂停',failed:'需要重试',done:'制作完成','needs-review':'等待处理检查问题'}[job?.status]||'尚未开始';
    const records=Object.entries(job?.records||{});
    return `<div class="flow-status ${job?.status==='failed'?'error':''}"><strong>${status}</strong><p>${e(s.error||job?.message||'先核对拆集预览，然后开始。')}</p><p id="flow-stream"></p>${job?`<p>当前第 ${e(job.episode||'—')} 集 · ${e(stages.find(x=>x[0]===job.stage)?.[1]||'准备')} · 已完成 ${records.filter(([,r])=>['done','adopted'].includes(r.status)).length} 个步骤</p>`:''}</div>${records.length?`<details><summary>查看各集步骤</summary><div class="flow-records">${records.map(([key,r])=>`<div><span>第 ${e(key.split(':')[0])} 集 · ${e(stages.find(x=>x[0]===key.split(':')[1])?.[1])}</span><b>${e({done:'完成',adopted:'引用已有',running:'进行中',paused:'暂停',failed:'失败','needs-review':'待检查'}[r.status]||r.status)}</b></div>`).join('')}</div></details>`:''}<details ${job?.status==='failed'?'open':''}><summary>执行记录</summary><pre class="flow-log">${(job?.logs||[]).map(x=>`${new Date(x.at).toLocaleTimeString()}  ${e(x.message)}`).join('\n')||'尚无记录'}</pre></details>`;
  }
  function renderAutomation() {
    const s=current(),d=s.draft;
    const imgStageEnabled=d.stages.includes('assetImages');
    return `<section class="page flow-page"><div class="page-heading"><div><div class="eyebrow">AUTOMATION · 全流程自动制作</div><h1>自动制作</h1><p class="lead">原文 → 大纲 → 剧本 → 人物关系网 → 资产提示词 → 自动生图（Magpie / API）→ 分镜 → 提示词 → 检查</p></div><div class="form-actions"><button class="button secondary" data-action="flow-open-asset-batch">批量生图工作台</button><button class="button quiet" data-action="flow-open-outputs">打开项目成果</button></div></div><div class="flow-layout"><div><fieldset class="flow-fieldset" ${s.busy?'disabled':''}><article class="card"><h2>1. 原文与拆集</h2><p class="hint">默认一章一集。选择整本原文后先预览拆集；留空则使用项目里已选定的每集原文。</p><div class="flow-source"><input data-flow-setting="draft.sourcePath" value="${e(d.sourcePath)}" placeholder="使用项目现有原文，或选择完整小说"><button class="button secondary" data-action="flow-source">选择原文</button></div><div class="flow-grid"><label>小说首章对应第几集<input type="number" min="1" data-flow-setting="draft.firstEpisode" value="${d.firstEpisode||1}"></label><label>每集章节数<input type="number" min="1" data-flow-setting="draft.chaptersPerEpisode" value="${d.chaptersPerEpisode}"></label><label>开始集<input type="number" min="1" data-flow-setting="draft.start" value="${d.start}"></label><label>结束集<input type="number" min="1" data-flow-setting="draft.end" value="${d.end}"></label></div><button class="button secondary" data-action="flow-preview">预览拆集与范围</button> <button class="button quiet" data-action="flow-use-all">使用全部章节</button><div id="flow-preview">${previewHTML(s)}</div></article><article class="card"><h2>2. 制作步骤</h2><div class="flow-steps">${stages.map(([id,label],i)=>`<label><input type="checkbox" data-flow-stage="${id}" ${d.stages.includes(id)?'checked':''}><span>${i+1}. ${label}</span></label>`).join('')}</div>${imgStageEnabled?`<div class="flow-image-config"><div class="flow-grid"><label>生图通道<select data-flow-setting="draft.imageProvider"><option value="magpie" ${(d.imageProvider||'magpie')==='magpie'?'selected':''}>Magpie 本机网关（推荐）</option><option value="openai-image-api" ${d.imageProvider==='openai-image-api'?'selected':''}>OpenAI 兼容图像 API</option></select></label><label>图像模型<input type="text" data-flow-setting="draft.imageModel" value="${e(d.imageModel||'codex/gpt-image-2')}" placeholder="codex/gpt-image-2"></label><label>并发数<input type="number" min="1" max="8" data-flow-setting="draft.imageConcurrency" value="${d.imageConcurrency||2}"></label></div><p class="hint">完成「资产与图片提示词」后会自动同步生成标准分层出图队列，并自动建批调用所选图像模型生成 L0 母板，随后可在「素材 → 批量生图」目检与归档。</p></div>`:''}<label class="flow-block">我的制作要求<textarea rows="4" data-flow-setting="draft.instruction" placeholder="补充节奏、集数、风格等需求">${e(d.instruction)}</textarea></label><label class="flow-block">资产图片风格<textarea rows="2" data-flow-setting="draft.assetStyle" placeholder="影视真人写实，统一年代；场景为空景，道具白底">${e(d.assetStyle||'影视真人写实，统一年代、摄影、色彩与光线；场景为空景；道具白底。')}</textarea></label><p class="hint">各步骤沿用 API / Magpie 输入设置。完成第 4 步后会自动写入分层出图队列，勾选第 5 步即可在自动流程中直接驱动批量生图。</p><div class="flow-check-grid"><label><input type="checkbox" data-flow-setting="draft.skipExisting" ${d.skipExisting?'checked':''}>继续时引用已有成品</label><label><input type="checkbox" data-flow-setting="draft.stopOnProblems" ${d.stopOnProblems?'checked':''}>检查有问题时暂停，处理后再继续</label></div></article><article class="card"><h2>3. 检查设置</h2>${settingsHTML(s.quality,'quality')}<p class="hint">自动流程不反复重写成品。需要优化时到“检查与优化”生成候选，确认后应用。</p></article></fieldset></div><aside class="flow-side card"><h2>执行与成果</h2><p class="hint">模型：${e(project().aiRunner?.model||'请先配置 API 或 Magpie')}</p><button class="button quiet small" data-view="generate">配置 API / Magpie 与要求文件</button><div id="flow-status">${statusHTML(s)}</div><div class="flow-buttons"><button class="button" data-action="flow-run" ${s.busy||!canEdit()?'disabled':''}>继续未完成 / 开始</button><button class="button secondary" data-action="flow-regenerate" ${s.busy||!canEdit()?'disabled':''}>重新生成所选范围</button><button class="button danger" data-action="flow-stop" ${s.busy?'':'disabled'}>暂停制作</button><button class="button secondary" data-action="flow-refresh" ${s.busy?'disabled':''}>刷新成果到编辑页</button></div><div class="flow-buttons"><button class="button quiet" data-action="flow-library-relationships">人物关系网</button><button class="button quiet" data-action="flow-library-assets">资产与图片提示词</button><button class="button quiet" data-action="flow-open-asset-batch">打开批量生图</button><button class="button quiet" data-action="flow-open-reports">检查报告</button><button class="button secondary" data-view="quality-center">检查与优化</button></div></aside></div></section>`;
  }
  function previewHTML(s) {return s.preview?`<p class="hint">识别 ${s.preview.chapterCount} 章，所选范围 ${s.preview.episodes.length} 集${s.preview.preface?'；序言单独保存，不混入第一集':''}。</p><div class="flow-records">${s.preview.episodes.map(x=>`<div><span>第 ${x.number} 集 · ${e(x.title)}</span><b>${x.characters} 字</b></div>`).join('')}</div>`:'';}
  function reportHTML(s) {
    const r=s.report;if(!r)return '<p class="hint">选择检查范围后开始。没有依据的问题会标为待核对。</p>';
    return `<h3>第 ${e(r.episode)} 集检查结果${r.incomplete?' · 有待补充的检查':''}</h3><p class="hint">${r.coverage.map(e).join('<br>')}</p>${r.issues.map(x=>`<article class="flow-issue ${x.level}"><strong>${e(x.level==='error'?'问题':'提示')} · ${e(x.title)}</strong><p>${e(x.location||'')} ${e(x.origin||'')}</p>${x.quote?`<blockquote>${e(x.quote)}</blockquote>`:''}<p>${e(x.explanation||x.detail||'')}</p><p>建议：${e(x.suggestion||'按定位信息核对正文。')}</p></article>`).join('')||'<p>本次范围内未发现问题。</p>'}<button class="button secondary" data-action="quality-propose" ${s.qualityBusy||!r.path?'disabled':''}>生成优化候选</button><p class="hint">候选经你确认才替换原稿；应用前再次核对原稿是否变化。</p>`;
  }
  function candidateHTML(s) {const c=s.candidate;if(!c)return '';return `<h3>优化候选 · 等待确认</h3><ul>${c.changes.map(x=>`<li>${e(x)}</li>`).join('')}</ul><div class="flow-compare"><div><h4>原稿</h4><pre>${e(c.report.content)}</pre></div><div><h4>候选</h4><pre>${e(c.content)}</pre></div></div><div class="flow-buttons"><button class="button" data-action="quality-apply" ${s.qualityBusy?'disabled':''}>确认应用并重新检查</button><button class="button quiet" data-action="quality-discard">保留原稿，丢弃候选</button></div>`;}
  function renderQuality() {
    const s=current();return `<section class="page flow-page"><div class="page-heading"><div><div class="eyebrow">QUALITY & EDITING</div><h1>检查与优化</h1><p class="lead">选择检查项和尺度，查看证据，再决定如何修改。</p></div><button class="button secondary" data-view="editor">返回编辑</button></div><article class="card"><fieldset class="flow-fieldset" ${s.qualityBusy?'disabled':''}><div class="flow-grid"><label>检查文件<select data-flow-kind>${[['script','本集剧本'],['shotlist','本集分镜'],['storyboard','本集视频提示词']].map(([id,label])=>`<option value="${id}" ${s.kind===id?'selected':''}>${label}</option>`).join('')}</select></label><span>第 ${e(project().currentEpisode)} 集</span></div>${settingsHTML(s.quality,'quality')}${scopeHTML(s.quality)}<label class="flow-block">检查重点 / 优化要求<textarea rows="3" data-flow-setting="quality.instruction" placeholder="例如：只调整场景衔接，保持剧情与台词">${e(s.quality.instruction)}</textarea></label><p class="hint">开始前保存当前编辑内容。本地检查无需调用 API；勾选 API 后可检查内容、逻辑、场景与连续性。未提供的材料会在报告中标明。</p><button class="button" data-action="quality-run" ${!canEdit()?'disabled':''}>检查当前文件</button></fieldset><button class="button danger" data-action="quality-stop" ${s.qualityBusy?'':'disabled'}>停止检查 / 优化</button><span id="quality-message">${e(s.qualityBusy?'正在处理，可随时停止。':s.error)}</span></article><article class="card" id="quality-report">${reportHTML(s)}</article><article class="card" id="quality-candidate" ${s.candidate?'':'hidden'}>${candidateHTML(s)}</article>${s.applied?`<article class="card"><p>优化已应用，原稿已备份。</p><button class="button secondary" data-action="quality-undo">恢复应用前原稿</button><button class="button quiet" data-action="flow-open-reports">打开报告与候选记录</button></article>`:''}</section>`;
  }
  function patchStatus(s=current()) {const el=document.getElementById('flow-status');if(el)el.innerHTML=statusHTML(s);}
  function libraryHTML(s) {
    const files=s.visuals||[],selected=files.find(f=>f.path===s.visualPath)||files[0];
    return `<div class="card-title"><h2>制作资料 · 在程序中查看</h2><button class="button quiet small" data-action="flow-library-refresh">刷新列表</button></div><p class="hint">人物关系网和资产提示词 HTML 均保存在“06 资产”。也支持这个文件夹内已有的 HTML 资料。</p>${files.length?`<div class="flow-grid"><label>选择资料<select data-flow-visual>${files.map(f=>`<option value="${e(f.path)}" ${f.path===selected.path?'selected':''}>${e(f.name)}</option>`).join('')}</select></label><button class="button secondary" data-action="flow-library-fullscreen">放大查看</button></div><iframe class="flow-visual-frame" title="${e(selected.name)}" src="${e(selected.url)}?directorTheme=${e(document.documentElement.dataset.theme)}" sandbox="allow-scripts allow-downloads" allow="clipboard-write"></iframe>`:'<p class="hint">尚未生成 HTML 资料，完成自动制作中的人物关系或资产步骤后即可查看。</p>'}`;
  }
  function renderLibrary() {const s=current();return `<article class="card flow-library" id="flow-library">${libraryHTML(s)}</article>`;}
  async function loadVisuals(force=false) {
    const p=project(),s=current();if(s.visuals&&!force)return;
    s.visuals=await api.automationVisuals(p);
    if(project()?.projectPath===p.projectPath){const element=document.getElementById('flow-library');if(element)element.innerHTML=libraryHTML(s);}
  }
  async function load() {const p=project(),s=current();if(!p||s.loaded)return;s.loaded=true;try{s.job=await api.automationLoad(p);if(project()?.projectPath===p.projectPath)patchStatus(s);}catch(err){s.error=err.message;patchStatus(s);}}
  function changed(event) {
    const t=event.target,s=current();if(!s)return;
    if(t.dataset.flowSetting) {const [area,key,id]=t.dataset.flowSetting.split('.');if(id){const set=new Set(s[area][key]);t.checked?set.add(id):set.delete(id);s[area][key]=[...set];}else s[area][key]=t.type==='checkbox'?t.checked:t.type==='number'?Number(t.value):t.value;
      project().automationOptions={...s.draft};project().qualityOptions={...s.quality};}
    if(t.dataset.flowStage){const set=new Set(s.draft.stages);t.checked?set.add(t.dataset.flowStage):set.delete(t.dataset.flowStage);s.draft.stages=[...set];project().automationOptions={...s.draft};if(t.dataset.flowStage==='assetImages')render();}
    if(t.matches('[data-flow-kind]')&&event.type==='change'){s.kind=t.value;s.report=null;s.candidate=null;render();}
    if(t.matches('[data-flow-visual]')&&event.type==='change'){s.visualPath=t.value;const element=document.getElementById('flow-library');if(element)element.innerHTML=libraryHTML(s);}
    if(t.dataset.flowSetting || t.dataset.flowStage)onSettings?.();
  }
  document.addEventListener('input',changed);
  document.addEventListener('change',event=>{if(event.target.type==='checkbox'||event.target.tagName==='SELECT')changed(event);});
  async function doCheck(s,p) {
    const previous= p.episodes?.find(ep=>Number(ep.number)===Math.floor(Number(p.currentEpisode))-1)?.script?.content || '';
    s.report=await api.qualityCheck(p,{kind:s.kind,settings:s.quality,previous});s.candidate=null;
  }
  async function action(name) {
    if(!name?.startsWith('flow-')&&!name?.startsWith('quality-'))return false;
    const s=current(),p=project();if(!p)return true;
    try {
      if(name==='flow-source'){const file=await api.automationChooseSource();if(file){s.draft.sourcePath=file;s.preview=null;project().automationOptions={...s.draft};render();}}
      else if(name==='flow-preview'){s.preview=await api.automationPreview(p,s.draft);const el=document.getElementById('flow-preview');if(el)el.innerHTML=previewHTML(s);}
      else if(name==='flow-use-all'){if(!s.draft.sourcePath)throw Error('请先选择完整小说原文。');const preview=await api.automationPreview(p,s.draft);s.draft.start=s.draft.firstEpisode||1;s.draft.end=s.draft.start+Math.ceil(preview.chapterCount/s.draft.chaptersPerEpisode)-1;s.preview=await api.automationPreview(p,s.draft);p.automationOptions={...s.draft};render();}
      else if(name==='flow-library-refresh'){await loadVisuals(true);}
      else if(name==='flow-library-fullscreen'){const frame=document.querySelector('.flow-visual-frame');await frame?.requestFullscreen();}
      else if(name==='flow-library-relationships'||name==='flow-library-assets'){
        openLibrary(name==='flow-library-relationships'?'relationships':'assets');
      }
      else if(name==='flow-open-asset-batch'){
        if(typeof openAssetBatch==='function')openAssetBatch();
        else openLibrary('assets');
      }
      else if(name==='flow-run'||name==='flow-regenerate') {
        if(s.busy||s.qualityBusy)return true;
        if(name==='flow-regenerate'&&!await window.directorConfirm(`重新生成第 ${s.draft.start}—${s.draft.end} 集所选步骤？已有成品会先备份。`))return true;
        await save();const snapshot=structuredClone(project());s.busy=true;s.error='';render();
        try{s.job=await api.automationRun(snapshot,{...s.draft,quality:s.quality,mode:name==='flow-regenerate'?'regenerate':'resume'});s.visuals=null;if(project()?.projectPath===snapshot.projectPath)await refresh(s.job.bindings);}
        finally{s.busy=false;if(project()?.projectPath===snapshot.projectPath)render();}
      } else if(name==='flow-stop'){await api.automationCancel();toast('正在暂停，当前请求已取消；完成的步骤会保留。');}
      else if(name==='flow-refresh'){await save();await refresh(s.job?.bindings);render();}
      else if(name.startsWith('flow-open-'))await api.automationOpen(p,name.slice('flow-open-'.length));
      else if(name==='quality-stop'){await api.qualityCancel();toast('已请求停止。');}
      else if(name==='quality-run'||name==='quality-propose'||name==='quality-apply'||name==='quality-undo') {
        if(s.busy||s.qualityBusy)return true;await save();const snapshot=structuredClone(project());s.qualityBusy=true;s.error='';render();
        try {
          if(name==='quality-run')await doCheck(s,snapshot);
          else if(name==='quality-propose')s.candidate=await api.qualityPropose(snapshot,s.report,s.quality.instruction,s.quality);
          else if(name==='quality-apply'){const applied=await api.qualityApply(snapshot,s.candidate.id);s.applied=applied;s.candidate=null;if(project()?.projectPath===snapshot.projectPath)await refresh();await doCheck(s,structuredClone(project()?.projectPath===snapshot.projectPath?project():snapshot));}
          else {await api.qualityUndo(snapshot,s.applied.id);s.applied=null;s.report=null;if(project()?.projectPath===snapshot.projectPath)await refresh();}
        } finally {s.qualityBusy=false;if(project()?.projectPath===snapshot.projectPath)render();}
      } else if(name==='quality-discard'){s.candidate=null;render();}
    } catch(err){s.error=err.message;toast(err.message);if(project()?.projectPath===p.projectPath)render();}
    return true;
  }
  api.onAutomationEvent(payload=>{
    if(['automation-progress','quality-progress','automation-log','quality-log'].includes(payload.type)){
      if(payload.projectPath!==project()?.projectPath)return;
      if(payload.type==='automation-progress'){const el=document.querySelector('#flow-stream');if(el)el.textContent=`思考 ${payload.progress.reasoningChars} 字 · 正文 ${payload.progress.contentChars} 字`;}
      else if(payload.type==='quality-progress'){const el=document.querySelector('#quality-message');if(el)el.textContent=`正在处理，已收到 ${payload.chars} 字，可随时停止。`;}
      else {const s=current();if(s.job&&payload.type==='automation-log'){s.job.logs.push({at:new Date().toISOString(),message:payload.message});s.job.message=payload.message;patchStatus(s);}else {const el=document.querySelector('#quality-message');if(el)el.textContent=payload.message;}}
      return;
    }
    if(payload.type!=='automation')return;
    const s=cache.get(payload.projectPath);if(!s)return;s.job=payload.job;if(project()?.projectPath===payload.projectPath)patchStatus(s);
  });
  return {summary:()=>{const s=current();return {busy:[...cache.values()].some(x=>x.busy),qualityBusy:[...cache.values()].some(x=>x.qualityBusy),error:s?.error,report:s?.report};},renderAutomation,renderQuality,renderLibrary,loadVisuals,action,load,isBusy:()=>[...cache.values()].some(s=>s.busy||s.qualityBusy)};
};
