const productionUi = { cache: {}, selected: {}, drafts: {}, errors: {}, busy: false };
const productionRoles = [ ['director','导演统筹'], ['assets','资产与连续性'], ['shotlist','12列分镜'], ['prompt','Seedance提示词'], ['qc','独立质检'], ['post','后期交接'] ];
const productionStatus = { pending:'待准备', waiting:'等待网页结果', review:'待验收', approved:'已验收', rework:'需返修', stale:'上游已变更' };
function productionKey() { return `${state.project.id}:${state.project.currentEpisode}`; }
function productionDraft() {
  if(!productionUi.drafts[productionKey()]){try{productionUi.drafts[productionKey()]=JSON.parse(localStorage.getItem('production-draft:'+productionKey())||'{}');}catch{productionUi.drafts[productionKey()]={};}}
  return productionUi.drafts[productionKey()];
}
function productionDb() { return productionUi.cache[state.project.id]; }
function productionRender() {
  const db = productionDb();
  if (!db) {
    if (productionUi.errors[state.project.id]) return `<section class="card"><h2>制作记录读取失败</h2><p>${escapeHTML(productionUi.errors[state.project.id])}</p><button class="button" data-action="production-reload">重试读取</button></section>`;
    setTimeout(() => productionReload(), 0); return '<section class="card"><h2>制作中枢</h2><p>正在读取本地制作记录…</p></section>';
  }
  const ep = db.episodes[state.project.currentEpisode];
  const selected = productionUi.selected[productionKey()] || 'director';
  const task = ep?.tasks.find(t => t.id === selected);
  const draft = productionDraft();
  const latest = task?.versions.at(-1);
  const button = (action, label, attrs='') => `<button class="button secondary small" data-action="production-${action}" ${productionUi.busy ? 'disabled' : ''} ${attrs}>${label}</button>`;
  const cards = productionRoles.map(([id,name], index) => {
    const t = ep?.tasks.find(t => t.id === id);
    return `<button class="production-role ${id===selected?'selected':''}" data-action="production-select" data-task="${id}"><span>0${index+1}</span><strong>${name}</strong><small class="production-status ${t?.status || 'pending'}">${productionStatus[t?.status] || '待准备'}</small></button>`;
  }).join('');
  const versions = (task?.versions || []).map((v,i) => `<details><summary>版本 ${i+1} · ${escapeHTML(v.at)} ${v.approvedAt?'· 已验收':''}</summary><pre class="production-preview">${escapeHTML(v.content)}</pre></details>`).join('');
  const issues = (task?.issues || []).map(i => `<article class="production-issue"><strong>${i.resolved?'已复查':'待解决'} · ${escapeHTML(i.location)}</strong><p>${escapeHTML(i.detail)}</p><blockquote>${escapeHTML(i.evidence)}</blockquote>${i.resolved?`<p>复查：${escapeHTML(i.resolution)}</p>`:`<input data-production-field="resolution-${i.id}" placeholder="修订位置与复查证据" value="${escapeHTML(draft['resolution-'+i.id] || '')}">${button('resolve','记录复查',`data-issue="${i.id}"`)}`}</article>`).join('') || '<p class="hint">暂无人工问题记录。未记录问题不代表已经完成质检。</p>';
  const memories = db.memory.map(m => `<article class="production-issue"><strong>第${m.from}—${m.to}集 · ${m.status==='confirmed'?'已确认':'待确认'}</strong><p>${escapeHTML(m.text)}</p><blockquote>${escapeHTML(m.evidence)}</blockquote>${m.status==='pending'?button('confirm-memory','确认并纳入后续任务',`data-memory="${m.id}"`):''}</article>`).join('');
  const snapshot = ep ? Object.entries(ep.documents).map(([k,v]) => `<span>${({source:'小说',script:'剧本',shotlist:'分镜',storyboard:'提示词'})[k] || escapeHTML(k)}：${v.content?'已同步':'空'} <small>${escapeHTML(v.hash.slice(0,8))}</small></span>`).join(' · ') : '请先在编辑器选择本集定稿剧本，再同步资料。';
  return `<section class="production-hub"><header class="production-heading"><div><div class="eyebrow">导演台剧场 V${escapeHTML(state.membership?.version || window.directorRuntimeInfo?.patch || '0.1.14')}</div><h1>第 ${escapeHTML(directorEpisodeSlots.label(state.project, state.project.currentEpisode))} 集 · 制作中枢</h1><p>按职责准备任务、回收完整结果、验收后交接。制作记录保存在本地项目。</p></div><span class="production-mode">网页协作 · 无 API 接入</span></header>
    <div class="production-toolbar">${button('sync','同步本集资料')}${button('reload','刷新记录')}${button('pause',ep?.paused?'恢复制作':'暂停制作')}${button('export','导出任务与版本')}<span>${ep?.paused?'已暂停，可查看和导出记录':`${ep?.tasks.filter(t=>t.status==='approved').length || 0} / 6 项已验收`}</span></div>
    <p class="hint">${snapshot}</p><div class="production-roles">${cards}</div>
    <div class="production-columns"><section class="card"><div class="card-title"><h2>${productionRoles.find(r=>r[0]===selected)[1]}</h2><span>${productionStatus[task?.status] || '待准备'}</span></div>
    <p class="hint">分镜需先验收导演与资产结果；提示词继承已验收分镜；质检完成后才进入后期交接。网页回复不会自动视为验收通过。</p>
    <div class="form-actions">${button('prepare','生成本轮任务单')}${button('copy','复制任务单')}${button('chat','打开 ChatGPT')}${button('execute','网页执行 / 继续回收')}${button('stop-web','暂停网页等待')}</div>
    <details ${task?.prepared?'open':''}><summary>本轮任务单与资料快照</summary><pre class="production-preview">${escapeHTML(task?.prepared?.prompt || '同步资料后生成。任务单包含本集全文、已验收上游结果、项目规则和已确认连续性。')}</pre></details>
    <label class="production-label" for="production-result">回收完整结果（每次保存为新版本）</label><textarea id="production-result" data-production-field="result-${selected}" rows="12" placeholder="从网页复制完整结果到这里">${escapeHTML(draft['result-'+selected] || '')}</textarea>
    <div class="form-actions">${button('result','保存结果并做基础检查')}${button('approve','人工验收通过')}</div>
    ${latest?`<div class="production-checks">${latest.checks.map(c=>`<p class="${c.level}">${escapeHTML(c.detail)}</p>`).join('')}</div>`:''}
    <details><summary>结果历史 · ${task?.versions.length || 0} 个版本</summary>${versions || '<p>尚无结果。</p>'}</details></section>
    <aside><section class="card"><h2>问题 → 返修 → 复查</h2><p class="hint">在对应制作职责下登记问题；重新生成任务单时自动带入未解决问题。需要新结果与复查证据才能再次验收。</p>
    <input data-production-field="location" placeholder="第几组 / 镜号 / 组内秒 / 前后镜" value="${escapeHTML(draft.location || '')}"><textarea data-production-field="detail" rows="2" placeholder="问题与建议替换">${escapeHTML(draft.detail || '')}</textarea><textarea data-production-field="evidence" rows="2" placeholder="剧本原句 / 文件与位置依据">${escapeHTML(draft.evidence || '')}</textarea>${button('issue','登记问题并退回返修')}${issues}</section>
    <section class="card"><h2>连续性记忆</h2><p class="hint">只把有依据、经你确认的事实放进任务；确认新记忆会提醒相关集数重新验收。</p><textarea data-production-field="memoryText" rows="2" placeholder="服饰、伤势、持物或地点连续性">${escapeHTML(draft.memoryText || '')}</textarea><input data-production-field="memoryEvidence" placeholder="来源文件与原句位置" value="${escapeHTML(draft.memoryEvidence || '')}"><div class="production-range"><input aria-label="记忆开始集" type="number" data-production-field="from" value="${Number(draft.from)||state.project.currentEpisode}"><span>至</span><input aria-label="记忆结束集" type="number" data-production-field="to" value="${Number(draft.to)||state.project.currentEpisode}"></div>${button('memory','保存待确认记忆')}${memories}</section></aside></div>
    <details class="card"><summary>进度记录 · 重启后保留</summary>${db.events.slice(-30).reverse().map(e=>`<p>${escapeHTML(e.at)} · 第${e.episode}集 · ${escapeHTML(productionRoles.find(r=>r[0]===e.task)?.[1] || '')} · ${escapeHTML(({sync:'同步资料',prepare:'生成任务单',result:'保存新结果',approve:'人工验收',issue:'登记返修',resolve:'记录复查',memory:'新增待确认记忆','confirm-memory':'确认记忆',export:'导出',pause:'切换暂停状态'})[e.action] || e.action)}</p>`).join('') || '尚无记录。'}</details></section>`;
}
async function productionReload() {
  const project = state.project;
  if (!project || productionUi.busy) return;
  productionUi.busy = true;
  try { productionUi.cache[project.id] = await window.directorApi.productionLoad(project); delete productionUi.errors[project.id]; }
  catch(e) { productionUi.errors[project.id] = e.message; showToast(e.message); }
  finally { productionUi.busy = false; if (state.project?.id === project.id && ['production','workbench'].includes(state.view)) render(); }
}
async function productionAction(action, button) {
  if (productionUi.busy) return;
  const project = deepCopy(state.project), selected = productionUi.selected[productionKey()] || 'director', draft = productionDraft();
  if(action==='execute')return productionWebRun(selected);
  if(action==='stop-web'){await window.directorApi.productionStop(project);return showToast('已请求暂停当前网页等待。');}
  if (action === 'select') { productionUi.selected[productionKey()] = button.dataset.task; render(); return; }
  if (action === 'reload') return productionReload();
  if (action === 'chat') { await window.directorApi.openChatGpt(project); return; }
  if (action === 'copy') {
    const prompt = productionDb()?.episodes[project.currentEpisode]?.tasks.find(t=>t.id===selected)?.prepared?.prompt;
    if (!prompt) return showToast('请先生成本轮任务单。');
    await window.directorApi.productionCopy(prompt); return showToast('任务单已复制，包含完整资料。');
  }
  const input = { action, episode: project.currentEpisode, revision: productionDb().revision, task: selected, content: draft['result-'+selected], location: draft.location, detail: draft.detail, evidence: action==='resolve'?draft['resolution-'+button.dataset.issue]:action==='memory'?draft.memoryEvidence:draft.evidence, issue: button.dataset.issue, memory: button.dataset.memory, text: draft.memoryText, from: draft.from, to: draft.to };
  productionUi.busy = true;
  try {
    const result = await window.directorApi.productionAct(project, input);
    productionUi.cache[project.id] = result.db;
    if (action === 'result') draft['result-'+selected] = '';
    if (action === 'issue') { draft.detail=''; draft.location=''; draft.evidence=''; }
    if (action === 'memory') { draft.memoryText=''; draft.memoryEvidence=''; }
    try{localStorage.setItem('production-draft:'+productionKey(),JSON.stringify(draft));}catch{}
    showToast(result.outputPath ? `已导出：${result.outputPath}` : '制作记录已保存。');
  } finally { productionUi.busy = false; render(); }
}
document.addEventListener('input', event => {
  if (event.target.dataset.productionField && state.project) {
    productionDraft()[event.target.dataset.productionField] = event.target.value;
    try{localStorage.setItem('production-draft:'+productionKey(),JSON.stringify(productionDraft()));}catch{}
  }
});

