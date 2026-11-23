'use strict';
window.createWorkspaceUI = function ({ state, api, render, toast, reviewUI, applyDocument, appendFile, syncEpisode, refreshHighlights, isComposing = () => false }) {
  const labels = { 'director-home': '制作总览', 'shot-studio': '镜头工作台', project: '项目文件', source: '原文', outline: '大纲', script: '剧本', shotlist: '分镜', storyboard: '提示词', review: '审片', 'review-notes': '审片意见', generate: '生成', assets: '素材', rules: '规则与设置', 'quality-center': '检查与优化', 'html-relationships': '人物关系网', 'html-assets': '素材可视化', 'html-post': '后期剪辑可视化', 'html-other': '其他 HTML 资料' };
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const icons = { open: '<path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>', panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', windows: '<rect x="3" y="7" width="14" height="13" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v10"/>', screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4M8 21h8"/>' };
  const icon = name => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  const pending = new Map(), reads = new Map();
  let windows = [], bootstrap = {}, published = '', dragView = null, metadataTimer, context = '', focusMode = false;
  const scope = () => key(state.project?.projectPath) + '|' + Number(state.project?.currentEpisode);
  function valid(event) {
    if (!state.project || key(event.projectPath) !== key(state.project.projectPath)) return false;
    const active = state.project.activeFiles?.[event.kind];
    return active ? key(active) === key(event.path) : Number(state.project.currentEpisode) === Number(event.episode);
  }
  function prune() {
    for (const [kind, event] of pending) {
      const version = state.workspaceVersions?.[kind];
      if (!valid(event) || (event.version && version?.version === event.version && key(version.path) === key(event.path))) pending.delete(kind);
    }
  }
  function windowRows() {
    return windows.map(item => {
      const own = item.id === bootstrap.id, status = own ? '本窗口' : item.visible === false ? '已隐藏' : item.minimized ? '已最小化' : '打开中';
      return `<button type="button" data-action="workspace-focus" data-window-id="${item.id}" class="workspace-window-item ${own ? 'is-current' : ''}" ${own ? 'aria-current="true"' : ''}><span class="workspace-window-title"><strong>${e(labels[item.view] || item.view || '工作台')}${item.episode ? ' · 第 ' + e(item.episode) + ' 集' : ''}</strong><span class="workspace-window-status">${status}</span></span><span class="workspace-window-project">${e(item.title || '未打开项目')}</span><span class="workspace-window-location">窗口 ${item.number}${item.screen ? ' · 屏幕 ' + item.screen : ''}</span></button>`;
    }).join('');
  }
  function notice() {
    prune(); const host = document.querySelector('#workspace-updates'); if (!host) return;
    host.hidden = !pending.size;
    const dirty = [...pending.keys()].some(kind => state.documentDirty[kind]);
    host.innerHTML = pending.size ? `<div><strong>${dirty ? '检测到内容冲突' : '有可读取的最新内容'}</strong><span>${[...pending.keys()].map(kind => e(labels[kind] || kind)).join('、')}已在其他窗口或外部程序中更新${dirty ? '，本窗草稿已保留' : ''}。</span></div><div class="workspace-notice-actions">${dirty ? '<button class="button quiet small" data-action="workspace-copy-draft">复制本窗草稿</button>' : ''}<button class="button secondary small" data-action="workspace-reload">读取最新内容</button></div>` : '';
  }
  function renderBar() {
    const checkCounts = {
      script: (state.project?.script?.checks || []).filter(item => ['error', 'warning'].includes(item.level)).length,
      shotlist: (state.shotlistVerdict?.problems?.length || 0) + (state.shotlistVerdict?.warnings?.length || 0),
      storyboard: (state.project?.storyboard?.checks || []).filter(item => ['error', 'warning'].includes(item.level)).length
    };
    return `<div class="workspace-bar" aria-label="多窗口工作台"><span class="workspace-caption" title="每个窗口可独立选择页面与集数"><span class="workspace-live-dot"></span>窗口 ${bootstrap.number || 1}</span><nav class="workspace-tabs" aria-label="可拖出为独立窗口的页面">${['outline', 'script', 'shotlist', 'storyboard', 'review'].map(view => `<button type="button" class="workspace-tab ${state.view === view ? 'active' : ''}" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ''} draggable="true" title="点击切换；拖出窗口可独立打开${labels[view]}">${labels[view]}${checkCounts[view] ? `<span class="workspace-tab-count">${checkCounts[view]}</span>` : ''}</button>`).join('')}</nav><div class="workspace-actions"><button type="button" class="workspace-focus-toggle" data-action="workspace-focus-mode" aria-pressed="${focusMode}" aria-controls="workspace-sidebar" title="${focusMode ? '显示功能侧栏' : '收起侧栏，扩大内容区域'}">${icon('panel')}<span>${focusMode ? '显示侧栏' : '专注模式'}</span></button><button type="button" class="workspace-open-button" data-action="workspace-open" title="在新窗口打开当前页面的已保存内容（Ctrl+Shift+N）" ${state.project ? '' : 'disabled'}>${icon('open')}独立窗口</button><details class="workspace-window-menu"><summary aria-label="管理工作窗口">${icon('windows')}<span>窗口</span><span class="workspace-window-count" data-workspace-count>${windows.length || 1}</span></summary><div class="workspace-window-popover"><div class="workspace-popover-heading"><strong>工作窗口</strong><span>点击切换或找回窗口</span></div><div data-workspace-window-list>${windowRows()}</div><button type="button" class="workspace-screen-button" data-action="workspace-move-screen">${icon('screen')}移到另一块屏幕</button></div></details></div></div><div id="workspace-updates" class="workspace-update-notice" role="status" hidden></div>`;
  }
  function closeMenu(restoreFocus = false) { const menu = document.querySelector('.workspace-window-menu'); if (menu?.open) { menu.open = false; if (restoreFocus) menu.querySelector('summary')?.focus(); } }
  async function open(view = state.view, dragOut = false) {
    if (!state.project) return;
    const result = await api.workspaceOpen({ projectPath: state.project.projectPath, view: view === 'editor' ? state.editorView : view, episode: state.project.currentEpisode, dragOut });
    if (result) toast(state.dirty ? '已在新窗口打开已保存内容；本窗草稿仍保留。' : '独立窗口已打开，可拖到另一块屏幕。');
  }
  function afterRender() {
    if (context !== scope()) { context = scope(); reads.clear(); }
    document.querySelector('.shell')?.classList.toggle('workspace-focus-mode', focusMode);
    const sidebar = document.querySelector('.sidebar'); if (sidebar) { sidebar.id = 'workspace-sidebar'; sidebar.inert = focusMode; }
    document.querySelectorAll('.nav-view-button, .editor-tab').forEach(button => { button.draggable = true; button.title = '点击切换；拖出窗口可独立打开此页面'; });
    notice();
    const value = { projectPath: state.project?.projectPath || '', title: state.project?.title || '', view: state.view, currentEpisode: state.project?.currentEpisode || null, episode: state.project ? window.episodeSlots.label(state.project, state.project.currentEpisode) : '' };
    const signature = JSON.stringify(value);
    if (signature !== published) { published = signature; void api.workspaceUpdate(value).catch(error => toast(error.message)); }
  }
  async function refreshFile(event, force = false) {
    if (!valid(event)) { notice(); return; }
    const project = state.project, kind = event.kind, version = state.workspaceVersions?.[kind], token = {}; reads.set(kind, token);
    if (event.version && version?.version === event.version && key(version.path) === key(event.path)) { pending.delete(kind); notice(); return; }
    const editing = document.hasFocus() && document.querySelector('textarea[data-bind="' + kind + '.content"]')?.matches(':focus');
    if (!force && (state.documentDirty[kind] || state.savingDocuments.size || editing || isComposing())) { pending.set(kind, event); notice(); return; }
    const revision = state.documentRevisions[kind], episode = project.currentEpisode;
    const doc = await api.openDocumentFile(project, kind, event.path);
    if (reads.get(kind) !== token || state.project !== project || project.currentEpisode !== episode || !valid(event)) return;
    if (revision !== state.documentRevisions[kind] || (!force && state.documentDirty[kind]) || isComposing() || state.savingDocuments.size) { pending.set(kind, event); notice(); return; }
    applyDocument(kind, doc); appendFile(kind, doc); syncEpisode(); pending.delete(kind);
    const visible = { project: 'source', outline: 'outline', script: 'script', shotlist: 'shotlist', storyboard: 'storyboard' }[state.view];
    if (visible === kind) render(); else notice();
  }
  async function changed(event) {
    if (!state.project || key(state.project.projectPath) !== key(event.projectPath)) return;
    if (event.type === 'review') return reviewUI().refreshRemote();
    if (event.type === 'document') return refreshFile(event);
    if (event.type === 'refresh') for (const [kind, path] of Object.entries(state.project.activeFiles || {})) if (path) await refreshFile({ ...event, kind, path });
    if (event.type === 'project') { clearTimeout(metadataTimer); metadataTimer = setTimeout(() => { void refreshMetadata().catch(error => toast(error.message)); }, 150); }
  }
  async function refreshMetadata() {
    const project = state.project, revision = state.changeRevision;
    if (!project || state.dirty || state.savingDocuments.size || isComposing() || document.activeElement?.matches('input,textarea,select') || window.directorCloseState?.().running) return;
    const latest = await api.workspaceSnapshot(project.projectPath);
    if (!latest || state.project !== project || state.changeRevision !== revision || state.dirty || state.savingDocuments.size || isComposing()) return;
    const own = {}; for (const field of ['currentEpisode', 'targetDuration', 'activeFiles', 'source', 'outline', 'script', 'shotlist', 'storyboard']) own[field] = project[field];
    Object.assign(project, latest, own); syncEpisode(); await api.workspaceAccept(project);
    if (state.project === project && !['review', 'review-notes', 'generate', 'shot-studio'].includes(state.view) && !state.view.startsWith('html-')) render();
  }
  async function action(action, button) {
    if (['workspace-focus', 'workspace-move-screen'].includes(action)) closeMenu();
    if (action === 'workspace-open') return open(button.dataset.workspaceView || state.view);
    if (action === 'workspace-focus') return api.workspaceFocus(Number(button.dataset.windowId));
    if (action === 'workspace-focus-mode') { focusMode = !focusMode; render(); return; }
    if (action === 'workspace-move-screen') { if (!await api.workspaceMoveScreen()) toast('当前只检测到一块屏幕；也可以直接拖动窗口标题栏。'); return; }
    prune();
    if (action === 'workspace-copy-draft') {
      const kinds = [...pending.keys()].filter(kind => state.documentDirty[kind]); if (!kinds.length) return notice();
      await api.productionCopy(kinds.map(kind => '【' + (labels[kind] || kind) + '】\n' + (state.project[kind]?.content || '')).join('\n\n')); return toast('本窗草稿已复制，可粘贴留存。');
    }
    if (action === 'workspace-reload') {
      if ([...pending.keys()].some(kind => state.documentDirty[kind]) && !await window.directorConfirm('读取最新内容会替换本窗对应的未保存草稿。请先复制需要保留的草稿；确定后继续读取，取消则保留当前编辑。')) return;
      for (const event of [...pending.values()]) await refreshFile(event, true);
      refreshHighlights(); notice();
    }
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.workspace-window-menu')) closeMenu(); });
  document.addEventListener('dragstart', event => { const tab = event.target.closest('.workspace-tab, .nav-view-button, .editor-tab'); if (!tab || !state.project) return; dragView = tab.dataset.view; event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData('application/x-director-workspace', dragView); });
  document.addEventListener('dragend', event => { const view = dragView; dragView = null; if (view && event.dataTransfer.dropEffect === 'none') void open(view, true).catch(error => toast(error.message)); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('.workspace-window-menu')?.open) { event.preventDefault(); closeMenu(true); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); void open().catch(error => toast(error.message)); }
  });
  window.addEventListener('focus', () => { prune(); for (const event of [...pending.values()]) if (!state.documentDirty[event.kind]) void refreshFile(event).catch(error => toast(error.message)); void refreshMetadata().catch(error => toast(error.message)); });
  return { renderBar, afterRender, action, async initialize() {
    bootstrap = await api.workspaceBootstrap(); windows = bootstrap.windows || [];
    api.onWorkspaceWindows(value => {
      windows = value; document.querySelectorAll('[data-workspace-count]').forEach(node => { node.textContent = windows.length; });
      const list = document.querySelector('[data-workspace-window-list]'), focusedId = list?.contains(document.activeElement) ? document.activeElement.dataset.windowId : null;
      if (list) { list.innerHTML = windowRows(); if (focusedId) list.querySelector('[data-window-id="' + Number(focusedId) + '"]')?.focus({ preventScroll: true }); }
    });
    api.onWorkspaceChanged(event => { void changed(event).catch(error => toast('窗口同步未完成：' + error.message)); }); return bootstrap;
  } };
};
