const appRoot = document.querySelector('#app');
const toastElement = document.querySelector('#toast');

const state = {
  project: null,
  view: 'project',
  episode: null,
  activeFiles: {},
  assetFilter: '全部',
  searchMatches: [],
  searchIndex: -1,
  toastTimer: null
};

const viewDefinitions = [
  ['project', '项目'],
  ['source', '原文'],
  ['script', '剧本'],
  ['shotlist', '分镜'],
  ['prompt', '提示词'],
  ['assets', '素材']
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function showToast(message, error = false) {
  clearTimeout(state.toastTimer);
  toastElement.textContent = message;
  toastElement.className = error ? 'show error' : 'show';
  state.toastTimer = setTimeout(() => { toastElement.className = ''; }, 3200);
}

function formatLabel(extension) {
  if (extension === '.docx') return 'WORD';
  if (extension === '.md' || extension === '.markdown') return 'MD';
  return 'TXT';
}

function formatTime(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; }
}

function semanticMarkup(value) {
  const pattern = /(@[^\s，。；、,:：!?！？\[\]{}<>“”"']+|\[[^\]\r\n]+\]|\{[^}\r\n]+\}|“[^”\r\n]+”)/g;
  let cursor = 0;
  let html = '';
  for (const match of String(value || '').matchAll(pattern)) {
    html += escapeHtml(value.slice(cursor, match.index));
    const token = match[0];
    const tokenClass = token.startsWith('@') ? 'token-at' : token.startsWith('[') ? 'token-bracket' : token.startsWith('{') ? 'token-brace' : 'token-quote';
    html += `<span class="${tokenClass}">${escapeHtml(token)}</span>`;
    cursor = match.index + token.length;
  }
  return html + escapeHtml(String(value || '').slice(cursor));
}

function shellMarkup() {
  const nav = viewDefinitions.map(([key, label]) => `<button type="button" data-view="${key}" class="${state.view === key ? 'active' : ''}">${label}</button>`).join('');
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <img src="../assets/app-icon.png" alt="" />
          <div><strong>导演台剧场</strong><small>READER</small></div>
          <span class="readonly-pill">只读</span>
        </div>
        <nav class="nav">${nav}</nav>
        <div class="sidebar-note">纯阅读版本<br />不会修改项目文件</div>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div class="project-heading">
            <strong id="project-name">${escapeHtml(state.project?.name || '尚未选择项目')}</strong>
            <span id="project-path">${escapeHtml(state.project?.rootPath || '选择一个 00—06 项目文件夹开始阅读')}</span>
          </div>
          <div class="top-actions">
            <button class="button" id="choose-project" type="button">选择项目</button>
            <button class="button primary" id="refresh-project" type="button" ${state.project ? '' : 'disabled'}><span class="refresh-icon">↻</span>刷新</button>
          </div>
        </header>
        <div class="episode-bar" id="episode-bar"></div>
        <main class="reader-panel" id="reader-panel"></main>
      </section>
    </div>`;
}

function bindShell() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    state.searchMatches = [];
    state.searchIndex = -1;
    renderShell();
  }));
  document.querySelector('#choose-project').addEventListener('click', chooseProject);
  document.querySelector('#refresh-project').addEventListener('click', refreshProject);
}

function renderEpisodeBar() {
  const bar = document.querySelector('#episode-bar');
  if (!state.project) {
    bar.innerHTML = '<span class="episode-empty">选择项目后显示集数</span>';
    return;
  }
  const episodes = state.project.episodes || [];
  bar.innerHTML = `<span class="episode-label">集</span><div class="episode-strip">${episodes.length
    ? episodes.map((episode) => `<button type="button" data-episode="${episode}" class="${Number(state.episode) === Number(episode) ? 'active' : ''}">${episode}</button>`).join('')
    : '<span class="episode-empty">未从文件名识别到集数，仍可按文件阅读</span>'}</div>`;
  bar.querySelectorAll('[data-episode]').forEach((button) => button.addEventListener('click', () => {
    state.episode = Number(button.dataset.episode);
    renderEpisodeBar();
    renderReader();
  }));
  requestAnimationFrame(() => bar.querySelector('[data-episode].active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
}

function welcomeMarkup() {
  return `<div class="welcome"><div class="welcome-card"><img class="welcome-icon" src="../assets/app-icon.png" alt="" /><h1>纯阅读版</h1><p>查看原文、剧本、分镜、提示词和素材。软件不会提供编辑、保存、检查或 AI 生成功能，也不会改动项目文件。</p><button class="button primary" id="welcome-choose" type="button">选择项目文件夹</button></div></div>`;
}

function toolbarMarkup({ title, fileOptions = '', selectedPath = '', format = '', duration = '', updatedAt = '' }) {
  return `<div class="reader-toolbar">
    <div class="view-title"><strong>${escapeHtml(title)}</strong><small>${state.episode ? `第 ${state.episode} 集` : '全部文件'}</small></div>
    ${fileOptions ? `<select class="file-select" id="file-select">${fileOptions}</select>` : ''}
    ${format ? `<span class="format-chip">${escapeHtml(format)}</span>` : ''}
    ${duration ? `<span class="duration-chip">${escapeHtml(duration)}</span>` : ''}
    ${updatedAt ? `<span class="updated-chip">更新 ${escapeHtml(formatTime(updatedAt))}</span>` : ''}
    ${selectedPath ? `<div class="search-box"><input id="reader-search" type="search" autocomplete="off" placeholder="查找当前文档" /><span id="search-count">0/0</span><button id="search-prev" type="button" title="上一个">‹</button><button id="search-next" type="button" title="下一个">›</button></div>` : ''}
  </div>`;
}

function projectMarkup() {
  const counts = [
    ['原文', state.project.documents.source?.length || 0],
    ['剧本', state.project.documents.script?.length || 0],
    ['分镜', state.project.documents.shotlist?.length || 0],
    ['提示词', state.project.documents.prompt?.length || 0],
    ['素材', state.project.assets?.length || 0],
    ['集数', state.project.episodes?.length || 0]
  ];
  const folderRows = viewDefinitions.filter(([key]) => key !== 'project').map(([key, label]) => {
    const folder = state.project.folders[key] || '';
    const count = key === 'assets' ? state.project.assets.length : state.project.documents[key]?.length || 0;
    return `<div class="folder-row"><strong>${label}</strong><code>${escapeHtml(folder || '未识别')}</code><em>${count} 个文件</em></div>`;
  }).join('');
  return `${toolbarMarkup({ title: '项目总览' })}<div class="reader-scroll"><div class="document summary">
    <section class="summary-hero"><h1>${escapeHtml(state.project.name)}</h1><p>${escapeHtml(state.project.rootPath)}</p></section>
    <section class="summary-grid">${counts.map(([label, count]) => `<div class="summary-card"><strong>${count}</strong><span>${label}</span></div>`).join('')}</section>
    <section class="folder-list">${folderRows}</section>
  </div></div>`;
}

function candidatesForView(view) {
  const files = state.project?.documents?.[view] || [];
  if (!state.episode) return files;
  const matches = files.filter((file) => Number(file.episodeNumber) === Number(state.episode));
  return matches.length ? matches : files;
}

function tableMarkup(content) {
  const tables = window.ShotlistDuration?.parseTables(content) || [];
  if (!tables.length) return '';
  return `<div class="markdown-wrap">${tables.map((table) => `<table class="markdown-table"><thead><tr>${table.headers.map((cell) => `<th>${semanticMarkup(cell)}</th>`).join('')}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${semanticMarkup(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('')}</div>`;
}

async function documentMarkup() {
  const files = candidatesForView(state.view);
  if (!files.length) return `${toolbarMarkup({ title: viewDefinitions.find(([key]) => key === state.view)?.[1] || '' })}<div class="reader-scroll"><div class="empty-state">当前文件夹没有可阅读的 TXT、MD 或 Word 文档。</div></div>`;
  const remembered = state.activeFiles[state.view];
  const selected = files.find((file) => file.path === remembered) || files[0];
  state.activeFiles[state.view] = selected.path;
  let document;
  try { document = await window.viewerApi.readDocument(selected.path); } catch (error) {
    return `${toolbarMarkup({ title: viewDefinitions.find(([key]) => key === state.view)?.[1] || '' })}<div class="reader-scroll"><div class="empty-state">文件读取失败：${escapeHtml(error.message)}</div></div>`;
  }
  const options = files.map((file) => `<option value="${escapeHtml(file.path)}" ${file.path === selected.path ? 'selected' : ''}>${escapeHtml(file.relativePath || file.name)}</option>`).join('');
  const duration = state.view === 'shotlist' ? window.ShotlistDuration?.calculate(document.content) : null;
  const durationLabel = duration?.seconds ? `总时长 ${window.ShotlistDuration.format(duration.seconds)} · ${duration.shotCount || 0} 镜头` : '';
  const isMarkdown = document.extension === '.md' || document.extension === '.markdown';
  const table = isMarkdown ? tableMarkup(document.content) : '';
  return `${toolbarMarkup({ title: viewDefinitions.find(([key]) => key === state.view)?.[1] || '', fileOptions: options, selectedPath: selected.path, format: formatLabel(document.extension), duration: durationLabel, updatedAt: document.modifiedAt })}<div class="reader-scroll" id="reader-scroll"><div class="document">${table || `<pre class="document-text">${semanticMarkup(document.content)}</pre>`}</div></div>`;
}

async function assetMarkup() {
  const assets = state.project.assets || [];
  const episodeAssets = state.episode ? assets.filter((item) => !item.episodeNumber || Number(item.episodeNumber) === Number(state.episode)) : assets;
  const filtered = state.assetFilter === '全部' ? episodeAssets : episodeAssets.filter((item) => item.category === state.assetFilter);
  const filters = ['全部', '人物', '场景', '道具', '配音', '其他'];
  const cards = await Promise.all(filtered.map(async (asset) => {
    let preview = `<div class="asset-preview ${asset.kind === 'audio' ? 'audio' : ''}">${asset.kind === 'audio' ? '♫' : asset.kind === 'document' ? formatLabel(asset.extension) : ''}</div>`;
    if (asset.kind === 'image') {
      try { preview = `<div class="asset-preview"><img src="${escapeHtml(await window.viewerApi.fileUrl(asset.path))}" alt="${escapeHtml(asset.name)}" loading="lazy" /></div>`; } catch { /* keep empty preview */ }
    }
    return `<article class="asset-card">${preview}<div class="asset-meta"><strong title="${escapeHtml(asset.relativePath)}">${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.category)}${asset.episodeNumber ? ` · 第${asset.episodeNumber}集` : ' · 全局素材'}</span><button type="button" data-show-file="${escapeHtml(asset.path)}">在文件夹中查看</button></div></article>`;
  }));
  return `${toolbarMarkup({ title: '素材' })}<div class="reader-scroll"><div class="document"><div class="assets-header">${filters.map((filter) => `<button type="button" data-asset-filter="${filter}" class="${state.assetFilter === filter ? 'active' : ''}">${filter}</button>`).join('')}<span class="updated-chip">${filtered.length} 项</span></div>${cards.length ? `<div class="asset-grid">${cards.join('')}</div>` : '<div class="empty-state">当前筛选下没有素材文件。</div>'}</div></div>`;
}

function bindSearch() {
  const input = document.querySelector('#reader-search');
  if (!input) return;
  input.addEventListener('input', () => applySearch(input.value));
  document.querySelector('#search-prev')?.addEventListener('click', () => moveSearch(-1));
  document.querySelector('#search-next')?.addEventListener('click', () => moveSearch(1));
}

function clearSearchMarks() {
  document.querySelectorAll('mark.reader-find').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
  document.querySelector('.document')?.normalize();
  state.searchMatches = [];
  state.searchIndex = -1;
}

function applySearch(query) {
  clearSearchMarks();
  const value = String(query || '').trim();
  if (!value) return updateSearchCount();
  const root = document.querySelector('.document');
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.toLowerCase().includes(value.toLowerCase())) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('mark')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    const source = node.nodeValue;
    const lower = source.toLowerCase();
    const needle = value.toLowerCase();
    let cursor = 0;
    let index = lower.indexOf(needle);
    while (index >= 0) {
      fragment.append(document.createTextNode(source.slice(cursor, index)));
      const mark = document.createElement('mark');
      mark.className = 'reader-find';
      mark.textContent = source.slice(index, index + value.length);
      fragment.append(mark);
      cursor = index + value.length;
      index = lower.indexOf(needle, cursor);
    }
    fragment.append(document.createTextNode(source.slice(cursor)));
    node.replaceWith(fragment);
  }
  state.searchMatches = [...document.querySelectorAll('mark.reader-find')];
  if (state.searchMatches.length) state.searchIndex = 0;
  focusSearchMatch();
}

function updateSearchCount() {
  const count = document.querySelector('#search-count');
  if (count) count.textContent = state.searchMatches.length ? `${state.searchIndex + 1}/${state.searchMatches.length}` : '0/0';
}

function focusSearchMatch() {
  state.searchMatches.forEach((item) => item.classList.remove('current'));
  const current = state.searchMatches[state.searchIndex];
  if (current) {
    current.classList.add('current');
    current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }
  updateSearchCount();
}

function moveSearch(direction) {
  if (!state.searchMatches.length) return;
  state.searchIndex = (state.searchIndex + direction + state.searchMatches.length) % state.searchMatches.length;
  focusSearchMatch();
}

async function renderReader() {
  const panel = document.querySelector('#reader-panel');
  if (!state.project) {
    panel.innerHTML = welcomeMarkup();
    document.querySelector('#welcome-choose')?.addEventListener('click', chooseProject);
    return;
  }
  if (state.view === 'project') panel.innerHTML = projectMarkup();
  else if (state.view === 'assets') panel.innerHTML = await assetMarkup();
  else panel.innerHTML = await documentMarkup();
  const select = document.querySelector('#file-select');
  select?.addEventListener('change', () => { state.activeFiles[state.view] = select.value; renderReader(); });
  document.querySelectorAll('[data-asset-filter]').forEach((button) => button.addEventListener('click', () => { state.assetFilter = button.dataset.assetFilter; renderReader(); }));
  document.querySelectorAll('[data-show-file]').forEach((button) => button.addEventListener('click', () => window.viewerApi.showFile(button.dataset.showFile)));
  bindSearch();
}

function renderShell() {
  appRoot.innerHTML = shellMarkup();
  bindShell();
  renderEpisodeBar();
  renderReader();
}

function acceptProject(project, preserve = false) {
  const previousEpisode = state.episode;
  state.project = project;
  if (preserve && project.episodes.includes(previousEpisode)) state.episode = previousEpisode;
  else state.episode = project.episodes?.[0] || null;
  for (const [view, filePath] of Object.entries(state.activeFiles)) {
    const stillExists = (project.documents[view] || []).some((file) => file.path === filePath);
    if (!stillExists) delete state.activeFiles[view];
  }
  renderShell();
}

async function chooseProject() {
  try {
    const project = await window.viewerApi.chooseProject();
    if (!project) return;
    acceptProject(project);
    showToast(`已打开：${project.name}`);
  } catch (error) { showToast(error.message || '项目打开失败', true); }
}

async function refreshProject() {
  if (!state.project) return;
  const button = document.querySelector('#refresh-project');
  const scrollTop = document.querySelector('#reader-scroll')?.scrollTop || 0;
  button?.classList.add('loading');
  if (button) button.disabled = true;
  try {
    const project = await window.viewerApi.refreshProject(state.project.rootPath);
    acceptProject(project, true);
    requestAnimationFrame(() => { const scroll = document.querySelector('#reader-scroll'); if (scroll) scroll.scrollTop = scrollTop; });
    showToast(`刷新完成 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  } catch (error) {
    showToast(error.message || '刷新失败', true);
    if (button) button.disabled = false;
    button?.classList.remove('loading');
  }
}

async function initialize() {
  renderShell();
  try {
    const project = await window.viewerApi.getInitialProject();
    if (project) acceptProject(project);
  } catch (error) { showToast(error.message || '上次项目无法读取，请重新选择。', true); }
}

initialize();
