const appRoot = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toast = document.querySelector('#toast');
const directorEpisodeSlots = window.episodeSlots;
const documentSaveQueue = window.DirectorSaveQueue.createSaveQueue();
const projectSaveQueue = window.DirectorSaveQueue.createSaveQueue();
const saveIndicatorMarkup = new WeakMap();

const SIDEBAR_WIDTH_KEY = 'director-sidebar-width';
const UI_THEME_KEY = 'director-ui-theme';
const ACTIVE_PROJECT_KEY = 'director-last-project-path';
const projectPathKey = value => String(value || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
function lastProjectPath() {
  try { return projectPathKey(localStorage.getItem(ACTIVE_PROJECT_KEY)); } catch { return ''; }
}
function rememberActiveProject(project) {
  if (!project?.projectPath) return;
  try { localStorage.setItem(ACTIVE_PROJECT_KEY, project.projectPath); } catch {}
}

const UI_THEMES = ['light', 'dark', 'morandi'];
const SIDEBAR_WIDTH_DEFAULT = 248;
const SIDEBAR_WIDTH_MIN = 196;
const SIDEBAR_WIDTH_MAX = 420;
const clampSidebarWidth = (value) => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Number(value) || SIDEBAR_WIDTH_DEFAULT));
function readSidebarWidth() {
  try {
    return clampSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}
function rememberSidebarWidth(value) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(value)));
  } catch {
    // The width remains active for this window even when storage is unavailable.
  }
}

function normalizeUiTheme(value) {
  return UI_THEMES.includes(value) ? value : 'light';
}

function readUiTheme() {
  try {
    return normalizeUiTheme(localStorage.getItem(UI_THEME_KEY));
  } catch {
    return 'light';
  }
}

function applyUiTheme(value) {
  const theme = normalizeUiTheme(value);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
  return theme;
}

function rememberUiTheme(value) {
  try {
    localStorage.setItem(UI_THEME_KEY, normalizeUiTheme(value));
  } catch {
    // The selected theme still remains active for the current window.
  }
}

const state = {
  projects: [],
  project: null,
  view: 'director-home',
  editorView: 'script',
  dirty: false,
  documentDirty: { source: false, outline: false, script: false, shotlist: false, storyboard: false },
  workspaceVersions: {},
  documentRevisions: { source: 0, outline: 0, script: 0, shotlist: 0, storyboard: 0 },
  savingDocuments: new Map(),
  saveErrors: {},
  projectSync: new Map(),
  changeRevision: 0,
  storeNotice: null,
  projectSwitchPending: null,
  projectSwitchToken: null,
  projectHistoryQuery: '',
  projectHistoryBusy: false,
  aiDrawerOpen: false,
  batchDraft: null,
  workflowReview: null,
  workflowBatchDraft: null,
  workflowRunning: false,
  taskReview: null,
  actionDialog: null,
  chromeStatus: null,
  chromeConnecting: false,
  batchRunning: false,
  batchStopRequested: false,
  apiBatchMinimized: false,
  workLocked: false,
  workLabel: '',
  mascotPhraseIndex: 0,
  scriptMode: 'read',
  shotlistMode: 'preview',
  storyboardMode: 'edit',
  locatedCheckId: null,
  locatedScriptCheckId: null,
  documentFindLocation: null,
  documentFindQuery: { outline: '', script: '', shotlist: '', storyboard: '' },
  documentFindActiveIndex: { outline: 0, script: 0, shotlist: 0, storyboard: 0 },
  storyboardChecksExpanded: false,
  scriptChecksExpanded: false,
  shotlistVerdict: null,
  checkCache: { script: '', storyboard: '', shotlist: '' },
  checkInFlight: { script: false, storyboard: false, shotlist: false },
  assetFilter: 'role',
  assetSearchQuery: '',
  assetPromptLibrary: null,
  pendingViewport: null,
  viewports: new Map(),
  renderedContextKey: '',
  toastTimer: null,
  sidebarWidth: readSidebarWidth(),
  uiTheme: readUiTheme(),
  membership: null,
  builtinTemplates: [],
  membershipModalOpen: false,
  builtinTemplatePreview: null,
  projectWizard: null,
  projectChooserOpen: false
};

applyUiTheme(state.uiTheme);

const directorUI=window.createDirectorUI({project:()=>state.project,view:()=>state.view,api:window.directorApi,toast:message=>showToast(message),canEdit:()=>membershipCanEdit(),isDirty:kind=>Boolean(state.documentDirty[kind]),label:key=>directorEpisodeSlots.label(state.project,key),onApplied:async file=>{
  if(!file||state.documentDirty.shotlist)return;
  state.project.shotlist={...state.project.shotlist,...file};state.project.activeFiles.shotlist=file.path;syncActiveEpisode();
  await saveProject({renderAfter:false,preserveViewport:true});
}});
const htmlLibraryUI = window.createHtmlLibraryUI({project:()=>state.project,view:()=>state.view,api:window.directorApi,toast:message=>showToast(message)});

const reviewUI = window.createReviewUI({ project: () => state.project, view: () => state.view, api: window.directorApi,
  canEdit: () => membershipCanEdit(), render: () => render(), toast: (message) => showToast(message),
  label: (key) => directorEpisodeSlots.label(state.project, key),
  onEpisodeChange: async (key) => {
    // 审片通过数据同步集数，不能模拟点击导航（会被点击动效再次触发）。
    const project = state.project;
    const target = directorEpisodeSlots.episodeByKey(project, key)
      ? Number(key) : directorEpisodeSlots.baseNumber(key);
    if (!directorEpisodeSlots.episodeByKey(project, target)) return true;
    if (!await confirmSaveBeforeEpisodeChange(target)) return false;
    if (state.project !== project) return false;
    if (Number(project.currentEpisode) !== target) {
      await activateEpisode(target);
      markDirty();
    }
    return state.project === project;
  } });
const automationUI = window.createAutomationUI({project:()=>state.project,api:window.directorApi,
  onSettings:()=>markDirty(),
  openLibrary:()=>{state.view='assets';render();document.querySelector('#flow-library')?.scrollIntoView({block:'start'});},
  render:()=>render(),toast:message=>showToast(message),canEdit:()=>membershipCanEdit(),
  save:async()=>{for(const kind of dirtyDocumentKinds())await saveFolderDocument(kind,{preserveViewport:false});await saveProject({renderAfter:false});},
  refresh:async bindings=>{
    const p=state.project;
    if(bindings)for(const [number,files] of Object.entries(bindings)) {
      const episode=p.episodes.find(x=>Number(x.number)===Number(number));
      if(episode)episode.activeFiles={...episode.activeFiles,...files};
      if(Number(p.currentEpisode)===Number(number))p.activeFiles={...p.activeFiles,...files};
      if(Number(p.currentEpisode)===Number(number))for(const [kind,file] of Object.entries(files)){
        const extension=String(file).split('.').at(-1).toLowerCase();if(['txt','md','docx'].includes(extension))p.documentFormats[kind]=extension;
      }
    }
    const scanned=await window.directorApi.rescanProject(p);
    if(state.project?.projectPath!==p.projectPath)return;
    if(bindings)for(const [number,files] of Object.entries(bindings)) {
      const episode=scanned.episodes.find(x=>Number(x.number)===Number(number));
      if(episode)episode.activeFiles={...episode.activeFiles,...files};
    }
    const docs=await window.directorApi.loadEpisodeDocuments(window.DirectorEpisodeReadContext(scanned),scanned.currentEpisode);
    if(state.project?.projectPath!==p.projectPath)return;
    const drafts=Object.fromEntries(dirtyDocumentKinds().map(kind=>[kind,{document:state.project[kind],path:state.project.activeFiles[kind]}]));
    state.project=scanned;
    for(const kind of ['source','outline','script','shotlist','storyboard'])if(drafts[kind]){state.project[kind]=drafts[kind].document;state.project.activeFiles[kind]=drafts[kind].path;}
    else if(docs[kind]){state.project[kind]={...state.project[kind],...docs[kind]};state.project.activeFiles[kind]=docs[kind].path;}
    if(Object.keys(drafts).length)showToast('新成果已保存；当前未保存的编辑内容已保留。');
    syncActiveEpisode();await saveProject({renderAfter:false});
  }});

const assistantUI=window.createAssistantUI({context:assistantContext,api:window.directorApi,canEdit:()=>membershipCanEdit(),toast:message=>showToast(message),act:async(type,target)=>{
    if(type==='local'&&target==='save'){if(!membershipCanEdit())return showToast('当前会员无法编辑。');for(const kind of dirtyDocumentKinds())await saveFolderDocument(kind,{preserveViewport:true});await reviewUI.saveDrafts();await saveProject({renderAfter:false,preserveViewport:true});showToast('修改已保存。');return;}
    const button=document.createElement('button');if(type==='view')button.dataset.view=target;else button.dataset.action=target;await handleAppClick({target:button});
  }});
function assistantContext(){
  const p=state.project,quality=automationUI.summary(),director=directorUI.summary(),review=reviewUI.summary();
  const tasks=[{label:'API 批量任务',busy:state.apiBatch?.status==='running',stopping:state.apiBatch?.stopRequested,detail:state.apiBatch?.currentEpisode?'第 '+directorEpisodeSlots.label(p,state.apiBatch.currentEpisode)+' 集 · 已完成 '+(state.apiBatch.completed?.length||0)+' 集':'',show:'ai-batch-show',stop:'ai-batch-stop'},
    {label:'网页批量任务',busy:state.batchRunning,stopping:state.batchStopRequested,detail:'当前集完成后暂停',stop:'stop-batch',stopLabel:'暂停网页批量'},
    {label:'网页工作流任务',busy:state.workflowRunning,stopping:state.batchStopRequested,stop:'stop-workflow-batch'},
    {label:'内容检查 / 优化',busy:quality.qualityBusy,view:'quality-center',stop:'quality-stop'},
    {label:'后台制作任务',busy:quality.busy,stop:'flow-stop'},
    {label:'镜头辅助',busy:director.busy,view:'shot-studio',stop:'director-stop'},
    {label:'助理问答',busy:assistantUI.isBusy(),stop:'assistant-stop-chat'}];
  const checks=state.view==='storyboard'?p?.storyboard?.checks:p?.script?.checks;
  const relevant=['script','storyboard'].includes(state.view);
  return {project:p?.title||p?.name||'',projectPath:p?.projectPath||'',episode:p?.currentEpisode||'',episodeLabel:p?directorEpisodeSlots.label(p,p.currentEpisode):'',page:state.view,pageLabel:views.find(x=>x[0]===state.view)?.[1]||({script:'剧本',outline:'大纲',shotlist:'分镜',storyboard:'提示词'}[state.view])||state.view,
    dirty:dirtyDocumentKinds(),readonly:!membershipCanEdit(),stages:director.stages,
    reviewOpen:review.open,reviewNeedsRevision:review.needsRevision||0,issues:relevant?(checks||[]).filter(x=>x.level==='error'||x.level==='warning').length:state.view==='quality-center'&&Number(quality.report?.episode)===Number(p?.currentEpisode)?quality.report?.issues?.length||0:0,
    issueView:relevant?state.view:'quality-center',tasks,model:p?.aiRunner?.model||'',projectData:p};
}
let observedTopbar=null;
const topbarObserver=new ResizeObserver(entries=>{const box=entries[0]?.target;if(box?.isConnected)document.documentElement.style.setProperty('--director-topbar-height',box.getBoundingClientRect().height+'px');});
function observeTopbar(){const topbar=document.querySelector('.topbar');if(topbar!==observedTopbar){topbarObserver.disconnect();observedTopbar=topbar;if(topbar)topbarObserver.observe(topbar);}}
let sidebarResizeSession = null;

const views = [
  ['director-home', '制作总览'],
  ['shot-studio', '镜头工作台'],
  ['generate', '生成'],
  ['project', '项目文件'],
  ['editor', '编辑与检查'],
  ['quality-center', '检查与优化'],
  ['assets', '素材'],
  ['html-relationships', '人物关系网'],
  ['html-assets', '素材可视化'],
  ['html-post', '后期剪辑可视化'],
  ['html-other', '其他 HTML 资料'],
  ['review', '审片'],
  ['review-notes', '审片意见'],
  ['rules', '规则与设置']
];

const documentFormatDefaults = { source: 'txt', outline: 'txt', script: 'txt', shotlist: 'md', storyboard: 'txt' };
const viewDocumentKinds = { project: 'source', outline: 'outline', script: 'script', shotlist: 'shotlist', storyboard: 'storyboard' };
function normalizeDocumentFormats(value = {}) {
  const normalized = { ...documentFormatDefaults };
  for (const kind of Object.keys(normalized)) {
    const format = String(value?.[kind] || '').toLowerCase();
    if (['txt', 'md', 'docx'].includes(format)) normalized[kind] = format;
  }
  return normalized;
}
function documentFormatForKind(kind) {
  return normalizeDocumentFormats(state.project?.documentFormats)[kind] || 'txt';
}
function fileMatchesDocumentFormat(filePath, format) {
  const extension = String(filePath || '').split('.').at(-1)?.toLowerCase() || '';
  return format === 'md' ? ['md', 'markdown'].includes(extension) : extension === format;
}
function documentFormatLabel(format) {
  return format === 'docx' ? 'WORD' : format.toUpperCase();
}
function savedFormatLabel(kind, result = {}) {
  const format = result.format || documentFormatForKind(kind);
  const label = documentFormatLabel(format);
  return `${label}${result.docxPath && result.docxPath !== result.outputPath ? '（同步 Word）' : ''}`;
}
function documentFormatSelect(kind, compact = false) {
  const selected = documentFormatForKind(kind);
  const label = kind === 'source' ? '原文' : kind === 'outline' ? '大纲' : kind === 'script' ? '剧本' : kind === 'shotlist' ? '分镜' : '提示词';
  return `<select class="document-format-select ${compact ? 'compact' : ''}" data-document-format="${kind}" aria-label="${label}文件格式" title="选择${label}阅读和保存格式"><option value="txt" ${selected === 'txt' ? 'selected' : ''}>TXT</option><option value="docx" ${selected === 'docx' ? 'selected' : ''}>WORD</option><option value="md" ${selected === 'md' ? 'selected' : ''}>MD</option></select>`;
}

function renderFrogAssistant(){return assistantUI.renderDock();}

const escapeHTML = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const formatTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '尚未保存';
const inputValue = (value) => escapeHTML(value || '');
const currentPrompt = (kind) => state.project?.promptSets?.[kind]?.at(-1);
const countByLevel = (level) => (state.project?.storyboard?.checks || []).filter((item) => item.level === level).length;
const countScriptChecksByLevel = (level) => (state.project?.script?.checks || []).filter((item) => item.level === level).length;
const interfaceIsLocked = () => Boolean(state.workLocked);
const statusClass = (status) => ({ '待审核': 'waiting', '等待发送': 'waiting', '等待回复': 'waiting', '自动执行中': 'waiting', '已保存': 'done', '需人工发送': 'attention', '读取失败': 'attention' }[status] || '');
const deepCopy = (value) => JSON.parse(JSON.stringify(value));
const replyModeLabel = (mode) => ({ auto: '自动识别（正文优先）', attachment: 'TXT 附件', message: '聊天正文' }[mode] || '自动识别（正文优先）');
const replyInstructionMarker = '【本次返回与保存方式】';
function promptForReplyMode(prompt, mode) {
  const base = String(prompt || '').replace(new RegExp(`\\n?${replyInstructionMarker}[\\s\\S]*$`), '').trim();
  const selected = ['auto', 'attachment', 'message'].includes(mode) ? mode : 'auto';
  const instruction = selected === 'attachment'
    ? '请仅交付最终成品 TXT 文件附件，文件名使用“XXX集.txt”；聊天框无需重复粘贴正文。'
    : selected === 'message'
      ? '请直接在聊天框输出完整最终成品正文，不要生成附件、不要解释、不要分析；正文会由软件自动保存为 TXT。'
      : '请优先在聊天框输出完整最终成品；如同时提供 TXT 附件，软件仍会在聊天正文不可用时回收附件。不要输出分析过程。';
  return `${base}\n\n${replyInstructionMarker}\n${instruction}`;
}
const defaultExecutionPriority = `1. 下方规则文档、参照文档和项目记忆必须严格遵守。
2. 未经允许不得增删、改写台词或临时改变素材标准名称。
3. 只输出最终成品，不要输出分析过程。`;
function normalizeWorkflowTemplates(value = {}) {
  const normalize = (key) => {
    const saved = value[key];
    if (!saved || (saved.builtin && state.membership?.builtinTemplatesAvailable === false)) return { name: '', path: '' };
    if (saved.builtin === true && (!saved.path || /\.dtp$/i.test(saved.path))) return { ...(state.builtinTemplates.find((item) => item.id === saved.id) || saved) };
    return { ...saved, builtin: false, id: undefined };
  };
  return {
    script: normalize('script'), shotlist: normalize('shotlist'),
    prompt15: normalize('prompt15'), prompt30: normalize('prompt30'),
    duration: normalize('duration'), seriesOutline: normalize('seriesOutline'),
    promptMode: String(value.promptMode) === '15' ? '15' : '30'
  };
}
const episodeNumberFromFileName = (fileName) => {
  const name = String(fileName || '').split(/[\\/]/).at(-1);
  const match = name.match(/(?:^|[^a-z0-9])EP\s*(\d{1,4})(?!\d)/i)
    || name.match(/(?:^|[^0-9])(?:第\s*)?(\d{1,4})(?:\s*(?:集|话|章)|[_-]|(?=第))/i);
  return match ? Number(match[1]) : null;
};

function ensureClientProjectShape(project) {
  if (!project) return project;
  for (const kind of ['source', 'outline', 'script', 'shotlist', 'storyboard']) {
    if (project[kind] && Object.hasOwn(project[kind], 'workspaceVersion')) {
      state.workspaceVersions[kind] = { projectPath: project.projectPath, episode: project.currentEpisode, path: project.activeFiles?.[kind] || '', version: project[kind].workspaceVersion };
      delete project[kind].workspaceVersion;
    }
  }
  project.script = { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null, ...(project.script || {}) };
  project.outline = { content: '', versions: [], updatedAt: null, ...(project.outline || {}) };
  project.storyboard = { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null, ...(project.storyboard || {}) };
  project.chatGptProjects = { script: '剧本工程', prompt: '提示词工程', ...(project.chatGptProjects || {}) };
  project.chatGptRunner = { mode: 'chrome', tabId: '', port: 9222, waitMinutes: 50, replyMode: 'auto', ...(project.chatGptRunner || {}) };
  project.generationMode = ['api', 'chrome', 'embedded'].includes(project.generationMode)
    ? project.generationMode : (project.aiRunner?.mode === 'api' ? 'api' : project.chatGptRunner.mode);
  project.aiRunner = { mode: 'api', provider: 'deepseek', baseUrl: '', model: '', apiKey: '', temperature: 0.7, maxTokens: 65536, timeoutMs: 180000, maxAttempts: 3, conversationCap: 3, maxContextChars: 900000, smartRead: true, ...(project.aiRunner || {}) };
  project.workflowTemplates = normalizeWorkflowTemplates(project.workflowTemplates);
  project.chatGptRunner.waitMinutes = Number(project.chatGptRunner.waitMinutes) === 30 ? 30 : 50;
  if (!['auto', 'attachment', 'message'].includes(project.chatGptRunner.replyMode)) project.chatGptRunner.replyMode = 'auto';
  project.executionPriority = String(project.executionPriority || defaultExecutionPriority).trim() || defaultExecutionPriority;
  project.referenceDocuments = project.referenceDocuments || [];
  project.activeFiles = { source: '', outline: '', script: '', shotlist: '', storyboard: '', ...(project.activeFiles || {}) };
  project.documentFormats = normalizeDocumentFormats(project.documentFormats);
  for (const episode of project.episodes || []) {
    episode.outline = { content: '', versions: [], updatedAt: null, ...(episode.outline || {}) };
    if (episode.script) episode.script = { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null, ...episode.script };
    if (episode.storyboard) episode.storyboard = { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null, ...episode.storyboard };
  }
  for (const asset of project.assets || []) {
    if (!['role', 'scene', 'prop', 'voice'].includes(asset.category)) asset.category = asset.type === 'audio' ? 'voice' : 'role';
    if (!Array.isArray(asset.episodes)) asset.episodes = [];
  }
  return project;
}

function assetHighlightClass(name) {
  const asset = (state.project?.assets || []).find((item) => item.standardName?.trim() === name.trim());
  const category = asset?.category || (asset?.type === 'audio' ? 'voice' : 'reference');
  return `semantic-${category}`;
}

const semanticTokenPattern = /(@\[[^\]\r\n]+\]|@[^\s@[\]{}<>"'\u0060，。；：、,.!?！？;:()（）]+)|(\[[^\]\r\n]+\])|(\{[^\}\r\n]+\})|(“[^”\r\n]*”|"[^"\r\n]*")/g;

function renderSemanticInlineTokens(text) {
  let html = '';
  let lastIndex = 0;
  semanticTokenPattern.lastIndex = 0;
  for (let match = semanticTokenPattern.exec(text); match; match = semanticTokenPattern.exec(text)) {
    html += escapeHTML(text.slice(lastIndex, match.index));
    const semanticClass = match[1] ? 'semantic-at' : match[2] ? 'semantic-bracket' : match[3] ? 'semantic-brace' : 'semantic-quote';
    html += `<span class="semantic-tag ${semanticClass}">${escapeHTML(match[0])}</span>`;
    lastIndex = match.index + match[0].length;
  }
  html += escapeHTML(text.slice(lastIndex));
  return html;
}

function renderSemanticTokens(text, preserveFormattingMarkers = false) {
  let html = '';
  let lastIndex = 0;
  const boldPattern = /\*\*([^\r\n]+?)\*\*/g;
  for (let match = boldPattern.exec(text); match; match = boldPattern.exec(text)) {
    html += renderSemanticInlineTokens(text.slice(lastIndex, match.index));
    const openingMarker = preserveFormattingMarkers ? '<span class="semantic-format-marker opening">**</span>' : '';
    const closingMarker = preserveFormattingMarkers ? '<span class="semantic-format-marker closing">**</span>' : '';
    html += `${openingMarker}<strong class="semantic-manual-highlight">${renderSemanticInlineTokens(match[1])}</strong>${closingMarker}`;
    lastIndex = match.index + match[0].length;
  }
  html += renderSemanticInlineTokens(text.slice(lastIndex));
  return html || '&nbsp;';
}

const errorTargetsCache = { script: { key: '', value: null }, storyboard: { key: '', value: null } };

function storyboardErrorTargets() {
  const checks = (state.project?.storyboard?.checks || []).filter((item) => ['error', 'warning'].includes(item.level));
  const searchLine = state.documentFindLocation?.kind === 'storyboard' ? Number(state.documentFindLocation.line || 0) - 1 : -1;
  const located = checks.find((item) => item.id === state.locatedCheckId) || null;
  const cacheKey = `${state.project?.id || ''}|${state.project?.currentEpisode || ''}|${state.documentEditRevision || 0}|${checks.map(storyboardCheckSignature).join('\u0002')}|${located?.id || ''}|${searchLine}`;
  if (errorTargetsCache.storyboard.key === cacheKey && errorTargetsCache.storyboard.value) return errorTargetsCache.storyboard.value;
  const lines = String(state.project?.storyboard?.content || '').split(/\r?\n/);
  const lineLevels = new Map();
  for (const issue of checks) {
    for (const lineIndex of storyboardIssueLineIndexes(issue, lines)) setIssueLineLevel(lineLevels, lineIndex, issue.level);
  }
  const locatedLine = searchLine >= 0 ? searchLine : (located ? storyboardIssueLineIndexes(located, lines)[0] : -1);
  const value = {
    lineLevels,
    located: null,
    locatedLine,
    key: `${checks.map(storyboardCheckSignature).join('\u0002')}|${[...lineLevels].map(([line, level]) => `${line}:${level}`).join(',')}|${located?.id || ''}|${locatedLine}`
  };
  errorTargetsCache.storyboard = { key: cacheKey, value };
  return value;
}

function scriptErrorTargets() {
  const checks = (state.project?.script?.checks || []).filter((item) => ['error', 'warning'].includes(item.level));
  const located = checks.find((item) => item.id === state.locatedScriptCheckId) || null;
  const searchLine = state.documentFindLocation?.kind === 'script' ? Number(state.documentFindLocation.line || 0) - 1 : -1;
  const cacheKey = `${state.project?.id || ''}|${state.project?.currentEpisode || ''}|${state.documentEditRevision || 0}|${checks.map(scriptCheckSignature).join('\u0002')}|${located?.id || ''}|${searchLine}`;
  if (errorTargetsCache.script.key === cacheKey && errorTargetsCache.script.value) return errorTargetsCache.script.value;
  const lineLevels = new Map();
  for (const issue of checks) setIssueLineLevel(lineLevels, Math.max(0, Number(issue.line || 1) - 1), issue.level);
  const locatedLine = searchLine >= 0 ? searchLine : Number(located?.line || 0) - 1;
  const value = {
    lineLevels,
    located: null,
    locatedLine,
    key: `${checks.map(scriptCheckSignature).join('\u0002')}|${[...lineLevels].map(([line, level]) => `${line}:${level}`).join(',')}|${located?.id || ''}|${searchLine}`
  };
  errorTargetsCache.script = { key: cacheKey, value };
  return value;
}

function setIssueLineLevel(lineLevels, lineIndex, level) {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || !['error', 'warning'].includes(level)) return;
  if (level === 'error' || !lineLevels.has(lineIndex)) lineLevels.set(lineIndex, level);
}

function groupLineRange(lines, groupNumber) {
  if (!groupNumber) return { start: 0, end: lines.length };
  const start = lines.findIndex((line) => new RegExp(`第\\s*${Number(groupNumber)}\\s*组`).test(line));
  if (start < 0) return { start: 0, end: lines.length };
  const nextOffset = lines.slice(start + 1).findIndex((line) => /第\s*\d+\s*组/.test(line));
  return { start, end: nextOffset >= 0 ? start + 1 + nextOffset : lines.length };
}

function missingTagsFromIssue(issue) {
  const match = String(issue?.detail || '').match(/分镜序列中的@(.+?)未在/);
  return match ? match[1].split(/、@/).map((item) => item.trim()).filter(Boolean) : [];
}

function storyboardIssueLineIndexes(issue, lines) {
  const { start, end } = groupLineRange(lines, issue?.group);
  if (issue?.title === '缺少@' && !issue?.shot) {
    const tags = missingTagsFromIssue(issue);
    const matches = [];
    for (let index = start; index < end; index += 1) {
      if (tags.some((tag) => lines[index].includes(`@${tag}`))) matches.push(index);
    }
    if (matches.length) return matches;
  }
  return [issueLineIndex(issue, lines)];
}

function issueAnchor(issue) {
  if (issue?.shot) return { type: 'shot', value: String(issue.shot) };
  if (issue?.group) return { type: 'group', value: Number(issue.group) };
  if (/参考素材|素材标签|@素材/.test(issue?.title || '')) return { type: 'reference' };
  return { type: 'sequence' };
}

function lineHasLocatedIssue(line, issue) {
  if (!issue) return false;
  const anchor = issueAnchor(issue);
  if (anchor.type === 'shot') {
    const shot = line.match(/镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[：:]/);
    return Boolean(shot && shot[1].replace(/\s+/g, '') === anchor.value);
  }
  if (anchor.type === 'group') return new RegExp(`第\\s*${anchor.value}\\s*组`).test(line);
  if (anchor.type === 'reference') return /参考素材\s*[：:]/.test(line);
  return /分镜序列\s*[：:]/.test(line);
}

function highlightLine(line, targets = null, lineIndex = -1, preserveFormattingMarkers = false) {
  const isActionLine = /^\s*△/.test(line);
  const isDialogueLine = /^\s*(?:\*\*)?[^:：\n]{1,16}(?:\*\*)?[:：]/.test(line);
  const html = renderSemanticTokens(line, preserveFormattingMarkers);
  const decorated = isActionLine ? `<span class="semantic-action">${html}</span>` : (isDialogueLine ? `<span class="semantic-dialogue">${html}</span>` : html);
  const issueLevel = targets?.lineLevels?.get(lineIndex);
  const marked = issueLevel ? `<span class="semantic-issue semantic-issue-${issueLevel}">${decorated}</span>` : decorated;
  const located = lineHasLocatedIssue(line, targets?.located) || (Number.isInteger(targets?.locatedLine) && targets.locatedLine === lineIndex);
  return located ? `<span class="semantic-located">${marked}</span>` : marked;
}

function highlightedEditor(bind, value, placeholder) {
  const layerId = `highlight-${bind.replace(/[^a-z0-9]/gi, '-')}`;
  // The mirror paints both committed and pre-edit text in the same flow.
  // The native textarea continues to own selection, IME and undo history.
  const footer = editorWorkspaceKind() === bind.split('.')[0] ? '' : window.DirectorEditorStats?.renderFooter(value) || '';
  return `<div class="highlight-editor"><div class="highlight-viewport" aria-hidden="true"><div class="highlight-layer" id="${layerId}"></div></div><textarea wrap="soft" spellcheck="false" class="editor semantic-editor" data-bind="${bind}" data-editor-context="${escapeHTML(viewportContextKey())}" data-highlight-layer="${layerId}" placeholder="${escapeHTML(placeholder)}">${escapeHTML(value || '')}</textarea>${footer}</div>`;
}

const compositionViews = new WeakMap();
let compositionPreviewLayer = null;
const highlightMarkupCache = new Map();
let highlightMarkupCacheChars = 0;
const HIGHLIGHT_CACHE_MAX_ENTRIES = 6;
const HIGHLIGHT_CACHE_MAX_CHARS = 1500000;
function clearCompositionPreview(textarea = null) {
  const layer = textarea ? document.getElementById(textarea.dataset?.highlightLayer) : compositionPreviewLayer;
  window.DirectorCompositionMirror.clear(layer);
  if (layer === compositionPreviewLayer) compositionPreviewLayer = null;
}
function updateCompositionPreview(textarea) {
  const view = compositionViews.get(textarea);
  if (!view || !textarea.isConnected || !inputOwnerMatches(textarea)) return;
  const layer = document.getElementById(textarea.dataset.highlightLayer);
  if (!layer) return;
  const current = window.DirectorCompositionMirror.frame(view, textarea.value);
  const previous = view.lastFrame;
  if (previous?.layer === layer && previous.value === current.value && previous.start === current.start && previous.end === current.end
      && previous.selectionStart === textarea.selectionStart && previous.selectionEnd === textarea.selectionEnd && previous.direction === textarea.selectionDirection) {
    layer.style.transform = `translateY(${-textarea.scrollTop}px)`;
    return;
  }
  if (current.value.length > 120000) {
    clearCompositionPreview(textarea);
    textarea.closest('.highlight-editor').dataset.largeText = 'true';
    layer.textContent = ''; layer._sourceText = null;
    return;
  }
  const targets = textarea.dataset.bind === 'storyboard.content' ? storyboardErrorTargets() : textarea.dataset.bind === 'script.content' ? scriptErrorTargets() : null;
  window.DirectorCompositionMirror.render(layer, view, textarea.value, (line, index) => highlightLine(line, targets, index, true),
    { start: textarea.selectionStart, end: textarea.selectionEnd, backward: textarea.selectionDirection === 'backward' });
  view.lastFrame = { ...current, layer, selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd, direction: textarea.selectionDirection };
  compositionPreviewLayer = layer;
  layer.style.transform = `translateY(${-textarea.scrollTop}px)`;
}
function compositionDisplayValue(textarea) {
  return String(textarea?.value || '');
}
function updateHighlightedEditor(textarea, { committed = false, composing = false } = {}) {
  if (!inputOwnerMatches(textarea)) return;
  const layer = document.getElementById(textarea.dataset.highlightLayer);
  if (!layer) return;
  if (!committed && !composing && editorComposition.isBlocked(textarea)) {
    updateCompositionPreview(textarea);
    return;
  }
  if (composing) {
    updateCompositionPreview(textarea);
    return;
  }
  if (committed) clearCompositionPreview(textarea);
  // Use the native textarea value directly.  Keeping this path free of any
  // composition-only helper also avoids a stale global binding after a
  // background renderer refresh.
  const displayValue = String(textarea?.value || '');
  const wrapper = textarea.closest('.highlight-editor');
  const largeText = displayValue.length > 120000;
  if (wrapper) wrapper.dataset.largeText = String(largeText);
  if (largeText) {
    // Rendering tens of thousands of semantic DOM nodes on every edit can
    // overwhelm a single CPU core. Keep Chromium's native editor and undo/IME.
    if (layer._sourceText !== null) { layer.textContent = ''; layer._sourceText = null; }
    return;
  }
  const targets = textarea.dataset.bind === 'storyboard.content' ? storyboardErrorTargets() : textarea.dataset.bind === 'script.content' ? scriptErrorTargets() : null;
  const sourceKey = `${displayValue}\u0000${targets?.key || ''}`;
  if (layer._sourceText !== sourceKey) {
    const cacheKey = `${textarea.dataset.bind}\u0000${contentFingerprint([displayValue, targets?.key || ''])}`;
    let markup = highlightMarkupCache.get(cacheKey);
    if (!markup && displayValue.length <= 200000) {
      markup = displayValue.split(/\r?\n/).map((line, index) => `<div class="highlight-line" data-line-index="${index}">${highlightLine(line, targets, index, true)}</div>`).join('');
      highlightMarkupCache.set(cacheKey, markup);
      highlightMarkupCacheChars += markup.length;
      while (highlightMarkupCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES || highlightMarkupCacheChars > HIGHLIGHT_CACHE_MAX_CHARS) {
        const oldestKey = highlightMarkupCache.keys().next().value;
        if (oldestKey == null) break;
        highlightMarkupCacheChars -= highlightMarkupCache.get(oldestKey)?.length || 0;
        highlightMarkupCache.delete(oldestKey);
      }
    }
    if (markup == null) markup = displayValue.split(/\r?\n/).map((line, index) => `<div class="highlight-line" data-line-index="${index}">${highlightLine(line, targets, index, true)}</div>`).join('');
    layer.innerHTML = markup;
    layer._sourceText = sourceKey;
  }
  layer.style.transform = `translateY(${-textarea.scrollTop}px)`;
}

function refreshHighlightedEditors() {
  document.querySelectorAll('textarea[data-highlight-layer]').forEach(updateHighlightedEditor);
}

function updateEditorStats(textarea, options = {}) {
  const kind = textarea?.dataset.bind?.split('.')[0];
  const footer = textarea?.closest?.('.highlight-editor')?.querySelector('[data-editor-stats]')
    || document.querySelector(`.editor-commandbar[data-editor-kind="${kind}"] [data-editor-stats]`);
  if (!footer || !window.DirectorEditorStats) return;
  window.DirectorEditorStats.updateFromInput(footer, textarea, options);
}

function refreshEditorStats() {
  document.querySelectorAll('textarea[data-highlight-layer]').forEach(updateEditorStats);
}

window.addEventListener('resize', () => requestAnimationFrame(refreshHighlightedEditors));

function centerSelectedNavigation() {
  const episode = document.querySelector('.episode-rail button.current');
  const episodeRail = episode?.closest('.episode-rail-scroll');
  if (episode && episodeRail) episodeRail.scrollLeft = Math.max(0, episode.offsetLeft - ((episodeRail.clientWidth - episode.offsetWidth) / 2));
  const sourceFile = document.querySelector('.source-file.current');
  const sourceList = sourceFile?.closest('.source-file-list');
  if (sourceFile && sourceList) sourceList.scrollTop = Math.max(0, sourceFile.offsetTop - ((sourceList.clientHeight - sourceFile.offsetHeight) / 2));
}

function updateChromeConnectionControls() {
  const openButton = document.querySelector('[data-action="open-chrome-permission"]');
  const connectButton = document.querySelector('[data-action="refresh-chrome-status"]');
  if (!openButton || !connectButton) return;
  openButton.textContent = '① 打开 Chrome 远程调试授权';
  connectButton.textContent = state.chromeConnecting ? '② 正在等待 Chrome 允许…' : '② 连接并刷新当前聊天';
  connectButton.disabled = state.chromeConnecting;
  const actions = connectButton.closest('.form-actions');
  const runnerHint = actions?.closest('.card')?.querySelector('.hint');
  if (runnerHint) runnerHint.textContent = '首次操作：先点①，软件会只打开 Chrome 的“远程调试”授权页；开启授权页中的“远程调试”开关后，回软件点②，并在 Chrome 的允许框中确认。无需退出 Chrome、无需填写端口、无需重新登录。之后始终复用你选定的当前 ChatGPT 聊天，不会切换项目或新建聊天；确认任务后才上传本集当前所选格式的文件与启用的规则/参照文件，并把结果保存为该页面选择的 TXT、Word 或 MD。生成中若浏览器短暂断开，软件会自动重连最多六次，并从当前集继续。';
  const previous = document.querySelector('#chrome-connection-progress');
  if (previous) previous.remove();
  if (state.chromeConnecting && actions) {
    const notice = document.createElement('div');
    notice.id = 'chrome-connection-progress';
    notice.className = 'notice';
    notice.style.marginTop = '10px';
    notice.textContent = '正在向 Chrome 发起连接请求。请切回 Chrome 查看“允许”窗口；首次出现可能需要几秒，请不要关闭 Chrome 或本软件。';
    actions.insertAdjacentElement('afterend', notice);
  }
}

function activeEpisode() {
  return directorEpisodeSlots.episodeByKey(state.project, state.project?.currentEpisode);
}

function contentFingerprint(parts) {
  const source = parts.map((part) => String(part || '')).join('\u0000');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length}:${(hash >>> 0).toString(36)}`;
}

function currentCheckFingerprint() {
  return contentFingerprint([state.project?.script?.content, state.project?.shotlist?.content, state.project?.storyboard?.content, JSON.stringify(localCheckPolicy())]);
}

function storyboardCheckSignature(issue) {
  return [issue?.level || '', issue?.title || '', issue?.detail || '', issue?.group || '', issue?.shot || ''].join('\u0001');
}

function filterConfirmedStoryboardChecks(checks) {
  const fingerprint = currentCheckFingerprint();
  const confirmed = state.project?.storyboard?.confirmedChecks || [];
  const ignored = new Set(confirmed.filter((item) => item.fingerprint === fingerprint).map((item) => item.signature));
  return checks.filter((item) => !ignored.has(storyboardCheckSignature(item)));
}

function hasConfirmedStoryboardChecks() {
  const fingerprint = currentCheckFingerprint();
  return (state.project?.storyboard?.confirmedChecks || []).some((item) => item.fingerprint === fingerprint);
}

function currentScriptCheckFingerprint() {
  return contentFingerprint([state.project?.source?.content, state.project?.script?.content, state.project?.activeFiles?.source, JSON.stringify(localCheckPolicy())]);
}

function currentShotlistCheckFingerprint() {
  return contentFingerprint([state.project?.shotlist?.content, JSON.stringify(localCheckPolicy())]);
}

function checkIsFresh(kind) {
  const key = kind === 'script' ? currentScriptCheckFingerprint()
    : kind === 'storyboard' ? currentCheckFingerprint() : currentShotlistCheckFingerprint();
  return Boolean(state.checkCache?.[kind] && state.checkCache[kind] === key);
}

function queuePageCheck(kind) {
  if (!state.project || !localCheckPolicy().automatic || checkIsFresh(kind) || state.checkInFlight?.[kind]) return;
  const run = kind === 'script' ? runScriptCheck : kind === 'storyboard' ? runCheck : runShotlistCheck;
  state.checkInFlight[kind] = true;
  setTimeout(() => {
    void run({ silent: true }).catch(reportRendererFailure).finally(() => { state.checkInFlight[kind] = false; });
  }, 0);
}

function scriptCheckSignature(issue) {
  return [issue?.level || '', issue?.title || '', issue?.detail || '', issue?.line || ''].join('\u0001');
}

function filterConfirmedScriptChecks(checks) {
  const fingerprint = currentScriptCheckFingerprint();
  const confirmed = state.project?.script?.confirmedChecks || [];
  const ignored = new Set(confirmed.filter((item) => item.fingerprint === fingerprint).map((item) => item.signature));
  return checks.filter((item) => !ignored.has(scriptCheckSignature(item)));
}

function hasConfirmedScriptChecks() {
  const fingerprint = currentScriptCheckFingerprint();
  return (state.project?.script?.confirmedChecks || []).some((item) => item.fingerprint === fingerprint);
}

function syncActiveEpisode(kinds = ['outline', 'script', 'shotlist', 'storyboard']) {
  if (!state.project) return;
  const episode = activeEpisode();
  if (!episode) return;
  const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : deepCopy(value);
  episode.targetSeconds = Number(state.project.targetDuration) || 120;
  for (const kind of kinds) episode[kind] = clone(state.project[kind] || { content: '', versions: [], updatedAt: null });
  episode.activeFiles = { ...(state.project.activeFiles || {}) };
}

let episodeCheckTimer = null;
function cancelScheduledEpisodeCheck() { clearTimeout(episodeCheckTimer); episodeCheckTimer = null; }
function scheduleEpisodeChecks(project, episodeNumber, loadToken) {
  cancelScheduledEpisodeCheck();
  episodeCheckTimer = setTimeout(() => {
    episodeCheckTimer = null;
    if (state.project !== project || state.episodeLoadToken !== loadToken || Number(project.currentEpisode) !== Number(episodeNumber)) return;
    const kind = { script: 'script', shotlist: 'shotlist', storyboard: 'storyboard' }[state.view];
    if (kind) queuePageCheck(kind);
  }, 120);
}

function updateEpisodeLoadingStatus(number) {
  const status = document.querySelector('#episode-loading-status');
  if (status) status.textContent = number ? '正在读取第 ' + directorEpisodeSlots.label(state.project, number) + ' 集…' : '';
}

async function activateEpisode(number, { preferKnownFiles = false } = {}) {
  const project = state.project;
  if (!project) return false;
  const episode = project.episodes.find(item => Number(item.number) === Number(number));
  if (!episode) return false;
  cancelScheduledEpisodeCheck();
  const startedAt = performance.now();
  const loadToken = {};
  state.episodeLoadToken = loadToken;
  updateEpisodeLoadingStatus(number);
  syncActiveEpisode();
  const editRevision = state.documentEditRevision || 0;
  const readContext = window.DirectorEpisodeReadContext(project, episode.number);
  readContext.preferKnownFiles = preferKnownFiles;
  const sourceFormat = documentFormatForKind('source');
  const previousSourcePath = project.activeFiles?.source || '';
  const previousSourceNumber = episodeNumberFromFileName(previousSourcePath.split(/[\\/]/).at(-1));
  const sourceBinding = episode.sourceBinding || (Number(project.currentEpisode) === Number(episode.number)
    && (previousSourceNumber === null || previousSourceNumber === directorEpisodeSlots.baseNumber(episode.number)) ? previousSourcePath : '');
  const sourceFile = (sourceBinding && fileMatchesDocumentFormat(sourceBinding, sourceFormat) ? { path: sourceBinding } : null)
    || (project.source.files || []).find(file => fileMatchesDocumentFormat(file.path || file.name, sourceFormat)
    && (Number(file.episodeNumber) === directorEpisodeSlots.baseNumber(episode.number)
      || episodeNumberFromFileName(file.name) === directorEpisodeSlots.baseNumber(episode.number)));
  try {
    const [documents, sourceDocument] = await Promise.all([
      window.directorApi.loadEpisodeDocuments(readContext, episode.number),
      sourceFile ? window.directorApi.openDocumentFile(readContext, 'source', sourceFile.path).catch(() => null) : Promise.resolve(null)
    ]);
    if (state.episodeLoadToken !== loadToken || state.project !== project) return false;
    if ((state.documentEditRevision || 0) !== editRevision) {
      showToast('读取期间当前集又有新编辑，已保留内容。请保存后再切换。');
      return false;
    }
    // Commit the new episode and its documents together. While I/O is pending,
    // the previous episode remains intact; late results cannot overwrite it.
    state.documentFindLocation = null;
    state.documentFindQuery = { outline: '', script: '', shotlist: '', storyboard: '' };
    state.documentFindActiveIndex = { outline: 0, script: 0, shotlist: 0, storyboard: 0 };
    state.documentDirty = { source: false, outline: false, script: false, shotlist: false, storyboard: false };
    state.saveErrors = {};
    for (const kind of ['outline', 'script', 'shotlist', 'storyboard']) state.workspaceVersions[kind] = { projectPath: project.projectPath, episode: episode.number, path: '', version: null };
    state.shotlistVerdict = null;
    state.checkCache = { script: '', storyboard: '', shotlist: '' };
    state.checkInFlight = { script: false, storyboard: false, shotlist: false };
    project.currentEpisode = Number(episode.number);
    project.targetDuration = Number(episode.targetSeconds) || 120;
    const sharedOutlinePath = project.activeFiles?.outline || episode.activeFiles?.outline || '';
    project.outline = { content: '', versions: episode.outline?.versions || [], updatedAt: null };
    project.script = { content: '', versions: episode.script?.versions || [], checks: episode.script?.checks || [], confirmedChecks: episode.script?.confirmedChecks || [], updatedAt: null };
    project.shotlist = { content: '', versions: episode.shotlist?.versions || [], updatedAt: null };
    project.storyboard = { content: '', versions: episode.storyboard?.versions || [], checks: episode.storyboard?.checks || [], confirmedChecks: episode.storyboard?.confirmedChecks || [], updatedAt: null };
    project.activeFiles = { source: project.activeFiles?.source || '', outline: sharedOutlinePath, script: '', shotlist: '', storyboard: '' };
    if (sourceDocument) applyOpenedDocument('source', sourceDocument);
    else {
      project.source = { ...project.source, content: '', name: '', path: '', updatedAt: null };
      project.activeFiles.source = '';
    }
    for (const kind of ['outline', 'script', 'shotlist', 'storyboard']) if (documents[kind]) applyOpenedDocument(kind, documents[kind]);
    syncActiveEpisode();
    window.directorLastEpisodeTiming = { episode: Number(episode.number), readMs: Math.round(performance.now() - startedAt),
      requestBytes: new TextEncoder().encode(JSON.stringify(readContext)).length };
    state.episodeDisplayTiming = { token: loadToken, startedAt };
    state.focusEditorAfterEpisodeLoad = true;
    scheduleEpisodeChecks(project, episode.number, loadToken);
    return true;
  } finally {
    if (state.episodeLoadToken === loadToken) updateEpisodeLoadingStatus(null);
  }
}

function dirtyDocumentKinds() {
  return Object.entries(state.documentDirty || {}).filter(([, dirty]) => dirty).map(([kind]) => kind);
}

function preferredDirtyDocumentKind(kinds) {
  const currentKind = state.view === 'project' ? 'source' : state.view === 'outline' ? 'outline' : state.view === 'script' ? 'script' : state.view === 'shotlist' ? 'shotlist' : state.view === 'storyboard' ? 'storyboard' : '';
  return kinds.includes(currentKind) ? currentKind : kinds[0];
}

async function confirmSaveBeforeEpisodeChange(nextEpisode) {
  if (!state.project || Number(nextEpisode) === Number(state.project.currentEpisode)) return true;
  await documentSaveQueue.drain();
  const kinds = dirtyDocumentKinds();
  if (!kinds.length) return true;
  const shouldSave = await window.directorConfirm(`第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集有未保存的编辑内容。\n\n保存后切换到第 ${directorEpisodeSlots.label(state.project, nextEpisode)} 集；取消则留在当前集。`, { title: '保存后切换集数', confirmLabel: '保存并切换', cancelLabel: '留在当前集' });
  if (!shouldSave) return false;
  for (const kind of [preferredDirtyDocumentKind(kinds), ...kinds.filter((kind) => kind !== preferredDirtyDocumentKind(kinds))]) {
    await saveFolderDocument(kind, { preserveViewport: true });
  }
  if (dirtyDocumentKinds().length) {
    showToast('保存期间还有新输入，已保留当前集；请保存后再切换。');
    return false;
  }
  return true;
}

function rebuildEpisodes() {
  if (!state.project) return;
  syncActiveEpisode();
  const season = state.project.season || {};
  const start = Number(season.startEpisode) || 1;
  const count = Math.max(1, Number(season.numberedEpisodes) || Number(season.totalEpisodes) || 1);
  state.project.episodes = directorEpisodeSlots.numberedEpisodePlan(state.project, start, count);
  state.project.season = { ...season, startEpisode: start, endEpisode: start + count - 1,
    numberedEpisodes: count, totalEpisodes: state.project.episodes.length };
  if (!state.project.episodes.some((episode) => Number(episode.number) === Number(state.project.currentEpisode))) void activateEpisode(start);
}

async function selectWorkspaceEpisode(nextEpisode) {
  if (!await confirmSaveBeforeEpisodeChange(nextEpisode)) return false;
  if (!await activateEpisode(nextEpisode)) return false;
  if (state.view === 'review') reviewUI.selectEpisode(nextEpisode);
  markDirty();
  render();
  if (state.view === 'assets') await refreshAssetPromptLibrary({ silent: true });
  return true;
}

let episodeSideButtonBusy = false;
let lastEpisodeSideButton = null;
async function stepEpisodeWithMouse(direction, source = 'mouse') {
  if (direction !== -1 && direction !== 1) return;
  const now = performance.now();
  // Some Windows mouse drivers deliver both DOM and native app-command events.
  // Treat that pair as one press while allowing repeated presses on either route.
  if (lastEpisodeSideButton?.direction === direction && lastEpisodeSideButton.source !== source
      && now - lastEpisodeSideButton.time < 300) return;
  lastEpisodeSideButton = { direction, source, time: now };
  if (episodeSideButtonBusy || !state.project || state.projectSwitchPending
      || interfaceIsLocked() || compositionActive || editorComposition.busy()
      || modalRoot.querySelector('.modal') || document.querySelector('dialog[open]')) return;
  const numbers = (state.project.episodes || []).map(item => Number(item.number)).filter(Number.isFinite).sort((a, b) => a - b);
  const current = numbers.indexOf(Number(state.project.currentEpisode));
  if (current < 0) return;
  const nextEpisode = numbers[current + direction];
  if (nextEpisode == null) return showToast(direction < 0 ? '已经是第一集。' : '已经是最后一集。');
  episodeSideButtonBusy = true;
  try { await selectWorkspaceEpisode(nextEpisode); }
  finally { episodeSideButtonBusy = false; }
}

for (const type of ['mousedown', 'mouseup', 'auxclick']) {
  document.addEventListener(type, event => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    event.stopPropagation();
    if (type === 'mousedown') void stepEpisodeWithMouse(event.button === 3 ? -1 : 1).catch(reportRendererFailure);
  }, { capture: true });
}
window.directorApi.onEpisodeStep?.(direction => {
  void stepEpisodeWithMouse(direction, 'native').catch(reportRendererFailure);
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function markDirty() {
  if (!membershipCanEdit()) return;
  state.dirty = true;
  state.changeRevision += 1;
  const label = document.querySelector('.save-state');
  if (label) label.textContent = '有未保存修改';
  updateSaveIndicators();
}

function currentDocumentKind() { return viewDocumentKinds[state.view] || ''; }
function renderSaveState() {
  if (!state.project) return '';
  const kind = currentDocumentKind();
  const saving = [...state.savingDocuments.values()].some(item => item.project === state.project && Number(item.episode) === Number(state.project.currentEpisode));
  const failed = kind && state.saveErrors[kind];
  const dirty = kind ? state.documentDirty[kind] : dirtyDocumentKinds().length || state.dirty;
  const sync = state.projectSync.get(projectPathKey(state.project.projectPath));
  const syncError = sync?.status === 'error';
  const syncing = sync && ['queued', 'saving'].includes(sync.status);
  const text = saving ? '正在保存…' : failed ? '保存失败 · 请重试' : dirty ? '未保存 · Ctrl+S' : kind && !state.project.activeFiles?.[kind] ? '尚未创建文件' : syncError ? '正文已保存 · 项目资料同步失败' : syncing ? '已保存 · 项目资料同步中' : '已保存';
  return `<span class="workspace-save-status ${saving ? 'saving' : failed || syncError ? 'error' : dirty ? 'unsaved' : 'saved'}" title="${escapeHTML(failed || sync?.error || (dirty ? '当前修改仍在编辑器中，按 Ctrl+S 保存；Ctrl+Shift+S 保存所有修改。' : 'Ctrl+S 保存当前文档；Ctrl+Shift+S 保存所有修改。'))}">${text}</span>${syncError ? '<button class="button quiet small" data-action="retry-project-sync">重试同步</button>' : ''}`;
}

function updateSaveIndicators() {
  const status = document.querySelector('#workspace-save-state');
  if (status) {
    const markup = renderSaveState();
    if (saveIndicatorMarkup.get(status) !== markup) {
      status.innerHTML = markup;
      saveIndicatorMarkup.set(status, markup);
    }
  }
  const label = document.querySelector('.save-state');
  const sync = state.projectSync.get(projectPathKey(state.project?.projectPath));
  if (label && !state.dirty) label.textContent = sync?.status === 'error' ? '已保存 · 资料同步失败'
    : sync && ['queued', 'saving'].includes(sync.status) ? '已保存 · 资料同步中' : '已保存';
  document.querySelectorAll('[data-action="save-document"]').forEach(button => {
    const saving = [...state.savingDocuments.values()].some(item => item.project === state.project && item.kind === button.dataset.kind && Number(item.episode) === Number(state.project?.currentEpisode));
    button.textContent = saving ? '保存中…' : '保存';
    button.setAttribute('aria-busy', String(saving));
    button.title = '保存当前文档（Ctrl+S）';
  });
  document.querySelectorAll('.editor-tab[data-view], .workspace-tab[data-view]').forEach(tab => {
    tab.classList.toggle('has-unsaved-changes', Boolean(state.documentDirty[tab.dataset.view]));
  });
}

function viewportContextKey() {
  if (!state.project) return '';
  const kind = viewDocumentKinds[state.view];
  const file = kind ? state.project.activeFiles?.[kind] || '' : '';
  return [state.project.id, state.view === 'review' ? 'screening' : state.project.currentEpisode, state.view, file].join('|');
}

function captureVisibleViewport() {
  const focused = document.activeElement;
  const editor = focused?.matches?.('textarea[data-bind$=".content"]')
    ? focused
    : document.querySelector('textarea[data-bind$=".content"]');
  const scrollable = document.querySelector('.script-reader, .shotlist-table-reader, .source-file-list');
  return {
    pageY: window.scrollY,
    scrollables: ['.script-reader', '.shotlist-table-reader', '.source-file-list', '.episode-rail-scroll', '.review-video-items'].flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((element, index) => ({ selector, index, top: element.scrollTop, left: element.scrollLeft }))),
    bind: editor?.dataset?.bind || '',
    scrollTop: editor?.scrollTop || 0,
    scrollLeft: editor?.scrollLeft || 0,
    readerScrollTop: scrollable?.scrollTop || 0,
    readerScrollLeft: scrollable?.scrollLeft || 0,
    selectionStart: editor?.selectionStart,
    selectionEnd: editor?.selectionEnd,
    focus: focused === editor
  };
}

function preserveViewportForNextRender() {
  if (state.pendingViewport?.key === state.renderedContextKey) return;
  state.pendingViewport = { key: state.renderedContextKey, ...captureVisibleViewport() };
  state.viewports.set(state.renderedContextKey, state.pendingViewport);
}

function restorePendingViewport() {
  const key = viewportContextKey();
  const pending = state.pendingViewport;
  state.pendingViewport = null;
  const snapshot = pending?.key === key ? pending : state.viewports.get(key);
  if (!snapshot) { window.scrollTo(0, 0); return; }
  window.scrollTo(0, snapshot.pageY);
  const scrollable = document.querySelector('.script-reader, .shotlist-table-reader, .source-file-list');
  if (scrollable) {
    scrollable.scrollTop = snapshot.readerScrollTop;
    scrollable.scrollLeft = snapshot.readerScrollLeft;
  }
  for (const saved of snapshot.scrollables || []) {
    const element = document.querySelectorAll(saved.selector)[saved.index];
    if (element) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
  }
  const editor = snapshot.bind ? document.querySelector(`textarea[data-bind="${snapshot.bind}"]`) : null;
  if (!editor) return;
  if (Number.isInteger(snapshot.selectionStart) && Number.isInteger(snapshot.selectionEnd)) {
    editor.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
  if (snapshot.focus) editor.focus({ preventScroll: true });
  editor.scrollTop = snapshot.scrollTop;
  editor.scrollLeft = snapshot.scrollLeft;
  updateHighlightedEditor(editor);
}

function markDocumentDirty(bind) {
  state.documentEditRevision = (state.documentEditRevision || 0) + 1;
  const kind = String(bind || '').replace(/\.content$/, '');
  const alreadyDirty = state.documentDirty[kind];
  if (Object.prototype.hasOwnProperty.call(state.documentDirty, kind)) state.documentDirty[kind] = true;
  state.documentRevisions[kind] = (state.documentRevisions[kind] || 0) + 1;
  delete state.saveErrors[kind];
  if (kind === 'source' || kind === 'script') state.checkCache.script = '';
  if (kind === 'script' || kind === 'shotlist' || kind === 'storyboard') state.checkCache.storyboard = '';
  if (kind === 'shotlist') state.checkCache.shotlist = '';
  if (!alreadyDirty) {
    const slot = document.querySelector('.sidebar-check-slot');
    if (slot && ['script', 'shotlist', 'storyboard'].includes(state.view)) slot.innerHTML = renderLocalCheckContext(state.view) + (state.view === 'script' ? renderScriptChecks('sidebar') : state.view === 'shotlist' ? renderShotlistChecks() : renderStoryboardChecks('sidebar'));
  }
}

function clearDocumentDirty(kind) {
  if (Object.prototype.hasOwnProperty.call(state.documentDirty, kind)) state.documentDirty[kind] = false;
}

function getPath(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], object);
}

function setPath(object, dottedPath, value) {
  const keys = dottedPath.split('.');
  const finalKey = keys.pop();
  const target = keys.reduce((item, key) => item[key], object);
  target[finalKey] = value;
}

const membershipCanEdit = () => state.membership?.canEdit === true;
const membershipCanUseBuiltinTemplates = () => state.membership?.canUseBuiltinTemplates === true;
const membershipSafeActions = new Set([
  'html-select', 'html-refresh', 'html-reload', 'html-fullscreen', 'html-choose', 'html-files-toggle',
  'open-membership', 'close-membership', 'membership-activate', 'membership-import',
  'membership-copy-machine', 'membership-remove-license', 'set-ui-theme', 'toggle-frog',
  'mascot-next-message', 'toggle-script-mode', 'toggle-shotlist-mode', 'toggle-storyboard-mode',
  'open-document-find', 'navigate-document-find', 'close-document-find', 'load-source-file',
  'select-episode', 'set-asset-filter', 'refresh-assets', 'refresh-asset-prompts',
  'locate-check', 'locate-script-check', 'close-modal', 'open-projects',
  'close-projects', 'adopt-folder', 'select-recent-project'
  , 'forget-project', 'forget-all-projects'
  , 'review-select', 'review-play', 'review-back', 'review-forward', 'review-frame',
  'review-frame-back', 'review-mute', 'review-fullscreen', 'review-pip', 'review-prev',
  'review-next', 'review-external', 'review-open-folder', 'review-jump', 'review-export'
  , 'review-open-video'
  , 'unlock-work', 'ai-batch-stop', 'ai-batch-show', 'ai-batch-minimize', 'ai-batch-close', 'ai-batch-copy-draft',
  'stop-batch', 'stop-workflow-batch', 'assistant-open'
]);

function membershipStatusText() {
  const member = state.membership;
  if (!member) return '正在读取会员状态';
  if (!member.active) return `${member.planLabel || '会员'}已到期`;
  if (member.permanent) return `${member.planLabel} · 永久`;
  return `${member.planLabel} · 剩余${member.remainingDays ?? 0}天`;
}

function formatMembershipDate(value) {
  if (!value) return '永久';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN');
}

function renderMembershipModal() {
  const member = state.membership || {};
  const templatesAvailable = member.builtinTemplatesAvailable;
  const plans = [
    ['free', '免费会员', '免费', '首次使用7天', '可阅读与编辑'],
    ['plus', 'Plus会员', '¥7/月', '按月开通', templatesAvailable ? '开放全部内置提示词' : '有效期内可编辑'],
    ['pro', 'Pro会员', '¥50/年', '按年开通', templatesAvailable ? '开放全部内置提示词' : '有效期内可编辑'],
    ['lifetime', '永久会员', '¥99', '一次开通', templatesAvailable ? '永久开放编辑与内置提示词' : '永久开放编辑']
  ];
  modalRoot.innerHTML = `<div class="modal-overlay membership-overlay"><div class="modal membership-modal">
        <div class="modal-head"><div><div class="eyebrow">MEMBERSHIP · V0.1.8</div><h2>导演台剧场会员中心</h2></div><button class="modal-close" data-action="close-membership">×</button></div>
    <section class="membership-current ${member.active ? 'active' : 'expired'}"><div><span>当前身份</span><strong>${escapeHTML(member.planLabel || '读取中')}</strong><small>${escapeHTML(member.reason || (member.permanent ? '永久有效' : `有效期至 ${formatMembershipDate(member.expiresAt)}`))}</small></div><span class="membership-state">${member.canEdit ? '可编辑' : '只读'}</span></section>
    ${member.bundledEdition ? '<p class="membership-note">此安装版本已附带永久会员，编辑和全部内置提示词均已解锁，无需激活或续费。AI 生成仍使用你自己配置的服务商和 API。</p>' : `<div class="membership-plans">${plans.map(([id, label, price, duration, note]) => `<article class="membership-plan ${member.plan === id ? 'current' : ''}"><span>${label}</span><strong>${price}</strong><small>${duration}<br>${note}</small></article>`).join('')}</div>`}
    ${!templatesAvailable ? '<p class="membership-note">当前版本使用自行导入的要求文件，可在规则页面选择。</p>' : member.plan === 'free' && member.active ? '<p class="membership-note">免费试用期间可以编辑项目和使用自行导入的要求文件。</p>' : ''}
    ${!member.canEdit ? '<p class="membership-note danger">会员已到期，项目仍可打开和阅读，但保存、修改、生成和内置提示词均已停止。</p>' : ''}
    ${member.bundledEdition ? '' : `<div class="membership-activation"><div class="field"><label>电脑识别码</label><div class="membership-machine"><code>${escapeHTML(member.machineCode || '')}</code><button class="button quiet small" data-action="membership-copy-machine">复制</button></div></div>
      <div class="field"><label>激活码</label><textarea id="membership-token" rows="4" placeholder="粘贴管理员发给你的激活码，或导入 .dtlicense 授权文件"></textarea></div>
      <div class="form-actions"><button class="button secondary" data-action="membership-import">导入授权文件</button><button class="button" data-action="membership-activate">激活会员</button>${member.source === 'license' ? '<button class="button quiet" data-action="membership-remove-license">移除当前授权</button>' : ''}</div>
      <p class="hint">购买或续费时，把电脑识别码发给管理员。开发者与管理员使用永久内部授权。</p>
    </div>`}
  </div></div>`;
}

function renderBuiltinTemplateModal() {
  const preview = state.builtinTemplatePreview;
  if (!preview) return;
  modalRoot.innerHTML = `<div class="modal-overlay builtin-template-overlay"><div class="modal builtin-template-modal" role="dialog" aria-modal="true" aria-labelledby="builtin-template-title"><div class="modal-head"><div><div class="eyebrow">BUILT-IN TEMPLATE · MEMBER ONLY</div><h2 id="builtin-template-title">${escapeHTML(preview.template?.label || preview.template?.name || '内置提示词')}</h2></div><button class="modal-close" data-action="close-builtin-template" aria-label="关闭提示词预览">×</button></div><textarea class="builtin-template-content" aria-label="内置提示词正文" readonly>${escapeHTML(preview.content || '')}</textarea><div class="form-actions"><button class="button secondary" data-action="copy-builtin-template">复制内容</button><button class="button" data-action="close-builtin-template">关闭</button></div></div></div>`;
}

function renderBuiltinTemplateLibrary() {
  if (state.membership?.builtinTemplatesAvailable === false) return '';
  if (!membershipCanUseBuiltinTemplates()) {
    return `<article class="card builtin-library locked"><div class="card-title"><div><h2>内置提示词库</h2><p class="hint">共 10 份生产提示词</p></div><span class="badge">付费会员专享</span></div><p>免费会员不能读取或使用内置提示词。Plus、Pro、永久会员、开发者和管理员可全部使用。</p><button class="button" data-action="open-membership">查看会员方案</button></article>`;
  }
  const templates = state.builtinTemplates || [];
  const current = normalizeWorkflowTemplates(state.project?.workflowTemplates);
  const activeSlots = ['script', 'shotlist', current.promptMode === '15' ? 'prompt15' : 'prompt30'];
  const categories = { script: 'script', shotlist: 'storyboard', prompt15: 'shared', prompt30: 'shared' };
  const currentIds = new Set(activeSlots.filter((slot) => !(state.project?.ruleDocuments || []).some((doc) => doc.category === categories[slot] && doc.enabled !== false)).map((slot) => current[slot]?.id).filter(Boolean));
  const categoryLabel = { planning: '前期规划', script: '原文转剧本', shotlist: '剧本转分镜', prompt: '分镜转提示词' };
  return `<article class="card builtin-library"><div class="card-title"><div><h2>内置提示词库</h2><p class="hint">选择生产模板后会用于对应生成步骤；时长配置和全剧大纲可查看、复制，用于前期规划。</p></div><span class="badge pass">会员已解锁</span></div><div class="builtin-template-grid">${templates.map((item) => `<div class="builtin-template-row ${currentIds.has(item.id) ? 'current' : ''}"><div><span>${escapeHTML(categoryLabel[item.category] || item.category)}</span><strong>${escapeHTML(item.label)}</strong><small>${currentIds.has(item.id) ? '当前使用' : escapeHTML(item.name)}</small></div><div class="form-actions"><button class="button quiet small" data-action="preview-builtin-template" data-template-id="${escapeHTML(item.id)}">查看</button>${item.category === 'planning' ? '<span class="hint">规划参考</span>' : `<button class="button secondary small" data-action="use-builtin-template" data-template-id="${escapeHTML(item.id)}">用于生成</button>`}</div></div>`).join('')}</div></article>`;
}

function applyMembershipAccess() {
  if (membershipCanEdit()) return;
  appRoot.querySelectorAll('textarea[data-bind], input[data-bind], select[data-bind], [data-document-format], [data-rule-id], [data-reference-id], [data-reference-format-id], [data-asset-id]').forEach((control) => {
    if (control.matches('textarea,input[type="text"],input[type="number"]')) control.readOnly = true;
    else control.disabled = true;
  });
  appRoot.querySelectorAll('[data-action]').forEach((button) => {
    if (!membershipSafeActions.has(button.dataset.action)) button.disabled = true;
  });
}

const workspaceUI = window.createWorkspaceUI({ state, api: window.directorApi, render,
  toast: showToast, reviewUI: () => reviewUI, applyDocument: applyOpenedDocument,
  appendFile: appendFolderFile, syncEpisode: syncActiveEpisode, refreshHighlights: refreshHighlightedEditors, isComposing: () => compositionActive });

async function refreshMembership({ loadTemplates = true } = {}) {
  state.membership = await window.directorApi.membershipStatus();
  state.builtinTemplates = [];
  if (loadTemplates && membershipCanUseBuiltinTemplates()) {
    state.builtinTemplates = await window.directorApi.builtinTemplates();
  }
  return state.membership;
}

function renderShell(content, { liveEditor = null } = {}) {
  if (state.view === 'rules') content = renderWorkspacePreferencesEntry() + content;
  const navGroups = { 'director-home': '创作', assets: '素材与资料', review: '审片与设置' };
  const renderNavItem = ([id, label]) => {
    const kind = viewDocumentKinds[id];
    const active = id === 'editor' ? ['outline', 'script', 'shotlist', 'storyboard'].includes(state.view) : state.view === id;
    return `${navGroups[id] ? `<div class="nav-group-label">${navGroups[id]}</div>` : ''}<div class="nav-row ${active ? 'active' : ''} ${id.startsWith('html-')?'html-child':''}"><button class="nav-view-button ${active ? 'active' : ''}" data-view="${id}" ${active ? 'aria-current="page"' : ''}>${label}</button>${kind && state.project ? documentFormatSelect(kind, true) : ''}${state.project ? `<button type="button" class="workspace-nav-open" data-action="workspace-open" data-workspace-view="${id}" aria-label="在独立窗口打开${label}" title="在独立窗口打开${label}">↗</button>` : ''}</div>`;
  };
  const preferences = readWorkspacePreferences();
  const nav = views.filter(([id]) => preferences.pinOptionalTools || !optionalWorkspaceViews.has(id)).map(renderNavItem).join('')
    + (!preferences.pinOptionalTools ? `<details class="optional-tools" ${optionalWorkspaceViews.has(state.view) ? 'open' : ''}><summary>更多工具 <span>2</span></summary>${views.filter(([id]) => optionalWorkspaceViews.has(id)).map(renderNavItem).join('')}</details>` : '')
    + '<button class="nav-settings-button" data-action="ux-workspace-settings">界面设置</button>';
  const sidebarChecks = state.project && state.view === 'script'
    ? renderScriptChecks('sidebar')
    : state.project && state.view === 'shotlist'
      ? renderShotlistChecks()
    : state.project && state.view === 'storyboard'
      ? renderStoryboardChecks('sidebar')
      : '';
  const projectOptions = state.projects.map((project) => {
    const pathLabel = project.projectPath ? ` · ${project.projectPath}` : '';
    return `<option value="${project.id}" title="${escapeHTML(project.title + pathLabel)}" ${project.unavailable ? 'disabled' : ''} ${project.id === state.project?.id ? 'selected' : ''}>${escapeHTML(project.title)}${project.unavailable ? ' · 文件夹暂不可用' : ''}</option>`;
  }).join('');
  const episodes = state.project?.episodes || [];
  const episodeRail = episodes.length ? `<nav class="episode-rail" aria-label="集数导航"><span>集</span><div class="episode-rail-scroll">${episodes.map((episode) => `<button class="${Number(episode.number) === Number(state.project.currentEpisode) ? 'current' : ''}" title="第 ${directorEpisodeSlots.label(state.project, episode.number)} 集 · ${episode.targetSeconds || state.project?.targetDuration || 120} 秒" data-action="select-episode" data-episode="${episode.number}">${directorEpisodeSlots.label(state.project, episode.number)}${reviewUI.badge(episode.number)}</button>`).join('')}</div><button class="episode-split-button" data-action="split-episode" title="现有内容归上集；新增空白下集，后续集号不变">＋ 拆分当前集</button><span id="episode-loading-status" class="hint" role="status"></span></nav>` : '';
  const themeOptions = [
    ['light', '明亮', '明亮浅色'],
    ['dark', '黑色', '黑色夜间'],
    ['morandi', '莫兰迪', '莫兰迪护眼']
  ];
  const themeSwitcher = `<div class="theme-switcher" role="group" aria-label="界面主题">${themeOptions.map(([id, label, title]) => `<button type="button" class="theme-choice ${state.uiTheme === id ? 'active' : ''}" data-action="set-ui-theme" data-theme="${id}" title="${title}" aria-pressed="${state.uiTheme === id}"><span class="theme-swatch ${id}" aria-hidden="true"></span>${label}</button>`).join('')}</div>`;
  const apiBatchRunning = state.apiBatch?.status === 'running';
  const membershipBanner = state.membership && !state.membership.canEdit
    ? `<div class="membership-banner expired"><strong>会员已到期，当前为只读模式。</strong><span>${escapeHTML(state.membership.reason || '请续费或导入有效授权。')}</span><button class="button small" data-action="open-membership">开通会员</button></div>`
    : state.membership?.plan === 'free'
      ? `<div class="membership-banner trial"><strong>免费试用剩余 ${state.membership.remainingDays ?? 0} 天</strong><span>${state.membership.builtinTemplatesAvailable ? '基础编辑可用。内置提示词需要 Plus、Pro 或永久会员。' : '可编辑项目和使用自行导入的要求文件。'}</span><button class="button quiet small" data-action="open-membership">查看会员</button></div>`
      : '';
  const apiTaskDock = apiBatchRunning && state.apiBatchMinimized
    ? `<aside class="api-task-dock" aria-live="polite"><div><strong data-api-batch-dock-title>${state.apiBatch.stopRequested ? '正在停止 API 批量任务…' : 'API 批量任务在后台运行'}</strong><span data-api-batch-dock-status>第 ${state.apiBatch.currentEpisode ? directorEpisodeSlots.label(state.project, state.apiBatch.currentEpisode) : '—'} 集 · ${state.apiBatch.completed?.length || 0} 集已完成</span></div><div class="form-actions"><button class="button secondary small" data-action="ai-batch-show">查看进度</button><button class="button danger small" data-action="ai-batch-stop" ${state.apiBatch.stopRequested ? 'disabled' : ''}>${state.apiBatch.stopRequested ? '正在停止…' : '立即停止'}</button></div></aside>`
    : '';
  const lockActions = apiBatchRunning
    ? `<div class="form-actions work-lock-actions"><button class="button secondary" data-action="unlock-work">解锁并转到后台</button><button class="button danger" data-action="ai-batch-stop">立即停止任务</button></div>`
    : '<button class="button" data-action="unlock-work">解锁操作</button>';
  const shellMarkup = `
    <div class="shell ${editorWorkspaceKind() ? 'editor-shell' : ''} ${state.view.startsWith('html-') ? 'html-shell' : ['project','source','editor','outline','script','shotlist','storyboard'].includes(state.view) ? '' : 'compact-shell'} ${interfaceIsLocked() ? 'locked' : ''}" style="--sidebar-width: ${state.sidebarWidth}px">
      <aside class="sidebar">
          <div class="brand"><div class="brand-mark"><img src="../assets/brand-v008/logo-display.png" alt="" /></div><div><div class="brand-name">导演台剧场</div><div class="brand-subtitle">DIRECTOR THEATER · V0.1.12</div></div></div>
        <nav class="nav" aria-label="导演台功能">${nav}</nav>
        <div class="sidebar-bottom">
          ${sidebarChecks ? `<div class="sidebar-check-slot">${renderLocalCheckContext(state.view)}${sidebarChecks}</div>` : ''}
          ${state.project ? renderFrogAssistant() : ''}
          <div class="sidebar-foot">${escapeHTML(membershipStatusText())}<br>本地项目与可追溯版本</div>
        </div>
        <div class="sidebar-resizer" data-sidebar-resizer role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuemin="${SIDEBAR_WIDTH_MIN}" aria-valuemax="${SIDEBAR_WIDTH_MAX}" aria-valuenow="${state.sidebarWidth}" tabindex="0" title="拖动调整宽度，双击恢复默认"></div>
      </aside>
      <main class="main">
        ${membershipBanner}
        <div class="topbar">
          <div class="topbar-row"><select class="project-select" id="project-switch" aria-label="切换最近项目" title="${escapeHTML(state.project?.projectPath || '选择最近项目')}"><option value="">选择项目</option>${projectOptions}</select><div class="top-actions"><span id="workspace-save-state" role="status" aria-live="polite">${renderSaveState()}</span><button class="button secondary small" data-action="open-projects">打开项目</button><button class="button secondary small" data-action="new-project">新建</button><button class="membership-chip ${state.membership?.canEdit ? 'active' : 'expired'}" data-action="open-membership">${escapeHTML(membershipStatusText())}</button>${themeSwitcher}<button class="button secondary small" data-action="assistant-open">导演助手</button><button class="button small" data-view="generate" ${state.project ? '' : 'disabled'}>生成</button></div></div>
          ${workspaceUI.renderBar()}
          ${episodeRail}
          <div id="project-switch-status" class="project-switch-status" role="status" aria-live="polite" hidden></div>
          ${renderEditorWorkspaceHeader()}
        </div>
        ${state.storeNotice ? `<div class="store-recovery-notice" role="status"><strong>${state.storeNotice.recovered ? '已恢复项目列表' : '项目列表需要恢复'}</strong><span>${escapeHTML(state.storeNotice.message)}</span><details><summary>查看保留文件位置</summary><code>${escapeHTML(state.storeNotice.preservedPath || '')}</code></details><button class="button secondary small" data-action="open-projects">打开项目</button></div>` : ''}
        ${content}
      </main>
      
    </div>${apiTaskDock}${interfaceIsLocked() ? `<section class="work-lock-layer" role="dialog" aria-modal="true" aria-label="任务运行中"><div class="work-lock-card"><div class="eyebrow">WORKING · KEEP AWAKE</div><h2>任务正在运行</h2><p>${escapeHTML(state.workLabel || '软件正在等待 ChatGPT 回复并保存文件。')}</p><p class="hint">电脑会保持唤醒。可以把任务转到后台继续操作，也可以立即停止。</p>${lockActions}</div></section>` : ''}`;
  if (liveEditor) window.EditorFormatting.renderAroundEditor(appRoot, shellMarkup, liveEditor);
  else appRoot.innerHTML = shellMarkup;
  appRoot.querySelectorAll('[data-bind]').forEach((control) => {
    if (!control.dataset.editorContext) control.dataset.editorContext = viewportContextKey();
  });
  updateProjectSwitchStatus();
}

function updateProjectSwitchStatus() {
  const pending = state.projectSwitchPending;
  const status = document.querySelector('#project-switch-status');
  if (status) {
    status.hidden = !pending;
    status.textContent = pending ? `正在打开“${pending.title}”…` : '';
  }
  appRoot.querySelectorAll('.main > .page').forEach(page => { page.inert = Boolean(pending); page.setAttribute('aria-busy', String(Boolean(pending))); });
  const selector = document.querySelector('#project-switch');
  if (selector) {
    const selected = pending?.id || state.project?.id || '';
    if ([...selector.options].some(option => option.value === selected)) selector.value = selected;
  }
}

function renderEmpty() {
  renderShell(`<section class="page project-welcome"><div class="eyebrow">开始创作</div><h1>选择一种开始方式</h1><p class="lead">已有完整项目就打开文件夹；只有原文或剧本文件也可以直接开始。新建项目时，资料和集数都能稍后补充。</p><div class="project-entry-grid"><button class="project-entry" data-action="adopt-folder"><span class="project-entry-icon">01</span><strong>打开已有项目</strong><span>选择项目根文件夹，自动识别原文、大纲、剧本和分镜。</span></button><button class="project-entry" data-action="new-project-from-file"><span class="project-entry-icon">02</span><strong>从一个文件开始</strong><span>先选 TXT、Markdown 或 Word，再一步步建立项目。</span></button><button class="project-entry" data-action="new-project"><span class="project-entry-icon">03</span><strong>从空白开始</strong><span>只填项目名称即可建立；其他步骤都可以跳过。</span></button></div>${state.projects.length ? `<div class="recent-projects"><h2>最近打开</h2>${state.projects.slice(0, 6).map((project) => `<button data-action="select-recent-project" data-project-id="${escapeHTML(project.id)}"><strong>${escapeHTML(project.title)}</strong><span>${escapeHTML(project.projectPath || '')}</span></button>`).join('')}</div>` : ''}</section>`);
  workspaceUI.afterRender();
  assistantUI.afterRender();
  window.DirectorUIMotion?.afterRender(state.project ? state.view : 'welcome');
  observeTopbar();
  applyMembershipAccess();
  if (state.membershipModalOpen) renderMembershipModal();
  else if (state.builtinTemplatePreview) renderBuiltinTemplateModal();
  else if (state.projectWizard) renderProjectWizard();
  else if (state.projectChooserOpen) renderProjectChooser();
}

function renderHome() {
  const project = state.project;
  const hasSource = Boolean(project.source.content.trim());
  const hasOutline = Boolean(project.outline.content.trim());
  const hasScript = Boolean(project.script.content.trim());
  const hasShotlist = Boolean(project.shotlist?.content?.trim());
  const hasBoard = Boolean(project.storyboard.content.trim());
  const risks = countByLevel('error') + countByLevel('warning');
  const season = project.season || {};
  const episode = activeEpisode() || {};
  const stages = [
    ['00', '小说原文', '原始章节、高潮拆分', 'project', hasSource, project.source.files?.length ? `${project.source.files.length} 个文件` : '待读取'],
    ['01', '故事梗概', '逐集卖点与剧情摘要', 'project', true, '项目目录'],
    ['02', '大纲', '本集剧情结构，生成剧本时自动引用', 'outline', hasOutline, hasOutline ? '本集已读取' : '待编辑'],
    ['03', '剧本', '本集可阅读、可手改的剧本', 'script', hasScript, hasScript ? `${project.script.versions.length} 个版本` : '待生成'],
    ['04', '分镜', '结构化镜头计划', 'shotlist', hasShotlist || episode.shotlistSkipped, episode.shotlistSkipped ? '已跳过 · 直连提示词' : (hasShotlist ? `${project.shotlist.versions.length} 个版本` : '可选步骤')],
    ['05', 'Seedance提示词', '最终投喂与质量检查', 'storyboard', hasBoard, hasBoard ? `${risks} 个风险提示` : '待生成'],
    ['06', '资产', '角色、场景、道具、音频', 'assets', project.assets.length > 0, project.assets.length ? `${project.assets.length} 份素材` : '待补充']
  ];
  return `<section class="page">
    <div class="page-heading"><div><div class="eyebrow">SEASON CONTROL / ${String(project.currentEpisode).padStart(3, '0')}</div><h1>${escapeHTML(project.title)}</h1><p class="lead">先总控这一季，再精修每一集。00–06 是文件夹顺序，也是你从原文到可生成素材的制作路径。</p></div><div class="side-note">${escapeHTML(project.genre)}<br>当前第 ${directorEpisodeSlots.label(project, project.currentEpisode)} 集 · ${project.targetDuration} 秒</div></div>
    <div class="grid four">
      <article class="card"><div class="card-kicker">本季集数</div><div class="metric">${season.totalEpisodes || 1}</div><div class="metric-note">第 ${season.startEpisode || 1} 集至第 ${season.endEpisode || 1} 集</div></article>
      <article class="card"><div class="card-kicker">本季总时长</div><div class="metric">${season.totalMinutes || 0}<small> min</small></div><div class="metric-note">整季预估，可自行调整</div></article>
      <article class="card"><div class="card-kicker">当前单集</div><div class="metric">${project.targetDuration}<small> s</small></div><div class="metric-note">第 ${directorEpisodeSlots.label(project, project.currentEpisode)} 集 · ${escapeHTML(episode.status || '待创作')}</div></article>
      <article class="card"><div class="card-kicker">当前集风险</div><div class="metric">${risks}</div><div class="metric-note">${risks ? '先修正后再交付' : '尚未检查或已通过'}</div></article>
    </div>
    <article class="card" style="margin-top:16px"><div class="card-title"><h2>整季总控</h2><span class="badge">可修改</span></div><div class="form-grid"><div class="field"><label>开始集号</label><input data-bind="season.startEpisode" type="number" min="1" value="${season.startEpisode || 1}" /></div><div class="field"><label>编号集数</label><input data-bind="season.numberedEpisodes" type="number" min="1" value="${season.numberedEpisodes || season.totalEpisodes || 1}" /><p class="hint">含上／下分段后，实际可编辑位置：${project.episodes.length} 个。</p></div><div class="field"><label>本季总分钟数</label><input data-bind="season.totalMinutes" type="number" min="1" value="${season.totalMinutes || 1}" /></div></div><div class="form-actions"><button class="button secondary small" data-action="rebuild-episodes">更新本季集数</button><button class="button secondary small" data-action="split-episode">将当前集拆为上／下</button></div><div class="episode-strip">${project.episodes.map((item) => `<button class="episode-chip ${Number(item.number) === Number(project.currentEpisode) ? 'current' : ''}" data-action="select-episode" data-episode="${item.number}"><span>EP ${directorEpisodeSlots.label(project, item.number)}</span><small>${item.targetSeconds || 120}s</small></button>`).join('')}</div></article>
    <div class="workflow">${stages.map(([number, title, description, view, ready, meta], index) => `<button class="workflow-stage ${ready ? 'ready' : ''}" data-view="${view}"><span class="workflow-number">${number}</span><span class="workflow-copy"><strong>${title}</strong><small>${description}</small></span><span class="workflow-status">${meta}</span>${index < stages.length - 1 ? '<span class="workflow-arrow">→</span>' : ''}</button>`).join('')}</div>
    <div class="quick-actions"><button class="button" data-view="script">进入第 ${directorEpisodeSlots.label(project, project.currentEpisode)} 集剧本</button><button class="button secondary" data-action="toggle-ai-drawer">打开 AI 任务栏</button><button class="button secondary" data-action="run-check">检查当前 Seedance 提示词</button></div>
  </section>`;
}

function renderProject() {
  const project = state.project;
  const sourceFormat = documentFormatForKind('source');
  const sourceFiles = (project.source.files || []).filter((file) => fileMatchesDocumentFormat(file.path || file.name, sourceFormat));
  const selectedPath = project.activeFiles?.source || '';
  return `<section class="page editor-page project-source-page"><div class="workspace-commandbar"><span class="workspace-stage">00 原文</span><span class="workspace-count">${sourceFiles.length} 个文件</span><span class="workspace-file" title="${escapeHTML(project.activeFiles?.source || project.folders.source)}">${escapeHTML(project.source.name || '选择文件开始阅读')}</span><div><button class="button quiet small" data-action="import-source">导入</button><button class="button quiet small" data-action="rescan-project">刷新</button><button class="button secondary small" data-action="save-document" data-kind="source">保存</button></div></div>
    <div class="source-workspace"><aside class="source-file-browser"><div class="source-file-head"><span>文件夹内容</span><span class="badge">${sourceFiles.length}</span></div><div class="source-file-filter"><input id="source-filter" placeholder="筛选文件" /></div><div class="source-file-list">${sourceFiles.length ? sourceFiles.map((file) => `<button class="source-file ${file.path === selectedPath ? 'current' : ''}" data-action="load-source-file" data-source-path="${escapeHTML(file.path)}" data-source-name="${escapeHTML(file.name)}" title="${escapeHTML(file.path)}"><span class="source-file-name">${escapeHTML(file.name)}</span><small>${file.episodeNumber ? `第 ${file.episodeNumber} 集 · ${file.episodeDetectedFrom === 'content' ? '正文识别' : '文件名识别'}` : (file.modifiedAt ? formatTime(file.modifiedAt) : '原文文件')}</small></button>`).join('') : `<div class="source-file-empty">原文目录内还没有可读取的 ${documentFormatLabel(sourceFormat)} 文件。</div>`}</div></aside>
      <div class="editor-focus source-editor-focus"><div class="editor-toolbar"><p>${escapeHTML(project.source.name || '请选择左侧原文文件')}</p><div><span class="editor-autosave-note">直接编辑 · 保存写回</span><button class="button quiet small" data-action="open-episode-find-replace" data-kind="source">查找替换</button><button class="button quiet small" data-action="open-global-find-replace">全局替换</button></div></div>${highlightedEditor('source.content', project.source.content, '从左侧选择原文文件后，在这里阅读或修改内容。')}</div>
    </div>
  </section>`;
}

function referenceControls(category) {
  const isScript = category === 'script';
  const title = isScript ? '剧本参照文档' : '提示词参照文档';
  const docs = (state.project.referenceDocuments || []).filter((doc) => doc.category === category);
  return `<article class="card tight reference-controls"><div class="card-title"><h3>${title}</h3><button class="button quiet small" data-action="import-references" data-reference-category="${category}">导入</button></div><p class="hint">启用后，文档正文会在每次生成时发送；勾选“格式”会要求输出严格沿用该文档的标题、编号、分组和标签格式。</p>${docs.length ? `<div class="reference-list">${docs.map((doc) => `<div class="reference-item"><div><strong>${escapeHTML(doc.name)}</strong><span class="path">${escapeHTML(doc.path)}</span></div><label><input type="checkbox" data-reference-id="${doc.id}" ${doc.enabled !== false ? 'checked' : ''} /> 使用</label><label><input type="checkbox" data-reference-format-id="${doc.id}" ${doc.outputFormat !== false ? 'checked' : ''} /> 格式</label></div>`).join('')}</div>` : '<p class="hint">尚未导入参照文档。</p>'}</article>`;
}

function folderFilesForKind(kind, formatOverride = '') {
  const key = kind === 'outline' ? 'outline' : kind === 'script' ? 'script' : kind === 'shotlist' ? 'storyboard' : kind === 'storyboard' ? 'seedance' : 'source';
  const format = formatOverride || documentFormatForKind(kind);
  const currentEpisode = Number(state.project.currentEpisode);
  const belongsToCurrentEpisode = (file) => {
    if (kind === 'outline') return true;
    const episodeNumber = Number(file.episodeNumber) || episodeNumberFromFileName(file.name || file.path);
    return (!episodeNumber && directorEpisodeSlots.partForKey(state.project, currentEpisode) !== '下')
      || (episodeNumber === directorEpisodeSlots.baseNumber(currentEpisode)
      && directorEpisodeSlots.matchingPart(state.project, currentEpisode, file.name || file.path, kind === 'source'));
  };
  const files = [...(kind === 'source' ? state.project.source.files : state.project.availableFiles?.[key] || [])]
    .filter((file) => fileMatchesDocumentFormat(file.path || file.name, format))
    .filter((file) => kind === 'source' || belongsToCurrentEpisode(file));
  const activePath = state.project.activeFiles?.[kind];
  const activeEpisode = episodeNumberFromFileName(activePath?.split(/[\\/]/).at(-1));
  if (activePath && fileMatchesDocumentFormat(activePath, format) && (kind === 'source' || kind === 'outline' ||
      (!activeEpisode && directorEpisodeSlots.partForKey(state.project, currentEpisode) !== '下') ||
      (activeEpisode === directorEpisodeSlots.baseNumber(currentEpisode) &&
        directorEpisodeSlots.matchingPart(state.project, currentEpisode, activePath))) && !files.some((file) => file.path === activePath)) {
    files.unshift({ name: activePath.split(/[\\/]/).at(-1), path: activePath });
  }
  return files;
}

function folderDocumentBar(kind, actions = '') {
  const files = folderFilesForKind(kind);
  const activePath = state.project.activeFiles?.[kind] || '';
  const stage = kind === 'outline' ? '02 大纲' : kind === 'script' ? '03 剧本' : kind === 'shotlist' ? '04 分镜' : kind === 'storyboard' ? '05 提示词' : '00 原文';
  return `<div class="folder-document-bar"><span class="folder-stage">${stage}</span><select data-document-select="${kind}" title="选择文件"><option value="">${files.length ? '选择文件' : `暂无 ${documentFormatLabel(documentFormatForKind(kind))} 文档`}</option>${files.map((file) => `<option value="${escapeHTML(file.path)}" ${file.path === activePath ? 'selected' : ''}>${escapeHTML(file.name)}</option>`).join('')}</select>${actions}<button class="button secondary small" data-action="save-document" data-kind="${kind}">保存</button><button class="button quiet small" data-action="export-document-word" data-kind="${kind}">导出 Word</button></div>`;
}

function scriptReader(content, emptyText = '当前还没有内容。请从右侧 AI 任务栏生成，或切换到编辑模式手写。') {
  if (!content?.trim()) return `<div class="reader-empty"><div><strong>从本集剧本开始</strong><p>导入已有文件、手写剧本，或用原文和大纲生成。</p><div class="form-actions"><button class="button" data-action="toggle-script-mode">开始编辑</button><button class="button secondary" data-view="generate">生成剧本</button><button class="button quiet" data-view="project">查看原文</button></div></div></div>`;
  const targets = scriptErrorTargets();
  return content.split(/\r?\n/).map((line, index) => {
    const trimmed = line.trim();
    const kind = /^△/.test(trimmed) ? 'action' : /\[内\]|\[外\]|场\s*\d|^\d+[-－]\d+/.test(trimmed) ? 'scene' : /(?:\*\*)?[^：:]{1,16}(?:\*\*)?[：:]/.test(trimmed) ? 'dialogue' : '';
    return `<p class="script-line ${kind}">${highlightLine(line, targets, index)}</p>`;
  }).join('');
}

function storyboardReader(content, emptyText = '当前还没有提示词。请先选择本集提示词文件，或切换到编辑模式填写。') {
  if (!content?.trim()) return `<div class="reader-empty">${emptyText}</div>`;
  const targets = storyboardErrorTargets();
  return content.split(/\r?\n/).map((line, index) => {
    const trimmed = line.trim();
    const displayLine = line.replace(/^(\s*)#{1,6}\s+/, '$1');
    const kind = /^(?:#{1,6}\s*)?第\s*\d+\s*组/.test(trimmed)
      ? 'scene storyboard-group'
      : /^镜头\s*\d+(?:\s*-\s*\d+)*\s*[：:]/.test(trimmed)
        ? 'storyboard-shot'
        : /^(?:#{1,6}\s*)?(?:任务类型|参考素材|声音|完整音频原句|分镜序列|固定统一风格与约束)\s*[：:]?/.test(trimmed)
          ? 'storyboard-section'
          : '';
    return `<p class="script-line storyboard-line ${kind}">${highlightLine(displayLine, targets, index)}</p>`;
  }).join('');
}

function inlineDocumentFindControl(kind) {
  const query = state.documentFindQuery?.[kind] || '';
  const { matches, overflow } = documentFindMatches(contentForKind(kind), query);
  const activeIndex = matches.length ? Math.max(0, Math.min(Number(state.documentFindActiveIndex?.[kind]) || 0, matches.length - 1)) : 0;
  const activeMatch = matches[activeIndex] || null;
  const status = query.trim()
    ? (activeMatch ? `${activeIndex + 1}/${overflow ? `${matches.length}+` : matches.length} · 第${activeMatch.line}行` : '未找到')
    : '';
  const placeholder = `查找当前${documentKindLabel(kind).replace('Seedance ', '')}`;
  const disabled = activeMatch ? '' : 'disabled';
  return `<div class="inline-document-find" role="search"><input data-inline-document-find="${kind}" value="${inputValue(query)}" autocomplete="off" placeholder="${placeholder}" aria-label="${placeholder}" /><span data-inline-document-find-status="${kind}">${escapeHTML(status)}</span><button type="button" class="inline-document-find-nav" data-action="navigate-document-find" data-find-kind="${kind}" data-find-direction="-1" data-inline-document-find-nav="${kind}" aria-label="上一处" title="上一处" ${disabled}>‹</button><button type="button" class="inline-document-find-nav" data-action="navigate-document-find" data-find-kind="${kind}" data-find-direction="1" data-inline-document-find-nav="${kind}" aria-label="下一处" title="下一处" ${disabled}>›</button></div>`;
}

function renderScriptChecks(placement = 'inline') {
  const checks = state.project.script.checks || [];
  const errors = checks.filter((item) => item.level === 'error').length;
  const warnings = checks.filter((item) => item.level === 'warning').length;
  const confirmed = hasConfirmedScriptChecks();
  const incomplete = checks.some(item => item.level === 'info');
  const stale = checks.length && !checkIsFresh('script');
  const status = stale ? 'pending' : errors ? 'error' : warnings ? 'warning' : incomplete ? 'info' : (checks.length || confirmed) ? 'pass' : '';
  const statusText = documentCheckHeadline('script');
  const priorityChecks = errors ? checks.filter((item) => item.level === 'error') : checks.filter((item) => item.level === 'warning');
  const shortText = stale ? '内容或设置已变化，以下为上次结果。重新检查后更新。' : priorityChecks.length ? [...new Set(priorityChecks.map(item => item.title))].slice(0, 3).join(' · ') : incomplete ? checks.find(item => item.level === 'info').detail : (checks.length ? '所选规则未发现问题；剧情与改编合理性仍需人工审阅。' : confirmed ? '待核对项已由你确认。' : '请运行检查，或在检查设置中启用自动检查。');
  const detailLabel = checks.length ? `查看 ${checks.length} 条规则结果` : '检查详情';
  const actionableCount = checks.filter((item) => ['error', 'warning'].includes(item.level)).length;
  const confirmAll = actionableCount ? `<button class="button quiet small" data-action="dismiss-all-script-checks">全部确认无误</button>` : '';
  return `<section class="storyboard-check-pin ${status} ${placement === 'sidebar' ? 'sidebar-check-panel' : ''}"><div class="storyboard-check-summary"><div class="storyboard-check-heading"><strong>剧本检查</strong><span class="badge ${status}">${statusText}</span>${confirmAll}</div><div class="storyboard-check-short">${escapeHTML(shortText)}</div></div><details class="storyboard-check-details" data-check-panel="script" ${state.scriptChecksExpanded ? 'open' : ''}><summary>${detailLabel}</summary><div class="storyboard-check-list">${checks.length ? renderCheckItems(checks, 'script') : '<p class="hint">运行后显示每条规则的结果与依据。</p>'}</div></details></section>`;
}

function editorWorkspaceKind() {
  return ['outline', 'script', 'shotlist', 'storyboard'].includes(state.view) ? state.view : '';
}

function renderEditorWorkspaceHeader() {
  const kind = editorWorkspaceKind();
  if (!kind) return '';
  const project = state.project;
  let context = '';
  let controls = '';
  if (kind === 'outline') {
    context = `大纲编辑 · ${project.outline.content?.trim() ? '生成剧本时会自动引用' : '可直接填写并保存本集大纲'}`;
  } else if (kind === 'script') {
    context = `${state.scriptMode === 'read' ? '阅读' : '编辑'} · <span data-check-headline="script">${documentCheckHeadline('script')}</span>`;
    controls = `<button class="button secondary small" data-action="run-script-check">重新检查</button><button class="button quiet small" data-action="toggle-script-mode">${state.scriptMode === 'read' ? '编辑' : '阅读'}</button>`;
  } else if (kind === 'shotlist') {
    const skipped = Boolean(activeEpisode()?.shotlistSkipped);
    const markdown = documentFormatForKind('shotlist') === 'md';
    const preview = markdown && state.shotlistMode !== 'edit';
    context = `<span>${skipped ? '已跳过分镜' : preview ? '分镜表格预览' : '分镜编辑'}</span>${shotlistDurationBadge(project.shotlist.content)}`;
    controls = `${markdown ? `<button class="button secondary small" data-action="toggle-shotlist-mode">${preview ? '编辑' : '表格预览'}</button>` : ''}<button class="button secondary small" data-action="run-shotlist-check">重新检查</button><button class="button ${skipped ? 'secondary' : ''} small" data-action="${skipped ? 'enable-shotlist' : 'skip-shotlist'}">${skipped ? '启用分镜' : '跳过生成'}</button>`;
  } else {
    const preview = state.storyboardMode === 'preview';
    context = `${preview ? '大字预览' : '编辑'} · <span data-check-headline="storyboard">${documentCheckHeadline('storyboard')}</span>`;
    controls = `<button class="button secondary small" data-action="run-check">重新检查</button><button class="button secondary small" data-action="toggle-storyboard-mode">${preview ? '编辑' : '大字预览'}</button>`;
  }
  const actions = `<div class="editor-command-actions">${inlineDocumentFindControl(kind)}${controls}<button class="button quiet small" data-action="open-episode-find-replace" data-kind="${kind}">查找替换</button><button class="button quiet small" data-action="open-global-find-replace">全局替换</button><button class="button secondary small" data-view="generate">${kind === 'outline' ? '生成剧本' : '生成'}</button></div>`;
  return `<section class="editor-commandbar" data-editor-kind="${kind}" aria-label="当前文档工具"><div class="editor-command-context"><p${kind === 'shotlist' ? ' class="shotlist-toolbar-title"' : ''}>第 ${directorEpisodeSlots.label(project, project.currentEpisode)} 集 · ${context}</p>${window.DirectorEditorStats?.renderFooter(project[kind].content) || ''}</div>${folderDocumentBar(kind, actions)}</section>`;
}

function renderOutline() {
  const project = state.project;
  return `<section class="page editor-page workspace-page"><div class="editor-focus">${highlightedEditor('outline.content', project.outline.content, '填写本集剧情结构、关键转折和结尾钩子；保存后生成剧本会自动引用。')}</div></section>`;
}

function renderScript() {
  const project = state.project;
  return `<section class="page editor-page workspace-page"><div class="editor-focus">${state.scriptMode === 'read' ? `<article class="script-reader">${scriptReader(project.script.content)}</article>` : highlightedEditor('script.content', project.script.content, '请从上方选择本集剧本文件；修改后点击“保存”。')}</div></section>`;
}

let shotlistDurationCache = { key: '', presentation: null };
function shotlistDurationPresentation(content) {
  const key = `${state.project?.id || ''}|${state.project?.currentEpisode || ''}|${state.documentEditRevision || 0}:${String(content || '').length}`;
  if (shotlistDurationCache.key === key && shotlistDurationCache.presentation) return shotlistDurationCache.presentation;
  const summary = window.ShotlistDuration?.calculate(content) || { seconds: 0, shotCount: 0, method: 'none' };
  let presentation;
  if (summary.method === 'table' || summary.method === 'shots') {
    const formatted = window.ShotlistDuration.format(summary.seconds);
    presentation = {
      className: 'shotlist-duration calculated',
      text: `总时长 ${formatted} · ${summary.shotCount}镜`,
      title: `已逐镜计算：${summary.shotCount}个镜头，共${summary.seconds}秒`
    };
  } else if (summary.method === 'declared') {
    const formatted = window.ShotlistDuration.format(summary.seconds);
    presentation = {
      className: 'shotlist-duration declared',
      text: `标注时长 ${formatted}`,
      title: '暂未识别到逐镜时长，当前显示文档里的总时长标注。'
    };
  } else {
    presentation = {
      className: 'shotlist-duration empty',
      text: '总时长待识别',
      title: '请在分镜表的“时长”列填写秒数，软件会自动求和。'
    };
  }
  shotlistDurationCache = { key, presentation };
  return presentation;
}

function shotlistDurationBadge(content) {
  const presentation = shotlistDurationPresentation(content);
  return `<span class="${presentation.className}" data-shotlist-duration title="${escapeHTML(presentation.title)}" aria-live="polite">${escapeHTML(presentation.text)}</span>`;
}

function updateShotlistDurationDisplay(content) {
  const indicator = document.querySelector('[data-shotlist-duration]');
  if (!indicator) return;
  const presentation = shotlistDurationPresentation(content);
  indicator.className = presentation.className;
  indicator.textContent = presentation.text;
  indicator.title = presentation.title;
}

function renderShotlistTableCell(value) {
  return escapeHTML(String(value || ''))
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="semantic-manual-highlight">$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
}

function shotlistTablePreview(content) {
  const tables = window.ShotlistDuration?.parseTables(content) || [];
  if (!tables.length) {
    return `<article class="shotlist-table-reader"><div class="reader-empty"><div><strong>当前 MD 没有识别到标准分镜表格</strong><p>请切换到“编辑”，确认第一行是表头、第二行是 Markdown 分隔线。</p></div></div></article>`;
  }
  const rendered = tables.map((table, tableIndex) => `<table class="shotlist-markdown-table" aria-label="分镜表${tableIndex + 1}"><thead><tr>${table.headers.map((cell) => `<th scope="col">${renderShotlistTableCell(cell)}</th>`).join('')}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${renderShotlistTableCell(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  return `<article class="shotlist-table-reader">${rendered}</article>`;
}

function renderShotlist() {
  const project = state.project;
  const markdown = documentFormatForKind('shotlist') === 'md';
  const preview = markdown && state.shotlistMode !== 'edit';
  const body = preview
    ? shotlistTablePreview(project.shotlist.content)
    : highlightedEditor('shotlist.content', project.shotlist.content, '请从上方选择本集分镜文件；修改后点击“保存”。');
  return `<section class="page editor-page workspace-page"><div class="editor-focus">${body}</div>
  </section>`;
}

function renderShotlistChecks() {
  const verdict = state.shotlistVerdict;
  const problems = verdict?.problems || [];
  const warnings = verdict?.warnings || [];
  const stale = verdict && !checkIsFresh('shotlist');
  const status = stale ? 'pending' : verdict?.skipped ? 'info' : problems.length ? 'error' : warnings.length ? 'warning' : verdict ? 'pass' : '';
  const title = stale ? '修改后待检查' : verdict?.skipped ? '未执行检查' : problems.length ? `${problems.length} 个结构问题` : warnings.length ? `${warnings.length} 项待核对` : verdict ? '所选规则未发现问题' : '待检查';
  return `<section class="storyboard-check-pin ${status} sidebar-check-panel"><div class="storyboard-check-summary"><div class="storyboard-check-heading"><strong>分镜检查</strong><span class="badge ${status}">${title}</span></div><div class="storyboard-check-short">${verdict?.skipped ? '内容为空或所有检查项已关闭。' : '按所勾选的格式规则检查；不评判镜头创意和可拍性。'}</div></div><details class="storyboard-check-details" ${problems.length ? 'open' : ''}><summary>查看检查详情</summary><div class="storyboard-check-list">${[...problems.map((message) => `<article class="check error"><div class="check-color"></div><div class="check-content">${escapeHTML(message)}</div></article>`), ...warnings.map((message) => `<article class="check warning"><div class="check-color"></div><div class="check-content">${escapeHTML(message)}</div></article>`)].join('') || `<p class="hint">${verdict?.skipped || !verdict ? '尚未完成检查。' : '当前所选范围内未发现结构问题。'}</p>`}</div></details></section>`;
}

function renderCheckItems(checks, scope = 'storyboard') {
  return checks.map((item) => {
    const locateAction = scope === 'script' ? 'locate-script-check' : 'locate-check';
    const dismissAction = scope === 'script' ? 'dismiss-script-check' : 'dismiss-check';
    const dismiss = ['error', 'warning'].includes(item.level) ? `<button class="button quiet small check-dismiss" data-action="${dismissAction}" data-check-id="${escapeHTML(item.id)}">确认无误</button>` : '';
    const place = scope === 'script'
      ? (item.line ? `第${item.line}行` : '')
      : `${item.group ? `第${item.group}组` : ''}${item.shot ? `${item.group ? '<br>' : ''}镜头${item.shot}` : ''}`;
    const locationTitle = scope === 'script' ? '点击定位到剧本中的问题位置' : '点击定位到提示词中的问题位置';
    return `<article class="check ${item.level}"><div class="check-color"></div><div class="check-content"><div class="check-heading">${place ? `<button class="check-locate" data-action="${locateAction}" data-check-id="${escapeHTML(item.id)}" title="${locationTitle}">${escapeHTML(item.title)}</button>` : `<strong>${escapeHTML(item.title)}</strong>`}${dismiss}</div><details class="check-details"><summary>依据与详情</summary><div class="check-detail">${escapeHTML(item.detail)}${item.quote ? `<blockquote>${escapeHTML(item.quote)}</blockquote>` : ''}${item.basis ? `<p>依据：${escapeHTML(item.basis)}</p>` : ''}</div></details></div><div class="check-place">${place}</div></article>`;
  }).join('');
}

function renderStoryboardChecks(placement = 'inline') {
  const checks = state.project.storyboard.checks || [];
  const errors = checks.filter((item) => item.level === 'error').length;
  const warnings = checks.filter((item) => item.level === 'warning').length;
  const confirmed = hasConfirmedStoryboardChecks();
  const incomplete = checks.some(item => item.level === 'info');
  const stale = checks.length && !checkIsFresh('storyboard');
  const status = stale ? 'pending' : errors ? 'error' : warnings ? 'warning' : incomplete ? 'info' : (checks.length || confirmed) ? 'pass' : '';
  const statusText = documentCheckHeadline('storyboard');
  const priorityChecks = errors ? checks.filter((item) => item.level === 'error') : checks.filter((item) => item.level === 'warning');
  const shortText = stale ? '内容已变化，以下为上次检查结果。保存或点击“重新检查”后更新。' : incomplete ? checks.find(item => item.level === 'info').detail : priorityChecks.length ? [...new Set(priorityChecks.map((item) => item.title))].slice(0, 3).join(' · ') : (checks.length ? '本地规则未发现阻断问题，画面和表演仍需审阅。' : confirmed ? '本集问题已全部确认无误。' : '正在读取当前集提示词并检查。');
  const detailLabel = checks.length ? `展开 ${checks.length} 条检查详情` : '正在检查';
  const actionableCount = checks.filter((item) => ['error', 'warning'].includes(item.level)).length;
  const confirmAll = actionableCount ? `<button class="button quiet small" data-action="dismiss-all-checks">全部确认无误</button>` : '';
  return `<section class="storyboard-check-pin ${status} ${placement === 'sidebar' ? 'sidebar-check-panel' : ''}"><div class="storyboard-check-summary"><div class="storyboard-check-heading"><strong>提示词问题</strong><span class="badge ${status}">${statusText}</span>${confirmAll}</div><div class="storyboard-check-short">${escapeHTML(shortText)}</div></div><details class="storyboard-check-details" data-check-panel="storyboard" ${(state.storyboardChecksExpanded || !checks.length) ? 'open' : ''}><summary>${detailLabel}</summary><div class="storyboard-check-list">${checks.length ? renderCheckItems(checks) : '<p class="hint">检查内容只来自当前集的剧本、分镜和提示词文件。</p>'}</div></details></section>`;
}

function renderStoryboard() {
  const project = state.project;
  const preview = state.storyboardMode === 'preview';
  const body = preview
    ? `<article class="script-reader storyboard-reader">${storyboardReader(project.storyboard.content)}</article>`
    : highlightedEditor('storyboard.content', project.storyboard.content, '请从上方选择本集提示词文件；修改后点击“保存”。');
  return `<section class="page editor-page workspace-page"><div class="editor-focus">${body}</div></section>`;
}

function assetPreview(asset) {
  if (asset.type === 'image') return `<img src="${encodeURI(`file:///${asset.localPath.replace(/\\/g, '/')}`).replace(/#/g, '%23')}" alt="${escapeHTML(asset.name)}" />`;
  return '<span>音频参考</span>';
}

const assetCategoryMeta = {
  role: { label: '人物', folder: '01 人物' },
  scene: { label: '场景', folder: '02 场景' },
  prop: { label: '道具', folder: '03 道具' },
  voice: { label: '配音', folder: '04 配音' }
};

const assetPromptCategoryMeta = {
  role: { label: '人物', documentLabel: '角色资产提示词' },
  scene: { label: '场景', documentLabel: '场景资产提示词' },
  prop: { label: '道具', documentLabel: '道具资产提示词' }
};

function assetCategory(asset) {
  return assetCategoryMeta[asset?.category] ? asset.category : (asset?.type === 'audio' ? 'voice' : 'role');
}

function assetSearchText(entry) {
  return [entry?.name, entry?.variant, entry?.appliesTo, entry?.prompt, entry?.standardName, entry?.fileName]
    .filter(Boolean).join('\n').toLocaleLowerCase();
}

function assetEntriesForCurrentEpisode(category, library = state.assetPromptLibrary) {
  const promptEntries = library?.categories?.[category]?.entries || [];
  const episode = directorEpisodeSlots.baseNumber(state.project?.currentEpisode);
  const localEntries = (state.project?.assets || []).filter((asset) => assetCategory(asset) === category && asset.episodes?.includes(episode));
  return { promptEntries, localEntries };
}

function assetNamesForCurrentEpisode(category, library = state.assetPromptLibrary) {
  const { promptEntries, localEntries } = assetEntriesForCurrentEpisode(category, library);
  return [...new Set([
    ...promptEntries.map((item) => item.name),
    ...localEntries.map((item) => item.standardName || item.name)
  ].map((name) => String(name || '').trim()).filter(Boolean))];
}

function assetCategoryMatchesSearch(category, query) {
  if (!query) return true;
  const { promptEntries, localEntries } = assetEntriesForCurrentEpisode(category);
  return [...promptEntries, ...localEntries].some((item) => assetSearchText(item).includes(query));
}

function restoreAssetSearchFocus() {
  requestAnimationFrame(() => {
    const input = document.querySelector('[data-asset-find]');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function runAssetSearch(query) {
  state.assetSearchQuery = String(query || '');
  const needle = state.assetSearchQuery.trim().toLocaleLowerCase();
  if (needle && !assetCategoryMatchesSearch(state.assetFilter, needle)) {
    const matchingCategory = Object.keys(assetPromptCategoryMeta).find((category) => assetCategoryMatchesSearch(category, needle));
    if (matchingCategory) state.assetFilter = matchingCategory;
  }
  render();
  restoreAssetSearchFocus();
}

function episodeSummary(asset) {
  const episodes = [...new Set((asset.episodes || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  return episodes.length ? `出现：${episodes.map((episode) => `第${episode}集`).join('、')}` : '尚未在已识别的文本中引用';
}

function isInDedicatedRoleFolder(asset) {
  const normalized = String(asset.localPath || '').replace(/\\/g, '/');
  return /\/01 人物\/[^/]+\/[^/]+$/u.test(normalized);
}

function renderAssetCard(asset) {
  const category = assetCategory(asset);
  const dragAttributes = asset.type === 'image'
    ? `draggable="true" data-asset-drag-path="${inputValue(asset.localPath)}" title="按住图片拖到 Seedance 或其他软件中使用"`
    : '';
  return `<article class="asset-card">
    <div class="asset-preview ${asset.type === 'image' ? 'asset-preview-draggable' : ''}" ${dragAttributes}><span class="asset-kind semantic-${category}">${assetCategoryMeta[category].label}</span>${assetPreview(asset)}${asset.type === 'image' ? '<span class="asset-drag-note">按住图片拖出使用</span>' : ''}</div>
    <div class="asset-card-body">
      <div class="asset-card-head"><strong>${escapeHTML(asset.name || '未命名素材')}</strong><span>${asset.type === 'audio' ? '音频' : '图片'}</span></div>
      <div class="asset-standard">@${escapeHTML(asset.standardName?.trim() || '未设置标准名称')}</div>
      <div class="asset-episodes">${escapeHTML(episodeSummary(asset))}</div>
      <div class="asset-card-actions">${category === 'role' && !isInDedicatedRoleFolder(asset) ? `<button class="button quiet small" data-action="organize-role-asset" data-asset-id="${asset.id}">收纳到人物文件夹</button>` : ''}</div>
      <details class="asset-edit"><summary>编辑</summary>
        <div class="asset-edit-fields">
          <label>显示名称<input data-asset-id="${asset.id}" data-asset-field="name" value="${inputValue(asset.name)}" /></label>
          <label>分镜标准名称<input data-asset-id="${asset.id}" data-asset-field="standardName" value="${inputValue(asset.standardName)}" placeholder="不含 @，例如：阮念念" /></label>
          <label>素材设定 / 提示词<textarea data-asset-id="${asset.id}" data-asset-field="prompt" placeholder="外形、服装、镜头或音色特征…">${escapeHTML(asset.prompt)}</textarea></label>
        </div>
      </details>
    </div>
  </article>`;
}

function renderAssets() {
  const library = state.assetPromptLibrary;
  const category = assetPromptCategoryMeta[state.assetFilter] ? state.assetFilter : 'role';
  const categoryInfo = library?.categories?.[category] || { ...assetPromptCategoryMeta[category], fileName: '', entries: [] };
  const query = state.assetSearchQuery.trim().toLocaleLowerCase();
  const allEntries = categoryInfo.entries || [];
  const entries = query ? allEntries.filter((entry) => assetSearchText(entry).includes(query)) : allEntries;
  const tabs = Object.entries(assetPromptCategoryMeta).map(([key, meta]) => {
    const count = assetNamesForCurrentEpisode(key, library).length;
    return `<button class="asset-filter ${category === key ? 'active' : ''}" data-action="set-asset-filter" data-asset-filter="${key}">${meta.label}<span>${count}</span></button>`;
  }).join('');
  const overview = Object.entries(assetPromptCategoryMeta).map(([key, meta]) => {
    const names = assetNamesForCurrentEpisode(key, library);
    const visibleNames = query ? names.filter((name) => name.toLocaleLowerCase().includes(query)) : names;
    return `<button class="asset-episode-category ${category === key ? 'active' : ''}" data-action="set-asset-filter" data-asset-filter="${key}"><span class="asset-kind semantic-${key}">${meta.label}</span><strong>${visibleNames.length}</strong><small>${visibleNames.length ? escapeHTML(visibleNames.join(' · ')) : '本集未识别到'}</small></button>`;
  }).join('');
  const promptCards = entries.map((entry) => `<article class="asset-prompt-card">
    <div class="asset-prompt-card-head"><div><span class="asset-kind semantic-${category}">${assetPromptCategoryMeta[category].label}</span><h2>${escapeHTML(entry.name)}</h2></div><p>${escapeHTML(entry.variant || '当前集版本')}</p></div>
    <div class="asset-prompt-applies">${escapeHTML(entry.appliesTo || `适用：第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集`)}</div>
    <div class="asset-prompt-text">${escapeHTML(entry.prompt)}</div>
  </article>`).join('');
  const empty = library
    ? `<div class="empty asset-prompt-empty"><h2>${categoryInfo.fileName ? `第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集没有匹配的${assetPromptCategoryMeta[category].label}资产提示词` : `未找到${assetPromptCategoryMeta[category].documentLabel}文件`}</h2><p>${categoryInfo.fileName ? `已读取 ${categoryInfo.fileName}，仅展示标有当前集适用范围的内容。` : '请把对应的 TXT 放在项目的 06 资产文件夹中。'}</p></div>`
    : `<div class="empty asset-prompt-empty"><h2>正在读取本集资产提示词</h2><p>将从 06 资产中读取角色、场景、道具三份 TXT。</p></div>`;
  return `<section class="page asset-page"><div class="asset-toolbar"><div class="asset-title"><strong>素材提示词</strong><span>第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集 · 06 资产</span></div><div class="asset-toolbar-actions"><button class="button quiet small" data-action="refresh-asset-prompts">刷新</button></div></div>
    <div class="asset-episode-overview"><div class="asset-episode-overview-title"><strong>第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集素材</strong><span>人物、场景、道具仅统计当前集可用素材</span></div><div class="asset-episode-categories">${overview}</div></div>
    <div class="asset-filterbar"><div class="asset-filters">${tabs}</div><label class="asset-find"><input data-asset-find value="${inputValue(state.assetSearchQuery)}" autocomplete="off" placeholder="查找本集素材" /><span>${query ? `${entries.length}/${allEntries.length}` : `${allEntries.length}`}</span></label><div class="asset-prompt-source">${escapeHTML(categoryInfo.fileName || assetPromptCategoryMeta[category].documentLabel)}</div></div>
    ${entries.length ? `<div class="asset-prompt-list">${promptCards}</div>` : empty}
  ${htmlLibraryUI.renderCards()}</section>`;
}

function renderRules() {
  const project = state.project;
  const runner = project.chatGptRunner || { mode: 'chrome', tabId: '', port: 9222, replyMode: 'auto' };
  const chrome = state.chromeStatus;
  const availableTabs = chrome?.tabs || [];
  const documents = project.ruleDocuments || [];
  const scriptTemplate = currentPrompt('script');
  const boardTemplate = currentPrompt('storyboard');
  const groups = [
    ['script', '剧本生成规则', '这类规则会随每次剧本任务一并发给 ChatGPT。'],
    ['storyboard', 'Seedance 分镜规则', '这类规则会随每次分镜提示词任务一并发给 ChatGPT。'],
    ['shared', '项目记忆与通用规则', '这类规则会同时注入剧本与分镜任务。']
  ];
  return `<section class="page">
    <div class="rules-toolbar"><div class="rules-toolbar-title"><strong>规则与记忆</strong><span>07 AI规则与记忆 · 仅作用于之后发起的生成任务</span></div><div class="rules-toolbar-actions"><button class="button quiet small" data-action="open-global-find-replace">全局查找替换</button><button class="button small" data-action="save-rule-settings">保存规则与记忆</button></div></div>
    <article class="card rules-priority-card"><div class="card-title"><h2>执行优先级</h2><span class="badge">全任务</span></div><div class="field"><textarea data-bind="executionPriority" placeholder="写入剧本与提示词任务都要遵守的执行优先级…">${escapeHTML(project.executionPriority || defaultExecutionPriority)}</textarea></div></article>
    <div class="grid three" style="margin-top:16px">${groups.map(([category, title, note]) => { const docs = documents.filter((doc) => doc.category === category); return `<article class="card"><div class="card-title"><h2>${title}</h2><button class="button quiet small" data-action="import-rules" data-rule-category="${category}">导入文档</button></div><p class="hint">${note}</p><div class="rule"></div>${docs.length ? `<div class="version-list">${docs.map((doc) => `<label class="version"><input type="checkbox" data-rule-id="${doc.id}" ${doc.enabled !== false ? 'checked' : ''} style="margin-right:7px" /><span class="version-name" style="display:inline">${escapeHTML(doc.name)}</span><span class="version-time">${escapeHTML(doc.path)}</span></label>`).join('')}</div>` : `<p class="hint">尚未导入。可把已有 TXT、Markdown 或 Word 规则文件放入此类。</p>`}</article>`; }).join('')}</div>
    <div class="grid three" style="margin-top:16px"><article class="card"><div class="card-title"><h2>项目记忆</h2><span class="badge">全任务</span></div><div class="field"><textarea data-bind="memory.project" placeholder="世界观、年代、叙事视角、每集节奏、不可修改的设定…">${escapeHTML(project.memory?.project || '')}</textarea></div></article><article class="card"><div class="card-title"><h2>角色与素材记忆</h2><span class="badge">连续性</span></div><div class="field"><textarea data-bind="memory.characters" placeholder="角色标准名、关系、外形、服装、音色、场景和关键道具的固定设定…">${escapeHTML(project.memory?.characters || '')}</textarea></div></article><article class="card"><div class="card-title"><h2>剧情连续性记忆</h2><span class="badge">跨集</span></div><div class="field"><textarea data-bind="memory.continuity" placeholder="上集结尾、本集起点、已发生事件、未回收伏笔、禁止矛盾的剧情事实…">${escapeHTML(project.memory?.continuity || '')}</textarea></div></article></div>
    <article class="card" style="margin-top:16px"><div class="card-title"><h2>ChatGPT 运行方式</h2><span class="badge">当前聊天优先</span></div><div class="grid two"><div class="field"><label>运行方式</label><select data-bind="chatGptRunner.mode"><option value="chrome" ${runner.mode === 'chrome' ? 'selected' : ''}>使用我的 Chrome · 当前聊天</option><option value="embedded" ${runner.mode === 'embedded' ? 'selected' : ''}>软件内 ChatGPT（兼容模式）</option></select></div><div class="field"><label>单集最长等待官网回复</label><select data-bind="chatGptRunner.waitMinutes"><option value="30" ${Number(runner.waitMinutes) === 30 ? 'selected' : ''}>30 分钟</option><option value="50" ${Number(runner.waitMinutes) !== 30 ? 'selected' : ''}>50 分钟（默认）</option></select></div><div class="field"><label>默认回收结果</label><select data-bind="chatGptRunner.replyMode"><option value="auto" ${runner.replyMode === 'auto' ? 'selected' : ''}>自动识别（附件优先，正文兜底）</option><option value="attachment" ${runner.replyMode === 'attachment' ? 'selected' : ''}>只收 TXT 附件</option><option value="message" ${runner.replyMode === 'message' ? 'selected' : ''}>只收聊天正文</option></select></div>${runner.mode === 'embedded' ? `<div class="field"><label>剧本任务进入的项目</label><input data-bind="chatGptProjects.script" value="${inputValue(project.chatGptProjects?.script || '剧本工程')}" /></div><div class="field"><label>镜头计划与 Seedance 任务进入的项目</label><input data-bind="chatGptProjects.prompt" value="${inputValue(project.chatGptProjects?.prompt || '提示词工程')}" /></div>` : ''}</div>${runner.mode === 'chrome' ? `<div class="field" style="margin-top:12px"><label>要继续使用的 ChatGPT 当前聊天</label><select data-bind="chatGptRunner.tabId"><option value="">${availableTabs.length ? '自动选择第一个当前聊天' : '先点击“刷新当前聊天”'}</option>${availableTabs.map((tab) => `<option value="${escapeHTML(tab.id)}" ${String(runner.tabId) === String(tab.id) ? 'selected' : ''}>${escapeHTML(tab.title || tab.url)}</option>`).join('')}</select></div><div class="form-actions" style="margin-top:12px"><button class="button secondary" data-action="open-chrome-permission">① 打开 Chrome 授权</button><button class="button secondary" data-action="refresh-chrome-status">② 刷新当前聊天</button><button class="button quiet small" data-action="reset-chrome">连接卡住时重连</button><button class="button secondary" data-action="open-chatgpt">打开我的 ChatGPT</button></div><p class="hint" style="margin:12px 0 0">默认“自动识别”会优先保存 ChatGPT 返回的 TXT 附件；若本次仅在聊天框输出，将直接把聊天正文存成当前集 TXT，保存为当前选择的文件格式。单集审核和批量任务都可临时改为“只收附件”或“只收正文”。</p>${chrome ? `<div class="notice ${chrome.ok ? '' : 'danger-note'}" style="margin-top:10px">${chrome.ok ? `已连接到 Chrome，发现 ${chrome.tabs.length} 个 ChatGPT 当前聊天。` : escapeHTML(chrome.reason || 'Chrome 当前聊天尚未连接。')}</div>` : ''}` : `<p class="hint" style="margin:12px 0 0">兼容模式会为每项任务先回到填写的 ChatGPT 项目首页，再从项目内建立全新聊天；不会复用旧会话，也不会使用项目外的新聊天。默认“自动识别”仍会优先保存 TXT 附件，找不到时保存聊天正文。单集最长等待回复时间使用上方的 30 或 50 分钟设置。</p>`}</article>
    <div class="grid two" style="margin-top:16px"><article class="card"><div class="card-title"><h2>剧本任务主提示词</h2><button class="button quiet small" data-action="save-prompt-version" data-kind="script">保存为新版本</button></div><div class="hint" style="margin-bottom:8px">${escapeHTML(scriptTemplate?.name || '内置剧本模板')}</div><div class="field"><textarea class="prompt-editor" data-prompt-kind="script">${escapeHTML(scriptTemplate?.content || '')}</textarea></div></article><article class="card"><div class="card-title"><h2>Seedance 任务主提示词</h2><button class="button quiet small" data-action="save-prompt-version" data-kind="storyboard">保存为新版本</button></div><div class="hint" style="margin-bottom:8px">${escapeHTML(boardTemplate?.name || '内置 Seedance 模板')}</div><div class="field"><textarea class="prompt-editor" data-prompt-kind="storyboard">${escapeHTML(boardTemplate?.content || '')}</textarea></div></article></div>
    <div class="notice" style="margin-top:16px">“执行优先级”可在本页上方修改；修改后点击“保存规则与记忆”，它会写入项目规则文件，并自动用于之后的剧本与 Seedance 任务。主提示词仍使用各自的“保存为新版本”。</div>
  </section>`;
}

function renderAiDrawer() {
  const queue = state.project.queue || [];
  const usingChrome = (state.project.chatGptRunner?.mode || 'chrome') === 'chrome';
  const captureKind = state.view === 'storyboard' ? 'storyboard' : 'script';
  const captureLabel = captureKind === 'storyboard' ? 'Seedance 提示词' : '剧本';
  const taskActions = (task) => {
    const locked = ['自动执行中', '已保存'].includes(task.status);
    const canDownload = ['等待回复', '需人工发送', '读取失败'].includes(task.status);
    return `<div class="task-actions"><button class="button quiet small" data-action="open-task-review" data-task-id="${task.id}" ${locked ? 'disabled' : ''}>${task.status === '自动执行中' ? '执行中' : task.status === '已保存' ? '已保存' : '审核'}</button>${canDownload ? `<button class="button quiet small" data-action="capture-task" data-task-id="${task.id}">读取官网回复</button>` : ''}<button class="button quiet small danger" data-action="remove-task" data-task-id="${task.id}">删除</button></div>`;
  };
  return `<aside class="ai-drawer ${state.aiDrawerOpen ? 'open' : ''}">
    <div class="ai-drawer-head"><div><div class="eyebrow">CHATGPT WEB RUNNER</div><h2>AI 任务</h2></div><button class="modal-close" data-action="toggle-ai-drawer">×</button></div>
    <div class="ai-drawer-project">第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集 · ${state.project.targetDuration} 秒<br><span>${usingChrome ? '运行：我的 Chrome · 当前聊天（不新建聊天）' : `剧本 → ${escapeHTML(state.project.chatGptProjects?.script || '剧本工程')}<br>镜头 / Seedance → ${escapeHTML(state.project.chatGptProjects?.prompt || '提示词工程')}<br>每项任务均在指定项目内新建聊天`}<br>${state.project.ruleDocuments.filter((doc) => doc.enabled !== false).length} 份规则 + ${(state.project.referenceDocuments || []).filter((doc) => doc.enabled !== false).length} 份参照文档将自动注入并上传</span></div>
    <div class="drawer-actions"><button class="button" data-action="queue-script">单集剧本</button><button class="button secondary" data-action="queue-storyboard">单集提示词</button></div>
    <div class="drawer-actions" style="margin-top:8px"><button class="button" data-action="open-batch-script">批量剧本</button><button class="button secondary" data-action="open-batch-storyboard">批量提示词</button></div>
    <button class="button quiet small" style="width:100%;margin-top:8px" data-action="capture-current-attachment" data-kind="${captureKind}">读取当前集已生成的${captureLabel}回复</button>
    <p class="hint" style="margin:7px 0 0">此按钮不会发送新消息；按“默认回收结果”读取当前聊天的 TXT 附件或聊天正文，并保存到本集文件夹。</p>
    <p class="hint" style="margin:10px 0 0">批量任务会先让你逐集审阅完整发送内容；确认开始后，程序才会逐集处理并锁定主界面。${usingChrome ? ' 将复用你选定的当前 ChatGPT 聊天。' : ''}</p>
    <button class="button secondary" style="width:100%;margin-top:8px" data-action="open-chatgpt">${usingChrome ? '打开我的 Chrome' : '打开 ChatGPT 官网'}</button>
    <div class="rule"></div>
    <div class="card-title"><h3>当前任务队列</h3><span class="badge">${queue.length}</span></div>
    <div class="drawer-queue">${queue.length ? queue.slice().reverse().map((task) => `<article class="drawer-task"><div><strong>${escapeHTML(task.name)}</strong><small class="task-status ${statusClass(task.status)}">${escapeHTML(task.status)}</small></div><p>${escapeHTML(task.note || (task.kind === 'script' ? '将自动下载到 03 剧本。' : task.kind === 'storyboard' ? '将自动下载到 05 seedance提示词。' : '等待执行。'))}</p>${taskActions(task)}</article>`).join('') : `<p class="hint">从这里发起剧本或 Seedance 任务。每次执行前都会先显示完整发送内容供你审核。</p>`}</div>
    <div class="drawer-foot">网页要求登录、验证或页面结构变动时，程序会暂停并保留任务；手动处理后可读取对应 TXT 附件或聊天正文。</div>
  </aside>`;
}

// New file-first workflow.  This declaration intentionally supersedes the
// legacy drawer/rules renderer above while keeping old queued tasks readable
// for projects created before the workflow upgrade.
function renderGenerate() {
  const project = state.project;
  const mode = project.generationMode || 'api';
  const runner = project.chatGptRunner || { mode: 'chrome', replyMode: 'auto', waitMinutes: 50 };
  const chrome = state.chromeStatus;
  const tabs = chrome?.tabs || [];
  const modes = [
    ['api', 'API 接口', '选择服务商和模型，按项目文件直接生成。'],
    ['embedded', '软件内 ChatGPT', '沿用旧版内置任务。'],
    ['chrome', 'ChatGPT 网页', '沿用旧版 Chrome 网页任务。']
  ];
  const webSettings = `<article class="card generation-settings"><div class="card-title"><h2>${mode === 'chrome' ? '网页连接' : '内置任务'}</h2><span class="badge">旧版方式</span></div>
    <div class="grid two"><div class="field"><label>单步最长等待</label><select data-bind="chatGptRunner.waitMinutes"><option value="30" ${Number(runner.waitMinutes) === 30 ? 'selected' : ''}>30 分钟</option><option value="50" ${Number(runner.waitMinutes) !== 30 ? 'selected' : ''}>50 分钟</option></select></div>
    <div class="field"><label>回收结果</label><select data-bind="chatGptRunner.replyMode"><option value="auto" ${runner.replyMode === 'auto' ? 'selected' : ''}>自动识别（附件优先）</option><option value="attachment" ${runner.replyMode === 'attachment' ? 'selected' : ''}>只收 TXT 附件</option><option value="message" ${runner.replyMode === 'message' ? 'selected' : ''}>只收聊天正文</option></select></div>
    ${mode === 'chrome' ? `<div class="field wide"><label>ChatGPT 页面</label><select data-bind="chatGptRunner.tabId"><option value="">${tabs.length ? '自动选择第一个页面' : '请先连接 Chrome'}</option>${tabs.map((tab) => `<option value="${escapeHTML(tab.id)}" ${String(runner.tabId) === String(tab.id) ? 'selected' : ''}>${escapeHTML(tab.title || tab.url)}</option>`).join('')}</select></div>` : ''}</div>
    ${mode === 'chrome' ? `<div class="form-actions"><button class="button secondary" data-action="open-chrome-permission">Chrome 授权</button><button class="button secondary" data-action="refresh-chrome-status">连接并刷新</button><button class="button quiet small" data-action="reset-chrome">重连</button></div><p class="hint">${chrome ? chrome.ok ? `已连接，发现 ${chrome.tabs.length} 个 ChatGPT 页面。` : escapeHTML(chrome.reason || '') : '连接后选择网页。'}</p>` : '<p class="hint">任务在软件内的 ChatGPT 页面运行。</p>'}
    <div class="form-actions"><button class="button" data-action="open-workflow-review">生成当前集</button><button class="button secondary" data-action="open-workflow-batch">批量生成</button><button class="button quiet small" data-action="open-chatgpt">打开 ChatGPT</button><button class="button quiet small" data-action="save-rule-settings">保存设置</button></div>
  </article>`;
  return `<section class="page generation-page"><div class="page-heading"><div><div class="eyebrow">GENERATION</div><h1>生成</h1><p class="lead">第 ${directorEpisodeSlots.label(project, project.currentEpisode)} 集 · 选择方式，核对输入与模板后开始。</p></div><button class="button secondary" data-view="editor">进入编辑与检查</button></div>
    <div class="generation-modes" role="group" aria-label="生成方式">${modes.map(([id, label, note]) => `<label class="generation-mode ${mode === id ? 'selected' : ''}"><input type="radio" name="generation-mode" data-bind="generationMode" value="${id}" ${mode === id ? 'checked' : ''}><strong>${label}</strong><span>${note}</span></label>`).join('')}</div>
    ${mode === 'api' ? `<article class="card generation-start"><div><strong>开始生成</strong><p class="hint">首次使用请先填写并保存下方接口配置。运行前会显示输入与模板供核对。</p></div><div class="form-actions"><button class="button" data-action="ai-open-batch" data-kind="script" data-current="true">本集剧本</button><button class="button secondary" data-action="ai-open-batch" data-kind="pair" data-current="true">本集分镜与提示词</button><button class="button quiet" data-action="ai-open-batch" data-kind="pair">批量生成</button></div></article>${renderAiPanel(true)}` : webSettings}
    <div class="generation-footer"><button class="button secondary" data-view="rules">${mode === 'api' ? 'API 输入文件' : '工作流模板与规则'}</button><button class="button quiet" data-view="project">查看项目文件</button></div>
  </section>`;
}

function renderRules() {
  const project = state.project;
  if ((project.generationMode || 'api') === 'api') {
    const row = (label, doc, action, category, optional = false) => `<div class="api-input-file"><div><strong>${label}</strong><span>${doc ? escapeHTML(doc.name) : optional ? '未选择（可不选）' : '尚未选择'}</span></div><div class="form-actions"><button class="button quiet small" data-action="${action}" ${category ? `data-rule-category="${category}"` : ''}>${doc ? '更换' : '选择'}</button>${optional && doc ? '<button class="button quiet small" data-action="ai-clear-outline">清除</button>' : ''}</div></div>`;
    const scriptRule = aiChosenDocument('ruleDocuments', 'script');
    const shotRule = aiChosenDocument('ruleDocuments', 'storyboard');
    const promptRule = aiChosenDocument('ruleDocuments', 'shared');
    const outline = aiChosenDocument('referenceDocuments', 'script');
    return `<section class="page"><div class="page-heading"><div><div class="eyebrow">API INPUTS</div><h1>API 输入文件</h1><p class="lead">每条工作流只发送下面列出的文件和你当次手输的要求。</p></div><button class="button secondary" data-view="generate">返回生成</button></div>
      <div class="api-input-workflows">
        <article class="card"><h2>剧本生成</h2><p class="hint">1 份要求文件＋本集小说原文＋可选大纲＋我的要求。</p>${row('剧本要求文件', scriptRule, 'ai-replace-rule', 'script')}${row('大纲', outline, 'ai-replace-outline', '', true)}</article>
        <article class="card"><h2>分镜＋提示词</h2><p class="hint">2 份要求文件＋本集剧本＋我的要求。</p>${row('分镜要求文件', shotRule, 'ai-replace-rule', 'storyboard')}${row('提示词要求文件', promptRule, 'ai-replace-rule', 'shared')}</article>
      </div>
      <div style="margin-top:16px">${renderBuiltinTemplateLibrary()}</div>
    </section>`;
  }
  const runner = project.chatGptRunner || { mode: 'chrome', replyMode: 'auto', waitMinutes: 50 };
  const templates = normalizeWorkflowTemplates(project.workflowTemplates);
  const chrome = state.chromeStatus;
  const tabs = chrome?.tabs || [];
  const templateCard = (key, title, note) => {
    const item = templates[key];
    return `<article class="card"><div class="card-title"><h2>${title}</h2><button class="button quiet small" data-action="choose-workflow-template" data-template-key="${key}">更换文件</button></div><p class="hint">${note}</p><div class="path" style="font-size:12px;overflow-wrap:anywhere">${escapeHTML(item.path)}</div></article>`;
  };
  const documents = project.ruleDocuments || [];
  const group = (category, title) => {
    const entries = documents.filter((doc) => doc.category === category);
    return `<article class="card"><div class="card-title"><h2>${title}</h2><button class="button quiet small" data-action="import-rules" data-rule-category="${category}">导入</button></div>${entries.length ? `<div class="version-list">${entries.map((doc) => `<label class="version"><input type="checkbox" data-rule-id="${doc.id}" ${doc.enabled !== false ? 'checked' : ''} style="margin-right:7px"><span class="version-name" style="display:inline">${escapeHTML(doc.name)}</span></label>`).join('')}</div>` : '<p class="hint">尚未导入。</p>'}</article>`;
  };
  return `<section class="page">
    <div class="rules-toolbar"><div class="rules-toolbar-title"><strong>规则与设置</strong><span>模板、项目记忆与执行规则</span></div><div class="rules-toolbar-actions"><button class="button quiet small" data-action="open-global-find-replace">全局查找替换</button><button class="button small" data-action="save-rule-settings">保存</button></div></div>
    <article class="card" style="margin-top:16px"><div class="card-title"><h2>工作流模板文件</h2><span class="badge">本集任务依据</span></div><p class="hint">网页方式上传模板与本集文件；API 方式读取文件正文发送。提示词默认使用 30 秒版本。</p><div class="grid two" style="margin-top:12px">${templateCard('script', '① 原文 → 剧本', '小说原文与模板')}${templateCard('shotlist', '② 剧本 → 分镜', '剧本与模板')}${templateCard('prompt30', '③ 分镜 → 提示词（30 秒）', '默认版本')}${templateCard('prompt15', '③ 分镜 → 提示词（15 秒）', '可在执行审核时切换')}</div></article>
    <div style="margin-top:16px">${renderBuiltinTemplateLibrary()}</div>
    <article class="card rules-priority-card" style="margin-top:16px"><div class="card-title"><h2>执行优先级</h2></div><div class="field"><textarea data-bind="executionPriority">${escapeHTML(project.executionPriority || defaultExecutionPriority)}</textarea></div></article>
    <div class="grid three" style="margin-top:16px">${group('script', '剧本规则')}${group('storyboard', '分镜规则')}${group('shared', '通用规则')}</div>
    <div class="grid three" style="margin-top:16px"><article class="card"><div class="card-title"><h2>项目记忆</h2></div><textarea data-bind="memory.project">${escapeHTML(project.memory?.project || '')}</textarea></article><article class="card"><div class="card-title"><h2>角色与素材记忆</h2></div><textarea data-bind="memory.characters">${escapeHTML(project.memory?.characters || '')}</textarea></article><article class="card"><div class="card-title"><h2>剧情连续性记忆</h2></div><textarea data-bind="memory.continuity">${escapeHTML(project.memory?.continuity || '')}</textarea></article></div>
  </section>`;
}

function renderAiDrawer() {
  if (state.project.generationMode === 'api') {
    const runner = aiRunnerOf(state.project);
    const preset = aiPresetOf(runner.provider);
    return `<aside class="ai-drawer ${state.aiDrawerOpen ? 'open' : ''}">
      <div class="ai-drawer-head"><div><div class="eyebrow">API WORKFLOW</div><h2>生成</h2></div><button class="modal-close" data-action="toggle-ai-drawer">×</button></div>
      <div class="ai-drawer-project">第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集 · ${state.project.targetDuration} 秒<br><span>API · ${escapeHTML(preset.label)} · ${escapeHTML(runner.model || preset.models[0] || '未设置模型')}</span></div>
      <div class="drawer-actions"><button class="button" data-action="open-workflow-review">单集工作流</button><button class="button secondary" data-action="ai-open-batch" data-kind="pair">批量分镜＋提示词</button></div>
      <p class="hint" style="margin:10px 0 0">先核对本集输入与模板。生成后校验结构，再写入项目文件夹。</p>
      <button class="button secondary" style="width:100%;margin-top:8px" data-view="ai">设置服务商与模型</button>
      <div class="drawer-foot">剧本保存到 03 剧本；分镜保存到 04 分镜；提示词保存到 05 seedance提示词。</div>
    </aside>`;
  }
  const runner = state.project.chatGptRunner || {};
  const usingChrome = (runner.mode || 'chrome') === 'chrome';
  return `<aside class="ai-drawer ${state.aiDrawerOpen ? 'open' : ''}">
    <div class="ai-drawer-head"><div><div class="eyebrow">FILE WORKFLOW</div><h2>生成</h2></div><button class="modal-close" data-action="toggle-ai-drawer">×</button></div>
    <div class="ai-drawer-project">第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集 · ${state.project.targetDuration} 秒<br><span>${usingChrome ? '使用我的 Chrome：本集先新建一个普通聊天' : '兼容模式：本集先新建一个普通聊天'}<br>原文 → 剧本 → 分镜 → 提示词，每步独立聊天并保存恢复记录。</span></div>
    <div class="drawer-actions"><button class="button" data-action="open-workflow-review">单集工作流</button><button class="button secondary" data-action="open-workflow-batch">批量工作流</button></div>
    <p class="hint" style="margin:10px 0 0">开始前只弹出一次总审核：可选择步骤、修改各步发送语、核对真实上传文件。确认后不会逐步打断。</p>
    <button class="button secondary" style="width:100%;margin-top:8px" data-action="open-chatgpt">${usingChrome ? '打开我的 Chrome' : '打开 ChatGPT 官网'}</button>
    <div class="drawer-foot">剧本保存到 03 剧本；分镜保存到 04 分镜；提示词保存到 05 seedance提示词。日常只保存当前格式；需要 Word 时点击“导出 Word”。</div>
  </aside>`;
}

function renderQuality() {
  const checks = state.project.storyboard.checks || [];
  const errors = checks.filter((item) => item.level === 'error').length;
  const warnings = checks.filter((item) => item.level === 'warning').length;
  const confirmed = hasConfirmedStoryboardChecks();
  return `<section class="page"><div class="page-heading"><div><div class="eyebrow">RULE ENGINE</div><h1>分镜质检</h1><p class="lead">仅检查当前集：缺少 @ 引用、单镜头多人发声、口播时间不足、台词与剧本不一致、缺少人物台词。</p></div><div><button class="button" data-action="run-check">重新检查</button></div></div>
    <div class="grid three"><article class="card"><div class="card-kicker">阻断问题</div><div class="metric">${errors}</div><div class="metric-note">需要修改或确认无误</div></article><article class="card"><div class="card-kicker">风险提示</div><div class="metric">${warnings}</div><div class="metric-note">仅保留口播时长提醒</div></article><article class="card"><div class="card-kicker">检查范围</div><div class="metric">5</div><div class="metric-note">引用、发声、口播、台词</div></article></div>
    <div class="checks" style="margin-top:16px">${checks.length ? renderCheckItems(checks) : confirmed ? '<div class="empty"><h2>检查通过</h2><p>本集问题已全部确认无误。</p></div>' : `<div class="empty"><h2>尚未运行检查</h2><p>完成或粘贴分镜提示词后，点击“重新检查”。</p><button class="button" data-action="run-check">运行第一次质检</button></div>`}</div>
  </section>`;
}

function renderExport() {
  const project = state.project;
  return `<section class="page"><div class="page-heading"><div><div class="eyebrow">ARCHIVE & EXPORT</div><h1>导出与归档</h1><p class="lead">剧本与 Seedance 提示词严格分开存放。官网任务的自动结果与手动导出都写回你项目已有的对应目录。</p></div></div>
    <div class="grid two"><article class="card"><div class="card-kicker">03 剧本</div><h2>剧本交付</h2><p class="hint">日常只保存当前选择的文件格式，Word 按需导出。</p><div class="form-actions"><button class="button secondary" data-action="export" data-type="txt" data-target="script">导出 TXT</button><button class="button secondary" data-action="export" data-type="docx" data-target="script">导出 Word</button></div></article><article class="card"><div class="card-kicker">05 seedance提示词</div><h2>Seedance 提示词交付</h2><p class="hint">按当前格式保存，Word 需要时再导出。</p><div class="form-actions"><button class="button secondary" data-action="export" data-type="txt" data-target="storyboard">导出 TXT</button><button class="button secondary" data-action="export" data-type="docx" data-target="storyboard">导出 Word</button></div></article></div>
    <article class="card" style="margin-top:16px"><div class="card-title"><h2>当前项目目录映射</h2><span class="badge">按文件夹读写</span></div><div class="path">${escapeHTML(project.projectPath)}<br>├─ 00 小说原文　读取原文<br>├─ 03 剧本　保存 ChatGPT 剧本与 Word/TXT<br>├─ 04 分镜　保留分镜素材<br>├─ 05 seedance提示词　保存最终 Seedance 提示词<br>├─ 06 资产　保存参考图、音频与素材提示词<br>└─ 07 AI规则与记忆　保存并注入规则文档与跨集记忆</div></article>
  </section>`;
}

function taskName(kind) {
  if (kind === 'script') return `第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集 · 剧本生成`;
  if (kind === 'shotlist') return `第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集 · 镜头计划生成`;
  if (kind === 'storyboard') return `第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集 · Seedance 分镜生成`;
  return `第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集 · 自定义任务`;
}

async function addTask(kind, content = null) {
  const prompt = content || await window.directorApi.prepareTask(state.project, kind);
  const chatGptProject = kind === 'script'
    ? state.project.chatGptProjects?.script
    : (kind === 'shotlist' || kind === 'storyboard' ? state.project.chatGptProjects?.prompt : '');
  const task = { id: crypto.randomUUID(), name: taskName(kind), kind, chatGptProject, prompt, episodeNumber: Number(state.project.currentEpisode), targetSeconds: Number(state.project.targetDuration), replyMode: state.project.chatGptRunner?.replyMode || 'auto', status: '待审核', note: '请先审核完整发送内容。', createdAt: new Date().toISOString() };
  state.project.queue = [...(state.project.queue || []), task];
  markDirty();
  return task;
}

async function discardRevisions(kind) {
  const title = kind === 'script' ? '剧本' : kind === 'shotlist' ? '分镜计划' : 'Seedance 提示词';
  state.actionDialog = {
    type: 'confirm',
    action: 'discard-revisions',
    kind,
    title: `删除第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集修改稿`,
    message: `将删除本集全部“（改N）”和旧自动归档的${title}文件；原版“${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集”会保留。`,
    confirmLabel: '删除修改稿',
    danger: true
  };
  render();
}

async function executeDiscardRevisions(kind) {
  const count = await window.directorApi.discardEpisodeRevisions(state.project, kind);
  showToast(count ? `已删除 ${count} 个不合格修改稿文件。` : '没有找到可删除的修改稿文件。');
}

async function finalizeEpisode(kind) {
  const content = state.project[kind]?.content?.trim();
  if (!content) return showToast('当前内容为空，无法定稿替换。');
  const title = kind === 'script' ? '剧本' : kind === 'shotlist' ? '分镜计划' : 'Seedance 提示词';
  const stem = `${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集`;
  state.actionDialog = {
    type: 'confirm',
    action: 'finalize-episode',
    kind,
    title: `定稿替换“${stem}”`,
    message: `将当前${title}保存为“${stem}.txt”和“${stem}.docx”，并删除该集全部“（改N）”及旧自动归档文件。`,
    confirmLabel: '确认定稿替换'
  };
  render();
}

async function executeFinalizeEpisode(kind) {
  const content = state.project[kind]?.content?.trim();
  if (!content) return showToast('当前内容为空，无法定稿替换。');
  const result = await window.directorApi.finalizeEpisodeOutput(state.project, kind);
  state.project[kind].versions = [{ id: crypto.randomUUID(), name: result.stem, content, createdAt: new Date().toISOString() }];
  state.project[kind].updatedAt = new Date().toISOString();
  syncActiveEpisode();
  markDirty();
  await saveProject();
  showToast(`已定稿：已更新 ${result.stem}.txt 与 ${result.stem}.docx。`);
}

function openPromptVersionDialog(kind) {
  const textarea = document.querySelector(`[data-prompt-kind="${kind}"]`);
  const content = textarea?.value.trim();
  if (!content) return showToast('提示词内容不能为空。');
  state.actionDialog = {
    type: 'prompt-version',
    kind,
    content,
    title: kind === 'script' ? '保存剧本主提示词' : '保存 Seedance 主提示词',
    defaultName: `${kind === 'script' ? '剧本模板' : 'Seedance 规范'} v${state.project.promptSets[kind].length + 1}.0`
  };
  render();
}

async function savePromptVersion(kind, name, content) {
  const saved = await window.directorApi.savePromptTemplate(state.project, kind, name, content);
  const versions = state.project.promptSets[kind];
  const existingIndex = versions.findIndex((item) => item.name.trim() === name.trim());
  const nextVersion = existingIndex >= 0
    ? { ...versions[existingIndex], content, path: saved.path, createdAt: new Date().toISOString() }
    : { id: crypto.randomUUID(), name, content, path: saved.path, createdAt: new Date().toISOString() };
  if (existingIndex >= 0) versions.splice(existingIndex, 1);
  versions.push(nextVersion);
  await saveProject({ renderAfter: false });
  render();
  showToast(`已保存到规则文件夹：${saved.name}`);
}

async function saveRuleSettings() {
  const saved = await window.directorApi.saveRuleSettings(state.project);
  await saveProject({ renderAfter: false });
  render();
  showToast(`规则与记忆已保存：${saved.name}`);
}

async function runScriptCheck({ silent = false, preserveViewport = false } = {}) {
  cancelScheduledEpisodeCheck();
  const checkingProject = state.project;
  const checkingEpisode = Number(state.project.currentEpisode);
  const checkingContent = state.project.script.content, checkingSource = state.project.source.content;
  const policyFingerprint = currentScriptCheckFingerprint();
  const checks = await window.directorApi.checkScriptDialogues(checkingContent, checkingSource, localCheckPolicy());
  if (state.project !== checkingProject || Number(state.project.currentEpisode) !== checkingEpisode) return;
  if(currentScriptCheckFingerprint() !== policyFingerprint)return;
  state.locatedScriptCheckId = null;
  state.project.script.checks = filterConfirmedScriptChecks(checks);
  state.checkCache.script = currentScriptCheckFingerprint();
  syncActiveEpisode(['script']);
  if (!silent) markDirty();
  updateCheckPanels();
  const errors = state.project.script.checks.filter((item) => item.level === 'error').length;
  if (!silent) showToast('本地检查完成：' + documentCheckHeadline('script') + '。');
}

async function runCheck({ silent = false, preserveViewport = false } = {}) {
  cancelScheduledEpisodeCheck();
  const checkingProject = state.project;
  const checkingEpisode = Number(state.project.currentEpisode);
  const checkingContent=state.project.storyboard.content,checkingScript=state.project.script.content,checkingShotlist=state.project.shotlist.content;
  const policyFingerprint = currentCheckFingerprint();
  const checks = await window.directorApi.checkStoryboard(checkingContent,checkingScript,checkingShotlist,localCheckPolicy());
  if (state.project !== checkingProject || Number(state.project.currentEpisode) !== checkingEpisode) return;
  if(currentCheckFingerprint() !== policyFingerprint)return;
  state.locatedCheckId = null;
  state.project.storyboard.checks = filterConfirmedStoryboardChecks(checks);
  state.checkCache.storyboard = currentCheckFingerprint();
  if (activeEpisode() && state.project.storyboard.checks.length && state.project.storyboard.checks.every((item) => !['error', 'info'].includes(item.level))) activeEpisode().status = '质检通过';
  syncActiveEpisode(['storyboard']);
  if (!silent) markDirty();
  updateCheckPanels();
  const errors = state.project.storyboard.checks.filter((item) => item.level === 'error').length;
  if (!silent) showToast(errors ? `检查完成：发现 ${errors} 个阻断问题。` : '检查完成：未发现阻断问题。');
}

async function runShotlistCheck({ silent = false, preserveViewport = false } = {}) {
  cancelScheduledEpisodeCheck();
  const checkingProject = state.project;
  const checkingEpisode = Number(state.project.currentEpisode);
  const checkingContent=state.project.shotlist.content;
  const policyFingerprint = currentShotlistCheckFingerprint();
  const selected = localCheckPolicy().shotlist;
  const verdict = Object.values(selected).some(Boolean) && checkingContent.trim()
    ? await window.directorApi.aiValidate('shotlist', checkingContent, { ...state.project.validationChecks, ...selected })
    : { problems: [], warnings: [], skipped: true };
  if (state.project !== checkingProject || Number(state.project.currentEpisode) !== checkingEpisode) return;
  if(currentShotlistCheckFingerprint() !== policyFingerprint)return;
  state.shotlistVerdict = verdict;
  state.checkCache.shotlist = currentShotlistCheckFingerprint();
  updateCheckPanels();
  if (!silent) showToast(verdict.skipped ? '未执行检查：内容为空或所有检查项已关闭。' : verdict.problems.length ? `分镜检查发现 ${verdict.problems.length} 个结构问题。` : '所选分镜结构检查完成。');
}

function updateCheckPanels() {
  const slot=document.querySelector('.sidebar-check-slot');
  if(slot)slot.innerHTML=renderLocalCheckContext(state.view)+(state.view==='script'?renderScriptChecks('sidebar'):state.view==='shotlist'?renderShotlistChecks():renderStoryboardChecks('sidebar'));
  document.querySelectorAll('[data-check-headline]').forEach(element => { element.textContent = documentCheckHeadline(element.dataset.checkHeadline); });
  refreshHighlightedEditors();
  refreshEditorStats();
}

function documentCheckHeadline(kind) {
  const checks = state.project?.[kind]?.checks || [];
  if (!checkIsFresh(kind)) return checks.length ? '修改后待检查' : '待检查';
  const errors = checks.filter(item => item.level === 'error').length;
  const warnings = checks.filter(item => item.level === 'warning').length;
  const incomplete = checks.some(item => item.level === 'info');
  return errors ? `${errors} 项不符合规则${incomplete ? ' · 部分未检查' : ''}` : warnings ? `${warnings} 项待核对${incomplete ? ' · 部分未检查' : ''}` : incomplete ? '部分项目未检查' : '所选规则未发现问题';
}

function issueLineIndex(issue, lines) {
  const anchor = issueAnchor(issue);
  const predicate = anchor.type === 'shot'
    ? (line) => {
      const shot = line.match(/镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[：:]/);
      return Boolean(shot && shot[1].replace(/\s+/g, '') === anchor.value);
    }
    : anchor.type === 'group'
      ? (line) => new RegExp(`第\\s*${anchor.value}\\s*组`).test(line)
      : anchor.type === 'reference'
        ? (line) => /参考素材\s*[：:]/.test(line)
        : (line) => /分镜序列\s*[：:]/.test(line);
  const range = groupLineRange(lines, issue?.group);
  const localIndex = lines.slice(range.start, range.end).findIndex(predicate);
  if (localIndex >= 0) return range.start + localIndex;
  const index = lines.findIndex(predicate);
  return index >= 0 ? index : Math.max(0, range.start);
}

function locateStoryboardCheck(checkId) {
  const issue = state.project?.storyboard?.checks?.find((item) => item.id === checkId);
  if (!issue) return;
  state.locatedCheckId = checkId;
  state.storyboardChecksExpanded = true;
  state.storyboardMode = 'edit';
  state.view = 'storyboard';
  render();
  requestAnimationFrame(() => {
    const textarea = document.querySelector('textarea[data-bind="storyboard.content"]');
    if (!textarea) return;
    refreshHighlightedEditors();
    const lines = textarea.value.split(/\r?\n/);
    const lineIndex = storyboardIssueLineIndexes(issue, lines)[0];
    const lineElement = document.querySelector(`.highlight-line[data-line-index="${lineIndex}"]`);
    const lineStarts = [0];
    for (const match of textarea.value.matchAll(/\r?\n/g)) lineStarts.push(match.index + match[0].length);
    const caret = lineStarts[lineIndex] || 0;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    if (lineElement) textarea.scrollTop = Math.max(0, lineElement.offsetTop - (textarea.clientHeight * 0.28));
    updateHighlightedEditor(textarea);
  });
  showToast(`已定位：${issue.title}`);
}

function locateScriptCheck(checkId) {
  const issue = state.project?.script?.checks?.find((item) => item.id === checkId);
  if (!issue) return;
  state.locatedScriptCheckId = checkId;
  state.scriptChecksExpanded = true;
  state.scriptMode = 'edit';
  state.view = 'script';
  render();
  requestAnimationFrame(() => {
    const textarea = document.querySelector('textarea[data-bind="script.content"]');
    if (!textarea) return;
    refreshHighlightedEditors();
    const lineIndex = Math.max(0, Number(issue.line || 1) - 1);
    const lineElement = document.querySelector(`.highlight-line[data-line-index="${lineIndex}"]`);
    const lineStarts = [0];
    for (const match of textarea.value.matchAll(/\r?\n/g)) lineStarts.push(match.index + match[0].length);
    const caret = lineStarts[lineIndex] || 0;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    if (lineElement) textarea.scrollTop = Math.max(0, lineElement.offsetTop - (textarea.clientHeight * 0.28));
    updateHighlightedEditor(textarea);
  });
  showToast(`已定位：${issue.title}`);
}

async function dismissStoryboardCheck(checkId) {
  const checks = state.project?.storyboard?.checks || [];
  const confirmed = checks.find((item) => item.id === checkId);
  if (!confirmed) return;
  if (state.locatedCheckId === checkId) state.locatedCheckId = null;
  const fingerprint = currentCheckFingerprint();
  const signature = storyboardCheckSignature(confirmed);
  const history = state.project.storyboard.confirmedChecks || [];
  state.project.storyboard.confirmedChecks = [
    ...history.filter((item) => item.fingerprint !== fingerprint || item.signature !== signature),
    { fingerprint, signature, confirmedAt: new Date().toISOString() }
  ];
  state.project.storyboard.checks = checks.filter((item) => item.id !== checkId);
  syncActiveEpisode();
  preserveViewportForNextRender();
  await saveProject({ renderAfter: false });
  render();
  showToast('已确认无误；本集相关文件未改变时，此问题不会再重复出现。');
}

async function dismissScriptCheck(checkId) {
  const checks = state.project?.script?.checks || [];
  const confirmed = checks.find((item) => item.id === checkId);
  if (!confirmed) return;
  if (state.locatedScriptCheckId === checkId) state.locatedScriptCheckId = null;
  const fingerprint = currentScriptCheckFingerprint();
  const signature = scriptCheckSignature(confirmed);
  const history = state.project.script.confirmedChecks || [];
  state.project.script.confirmedChecks = [
    ...history.filter((item) => item.fingerprint !== fingerprint || item.signature !== signature),
    { fingerprint, signature, confirmedAt: new Date().toISOString() }
  ];
  state.project.script.checks = checks.filter((item) => item.id !== checkId);
  syncActiveEpisode();
  preserveViewportForNextRender();
  await saveProject({ renderAfter: false });
  render();
  showToast('已确认无误；原文和剧本未改变时，此问题不会再重复出现。');
}

async function dismissAllStoryboardChecks() {
  const checks = state.project?.storyboard?.checks || [];
  const confirmed = checks.filter((item) => ['error', 'warning'].includes(item.level));
  if (!confirmed.length) return;
  const fingerprint = currentCheckFingerprint();
  const signatures = new Set(confirmed.map(storyboardCheckSignature));
  const history = state.project.storyboard.confirmedChecks || [];
  state.project.storyboard.confirmedChecks = [
    ...history.filter((item) => item.fingerprint !== fingerprint || !signatures.has(item.signature)),
    ...[...signatures].map((signature) => ({ fingerprint, signature, confirmedAt: new Date().toISOString() }))
  ];
  state.locatedCheckId = null;
  state.project.storyboard.checks = checks.filter((item) => !['error', 'warning'].includes(item.level));
  if (activeEpisode() && !state.project.storyboard.checks.some(item => item.level === 'info')) activeEpisode().status = '质检通过';
  syncActiveEpisode();
  preserveViewportForNextRender();
  await saveProject({ renderAfter: false });
  render();
  showToast(`已确认本集 ${confirmed.length} 条待核对项；未执行的检查仍保留。`);
}

async function dismissAllScriptChecks() {
  const checks = state.project?.script?.checks || [];
  const confirmed = checks.filter((item) => ['error', 'warning'].includes(item.level));
  if (!confirmed.length) return;
  const fingerprint = currentScriptCheckFingerprint();
  const signatures = new Set(confirmed.map(scriptCheckSignature));
  const history = state.project.script.confirmedChecks || [];
  state.project.script.confirmedChecks = [
    ...history.filter((item) => item.fingerprint !== fingerprint || !signatures.has(item.signature)),
    ...[...signatures].map((signature) => ({ fingerprint, signature, confirmedAt: new Date().toISOString() }))
  ];
  state.locatedScriptCheckId = null;
  state.project.script.checks = checks.filter((item) => !['error', 'warning'].includes(item.level));
  syncActiveEpisode();
  preserveViewportForNextRender();
  await saveProject({ renderAfter: false });
  render();
  showToast(`已确认本集 ${confirmed.length} 条待核对项；未执行的检查仍保留。`);
}

async function saveProject({ renderAfter = true, preserveViewport = true, deferRemote = false } = {}) {
  if (!state.project) return;
  const project = state.project;
  return projectSaveQueue.run(project.projectPath, async () => {
    if (state.project !== project) return false;
    if (renderAfter && preserveViewport) preserveViewportForNextRender();
    syncActiveEpisode();
    const revision = state.changeRevision;
    const saved = await window.directorApi.saveProject(project, { deferRemote });
    if (state.project !== project) return false;
    // The response is a snapshot taken before I/O. Replacing the live object
    // would erase text and settings entered while the save was in progress.
    project.updatedAt = saved.updatedAt;
    state.projects = state.projects.map(item => item.id === project.id ? project : item);
    if (state.changeRevision === revision) state.dirty = dirtyDocumentKinds().length > 0;
    updateSaveIndicators();
    if (renderAfter) render();
    if (renderAfter) showToast(state.dirty ? '已保存此前修改；仍有新修改待保存。' : '项目已保存到项目文件夹。');
    return true;
  });
}

async function importSource() {
  const source = await window.directorApi.importSource(state.project);
  if (!source) return;
  applyOpenedDocument('source', source);
  appendFolderFile('source', source);
  markDirty();
  render();
  showToast(`已导入 ${source.name}`);
}

function contentForKind(kind) {
  return kind === 'source' ? state.project.source.content : state.project[kind].content;
}

function applyOpenedDocument(kind, document) {
  state.workspaceVersions[kind] = { projectPath: state.project.projectPath, episode: state.project.currentEpisode, path: document.path, version: document.workspaceVersion };
  state.project.activeFiles[kind] = document.path;
  if (kind === 'source') {
    state.project.source = { ...state.project.source, name: document.name, content: document.content, updatedAt: document.updatedAt };
    if (activeEpisode()) activeEpisode().sourceBinding = document.path;
    state.checkCache.script = '';
  } else {
    state.project[kind].content = document.content;
    state.project[kind].updatedAt = document.updatedAt;
  }
  clearDocumentDirty(kind);
}

function appendFolderFile(kind, document) {
  if (kind === 'source') {
    const files = state.project.source.files || [];
    if (!files.some((file) => file.path === document.path)) files.unshift({ name: document.name, path: document.path, modifiedAt: document.updatedAt });
    return;
  }
  const key = kind === 'outline' ? 'outline' : kind === 'script' ? 'script' : kind === 'shotlist' ? 'storyboard' : 'seedance';
  state.project.availableFiles = state.project.availableFiles || {};
  const files = state.project.availableFiles[key] || [];
  if (!files.some((file) => file.path === document.path)) files.unshift({ name: document.name, path: document.path, modifiedAt: document.updatedAt });
  state.project.availableFiles[key] = files;
}

async function openFolderDocument(kind, filePath) {
  if (!filePath) return;
  const fileEpisode = episodeNumberFromFileName(filePath.split(/[\\/]/).at(-1));
  if (!['source', 'outline'].includes(kind) && ((!fileEpisode && directorEpisodeSlots.partForKey(state.project, state.project.currentEpisode) === '下')
      || fileEpisode && (fileEpisode !== directorEpisodeSlots.baseNumber(state.project.currentEpisode)
      || !directorEpisodeSlots.matchingPart(state.project, state.project.currentEpisode, filePath)))) {
    render();
    return showToast(`当前是第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集；请先从上方集数导航切换到对应分段。`);
  }
  if (state.documentDirty[kind]) {
    if (!await window.directorConfirm('当前' + documentKindLabel(kind) + '有未保存修改，保存后再读取所选文件？', { confirmLabel: '保存并读取' })) return;
    await saveFolderDocument(kind, { preserveViewport: true });
  }
  const openingProject = state.project, openingEpisode = state.project.currentEpisode;
  const openingRevision = state.documentEditRevision || 0;
  const document = await window.directorApi.openDocumentFile(openingProject, kind, filePath);
  if (state.project !== openingProject || state.project.currentEpisode !== openingEpisode || (state.documentEditRevision || 0) !== openingRevision) return showToast('读取期间页面或编辑内容发生变化，已保留当前内容。');
  if (state.documentFindLocation?.kind === kind) state.documentFindLocation = null;
  if (state.documentFindQuery?.[kind] !== undefined) state.documentFindQuery[kind] = '';
  if (state.documentFindActiveIndex?.[kind] !== undefined) state.documentFindActiveIndex[kind] = 0;
  applyOpenedDocument(kind, document);
  if (kind !== 'source') syncActiveEpisode();
  markDirty();
  render();
  if (localCheckPolicy().automatic && kind === 'script' && state.view === 'script') await runScriptCheck({ silent: true });
  if (localCheckPolicy().automatic && kind === 'storyboard' && state.view === 'storyboard') await runCheck({ silent: true });
  showToast(`已从文件夹读取 ${document.name}`);
}

async function switchDocumentFormat(kind, nextFormat) {
  if (!state.project || !Object.prototype.hasOwnProperty.call(documentFormatDefaults, kind)) return;
  const format = ['txt', 'md', 'docx'].includes(nextFormat) ? nextFormat : documentFormatDefaults[kind];
  const previousFormat = documentFormatForKind(kind);
  if (format === previousFormat) return;
  if (state.documentDirty?.[kind]) {
    const shouldSave = await window.directorConfirm(`当前${documentKindLabel(kind)}有未保存修改。\n\n先按 ${documentFormatLabel(previousFormat)} 保存，再切换到 ${documentFormatLabel(format)}；取消则保持当前格式。`);
    if (!shouldSave) {
      render();
      return;
    }
    await saveFolderDocument(kind, { preserveViewport: true });
  }

  const previousPath = state.project.activeFiles?.[kind] || '';
  const previousStem = previousPath.split(/[\\/]/).at(-1)?.replace(/\.(?:txt|md|markdown|docx)$/i, '') || '';
  state.project.documentFormats = normalizeDocumentFormats({ ...state.project.documentFormats, [kind]: format });
  if (kind === 'shotlist') state.shotlistMode = format === 'md' ? 'preview' : 'edit';
  const files = folderFilesForKind(kind, format);
  const preferred = files.find((file) => file.name?.replace(/\.(?:txt|md|markdown|docx)$/i, '') === previousStem) || files[0] || null;

  if (preferred) {
    const document = await window.directorApi.openDocumentFile(state.project, kind, preferred.path);
    applyOpenedDocument(kind, document);
    if (kind !== 'source') syncActiveEpisode();
  } else {
    state.project.activeFiles[kind] = kind === 'source' ? previousPath : '';
    if (contentForKind(kind)?.trim()) state.documentDirty[kind] = true;
  }
  markDirty();
  await saveProject({ renderAfter: false });
  render();
  if (preferred && kind === 'script') await runScriptCheck({ silent: true });
  if (preferred && kind === 'storyboard') await runCheck({ silent: true });
  showToast(preferred
    ? `已切换为 ${documentFormatLabel(format)}，并读取 ${preferred.name}`
    : `已切换为 ${documentFormatLabel(format)}；当前目录没有该格式，点击“保存”即可创建。`);
}

async function saveFolderDocument(kind, { preserveViewport = true } = {}) {
  if (!state.project) return false;
  const project = state.project;
  const episode = Number(project.currentEpisode);
  const key = [project.projectPath, episode, kind].join('|');
  return documentSaveQueue.run(key, async () => {
    if (state.project !== project || Number(project.currentEpisode) !== episode) return false;
    const startedAt = performance.now();
    const revision = state.documentRevisions[kind] || 0;
    const previousContext = viewportContextKey();
    const content = contentForKind(kind);
    state.savingDocuments.set(key, { project, episode, kind });
    delete state.saveErrors[kind];
    updateSaveIndicators();
    try {
  if (preserveViewport) preserveViewportForNextRender();
  const activePath = state.project.activeFiles?.[kind] || '';
  const activeEpisode = episodeNumberFromFileName(activePath.split(/[\\/]/).at(-1));
  const safeActivePath = kind === 'outline' || (!activeEpisode && (kind === 'source' || directorEpisodeSlots.partForKey(state.project, state.project.currentEpisode) !== '下'))
    || (activeEpisode === directorEpisodeSlots.baseNumber(state.project.currentEpisode)
    && directorEpisodeSlots.matchingPart(state.project, state.project.currentEpisode, activePath, kind === 'source')) ? activePath : '';
  const knownVersion = state.workspaceVersions[kind];
  const matchesVersion = projectPathKey(knownVersion?.projectPath) === projectPathKey(project.projectPath)
    && (knownVersion?.path ? projectPathKey(knownVersion.path) === projectPathKey(safeActivePath) && fileMatchesDocumentFormat(safeActivePath, documentFormatForKind(kind)) : Number(knownVersion?.episode) === episode);
  const document = await window.directorApi.saveDocumentFile(project, kind, content, safeActivePath, matchesVersion ? knownVersion.version : undefined);
  // The main process already read back the committed file. Reuse that result
  // instead of making another shared-drive round trip with the whole project.
  const persistedDocument = document;
  const fileSavedAt = performance.now();
  if (state.project !== project || Number(project.currentEpisode) !== episode) return false;
  const hasNewEdits = (state.documentRevisions[kind] || 0) !== revision;
  if (!hasNewEdits) applyOpenedDocument(kind, persistedDocument);
  else {
    // Keep the live draft, but remember the newly created file for the next
    // save. Do not reset its dirty flag or its native undo/selection state.
    project.activeFiles[kind] = document.path;
    project[kind].updatedAt = persistedDocument.updatedAt;
    state.workspaceVersions[kind] = { projectPath: project.projectPath, episode, path: document.path, version: persistedDocument.workspaceVersion };
    if (kind === 'source') project.source.name = document.name;
  }
  if (state.renderedContextKey === previousContext && currentDocumentKind() === kind) {
    const nextContext = viewportContextKey();
    state.renderedContextKey = nextContext;
    window.document.querySelectorAll('[data-bind]').forEach(control => {
      if (control.dataset.editorContext === previousContext) control.dataset.editorContext = nextContext;
      if (composingInputOwners.get(control) === previousContext) composingInputOwners.set(control, nextContext);
    });
  }
  if (preserveViewport && state.pendingViewport) {
    state.pendingViewport.key = viewportContextKey();
    state.viewports.set(state.pendingViewport.key, state.pendingViewport);
  }
  appendFolderFile(kind, document);
  if (kind !== 'source') syncActiveEpisode();
  if (!hasNewEdits) clearDocumentDirty(kind);
  await saveProject({ renderAfter: false, deferRemote: true });
  if (state.project !== project || Number(project.currentEpisode) !== episode) return false;
  if (preserveViewport) state.pendingViewport = { key: viewportContextKey(), ...captureVisibleViewport() };
  render();
  window.directorLastSaveTiming = { kind, episode, fileMs: Math.round(fileSavedAt - startedAt),
    totalMs: Math.round(performance.now() - startedAt) };
  // Checks update the visible document after the durable save has completed.
  // Other document checks remain stale until their page is opened.
  scheduleEpisodeChecks(project, episode, state.episodeLoadToken);
  showToast(state.documentDirty[kind] ? '已保存此前内容；你刚输入的新修改已保留，请继续保存。' : `已保存：${document.name}`);
  return true;
    } catch (error) {
      if (state.project === project && Number(project.currentEpisode) === episode) {
        state.documentDirty[kind] = true;
        state.saveErrors[kind] = error.message || String(error);
        state.dirty = true;
      }
      throw error;
    } finally {
      state.savingDocuments.delete(key);
      updateSaveIndicators();
    }
  });
}

function replacementCount(content, needle) {
  if (!needle) return 0;
  return String(content || '').split(needle).length - 1;
}

function documentKindLabel(kind) {
  return kind === 'source' ? '原文' : kind === 'outline' ? '大纲' : kind === 'script' ? '剧本' : kind === 'shotlist' ? '分镜' : 'Seedance 提示词';
}

function openEpisodeFindReplace(kind) {
  state.actionDialog = {
    type: 'find-replace',
    scope: 'episode',
    kind,
    title: '第 ' + state.project.currentEpisode + ' 集查找替换',
    confirmLabel: '替换本集'
  };
  render();
}

async function openGlobalFindReplace() {
  if (state.actionDialog?.busy) return;
  const dialog = { type: 'find-replace', scope: 'global', title: '全局查找替换',
    confirmLabel: '查找 / 预览替换范围', needle: '', replacement: '',
    scopes: ['script', 'storyboard', 'seedance'], extensions: ['.txt', '.md', '.markdown'], backupRoot: '' };
  state.actionDialog = dialog;
  const dirtyKinds = dirtyDocumentKinds();
  if (dirtyKinds.length) {
    dialog.busy = 'saving';
    dialog.progressText = '正在保存当前编辑，请稍候…';
  }
  renderActionDialog();
  try {
    for (const kind of [preferredDirtyDocumentKind(dirtyKinds), ...dirtyKinds.filter((kind) => kind !== preferredDirtyDocumentKind(dirtyKinds))].filter(Boolean)) {
      await saveFolderDocument(kind, { preserveViewport: true });
    }
  } catch (error) {
    dialog.saveFailed = true;
    dialog.error = '当前编辑保存失败：' + (error.message || error);
  } finally {
    dialog.busy = ''; if (state.actionDialog === dialog) renderActionDialog();
  }
}

function openDocumentFind(kind) {
  if (!['outline', 'script', 'shotlist', 'storyboard'].includes(kind)) return;
  const input = document.querySelector(`[data-inline-document-find="${kind}"]`);
  input?.focus();
  input?.select();
}

function documentFindMatches(content, query, limit = 200) {
  const source = String(content || '');
  const needle = String(query || '').trim();
  if (!needle) return { matches: [], overflow: false };
  const searchable = source.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const matches = [];
  let start = 0;
  let index = searchable.indexOf(target, start);
  while (index >= 0) {
    const lineStart = source.lastIndexOf('\n', index - 1) + 1;
    const lineEnd = source.indexOf('\n', index);
    const rawLine = source.slice(lineStart, lineEnd >= 0 ? lineEnd : source.length).replace(/\r$/, '');
    const prefixStart = Math.max(0, index - lineStart - 42);
    const suffixEnd = Math.min(rawLine.length, index - lineStart + needle.length + 60);
    const excerpt = `${prefixStart ? '…' : ''}${rawLine.slice(prefixStart, suffixEnd).trim()}${suffixEnd < rawLine.length ? '…' : ''}`;
    const line = source.slice(0, index).split(/\r?\n/).length;
    matches.push({ start: index, end: index + needle.length, line, column: index - lineStart + 1, excerpt });
    if (matches.length >= limit) return { matches, overflow: searchable.indexOf(target, index + Math.max(needle.length, 1)) >= 0 };
    start = index + Math.max(needle.length, 1);
    index = searchable.indexOf(target, start);
  }
  return { matches, overflow: false };
}

function setInlineDocumentFindStatus(kind, text, canNavigate = false) {
  const status = document.querySelector(`[data-inline-document-find-status="${kind}"]`);
  if (status) status.textContent = text;
  document.querySelectorAll(`[data-inline-document-find-nav="${kind}"]`).forEach((button) => {
    button.disabled = !canNavigate;
  });
}

function inlineDocumentFindStatus(matches, activeIndex, overflow) {
  const match = matches[activeIndex];
  if (!match) return '未找到';
  return `${activeIndex + 1}/${overflow ? `${matches.length}+` : matches.length} · 第${match.line}行`;
}

function selectDocumentFindLocation(kind, start, end, line, { focusEditor = false } = {}) {
  const textarea = document.querySelector(`textarea[data-bind="${kind}.content"]`);
  if (!textarea) return;
  const lineIndex = Math.max(0, Number(line || 1) - 1);
  const safeStart = Math.max(0, Math.min(Number(start) || 0, textarea.value.length));
  const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, textarea.value.length));
  refreshHighlightedEditors();
  const lineElement = document.querySelector(`.highlight-line[data-line-index="${lineIndex}"]`);
  textarea.setSelectionRange(safeStart, safeEnd);
  let targetScrollTop = lineElement ? Math.max(0, lineElement.offsetTop - (textarea.clientHeight * 0.28)) : 0;
  if (!lineElement && textarea.closest('.highlight-editor')?.dataset.largeText === 'true') {
    // Measure a prefix with exactly the native editor's wrapping metrics so
    // long-document search still scrolls to its real location.
    const ruler = document.createElement('textarea');
    const style = getComputedStyle(textarea);
    for (const property of ['font', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'padding', 'border', 'boxSizing', 'whiteSpace', 'overflowWrap', 'wordBreak', 'scrollbarGutter']) ruler.style[property] = style[property];
    ruler.style.position = 'fixed'; ruler.style.left = '-100000px';
    ruler.style.width = textarea.getBoundingClientRect().width + 'px';
    ruler.style.height = '0'; ruler.style.minHeight = '0'; ruler.style.visibility = 'hidden';
    ruler.style.overflowY = 'scroll'; ruler.wrap = 'soft';
    ruler.value = textarea.value.slice(0, safeStart) + '\u200b';
    document.body.appendChild(ruler);
    targetScrollTop = Math.max(0, ruler.scrollHeight - parseFloat(style.paddingBottom || '0') - (parseFloat(style.lineHeight) || 36) - textarea.clientHeight * 0.28);
    ruler.remove();
  }
  textarea.scrollTop = targetScrollTop;
  updateHighlightedEditor(textarea);
  if (focusEditor) textarea.focus();
  // The highlight layer is laid out after the input event. Apply the same
  // position on the next frame so long wrapped lines reliably jump into view.
  requestAnimationFrame(() => {
    textarea.scrollTop = targetScrollTop;
    updateHighlightedEditor(textarea);
  });
}

function runInlineDocumentFind(kind, query) {
  if (!['outline', 'script', 'shotlist', 'storyboard'].includes(kind)) return;
  const previousQuery = state.documentFindQuery?.[kind] || '';
  state.documentFindQuery[kind] = query;
  const { matches, overflow } = documentFindMatches(contentForKind(kind), query);
  if (!String(query || '').trim()) {
    if (state.documentFindLocation?.kind === kind) state.documentFindLocation = null;
    state.documentFindActiveIndex[kind] = 0;
    refreshHighlightedEditors();
    setInlineDocumentFindStatus(kind, '');
    return;
  }
  if (!matches.length) {
    if (state.documentFindLocation?.kind === kind) state.documentFindLocation = null;
    state.documentFindActiveIndex[kind] = 0;
    refreshHighlightedEditors();
    setInlineDocumentFindStatus(kind, '未找到');
    return;
  }
  if (previousQuery !== query) state.documentFindActiveIndex[kind] = 0;
  const activeIndex = Math.max(0, Math.min(Number(state.documentFindActiveIndex?.[kind]) || 0, matches.length - 1));
  state.documentFindActiveIndex[kind] = activeIndex;
  const match = matches[activeIndex];
  state.documentFindLocation = { kind, line: match.line };
  const status = inlineDocumentFindStatus(matches, activeIndex, overflow);
  const requiresEditor = (kind === 'script' && state.scriptMode === 'read')
    || (kind === 'shotlist' && state.shotlistMode !== 'edit')
    || (kind === 'storyboard' && state.storyboardMode === 'preview');
  if (requiresEditor) {
    if (kind === 'script') state.scriptMode = 'edit';
    if (kind === 'shotlist') state.shotlistMode = 'edit';
    if (kind === 'storyboard') state.storyboardMode = 'edit';
    render();
    requestAnimationFrame(() => {
      selectDocumentFindLocation(kind, match.start, match.end, match.line);
      const input = document.querySelector(`[data-inline-document-find="${kind}"]`);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
      setInlineDocumentFindStatus(kind, status, true);
    });
    return;
  }
  selectDocumentFindLocation(kind, match.start, match.end, match.line);
  setInlineDocumentFindStatus(kind, status, true);
}

function navigateInlineDocumentFind(kind, direction) {
  if (!['outline', 'script', 'shotlist', 'storyboard'].includes(kind)) return;
  const query = state.documentFindQuery?.[kind] || '';
  const { matches, overflow } = documentFindMatches(contentForKind(kind), query);
  if (!matches.length) return showToast(query.trim() ? '当前文件没有可跳转的命中内容。' : '请先输入要查找的文字。');
  const current = Math.max(0, Math.min(Number(state.documentFindActiveIndex?.[kind]) || 0, matches.length - 1));
  const step = Number(direction) < 0 ? -1 : 1;
  const activeIndex = (current + step + matches.length) % matches.length;
  state.documentFindActiveIndex[kind] = activeIndex;
  const match = matches[activeIndex];
  state.documentFindLocation = { kind, line: match.line };
  selectDocumentFindLocation(kind, match.start, match.end, match.line);
  setInlineDocumentFindStatus(kind, inlineDocumentFindStatus(matches, activeIndex, overflow), true);
}

function renderDocumentFindResults() {
  const dialog = state.actionDialog;
  const query = document.querySelector('#document-find-query')?.value || '';
  const resultRoot = document.querySelector('#document-find-results');
  const summary = document.querySelector('#document-find-summary');
  if (!dialog || dialog.type !== 'document-find' || !resultRoot || !summary) return;
  const { matches, overflow } = documentFindMatches(contentForKind(dialog.kind), query);
  if (!query.trim()) {
    summary.textContent = '输入文字后显示当前文件中的命中位置。';
    resultRoot.innerHTML = '';
    return;
  }
  summary.textContent = overflow ? `已显示前 ${matches.length} 个命中结果。` : `找到 ${matches.length} 处。`;
  resultRoot.innerHTML = matches.length
    ? matches.map((match) => `<button class="document-find-result" data-action="locate-document-find" data-find-kind="${dialog.kind}" data-find-start="${match.start}" data-find-end="${match.end}" data-find-line="${match.line}"><span>第 ${match.line} 行 · 第 ${match.column} 字</span><strong>${escapeHTML(match.excerpt || query.trim())}</strong></button>`).join('')
    : '<p class="hint document-find-empty">当前文件中没有找到这段文字。</p>';
}

function locateDocumentFind(kind, start, end, line) {
  const content = contentForKind(kind);
  const safeStart = Math.max(0, Math.min(Number(start) || 0, content.length));
  const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, content.length));
  state.actionDialog = null;
  state.documentFindLocation = { kind, line: Number(line) || 1 };
  closeModal();
  if (kind === 'script') {
    state.view = 'script';
    state.scriptMode = 'edit';
  } else {
    state.view = 'storyboard';
  }
  render();
  requestAnimationFrame(() => {
    selectDocumentFindLocation(kind, safeStart, safeEnd, line, { focusEditor: true });
  });
}

async function replaceCurrentEpisodeText(kind, needle, replacement) {
  const current = String(contentForKind(kind) || '');
  const count = replacementCount(current, needle);
  if (!count) return showToast('当前第 ' + state.project.currentEpisode + ' 集没有找到要替换的内容。');
  state.project[kind].content = current.split(needle).join(replacement);
  await saveFolderDocument(kind);
  showToast('已在本集' + documentKindLabel(kind) + '中替换 ' + count + ' 处，并写回文件夹。');
}

async function replaceAllProjectText(needle, replacement, expectedRevision = '', options = {}) {
  const result = await window.directorApi.replaceProjectText(state.project, needle, replacement, false, expectedRevision, options);
  if (!result.replacements) return result;
  if (state.actionDialog?.scope === 'global') state.actionDialog.result = result;
  rememberReplacement(result);
  try {
    const currentEpisode = Number(state.project.currentEpisode);
    state.project = ensureClientProjectShape(await window.directorApi.rescanProject(state.project));
    await activateEpisode(currentEpisode);
    await saveProject({ renderAfter: false });
  } catch (error) { result.refreshWarning = '文件替换已完成，备份已保存；界面刷新失败，请重新打开项目：' + (error.message || error); }
  render();
  showToast('已替换 ' + result.files + ' 个文件，备份详情见结果窗口。');
  return result;
}

async function addAssets(category = state.assetFilter === 'all' ? 'role' : state.assetFilter) {
  const assets = await window.directorApi.addAsset(state.project, category);
  if (!assets.length) return;
  state.project.assets.push(...assets);
  markDirty();
  render();
  showToast(`已导入 ${assets.length} 份${assetCategoryMeta[category]?.label || '素材'}素材。`);
}

async function refreshAssets({ silent = false } = {}) {
  const assets = await window.directorApi.refreshAssets(state.project);
  state.project.assets = assets;
  render();
  if (!silent) showToast(`素材库已刷新：识别到 ${assets.length} 份素材。`);
}

async function refreshAssetPromptLibrary({ silent = false } = {}) {
  if (!state.project) return;
  const episodeNumber = Number(state.project.currentEpisode);
  const library = await window.directorApi.loadAssetPromptLibrary(state.project, episodeNumber);
  if (Number(state.project.currentEpisode) !== episodeNumber) return;
  state.assetPromptLibrary = library;
  render();
  if (!silent) {
    const count = Object.values(library.categories || {}).reduce((total, item) => total + (item.entries?.length || 0), 0);
    showToast(`第${episodeNumber}集资产提示词已刷新：${count} 条。`);
  }
}

async function organizeRoleAsset(assetId) {
  const updated = await window.directorApi.organizeRoleAsset(state.project, assetId);
  const index = state.project.assets.findIndex((asset) => asset.id === updated.id);
  if (index >= 0) state.project.assets[index] = updated;
  markDirty();
  await saveProject();
  showToast(`已收纳到 01 人物 / ${updated.standardName || updated.name}。`);
}

function projectForTaskExecution(task) {
  const project = deepCopy(state.project);
  const episodeNumber = Number(task.episodeNumber) || Number(project.currentEpisode);
  const episode = project.episodes?.find((item) => Number(item.number) === episodeNumber);
  project.currentEpisode = episodeNumber;
  project.targetDuration = Number(task.targetSeconds) || Number(episode?.targetSeconds) || Number(project.targetDuration) || 120;
  return project;
}

async function sendTask(task) {
  state.singleTaskRunning = true;
  state.workLocked = true;
  const taskReplyMode = task.replyMode || state.project.chatGptRunner?.replyMode || 'auto';
  state.workLabel = `正在处理第 ${task.episodeNumber || state.project.currentEpisode} 集并等待 ChatGPT ${replyModeLabel(taskReplyMode)}。`;
  task.status = '自动执行中';
  const usingChrome = (state.project.chatGptRunner?.mode || 'chrome') === 'chrome';
  task.note = usingChrome
    ? `正在复用你选定的 ChatGPT 当前聊天，上传对应文件并按“${replyModeLabel(taskReplyMode)}”回收归档。`
    : (task.chatGptProject ? `正在返回 ChatGPT 项目“${task.chatGptProject}”首页，并在项目内新建聊天，发送提取后的文档内容并按“${replyModeLabel(taskReplyMode)}”回收归档。` : '正在发送、等待官网回复并自动归档。');
  markDirty();
  render();
  const executionProject = projectForTaskExecution(task);
  try {
    const result = await window.directorApi.executeChatGptTask(executionProject, task);
    if (result.ok) {
      await applyTaskReply(task, result.content, result.outputPath, result.plainTextPath, executionProject);
      syncActiveEpisode();
      await saveProject({ renderAfter: false });
      showToast(`ChatGPT ${result.replySource === 'message' ? '聊天正文' : 'TXT 附件'}已保存为 ${savedFormatLabel(task.kind, result)}。`);
    } else {
      task.status = '需人工发送';
      task.note = result.reason;
      markDirty();
      showToast(result.reason);
    }
  } catch (error) {
    task.status = '需人工发送';
    task.note = error.message || String(error);
    markDirty();
    showToast(task.note);
  } finally {
    state.singleTaskRunning = false;
    state.workLocked = false;
    state.workLabel = '';
    render();
  }
}

async function applyTaskReply(task, content, outputPath, plainTextPath = '', executionProject = state.project) {
  task.status = '已保存';
  task.resultPath = outputPath;
  task.note = `已将 ChatGPT ${content?.trim() ? '聊天正文' : 'TXT 附件'}保存为当前选择的 ${documentFormatLabel(documentFormatForKind(task.kind))} 格式。`;
  const kind = task.kind;
  if (kind === 'custom') {
    markDirty();
    render();
    return;
  }
  const savedDocument = await window.directorApi.openDocumentFile(executionProject, kind, plainTextPath || outputPath);
  content = savedDocument.content;
  if (task.episodeNumber && Number(task.episodeNumber) !== Number(state.project.currentEpisode)) {
    state.project = await window.directorApi.rescanProject(state.project);
    state.projects = state.projects.map((project) => project.id === state.project.id ? state.project : project);
    markDirty();
    render();
    return;
  }
  applyOpenedDocument(kind, savedDocument);
  appendFolderFile(kind, savedDocument);
  if (task.kind === 'script') {
    state.project.script.versions.push({ id: crypto.randomUUID(), name: `ChatGPT 剧本稿 ${formatTime(new Date())}`, content, createdAt: new Date().toISOString() });
    if (activeEpisode()) activeEpisode().status = '剧本已生成';
  }
  if (task.kind === 'storyboard') {
    state.project.storyboard.versions.push({ id: crypto.randomUUID(), name: `ChatGPT Seedance提示词 ${formatTime(new Date())}`, content, createdAt: new Date().toISOString() });
    state.project.storyboard.checks = await window.directorApi.checkStoryboard(content, state.project.script.content, state.project.shotlist.content);
    if (activeEpisode()) activeEpisode().status = '提示词已生成';
  }
  if (task.kind === 'shotlist') {
    state.project.shotlist.versions.push({ id: crypto.randomUUID(), name: `ChatGPT 镜头计划 ${formatTime(new Date())}`, content, createdAt: new Date().toISOString() });
    if (activeEpisode()) activeEpisode().shotlistSkipped = false;
  }
  syncActiveEpisode();
  markDirty();
  render();
}

async function captureTask(task) {
  const executionProject = projectForTaskExecution(task);
  state.workLocked = true;
  const taskReplyMode = task.replyMode || state.project.chatGptRunner?.replyMode || 'auto';
  state.workLabel = `正在读取第 ${task.episodeNumber || state.project.currentEpisode} 集已生成的 ChatGPT ${replyModeLabel(taskReplyMode)}。`;
  task.status = '读取中';
  task.note = `正在读取 ChatGPT 当前聊天中已生成的${replyModeLabel(taskReplyMode)}，不会发送新消息。`;
  markDirty();
  render();
  try {
    const file = await window.directorApi.downloadLatestChatGptAttachment(executionProject, task);
    if (!file.ok) {
      task.status = '读取失败';
      task.note = file.reason;
      markDirty(); render(); showToast(file.reason); return;
    }
    await applyTaskReply(task, file.content || '', file.outputPath, file.plainTextPath, executionProject);
    await saveProject();
    showToast(`已读取 ChatGPT ${file.replySource === 'message' ? '聊天正文' : 'TXT 附件'}并保存为 ${savedFormatLabel(task.kind, file)}。`);
  } catch (error) {
    task.status = '读取失败';
    task.note = error.message || String(error);
    markDirty();
    render();
    showToast(task.note);
  } finally {
    state.workLocked = false;
    state.workLabel = '';
    render();
  }
}

async function captureCurrentEpisodeAttachment(kind) {
  const task = {
    id: crypto.randomUUID(),
    kind,
    name: `第 ${directorEpisodeSlots.label(state.project, state.project.currentEpisode)} 集 · 官网回复读取`,
    episodeNumber: Number(state.project.currentEpisode),
    targetSeconds: Number(state.project.targetDuration),
    replyMode: state.project.chatGptRunner?.replyMode || 'auto',
    status: '待读取',
    note: '仅读取当前 ChatGPT 聊天中已生成的 TXT 附件或聊天正文。',
    createdAt: new Date().toISOString()
  };
  state.project.queue = [...(state.project.queue || []), task];
  markDirty();
  await captureTask(task);
}

function createProjectModal(seedFile = null) {
  state.projectChooserOpen = false;
  state.projectWizard = {
    step: 0, title: seedFile?.name?.replace(/\.(txt|md|markdown|docx)$/i, '').replace(/^\d+[_\s-]*/, '') || '',
    parentPath: '', seedFiles: seedFile ? { source: seedFile.path } : {},
    genre: '动漫微短剧', startEpisode: 1, totalEpisodes: 1, targetDuration: 120
  };
  renderProjectWizard();
}

function rememberProjectWizardStep() {
  const draft = state.projectWizard;
  if (!draft) return;
  if (draft.step === 0) draft.title = document.querySelector('#new-project-title')?.value.trim() || '';
  if (draft.step === 2) {
    draft.genre = document.querySelector('#new-project-genre')?.value.trim() || '动漫微短剧';
    draft.startEpisode = Math.max(1, Number(document.querySelector('#new-project-episode')?.value) || 1);
    draft.totalEpisodes = Math.max(1, Number(document.querySelector('#new-project-count')?.value) || 1);
    draft.targetDuration = Math.max(1, Number(document.querySelector('#new-project-duration')?.value) || 120);
  }
}

function renderRecentProjectRows() {
  const query = state.projectHistoryQuery.trim().toLowerCase();
  const projects = state.projects.filter(project => !query || (project.title + ' ' + project.projectPath).toLowerCase().includes(query));
  return projects.length ? projects.map(project => `<div class="project-history-row"><button class="history-open" data-history-action data-action="select-recent-project" data-project-id="${escapeHTML(project.id)}" ${project.unavailable || state.projectHistoryBusy ? 'disabled' : ''}><strong>${escapeHTML(project.title)}${project.id === state.project?.id ? '<small>当前打开</small>' : ''}</strong><span title="${escapeHTML(project.projectPath || '')}">${escapeHTML(project.projectPath || '')}</span>${project.unavailable ? '<span>文件夹暂不可用，记录仍可移除</span>' : ''}</button><button class="button quiet small history-remove" data-history-action data-action="forget-project" data-project-id="${escapeHTML(project.id)}" aria-label="从最近项目中移除${escapeHTML(project.title)}" ${state.projectHistoryBusy ? 'disabled' : ''}>移除记录</button></div>`).join('') : '<p class="project-history-empty">' + (state.projects.length ? '没有匹配的最近项目。' : '最近记录已清空。需要时可重新打开原项目文件夹。') + '</p>';
}

function renderProjectChooser() {
  state.projectChooserOpen = true;
  modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal project-chooser-modal"><div class="modal-head"><div><div class="eyebrow">项目入口</div><h2>打开项目</h2></div><button class="modal-close" data-action="close-projects" aria-label="关闭">×</button></div><div class="project-chooser-actions"><button class="project-entry" data-action="adopt-folder"><span class="project-entry-icon">文件夹</span><strong>打开已有项目文件夹</strong><span>自动识别 00 原文、02 大纲、03 剧本等目录。</span></button>${membershipCanEdit() ? `<button class="project-entry" data-action="new-project-from-file"><span class="project-entry-icon">文件</span><strong>从一个文件新建</strong><span>选原文、Markdown 或 Word 后继续填写项目资料。</span></button><button class="project-entry" data-action="new-project"><span class="project-entry-icon">新建</span><strong>空白项目</strong><span>只填名称，其他步骤都能跳过。</span></button>` : ''}</div><section class="recent-projects project-history"><div class="project-history-heading"><h3>最近项目 · ${state.projects.length}</h3><button class="button quiet small" data-history-action data-action="forget-all-projects" ${!state.projects.length || state.projectHistoryBusy ? 'disabled' : ''}>清空记录</button></div><p class="hint">完成的项目可以从这里移除记录，原文件夹、剧本和素材都会保留；以后仍可重新打开。</p><div class="project-history-tools"><input id="recent-project-search" aria-label="搜索最近项目" placeholder="按项目名称或文件夹搜索" value="${inputValue(state.projectHistoryQuery)}" /></div><div id="recent-project-rows">${renderRecentProjectRows()}</div></section></div></div>`;
}

async function forgetRecentProjects(ids) {
  if (state.projectHistoryBusy) return;
  if (state.projectSwitchPending) return showToast('请等待项目切换完成后再移除记录。');
  const projects = state.projects.filter(project => ids.includes(project.id));
  if (!projects.length) return;
  const includesCurrent = projects.some(project => project.id === state.project?.id);
  const label = projects.length === 1 ? `“${projects[0].title}”` : `这 ${projects.length} 个项目`;
  if (!await window.directorConfirm(`从最近项目中移除${label}的记录？\n\n原项目文件夹、剧本和素材都会保留，以后可重新打开。${includesCurrent ? '\n当前项目如有修改，会先保存，再关闭当前项目。' : ''}`)) return;
  if (includesCurrent && !await saveCurrentProjectBeforeSwitch({ actionLabel: '移除记录', confirmed: true })) return;
  state.projectHistoryBusy = true;
  modalRoot.querySelectorAll('[data-history-action]').forEach(button => { button.disabled = true; });
  try {
    const result = await window.directorApi.forgetProjects(projects.map(project => project.id));
    state.projects = result.projects;
    if (includesCurrent) {
      state.project = null;
      state.dirty = false;
      state.documentDirty = { source: false, outline: false, script: false, shotlist: false, storyboard: false };
      state.episodeLoadToken = {};
      state.renderedContextKey = '';
      state.pendingViewport = null;
      cancelScheduledEpisodeCheck();
      try { localStorage.removeItem(ACTIVE_PROJECT_KEY); } catch {}
    }
    showToast(`已移除 ${result.removed} 条最近记录，原项目文件仍保留。`);
  } finally {
    state.projectHistoryBusy = false;
    state.projectChooserOpen = true;
    render();
  }
}

function renderProjectWizard() {
  const draft = state.projectWizard;
  if (!draft) return;
  const steps = ['项目名称与位置', '带入已有资料', '集数与时长'];
  const fileRow = (kind, label, note) => `<div class="wizard-file-row"><div><strong>${label}</strong><span>${escapeHTML(draft.seedFiles[kind]?.split(/[\\/]/).pop() || note)}</span></div><div><button class="button secondary small" data-action="wizard-choose-file" data-seed-kind="${kind}">${draft.seedFiles[kind] ? '更换' : '选择文件'}</button>${draft.seedFiles[kind] ? `<button class="button quiet small" data-action="wizard-remove-file" data-seed-kind="${kind}">移除</button>` : ''}</div></div>`;
  const body = draft.step === 0
    ? `<p class="hint">先给项目起个名字。默认保存在“文档 / 导演台剧场 / projects”，也可以选择别的位置。</p><div class="field"><label for="new-project-title">项目名称 <span class="required-mark">必填</span></label><input id="new-project-title" value="${inputValue(draft.title)}" placeholder="例如：重生后我成了村花" /></div><div class="wizard-location"><div><strong>存放位置</strong><span>${escapeHTML(draft.parentPath || '默认：文档 / 导演台剧场 / projects')}</span></div><button class="button secondary small" data-action="wizard-choose-parent">更改位置</button></div>`
    : draft.step === 1
      ? `<p class="hint">已有文件可直接带入项目；软件会复制到对应目录，原文件保留。三项都可以跳过，稍后再导入。</p><div class="wizard-file-list">${fileRow('source', '小说原文', 'TXT、Markdown 或 Word')}${fileRow('outline', '分集大纲', '可选，之后可在编辑页补充')}${fileRow('script', '现有剧本', '可选，之后可生成或编辑')}</div>`
      : `<p class="hint">按当前作品填写；不确定时保持默认值，建好后仍可调整。</p><div class="form-grid"><div class="field wide"><label for="new-project-genre">作品类型</label><input id="new-project-genre" value="${inputValue(draft.genre)}" /></div><div class="field"><label for="new-project-episode">起始集</label><input id="new-project-episode" type="number" min="1" value="${draft.startEpisode}" /></div><div class="field"><label for="new-project-count">计划集数</label><input id="new-project-count" type="number" min="1" value="${draft.totalEpisodes}" /></div><div class="field"><label for="new-project-duration">每集预计秒数</label><input id="new-project-duration" type="number" min="1" value="${draft.targetDuration}" /></div></div><div class="notice">将创建“${escapeHTML(draft.title || '未命名项目')}”；带入 ${Object.keys(draft.seedFiles).length} 份资料。之后可以继续导入或修改。</div>`;
  modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal project-wizard-modal"><div class="modal-head"><div><div class="eyebrow">新建项目 · 第 ${draft.step + 1} / 3 步</div><h2>${steps[draft.step]}</h2></div><button class="modal-close" data-action="close-modal" aria-label="关闭">×</button></div><div class="wizard-steps">${steps.map((label, index) => `<span class="${index === draft.step ? 'current' : index < draft.step ? 'done' : ''}">${index + 1} ${label}</span>`).join('')}</div><div class="wizard-body">${body}</div><div class="form-actions wizard-actions"><button class="button quiet" data-action="close-modal">取消</button>${draft.step > 0 ? `<button class="button secondary" data-action="wizard-back">上一步</button>` : ''}${draft.step > 0 && draft.step < 2 ? `<button class="button secondary" data-action="wizard-skip">跳过此步</button>` : ''}<button class="button" data-action="${draft.step === 2 ? 'create-project' : 'wizard-next'}">${draft.step === 2 ? '创建项目' : '下一步'}</button></div></div></div>`;
  if (draft.step === 0) document.querySelector('#new-project-title')?.focus();
}

async function saveCurrentProjectBeforeSwitch({ actionLabel = '切换项目', confirmed = false } = {}) {
  if (!state.project) return true;
  await documentSaveQueue.drain();
  await projectSaveQueue.drain();
  const dirtyKinds = dirtyDocumentKinds();
  if (!dirtyKinds.length && !state.dirty && !reviewUI.hasDrafts()) return true;
  if (!confirmed && !await window.directorConfirm(`当前项目有未保存的修改。确定后会先保存，再${actionLabel}；取消则保留当前编辑。`)) return false;
  for (const kind of dirtyKinds) await saveFolderDocument(kind, { preserveViewport: false });
  if (state.dirty) await saveProject({ renderAfter: false, preserveViewport: false });
  await directorUI.saveDrafts();
  await reviewUI.saveDrafts();
  if (dirtyDocumentKinds().length || state.dirty) {
    showToast('保存期间还有新修改，已保留当前项目；请保存后再继续。');
    return false;
  }
  return true;
}

async function switchProject(project, options = {}) {
  if (state.projectHistoryBusy) { showToast('正在移除记录，请稍候。'); return false; }
  const sameProject = (left, right) => {
    if (!left || !right) return left === right;
    const leftPath = String(left.projectPath || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    const rightPath = String(right.projectPath || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    return Boolean(left.id && right.id && left.id === right.id) || Boolean(leftPath && rightPath && leftPath === rightPath);
  };
  if (sameProject(state.project, project) && project && !state.projectSwitchPending) {
    rememberActiveProject(state.project);
    state.projectChooserOpen = false;
    state.projectWizard = null;
    render();
    return true;
  }
  const token = {};
  const fallbackProject = state.projectSwitchPending?.fallbackProject || state.project;
  const fallbackView = state.projectSwitchPending?.fallbackView || state.view;
  state.projectSwitchToken = token;
  let previousProject = state.project;
  try {
    if (state.project && !sameProject(state.project, project)) {
      if (!await saveCurrentProjectBeforeSwitch()) return false;
    }
    if (state.projectSwitchToken !== token) return false;
    previousProject = state.project;
    const openingRevision = state.changeRevision;
    state.projectSwitchPending = project ? { id: project.id, title: project.title, fallbackProject, fallbackView } : null;
    updateProjectSwitchStatus();
    if (project && options.openFolder) {
      const requestedPath = project.projectPath;
      const openedProject = await window.directorApi.openProjectFolder(requestedPath);
      if (!openedProject || state.projectSwitchToken !== token) return false;
      if (state.project !== previousProject || state.changeRevision !== openingRevision) {
        showToast('读取项目期间有新修改，已保留当前内容。');
        return false;
      }
      project = openedProject;
      const index = state.projects.findIndex(item => projectPathKey(item.projectPath) === projectPathKey(project.projectPath));
      if (index >= 0) state.projects[index] = project;
      else state.projects.unshift(project);
    }
    if (state.projectSwitchToken !== token) return false;
    state.project = project || null;
    state.projectChooserOpen = false;
    state.projectWizard = null;
    state.dirty = false;
    state.view = 'script';
    if (state.project && !await activateEpisode(state.project.currentEpisode, { preferKnownFiles: true })) return false;
    if (state.projectSwitchToken !== token) return false;
    rememberActiveProject(state.project);
    render();
    return true;
  } catch (error) {
    if (state.projectSwitchToken === token) {
      state.project = fallbackProject;
      state.view = fallbackView;
      state.episodeLoadToken = {};
      cancelScheduledEpisodeCheck();
      render();
    }
    throw error;
  } finally {
    if (state.projectSwitchToken === token) {
      state.projectSwitchPending = null;
      updateProjectSwitchStatus();
    }
  }
}

function closeModal() { modalRoot.innerHTML = ''; }

function closeActionDialog() {
  if (state.actionDialog?.busy === 'search') {
    void window.directorApi.cancelGlobalSearch();
  } else if (state.actionDialog?.busy) {
    return showToast('正在保存文件，请等待完成。');
  }
  state.actionDialog = null;
  closeModal();
  render();
}

function renderActionDialog() {
  const dialog = state.actionDialog;
  if (!dialog) return closeModal();
  if (renderUsabilityDialog(dialog)) { arrangeUsabilityDialog(); return; }
  if (dialog.type === 'find-replace' && dialog.scope === 'global') { renderGlobalReplaceDialog(dialog); arrangeUsabilityDialog(); return; }
  if (dialog.type === 'document-find') {
    const label = documentKindLabel(dialog.kind);
    modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal action-dialog document-find-dialog"><div class="modal-head"><h2>${escapeHTML(dialog.title || `查找${label}`)}</h2><button class="modal-close" data-action="close-action-dialog">×</button></div><p class="hint">只查找当前正在打开的${label} ${documentFormatLabel(documentFormatForKind(dialog.kind))} 文件；点击结果会跳转到原文位置，不会修改文件。</p><div class="field" style="margin-top:14px"><label>查找内容</label><input id="document-find-query" autocomplete="off" placeholder="输入要查找的文字" /></div><div class="document-find-summary" id="document-find-summary"></div><div class="document-find-results" id="document-find-results"></div><div class="form-actions"><button class="button secondary" data-action="close-action-dialog">关闭</button></div></div></div>`;
    requestAnimationFrame(() => {
      document.querySelector('#document-find-query')?.focus();
      renderDocumentFindResults();
    });
    return;
  }
  const isPromptVersion = dialog.type === 'prompt-version';
  const isDanger = dialog.danger ? ' danger' : '';
  let body = isPromptVersion
    ? `<p class="hint">为这次主提示词更新填写一个名称。保存后会立刻写入“07 AI规则与记忆 / 00 主提示词版本”，并成为下次生成使用的版本。</p><div class="field" style="margin-top:14px"><label>版本名称</label><input id="action-dialog-name" value="${inputValue(dialog.defaultName)}" autofocus /></div>`
    : `<p class="hint">${escapeHTML(dialog.message || '')}</p>`;
  if (dialog.type === 'find-replace') {
    const globalPreview = dialog.scope === 'global' && dialog.preview;
    const scopeNote = dialog.scope === 'global'
      ? '查找项目文件夹的 00–05 与 07 目录，支持 UTF-8 的 TXT、Markdown 和 Word。先查找预览，确认后才替换；发现读取错误时禁止写入。替换前自动备份，Word 排版会按原程序重建。'
      : '仅处理当前第 ' + state.project.currentEpisode + ' 集正在打开的' + documentKindLabel(dialog.kind) + '文件，并立刻写回文件夹。';
    body = globalPreview
      ? `<p class="hint">${scopeNote}</p><div class="global-replace-summary"><strong>找到 ${dialog.preview.files} 个文件，共 ${dialog.preview.replacements} 处</strong><span>“${escapeHTML(dialog.needle)}” → “${escapeHTML(dialog.replacement)}”</span></div><div class="global-replace-results">${(dialog.preview.matches || []).slice(0, 200).map((item) => `<div><strong>${escapeHTML(item.path)}</strong><span>${item.count} 处</span></div>`).join('')}</div>${dialog.preview.matches?.length > 200 ? '<p class="hint">结果仅展示前200个文件，统计及替换包含所有命中文件。</p>' : ''}${(dialog.preview.errors || []).length ? '<p class="hint">部分文件未能读取，当前结果不完整，不能替换：</p><div class="global-replace-results">' + dialog.preview.errors.slice(0, 50).map(item => '<p>' + escapeHTML(item.path + '：' + item.message) + '</p>').join('') + '</div>' : ''}`
      : '<p class="hint">' + scopeNote + `</p><div class="field" style="margin-top:14px"><label>查找内容</label><textarea id="find-replace-find" ${dialog.busy ? 'disabled' : ''} rows="3" placeholder="输入要查找的文字；按原样匹配">${escapeHTML(dialog.needle || '')}</textarea></div><div class="field" style="margin-top:12px"><label>替换为</label><textarea id="find-replace-replace" ${dialog.busy ? 'disabled' : ''} rows="3" placeholder="可留空，表示删除找到的内容">${escapeHTML(dialog.replacement || '')}</textarea></div>`;
  }
  const globalPreview = dialog.type === 'find-replace' && dialog.scope === 'global' && dialog.preview;
  if (dialog.type === 'find-replace' && dialog.scope === 'global') {
    body += `<p class="hint" id="global-search-progress" role="status">${escapeHTML(dialog.progressText || '')}</p>`;
    if (dialog.error) body += `<p role="alert" class="hint">${escapeHTML(dialog.error)}</p>`;
  }
  const confirmDisabled = Boolean(dialog.busy || dialog.saveFailed || (globalPreview && (!dialog.preview.complete || !dialog.preview.replacements)));
  const confirmLabel = dialog.busy ? (dialog.busy === 'search' ? '正在查找…' : '正在保存…') : globalPreview ? `确认替换 ${dialog.preview.replacements} 处` : isPromptVersion ? '保存新版本' : (dialog.confirmLabel || '确认');
  modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal action-dialog ${globalPreview ? 'global-replace-dialog' : ''}"><div class="modal-head"><h2>${escapeHTML(dialog.title || '确认操作')}</h2><button class="modal-close" data-action="close-action-dialog">×</button></div>${body}<div class="form-actions">${globalPreview ? `<button class="button secondary" data-action="edit-global-find-replace" ${dialog.busy ? 'disabled' : ''}>返回修改</button>` : '<button class="button secondary" data-action="close-action-dialog">取消</button>'}<button class="button${isDanger}" data-action="confirm-action-dialog" ${confirmDisabled ? 'disabled' : ''}>${escapeHTML(confirmLabel)}</button></div></div></div>`;
  requestAnimationFrame(() => document.querySelector(dialog.type === 'find-replace' ? '#find-replace-find' : '#action-dialog-name')?.focus());
}

async function confirmActionDialog() {
  const dialog = state.actionDialog;
  if (!dialog || dialog.busy || dialog.saveFailed) return;
  if (dialog.type === 'find-replace' && dialog.scope === 'global') return confirmGlobalReplaceDialog(dialog);
  if (dialog.type === 'prompt-version') {
    const name = document.querySelector('#action-dialog-name')?.value.trim();
    if (!name) return showToast('请填写版本名称。');
    state.actionDialog = null;
    closeModal();
    await savePromptVersion(dialog.kind, name, dialog.content);
    return;
  }
  if (dialog.type === 'find-replace') {
    const needle = dialog.preview ? dialog.needle : (document.querySelector('#find-replace-find')?.value || '');
    const replacement = dialog.preview ? dialog.replacement : (document.querySelector('#find-replace-replace')?.value || '');
    if (!needle) return showToast('请填写要查找的内容。');
    if (dialog.scope === 'global') {
      if (dialog.preview && (!dialog.preview.complete || !dialog.preview.replacements)) return;
      dialog.needle = needle; dialog.replacement = replacement; dialog.error = '';
      const isPreview = !dialog.preview;
      dialog.busy = isPreview ? 'search' : 'write';
      dialog.progressText = isPreview ? '正在扫描项目文件…可点击右上角关闭并取消查找。' : '正在准备备份与替换，请等待完成…';
      renderActionDialog();
      try {
        if (isPreview) {
          const preview = await window.directorApi.replaceProjectText(state.project, needle, replacement, true);
          if (state.actionDialog !== dialog) return;
          dialog.preview = preview;
          dialog.progressText = '已检查 ' + preview.scanned + ' 个文件。';
        } else {
          await replaceAllProjectText(needle, replacement, dialog.preview.revision);
          if (state.actionDialog === dialog) { state.actionDialog = null; closeModal(); }
        }
      } catch (error) {
        if (state.actionDialog === dialog) { dialog.error = String(error.message || error); dialog.progressText = ''; }
      } finally {
        dialog.busy = '';
        if (state.actionDialog === dialog) renderActionDialog();
      }
      return;
    }
    state.actionDialog = null;
    closeModal();
    if (dialog.scope === 'global') await replaceAllProjectText(needle, replacement);
    else await replaceCurrentEpisodeText(dialog.kind, needle, replacement);
    return;
  }
  if (dialog.type === 'confirm') {
    state.actionDialog = null;
    closeModal();
    if (dialog.action === 'discard-revisions') await executeDiscardRevisions(dialog.kind);
    if (dialog.action === 'finalize-episode') await executeFinalizeEpisode(dialog.kind);
    if (dialog.action === 'remove-task') {
      state.project.queue = (state.project.queue || []).filter((task) => task.id !== dialog.taskId);
      markDirty();
      await saveProject();
      showToast('任务已从队列中删除。');
    }
  }
}

function requestTaskRemoval(taskId) {
  const task = state.project.queue?.find((item) => item.id === taskId);
  if (!task) return;
  state.actionDialog = {
    type: 'confirm',
    action: 'remove-task',
    taskId,
    title: '删除任务',
    message: `将从任务队列删除“${task.name}”。已保存到文件夹的剧本、提示词和 Word 文档不会被删除。`,
    confirmLabel: '删除任务',
    danger: true
  };
  render();
}

function taskKindLabel(kind) {
  return kind === 'script' ? '剧本' : kind === 'shotlist' ? '分镜' : kind === 'storyboard' ? 'Seedance 提示词' : '自定义任务';
}

function openTaskReview(task) {
  if (!task || task.status === '自动执行中' || task.status === '已保存') return;
  state.taskReview = { taskId: task.id, prompt: task.prompt || '' };
  render();
}

function renderTaskReviewModal() {
  const review = state.taskReview;
  const task = state.project?.queue?.find((item) => item.id === review?.taskId);
  if (!review || !task) { state.taskReview = null; return closeModal(); }
  const usingChrome = (state.project.chatGptRunner?.mode || 'chrome') === 'chrome';
  const waitMinutes = Number(state.project.chatGptRunner?.waitMinutes) === 30 ? 30 : 50;
  const replyMode = ['auto', 'attachment', 'message'].includes(task.replyMode) ? task.replyMode : (state.project.chatGptRunner?.replyMode || 'auto');
  const reviewPrompt = promptForReplyMode(review.prompt, replyMode);
  const projectName = usingChrome ? '我的 Chrome · 选定的当前聊天' : (task.chatGptProject || '当前 ChatGPT 页面');
  modalRoot.innerHTML = `<div class="modal-overlay batch-overlay"><div class="modal task-review-modal"><div class="modal-head"><div><div class="eyebrow">PRE-FLIGHT REVIEW</div><h2>执行前审核 · 第 ${task.episodeNumber || state.project.currentEpisode} 集${taskKindLabel(task.kind)}</h2></div><button class="modal-close" data-action="close-task-review">×</button></div><div class="task-review-meta"><span>目标：${escapeHTML(projectName)}</span><span>输出：${task.kind === 'script' ? '03 剧本' : task.kind === 'storyboard' ? '05 seedance提示词' : task.kind === 'shotlist' ? '04 分镜' : '任务归档'}</span><span>保存格式：${documentFormatLabel(documentFormatForKind(task.kind))}</span></div><p class="hint" style="margin:13px 0 0">以下是实际会发送的完整内容，已包含本集文件正文、启用的规则、参照文档和项目记忆。可直接修改；${usingChrome ? '确认后将复用当前 ChatGPT 聊天，上传对应文件，不会新建聊天。' : '确认后会先返回指定 ChatGPT 项目主页，再在项目内新建聊天并发送；不会复用旧聊天或使用项目外的新聊天。'} 本集最长等待官网回复 ${waitMinutes} 分钟。</p><div class="field" style="margin-top:14px"><label>本任务回收结果</label><select id="task-review-reply-mode"><option value="auto" ${replyMode === 'auto' ? 'selected' : ''}>自动识别（先收 TXT 附件，找不到则保存聊天正文）</option><option value="attachment" ${replyMode === 'attachment' ? 'selected' : ''}>只收 TXT 附件</option><option value="message" ${replyMode === 'message' ? 'selected' : ''}>只收聊天正文</option></select><p class="hint">ChatGPT 可返回 TXT 附件或聊天正文，导演台会转换并保存为当前页面选择的格式。</p></div><div class="field" style="margin-top:14px"><label>实际发送内容</label><textarea id="task-review-prompt" class="task-review-prompt">${escapeHTML(reviewPrompt)}</textarea></div><div class="form-actions"><button class="button secondary" data-action="open-chatgpt">${usingChrome ? '打开我的 Chrome' : '打开 ChatGPT 窗口'}</button><button class="button secondary" data-action="close-task-review">保留待审核</button><button class="button" data-action="confirm-task-review">确认并开始执行</button></div></div></div>`;
}

function batchKindLabel(kind) {
  return kind === 'script' ? '剧本' : 'Seedance 提示词';
}

function batchEpisodes(draft) {
  const start = Math.min(Number(draft.start), Number(draft.end));
  const end = Math.max(Number(draft.start), Number(draft.end));
  return (state.project.episodes || []).map((item) => Number(item.number)).filter((number) => number >= start && number <= end);
}

async function openBatchModal(kind) {
  const episodes = state.project.episodes || [];
  const start = Number(episodes[0]?.number || state.project.currentEpisode);
  const end = Number(episodes.at(-1)?.number || state.project.currentEpisode);
  state.batchDraft = {
    kind, start, end, previewEpisode: Number(state.project.currentEpisode),
    template: currentPrompt(kind)?.content || '', preview: '', status: 'review',
    nextIndex: 0, completed: [], error: '', currentEpisode: null, manualInstruction: '', awaitingExistingReply: false,
    replyMode: state.project.chatGptRunner?.replyMode || 'auto'
  };
  await refreshBatchPreview();
}

async function refreshBatchPreview() {
  const draft = state.batchDraft;
  if (!draft) return;
  const episodes = batchEpisodes(draft);
  if (!episodes.length) { draft.preview = '当前范围内没有可生成的集数。'; return renderBatchModal(); }
  if (!episodes.includes(Number(draft.previewEpisode))) draft.previewEpisode = episodes[0];
  const template = draft.manualInstruction?.trim()
    ? `${draft.template}\n\n【本轮人工修正要求】\n${draft.manualInstruction.trim()}`
    : draft.template;
  draft.preview = promptForReplyMode(
    await window.directorApi.previewBatchPrompt(state.project, draft.kind, draft.previewEpisode, template),
    draft.replyMode || state.project.chatGptRunner?.replyMode || 'auto'
  );
  renderBatchModal();
}

function renderBatchModal() {
  const draft = state.batchDraft;
  if (!draft) return closeModal();
  const episodes = batchEpisodes(draft);
  const running = state.batchRunning;
  const completed = draft.completed.length;
  const total = episodes.length;
  const waitMinutes = Number(state.project.chatGptRunner?.waitMinutes) === 30 ? 30 : 50;
  const manualInstruction = draft.status === 'paused' ? `<div class="field" style="margin-top:14px"><label>人工修正要求（只发送给继续处理的剩余集数）</label><textarea id="batch-manual-instruction" placeholder="例如：第 164 集的转场必须补全；之后每集都严格按这个规则处理。">${escapeHTML(draft.manualInstruction || '')}</textarea></div>` : '';
  const pauseNotice = draft.error ? `<div class="notice danger-note" style="margin-top:14px">已暂停：${escapeHTML(draft.error)}<br>${draft.awaitingExistingReply ? '如果当前集的结果已在 ChatGPT 中生成，请读取官网回复；会按当前回收方式保存附件或聊天正文，成功后再继续下一集，不会重发当前集。' : '请在 ChatGPT 窗口处理登录、验证或逻辑问题；补充人工修正后更新预览，再继续。'}</div>` : '';
  const captureExistingReply = draft.status === 'paused' && draft.awaitingExistingReply && episodes[draft.nextIndex]
    ? `<button class="button secondary" data-action="capture-batch-reply">读取第 ${episodes[draft.nextIndex]} 集官网回复</button>`
    : '';
  const form = `<div class="form-grid"><div class="field"><label>开始集</label><select id="batch-start">${state.project.episodes.map((episode) => `<option value="${episode.number}" ${Number(draft.start) === Number(episode.number) ? 'selected' : ''}>第 ${directorEpisodeSlots.label(state.project, episode.number)} 集</option>`).join('')}</select></div><div class="field"><label>结束集</label><select id="batch-end">${state.project.episodes.map((episode) => `<option value="${episode.number}" ${Number(draft.end) === Number(episode.number) ? 'selected' : ''}>第 ${directorEpisodeSlots.label(state.project, episode.number)} 集</option>`).join('')}</select></div><div class="field"><label>预览集</label><select id="batch-preview-episode">${episodes.map((number) => `<option value="${number}" ${Number(draft.previewEpisode) === number ? 'selected' : ''}>第 ${directorEpisodeSlots.label(state.project, number)} 集</option>`).join('')}</select></div><div class="field"><label>回收结果</label><select id="batch-reply-mode"><option value="auto" ${draft.replyMode === 'auto' ? 'selected' : ''}>自动识别（附件优先）</option><option value="attachment" ${draft.replyMode === 'attachment' ? 'selected' : ''}>只收 TXT 附件</option><option value="message" ${draft.replyMode === 'message' ? 'selected' : ''}>只收聊天正文</option></select></div></div><p class="hint" style="margin:12px 0 0">自动识别会读取 TXT 附件或聊天正文，再统一保存为当前页面选择的 ${documentFormatLabel(documentFormatForKind(draft.kind))} 格式。每集会最多等待官网回复 ${waitMinutes} 分钟。</p><div class="field" style="margin-top:14px"><label>批量发送模板（可修改，应用于每一集）</label><textarea id="batch-template" class="prompt-editor">${escapeHTML(draft.template)}</textarea></div>${manualInstruction}<div class="field" style="margin-top:14px"><label>第 ${directorEpisodeSlots.label(state.project, draft.previewEpisode)} 集实际发送预览（包含读取到的文件、规则与参照文档）</label><textarea class="batch-preview" readonly>${escapeHTML(draft.preview || '正在生成预览…')}</textarea></div>${pauseNotice}<div class="form-actions"><button class="button secondary" data-action="refresh-batch-preview">更新范围和预览</button><button class="button secondary" data-action="open-chatgpt">打开 ChatGPT 窗口</button>${captureExistingReply}<button class="button" data-action="${draft.status === 'paused' ? 'resume-batch' : 'start-batch'}">${draft.status === 'paused' ? '继续剩余任务' : `开始批量生成（${total} 集）`}</button></div>`;
  const runningContent = `<div class="batch-progress"><strong>正在处理第 ${draft.currentEpisode ? directorEpisodeSlots.label(state.project, draft.currentEpisode) : '—'} 集</strong><span>${completed} / ${total} 已完成</span></div><p class="hint">主界面已锁定。程序正在读取对应文件、发送到 ChatGPT 项目、等待回复并写入对应文件夹。本集最多等待 ${waitMinutes} 分钟，当前任务完成后可暂停。</p><div class="form-actions"><button class="button danger" data-action="stop-batch">处理完当前集后暂停</button><button class="button secondary" data-action="open-chatgpt">打开 ChatGPT 窗口</button></div>`;
  modalRoot.innerHTML = `<div class="modal-overlay batch-overlay"><div class="modal batch-modal"><div class="modal-head"><div><div class="eyebrow">BATCH GENERATION</div><h2>批量生成${batchKindLabel(draft.kind)}</h2></div>${running ? '' : '<button class="modal-close" data-action="close-batch">×</button>'}</div>${running ? runningContent : form}</div></div>`;
}

function readBatchModalInputs() {
  const draft = state.batchDraft;
  if (!draft) return;
  draft.start = Number(document.querySelector('#batch-start')?.value) || draft.start;
  draft.end = Number(document.querySelector('#batch-end')?.value) || draft.end;
  draft.previewEpisode = Number(document.querySelector('#batch-preview-episode')?.value) || draft.previewEpisode;
  draft.replyMode = document.querySelector('#batch-reply-mode')?.value || draft.replyMode || 'auto';
  draft.template = document.querySelector('#batch-template')?.value || draft.template;
  draft.manualInstruction = document.querySelector('#batch-manual-instruction')?.value || draft.manualInstruction || '';
}

async function runBatchGeneration() {
  const draft = state.batchDraft;
  if (!draft) return;
  const episodes = batchEpisodes(draft);
  if (!episodes.length) return showToast('请选择至少一集。');
  state.batchRunning = true;
  state.batchStopRequested = false;
  state.workLocked = true;
  state.workLabel = `正在批量处理 ${episodes.length} 集，任务会从当前集持续保存。`;
  draft.error = '';
  draft.awaitingExistingReply = false;
  draft.status = 'running';
  render();
  renderBatchModal();
  try {
    for (let index = draft.nextIndex; index < episodes.length; index += 1) {
      const episodeNumber = episodes[index];
      draft.currentEpisode = episodeNumber;
      state.workLabel = `正在批量处理第 ${episodeNumber} 集，电脑将保持唤醒直到该集保存完成。`;
      render();
      renderBatchModal();
      const episode = state.project.episodes.find((item) => Number(item.number) === episodeNumber);
      const projectForTask = deepCopy(state.project);
      projectForTask.currentEpisode = episodeNumber;
      projectForTask.targetDuration = Number(episode?.targetSeconds) || state.project.targetDuration;
      const template = draft.manualInstruction?.trim()
        ? `${draft.template}\n\n【本轮人工修正要求】\n${draft.manualInstruction.trim()}`
        : draft.template;
      const prompt = promptForReplyMode(await window.directorApi.previewBatchPrompt(projectForTask, draft.kind, episodeNumber, template), draft.replyMode || projectForTask.chatGptRunner?.replyMode || 'auto');
      const task = { id: crypto.randomUUID(), kind: draft.kind, name: `第 ${episodeNumber} 集 · 批量${batchKindLabel(draft.kind)}`, episodeNumber, targetSeconds: projectForTask.targetDuration, prompt, replyMode: draft.replyMode || projectForTask.chatGptRunner?.replyMode || 'auto', chatGptProject: draft.kind === 'script' ? projectForTask.chatGptProjects?.script : projectForTask.chatGptProjects?.prompt };
      const result = await window.directorApi.executeChatGptTask(projectForTask, task);
      if (!result.ok) {
        draft.status = 'paused';
        draft.error = `第 ${episodeNumber} 集：${result.reason}`;
        draft.nextIndex = index;
        draft.awaitingExistingReply = true;
        break;
      }
      draft.completed.push(episodeNumber);
      draft.nextIndex = index + 1;
      if (state.batchStopRequested) {
        draft.status = 'paused';
        draft.error = '已在当前集完成后暂停。可人工检查文件后继续。';
        break;
      }
    }
    if (draft.nextIndex >= episodes.length) draft.status = 'completed';
  } catch (error) {
    draft.status = 'paused';
    draft.error = error.message || String(error);
  } finally {
    state.batchRunning = false;
    draft.currentEpisode = null;
    state.workLocked = false;
    state.workLabel = '';
    state.project = await window.directorApi.rescanProject(state.project);
    state.projects = state.projects.map((project) => project.id === state.project.id ? state.project : project);
    await activateEpisode(state.project.currentEpisode);
    syncActiveEpisode();
    await saveProject({ renderAfter: false });
    render();
    renderBatchModal();
    if (draft.status === 'completed') showToast(`批量${batchKindLabel(draft.kind)}已全部保存到对应文件夹。`);
  }
}

async function capturePausedBatchReply() {
  const draft = state.batchDraft;
  if (!draft || draft.status !== 'paused' || !draft.awaitingExistingReply) return;
  const episodes = batchEpisodes(draft);
  const episodeNumber = episodes[draft.nextIndex];
  if (!episodeNumber) return showToast('当前没有可读取的批量任务。');
  const episode = state.project.episodes.find((item) => Number(item.number) === Number(episodeNumber));
  const executionProject = deepCopy(state.project);
  executionProject.currentEpisode = Number(episodeNumber);
  executionProject.targetDuration = Number(episode?.targetSeconds) || Number(state.project.targetDuration) || 120;
  const task = { id: crypto.randomUUID(), kind: draft.kind, episodeNumber: Number(episodeNumber), targetSeconds: executionProject.targetDuration, replyMode: draft.replyMode || executionProject.chatGptRunner?.replyMode || 'auto', name: `第 ${episodeNumber} 集 · 批量${batchKindLabel(draft.kind)}` };
  state.workLocked = true;
  state.workLabel = `正在读取第 ${episodeNumber} 集已生成的 ChatGPT ${replyModeLabel(task.replyMode)}。`;
  render();
  renderBatchModal();
  try {
    const result = await window.directorApi.downloadLatestChatGptAttachment(executionProject, task);
    if (!result.ok) {
      draft.error = `第 ${episodeNumber} 集：${result.reason}`;
      showToast(result.reason);
      return;
    }
    await applyTaskReply(task, result.content || '', result.outputPath, result.plainTextPath, executionProject);
    if (!draft.completed.includes(Number(episodeNumber))) draft.completed.push(Number(episodeNumber));
    draft.nextIndex += 1;
    draft.awaitingExistingReply = false;
    draft.error = '';
    draft.status = draft.nextIndex >= episodes.length ? 'completed' : 'paused';
    state.project = await window.directorApi.rescanProject(state.project);
    state.projects = state.projects.map((project) => project.id === state.project.id ? state.project : project);
    await activateEpisode(state.project.currentEpisode);
    markDirty();
    await saveProject();
    const savedLabel = result.replySource === 'message' ? '聊天正文' : 'TXT 附件';
    showToast(draft.status === 'completed' ? `最后一集${savedLabel}已保存，批量任务完成。` : `第 ${episodeNumber} 集${savedLabel}已保存；继续时将从第 ${episodes[draft.nextIndex]} 集开始。`);
  } catch (error) {
    draft.error = `第 ${episodeNumber} 集：${error.message || String(error)}`;
    showToast(draft.error);
  } finally {
    state.workLocked = false;
    state.workLabel = '';
    render();
    renderBatchModal();
  }
}

function workflowSelectionFromInputs(fallback = {}) {
  return {
    script: document.querySelector('#workflow-step-script')?.checked ?? fallback.script ?? true,
    shotlist: document.querySelector('#workflow-step-shotlist')?.checked ?? fallback.shotlist ?? true,
    storyboard: document.querySelector('#workflow-step-storyboard')?.checked ?? fallback.storyboard ?? true
  };
}

function workflowPromptInputs(fallback = {}) {
  return ['script', 'shotlist', 'storyboard'].reduce((prompts, step) => {
    const value = document.querySelector(`#workflow-prompt-${step}`)?.value;
    prompts[step] = value?.trim() || fallback[step] || '';
    return prompts;
  }, {});
}

function selectedWorkflowSteps(selection) {
  return ['script', 'shotlist', 'storyboard'].filter((step) => selection[step]);
}

async function refreshWorkflowReview({ preserve = true } = {}) {
  const review = state.workflowReview;
  if (!review) return;
  const selection = workflowSelectionFromInputs(review.selection);
  const promptMode = document.querySelector('#workflow-prompt-mode')?.value || review.promptMode || '30';
  const prompts = preserve ? workflowPromptInputs(review.prompts) : (review.prompts || {});
  review.selection = selection;
  review.promptMode = promptMode === '15' ? '15' : '30';
  review.prompts = prompts;
  review.error = '';
  try {
    const plan = await window.directorApi.prepareWorkflow(state.project, {
      episodeNumber: review.episodeNumber,
      selection: review.selection,
      promptMode: review.promptMode,
      prompts: review.prompts
    });
    review.plan = plan;
    for (const step of plan.steps) {
      if (!review.prompts[step.step]) review.prompts[step.step] = step.prompt;
    }
  } catch (error) {
    review.plan = null;
    review.error = error.message || String(error);
  }
  renderWorkflowReviewModal();
}

async function openWorkflowReview() {
  const templates = normalizeWorkflowTemplates(state.project.workflowTemplates);
  state.workflowReview = {
    episodeNumber: Number(state.project.currentEpisode),
    selection: { script: true, shotlist: true, storyboard: true },
    promptMode: templates.promptMode || '30',
    prompts: {},
    plan: null,
    error: ''
  };
  await refreshWorkflowReview({ preserve: false });
}

function workflowStepTitle(step) {
  return ({ script: '① 原文 → 剧本', shotlist: '② 剧本 → 分镜', storyboard: '③ 分镜 → 提示词' }[step] || step);
}

function renderWorkflowReviewModal() {
  const review = state.workflowReview;
  if (!review) return closeModal();
  const planByStep = new Map((review.plan?.steps || []).map((step) => [step.step, step]));
  const stepEditor = (step) => {
    if (!review.selection[step]) return '';
    const data = planByStep.get(step);
    const files = data
      ? `<div class="task-review-meta"><span>模板：${escapeHTML(data.template.name)}</span><span>输入：${escapeHTML(data.inputName)}</span><span>输出：${escapeHTML(data.outputFolder)}</span></div><p class="hint">${data.inputWillBeGenerated ? '输入 TXT 会在上一步保存后再作为真实文件上传。' : '下列输入与模板会作为真实文件上传，不会把文件正文拼进消息。'}</p>`
      : '';
    return `<article class="card" style="margin-top:12px"><div class="card-title"><h3>${workflowStepTitle(step)}</h3><span class="badge">${step === 'storyboard' ? `${review.promptMode} 秒模板` : 'TXT 输出'}</span></div>${files}<div class="field" style="margin-top:9px"><label>本步发送语（可改）</label><textarea id="workflow-prompt-${step}" class="task-review-prompt">${escapeHTML(review.prompts[step] || data?.prompt || '')}</textarea></div></article>`;
  };
  const error = review.error ? `<div class="notice danger-note" style="margin-top:12px">${escapeHTML(review.error)}</div>` : '';
  const ready = Boolean(review.plan?.steps?.length) && !review.error;
  modalRoot.innerHTML = `<div class="modal-overlay batch-overlay"><div class="modal task-review-modal"><div class="modal-head"><div><div class="eyebrow">ONE-TIME PRE-FLIGHT</div><h2>执行前总审核 · 第 ${review.episodeNumber} 集</h2></div><button class="modal-close" data-action="close-workflow-review">×</button></div><p class="hint">这一集只会在第一次开始前审核一次。确认后会新建一个普通 ChatGPT 聊天，按步骤分别开聊天并保存恢复记录；过程中不再弹出逐步审核。</p><div class="form-grid" style="margin-top:14px"><div class="field wide"><label>要执行的步骤</label><div class="form-actions"><label><input id="workflow-step-script" type="checkbox" ${review.selection.script ? 'checked' : ''}> 原文→剧本</label><label><input id="workflow-step-shotlist" type="checkbox" ${review.selection.shotlist ? 'checked' : ''}> 剧本→分镜</label><label><input id="workflow-step-storyboard" type="checkbox" ${review.selection.storyboard ? 'checked' : ''}> 分镜→提示词</label></div></div><div class="field"><label>提示词模板版本</label><select id="workflow-prompt-mode"><option value="30" ${review.promptMode === '30' ? 'selected' : ''}>30 秒（默认）</option><option value="15" ${review.promptMode === '15' ? 'selected' : ''}>15 秒</option></select></div><div class="field"><label>回收结果</label><select id="workflow-reply-mode"><option value="auto" ${(state.project.chatGptRunner?.replyMode || 'auto') === 'auto' ? 'selected' : ''}>自动识别（附件优先）</option><option value="attachment" ${state.project.chatGptRunner?.replyMode === 'attachment' ? 'selected' : ''}>只收 TXT 附件</option><option value="message" ${state.project.chatGptRunner?.replyMode === 'message' ? 'selected' : ''}>只收聊天正文</option></select></div></div>${error}${selectedWorkflowSteps(review.selection).map(stepEditor).join('')}<div class="form-actions" style="margin-top:14px"><button class="button secondary" data-action="refresh-workflow-review">更新审核内容</button><button class="button secondary" data-action="open-chatgpt">打开 ChatGPT</button><button class="button secondary" data-action="close-workflow-review">暂不执行</button><button class="button" data-action="confirm-workflow-review" ${ready ? '' : 'disabled'}>确认并连续执行</button></div></div></div>`;
}

async function runSingleWorkflow(review) {
  const payload = {
    episodeNumber: review.episodeNumber,
    selection: review.selection,
    promptMode: review.promptMode,
    prompts: review.prompts,
    replyMode: document.querySelector('#workflow-reply-mode')?.value || state.project.chatGptRunner?.replyMode || 'auto'
  };
  state.workflowReview = null;
  closeModal();
  state.workLocked = true;
  state.workflowRunning = true;
  state.workLabel = `正在处理第 ${payload.episodeNumber} 集：逐步执行并保存恢复记录。`;
  render();
  try {
    const result = await window.directorApi.executeWorkflow(deepCopy(state.project), payload);
    if (!result.ok) return showToast(`第 ${payload.episodeNumber} 集停在${workflowStepTitle(result.failedStep || '')}：${result.reason}`);
    state.project = ensureClientProjectShape(await window.directorApi.rescanProject(state.project));
    state.projects = state.projects.map((item) => item.id === state.project.id ? state.project : item);
    await activateEpisode(payload.episodeNumber);
    await saveProject({ renderAfter: false });
    showToast(`第 ${payload.episodeNumber} 集已连续完成 ${result.completed.length} 个步骤，并写回项目文件夹。`);
  } catch (error) {
    showToast(`生成未完成：${error.message || String(error)}`);
  } finally {
    state.workflowRunning = false;
    state.workLocked = false;
    state.workLabel = '';
    render();
  }
}

function workflowBatchEpisodes(draft) {
  const start = Math.min(Number(draft.start), Number(draft.end));
  const end = Math.max(Number(draft.start), Number(draft.end));
  return (state.project.episodes || []).map((episode) => Number(episode.number)).filter((number) => number >= start && number <= end);
}

async function refreshWorkflowBatchPreview({ preserve = true } = {}) {
  const draft = state.workflowBatchDraft;
  if (!draft) return;
  draft.selection = workflowSelectionFromInputs(draft.selection);
  draft.promptMode = (document.querySelector('#workflow-prompt-mode')?.value || draft.promptMode) === '15' ? '15' : '30';
  if (preserve) draft.prompts = workflowPromptInputs(draft.prompts);
  const episodes = workflowBatchEpisodes(draft);
  if (!episodes.includes(Number(draft.previewEpisode))) draft.previewEpisode = episodes[0];
  try {
    draft.plan = await window.directorApi.prepareWorkflow(state.project, { episodeNumber: draft.previewEpisode, selection: draft.selection, promptMode: draft.promptMode, prompts: draft.prompts });
    draft.error = '';
    for (const step of draft.plan.steps) if (!draft.prompts[step.step]) draft.prompts[step.step] = step.prompt;
  } catch (error) {
    draft.plan = null;
    draft.error = error.message || String(error);
  }
  renderWorkflowBatchModal();
}

async function openWorkflowBatch() {
  const episodes = state.project.episodes || [];
  const templates = normalizeWorkflowTemplates(state.project.workflowTemplates);
  state.workflowBatchDraft = { start: Number(episodes[0]?.number || state.project.currentEpisode), end: Number(episodes.at(-1)?.number || state.project.currentEpisode), previewEpisode: Number(state.project.currentEpisode), selection: { script: true, shotlist: true, storyboard: true }, promptMode: templates.promptMode || '30', prompts: {}, plan: null, completed: [], nextIndex: 0, status: 'review', error: '', currentEpisode: null };
  const saved = await window.directorApi.batchState(state.project);
  if(saved && saved.status !== 'completed') {
    state.workflowBatchDraft = {...saved,status:'paused',error:'已恢复上次批量检查点；已完成步骤不会重复发送。'};
    return refreshWorkflowBatchPreview({preserve:true});
  }
  await refreshWorkflowBatchPreview({ preserve: false });
}

function renderWorkflowBatchModal() {
  const draft = state.workflowBatchDraft;
  if (!draft) return closeModal();
  const episodes = workflowBatchEpisodes(draft);
  const running = state.workflowRunning;
  const planByStep = new Map((draft.plan?.steps || []).map((step) => [step.step, step]));
  const stepEditor = (step) => !draft.selection[step] ? '' : `<article class="card" style="margin-top:10px"><div class="card-title"><h3>${workflowStepTitle(step)}</h3></div><p class="hint">${escapeHTML(planByStep.get(step)?.template?.name || '')} · ${escapeHTML(planByStep.get(step)?.inputName || '')}</p><textarea id="workflow-prompt-${step}" class="task-review-prompt">${escapeHTML(draft.prompts[step] || planByStep.get(step)?.prompt || '')}</textarea></article>`;
  if (running) {
    modalRoot.innerHTML = `<div class="modal-overlay batch-overlay"><div class="modal batch-modal"><div class="modal-head"><div><div class="eyebrow">BATCH WORKFLOW</div><h2>正在处理第 ${draft.currentEpisode ? directorEpisodeSlots.label(state.project, draft.currentEpisode) : '—'} 集</h2></div></div><div class="batch-progress"><strong>${draft.completed.length} / ${episodes.length} 已完成</strong></div><p class="hint">每一步独立聊天，已完成且输入未变化的步骤会从记录恢复。界面已锁定，电脑会保持唤醒。</p><div class="form-actions"><button class="button danger" data-action="stop-workflow-batch">暂停网页等待</button><button class="button secondary" data-action="open-chatgpt">打开 ChatGPT</button></div></div></div>`;
    return;
  }
  const error = draft.error ? `<div class="notice danger-note" style="margin-top:12px">${escapeHTML(draft.error)}</div>` : '';
  modalRoot.innerHTML = `<div class="modal-overlay batch-overlay"><div class="modal batch-modal"><div class="modal-head"><div><div class="eyebrow">BATCH WORKFLOW REVIEW</div><h2>批量工作流 · 一次总审核</h2></div><button class="modal-close" data-action="close-workflow-batch">×</button></div><p class="hint">本次审核只出现一次。确认后，每一集各自新建一个聊天，所选步骤在该聊天中连续执行。</p><div class="form-grid"><div class="field"><label>开始集</label><select id="workflow-batch-start">${state.project.episodes.map((episode) => `<option value="${episode.number}" ${Number(draft.start) === Number(episode.number) ? 'selected' : ''}>第 ${directorEpisodeSlots.label(state.project, episode.number)} 集</option>`).join('')}</select></div><div class="field"><label>结束集</label><select id="workflow-batch-end">${state.project.episodes.map((episode) => `<option value="${episode.number}" ${Number(draft.end) === Number(episode.number) ? 'selected' : ''}>第 ${directorEpisodeSlots.label(state.project, episode.number)} 集</option>`).join('')}</select></div><div class="field"><label>审核预览集</label><select id="workflow-batch-preview">${episodes.map((episode) => `<option value="${episode}" ${Number(draft.previewEpisode) === episode ? 'selected' : ''}>第 ${directorEpisodeSlots.label(state.project, episode)} 集</option>`).join('')}</select></div><div class="field"><label>提示词版本</label><select id="workflow-prompt-mode"><option value="30" ${draft.promptMode === '30' ? 'selected' : ''}>30 秒（默认）</option><option value="15" ${draft.promptMode === '15' ? 'selected' : ''}>15 秒</option></select></div></div><div class="form-actions" style="margin-top:10px"><label><input id="workflow-step-script" type="checkbox" ${draft.selection.script ? 'checked' : ''}> 原文→剧本</label><label><input id="workflow-step-shotlist" type="checkbox" ${draft.selection.shotlist ? 'checked' : ''}> 剧本→分镜</label><label><input id="workflow-step-storyboard" type="checkbox" ${draft.selection.storyboard ? 'checked' : ''}> 分镜→提示词</label></div>${error}${selectedWorkflowSteps(draft.selection).map(stepEditor).join('')}<div class="form-actions" style="margin-top:14px"><button class="button secondary" data-action="refresh-workflow-batch">更新范围和审核</button><button class="button secondary" data-action="open-chatgpt">打开 ChatGPT</button><button class="button" data-action="start-workflow-batch" ${draft.plan?.steps?.length && !draft.error ? '' : 'disabled'}>${draft.status === 'paused' ? '继续剩余任务' : `确认并批量执行（${episodes.length} 集）`}</button></div></div></div>`;
}

async function runWorkflowBatch() {
  const draft = state.workflowBatchDraft;
  if (!draft) return;
  const signature=JSON.stringify([draft.start,draft.end,draft.selection,draft.promptMode,draft.prompts]);
  if(draft.scopeSignature!==signature){draft.nextIndex=0;draft.completed=[];draft.scopeSignature=signature;}
  const episodes = workflowBatchEpisodes(draft);
  if (!episodes.length) return showToast('请选择至少一集。');
  state.workflowRunning = true;
  state.batchStopRequested = false;
  state.workLocked = true;
  draft.error = '';
  draft.status = 'running';
  render();
  try {
    await window.directorApi.batchState(state.project,deepCopy(draft));
    for (let index = draft.nextIndex; index < episodes.length; index += 1) {
      const episodeNumber = episodes[index];
      draft.currentEpisode = episodeNumber;
      await window.directorApi.batchState(state.project,deepCopy(draft));
      state.workLabel = `正在批量处理第 ${episodeNumber} 集：逐步执行并保存恢复记录。`;
      render();
      const result = await window.directorApi.executeWorkflow(deepCopy(state.project), { episodeNumber, selection: draft.selection, promptMode: draft.promptMode, prompts: draft.prompts, replyMode: state.project.chatGptRunner?.replyMode || 'auto' });
      if (!result.ok) {
        draft.status = 'paused';
        draft.nextIndex = index;
        draft.error = `第 ${episodeNumber} 集：${result.reason}`;
        break;
      }
      draft.completed.push(episodeNumber);
      draft.nextIndex = index + 1;
      await window.directorApi.batchState(state.project,deepCopy(draft));
      if (state.batchStopRequested) {
        draft.status = 'paused';
        draft.error = '已在当前集保存后暂停。';
        break;
      }
    }
    if (draft.nextIndex >= episodes.length) draft.status = 'completed';
    state.project = ensureClientProjectShape(await window.directorApi.rescanProject(state.project));
    state.projects = state.projects.map((item) => item.id === state.project.id ? state.project : item);
    await activateEpisode(state.project.currentEpisode);
    await saveProject({ renderAfter: false });
    if (draft.status === 'completed') showToast(`批量工作流已完成 ${draft.completed.length} 集。`);
  } catch (error) {
    draft.status = 'paused';
    draft.error = error.message || String(error);
  } finally {
    draft.currentEpisode = null;
    state.workflowRunning = false;
    state.workLocked = false;
    state.workLabel = '';
    try { await window.directorApi.batchState(state.project,deepCopy(draft)); }
    catch(error) { draft.error = '保存恢复记录失败：' + error.message; }
    render();
  }
}

let compositionActive=false,renderAfterComposition=false;
const highlightTimers=new WeakMap();
const composingInputOwners = new WeakMap();
function inputOwnerMatches(target) {
  if (target?.isConnected === false) return false;
  const expected = target?.dataset?.editorContext || composingInputOwners.get(target);
  return !expected || expected === viewportContextKey();
}
const editorComposition = window.EditorFormatting.createCompositionGuard({
  commit: (target) => {
    syncBoundInput(target, { committed: true });
    if (target.matches?.('textarea[data-highlight-layer]')) updateHighlightedEditor(target, { committed: true });
  },
  settled: (target) => {
    clearCompositionPreview(target);
    compositionViews.delete(target);
    composingInputOwners.delete(target);
    updateEditorStats(target);
    compositionActive = editorComposition.busy();
    if (!compositionActive && renderAfterComposition) {
      renderAfterComposition = false;
      render();
    }
  }
});
document.addEventListener('compositionstart', (event) => {
  compositionActive = true;
  composingInputOwners.set(event.target, event.target.dataset?.editorContext || viewportContextKey());
  clearCompositionPreview();
  if (event.target.matches?.('textarea[data-highlight-layer]')) {
    updateHighlightedEditor(event.target, { committed: true });
    compositionViews.set(event.target, { baseValue: event.target.value, start: event.target.selectionStart, end: event.target.selectionEnd, data: '', useNative: false });
  }
  clearTimeout(highlightTimers.get(event.target));
  editorComposition.start(event.target);
});
document.addEventListener('compositionupdate', (event) => {
  clearTimeout(highlightTimers.get(event.target));
  if (event.target.matches?.('textarea[data-highlight-layer]')) {
    const previous = compositionViews.get(event.target) || { start: event.target.selectionStart, end: event.target.selectionEnd };
    compositionViews.set(event.target, { ...previous, data: String(event.data || ''), useNative: false });
    updateHighlightedEditor(event.target, { composing: true });
  }
});
document.addEventListener('compositionend', (event) => {
  const view = compositionViews.get(event.target);
  if (view) {
    compositionViews.set(event.target, { ...view, data: String(event.data || ''), useNative: true });
    updateCompositionPreview(event.target);
  }
  editorComposition.end(event.target);
});
function render() {
  if(compositionActive){renderAfterComposition=true;return;}
  reviewUI.beforeRender();
  if (state.renderedContextKey && appRoot.querySelector('.shell') && state.pendingViewport?.key !== state.renderedContextKey) {
    state.viewports.set(state.renderedContextKey, captureVisibleViewport());
  }
  if (!state.project) return renderEmpty();
  ensureClientProjectShape(state.project);
  const pages = { 'director-home':directorUI.renderPage,'shot-studio':directorUI.renderPage,'html-relationships':htmlLibraryUI.renderPage,'html-assets':htmlLibraryUI.renderPage,'html-post':htmlLibraryUI.renderPage,'html-other':htmlLibraryUI.renderPage,'quality-center':automationUI.renderQuality,review: reviewUI.renderReview, 'review-notes': reviewUI.renderNotes, generate: renderGenerate, workbench: workbenchRender, production: productionRender, home: renderHome, project: renderProject, outline: renderOutline, script: renderScript, shotlist: renderShotlist, storyboard: renderStoryboard, assets: renderAssets, ai: renderGenerate, rules: renderRules, quality: renderQuality, export: renderExport };
  if (!pages[state.view]) state.view = 'script';
  // Background updates must keep the live textarea and its native undo history.
  const liveEditor = document.activeElement?.matches?.('textarea[data-highlight-layer]') ? document.activeElement
    : appRoot.querySelector('textarea[data-highlight-layer]');
  const liveWrapper = liveEditor?.closest('.highlight-editor');
  const retainEditor = liveWrapper && state.renderedContextKey === viewportContextKey()
    && String(getPath(state.project, liveEditor.dataset.bind) || '').replace(/\r\n/g, '\n') === liveEditor.value;
  state.renderedContextKey = viewportContextKey();
  renderShell(pages[state.view](), { liveEditor: retainEditor ? liveEditor : null });
  reviewUI.afterRender();
  workspaceUI.afterRender();
  assistantUI.afterRender();
  window.DirectorUIMotion?.afterRender(state.project ? state.view : 'welcome');
  observeTopbar();
  if(state.view==='quality-center')void automationUI.load();
  if(['director-home','shot-studio'].includes(state.view))directorUI.afterRender();
  if(state.view.startsWith('html-'))htmlLibraryUI.afterRender();
  refreshHighlightedEditors();
  refreshEditorStats();
  updateSaveIndicators();
  centerSelectedNavigation();
  updateChromeConnectionControls();
  restorePendingViewport();
  if (state.focusEditorAfterEpisodeLoad && !state.actionDialog) {
    state.focusEditorAfterEpisodeLoad = false;
    document.querySelector('textarea[data-highlight-layer]')?.focus({ preventScroll: true });
  }
  if (state.view === 'review') reviewUI.restoreNavigation();
  applyMembershipAccess();
  if (state.membershipModalOpen) renderMembershipModal();
  else if (state.builtinTemplatePreview) renderBuiltinTemplateModal();
  else if (state.apiBatch && !state.apiBatchMinimized) renderApiBatchModal();
  else if (state.workflowBatchDraft && (!state.workflowRunning || interfaceIsLocked())) renderWorkflowBatchModal();
  else if (state.workflowReview) renderWorkflowReviewModal();
  else if (state.batchDraft && (!state.batchRunning || interfaceIsLocked())) renderBatchModal();
  else if (state.taskReview) renderTaskReviewModal();
  else if (state.actionDialog) renderActionDialog();
  else if (state.projectWizard) renderProjectWizard();
  else if (state.projectChooserOpen) renderProjectChooser();
  else closeModal();
  if (state.episodeDisplayTiming && state.episodeDisplayTiming.token === state.episodeLoadToken) {
    window.directorLastEpisodeTiming.displayMs = Math.round(performance.now() - state.episodeDisplayTiming.startedAt);
    state.episodeDisplayTiming = null;
    if (window.directorRuntimeInfo?.diagnostics) window.directorApi.reportEpisodeSwitch?.(window.directorLastEpisodeTiming);
  }
}

document.addEventListener('toggle', (event) => {
  const panel = event.target;
  if (!(panel instanceof HTMLDetailsElement) || !panel.dataset.checkPanel) return;
  if (panel.dataset.checkPanel === 'storyboard') state.storyboardChecksExpanded = panel.open;
  if (panel.dataset.checkPanel === 'script') state.scriptChecksExpanded = panel.open;
}, true);

function syncBoundInput(target, { committed = false } = {}) {
  if (!membershipCanEdit() || !state.project || !target.matches?.('[data-bind]') || !inputOwnerMatches(target)) return;
  const value = target.type === 'number' ? Number(target.value) : target.value;
  const changed = getPath(state.project, target.dataset.bind) !== value;
  if (!changed && !committed) return;
  if (changed) {
    setPath(state.project, target.dataset.bind, value);
    if (/^(?:source|outline|script|shotlist|storyboard)\.content$/.test(target.dataset.bind)) markDocumentDirty(target.dataset.bind);
  }
  if (target.dataset.bind === 'targetDuration') {
    const episode = activeEpisode();
    if (episode) episode.targetSeconds = value;
  }
  if (target.dataset.bind === 'shotlist.content' && (committed || !editorComposition.isBlocked(target))) {
    if (target.value.trim() && activeEpisode()) activeEpisode().shotlistSkipped = false;
    updateShotlistDurationDisplay(target.value);
    state.shotlistVerdict = null;
    const checkSlot = document.querySelector('.sidebar-check-slot');
    if (state.view === 'shotlist' && checkSlot) checkSlot.innerHTML = renderLocalCheckContext('shotlist') + renderShotlistChecks();
  }
  if (changed) markDirty();
}

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'recent-project-search') {
    state.projectHistoryQuery = target.value;
    const rows = document.querySelector('#recent-project-rows');
    if (rows) rows.innerHTML = renderRecentProjectRows();
    return;
  }
  if (event.isComposing && !composingInputOwners.has(target)) {
    composingInputOwners.set(target, target.dataset?.editorContext || viewportContextKey());
  }
  if (event.isComposing && target.matches?.('textarea[data-highlight-layer]')) {
    const previous = compositionViews.get(target) || { baseValue: String(getPath(state.project, target.dataset.bind) || ''), start: Math.max(0, target.selectionStart - String(event.data || '').length), end: Math.max(0, target.selectionStart - String(event.data || '').length) };
    compositionViews.set(target, { ...previous, data: String(event.data ?? previous.data ?? ''), useNative: true });
  }
  editorComposition.input(target, event.isComposing);
  if (target.matches?.('textarea[data-highlight-layer]') && editorComposition.isBlocked(target)) {
    const view = compositionViews.get(target);
    if (view) compositionViews.set(target, { ...view, useNative: true });
  }
  compositionActive = editorComposition.busy();
  if (!membershipCanEdit() && target.matches('[data-bind],[data-asset-id]')) return;
  if (target.id === 'document-find-query') renderDocumentFindResults();
  if (state.actionDialog?.type === 'find-replace' && !state.actionDialog.preview) {
    if (target.id === 'find-replace-find') state.actionDialog.needle = target.value;
    if (target.id === 'find-replace-replace') state.actionDialog.replacement = target.value;
  }
  if (target.matches('[data-inline-document-find]')) runInlineDocumentFind(target.dataset.inlineDocumentFind, target.value);
  if (target.matches('[data-asset-find]')) runAssetSearch(target.value);
  if (target.id === 'batch-template' && state.batchDraft) state.batchDraft.template = target.value;
  if (target.id === 'batch-manual-instruction' && state.batchDraft) state.batchDraft.manualInstruction = target.value;
  if (target.id === 'task-review-prompt' && state.taskReview) state.taskReview.prompt = target.value;
  if (target.id === 'task-review-reply-mode' && state.taskReview) {
    const task = state.project?.queue?.find((item) => item.id === state.taskReview.taskId);
    const prompt = document.querySelector('#task-review-prompt');
    if (task && prompt) {
      task.replyMode = target.value;
      prompt.value = promptForReplyMode(prompt.value, target.value);
      state.taskReview.prompt = prompt.value;
    }
  }
  if (target.id === 'source-filter') {
    const query = target.value.trim().toLocaleLowerCase();
    document.querySelectorAll('[data-source-name]').forEach((item) => {
      item.hidden = Boolean(query) && !item.dataset.sourceName.toLocaleLowerCase().includes(query);
    });
  }
  if (target.matches('[data-bind]') && state.project) {
    syncBoundInput(target);
    if (target.matches('textarea[data-highlight-layer]') && !event.isComposing && !compositionActive) updateEditorStats(target);
    if (target.dataset.highlightLayer && editorComposition.isBlocked(target)) {
      updateHighlightedEditor(target, { composing: true });
    } else if (target.dataset.highlightLayer && !event.isComposing && !compositionActive) {
      clearTimeout(highlightTimers.get(target));
      highlightTimers.set(target,setTimeout(()=>{if(target.isConnected && !editorComposition.isBlocked(target))updateHighlightedEditor(target);},80));
    }
  }
  if (target.matches('[data-asset-id]') && state.project) {
    const asset = state.project.assets.find((item) => item.id === target.dataset.assetId);
    if (asset) asset[target.dataset.assetField] = target.value;
    markDirty();
  }
});

document.addEventListener('selectionchange', () => {
  const target = document.activeElement;
  if (target?.matches?.('textarea[data-highlight-layer]')) {
    if (editorComposition.isBlocked(target)) updateCompositionPreview(target);
    else updateEditorStats(target);
  }
});

document.addEventListener('dragstart', (event) => {
  const card = event.target.closest?.('[data-asset-drag-path]');
  const filePath = card?.dataset.assetDragPath;
  if (!filePath || !window.directorApi?.startAssetDrag) return;
  // Chromium's own HTML5 drag and Electron's native file drag must not run at
  // the same time. The double drag was the reason the desktop process could exit.
  event.preventDefault();
  window.directorApi.startAssetDrag(filePath);
});

document.addEventListener('scroll', (event) => {
  if (event.target.matches?.('textarea[data-highlight-layer]')) updateHighlightedEditor(event.target);
}, true);

document.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest?.('[data-sidebar-resizer]');
  if (!handle || event.button !== 0) return;
  const shell = handle.closest('.shell');
  if (!shell) return;
  sidebarResizeSession = { handle, shell, pointerId: event.pointerId, shellLeft: shell.getBoundingClientRect().left };
  handle.setPointerCapture?.(event.pointerId);
  handle.classList.add('active');
  document.body.classList.add('sidebar-resizing');
  event.preventDefault();
});

document.addEventListener('pointermove', (event) => {
  if (!sidebarResizeSession || event.pointerId !== sidebarResizeSession.pointerId) return;
  const width = clampSidebarWidth(event.clientX - sidebarResizeSession.shellLeft);
  state.sidebarWidth = width;
  sidebarResizeSession.shell.style.setProperty('--sidebar-width', `${width}px`);
  sidebarResizeSession.handle.setAttribute('aria-valuenow', String(width));
  event.preventDefault();
});

function finishSidebarResize(event) {
  if (!sidebarResizeSession || (event?.pointerId != null && event.pointerId !== sidebarResizeSession.pointerId)) return;
  const { handle, pointerId } = sidebarResizeSession;
  try { handle.releasePointerCapture?.(pointerId); } catch {}
  handle.classList.remove('active');
  document.body.classList.remove('sidebar-resizing');
  rememberSidebarWidth(state.sidebarWidth);
  sidebarResizeSession = null;
}

document.addEventListener('pointerup', finishSidebarResize);
document.addEventListener('pointercancel', finishSidebarResize);
document.addEventListener('dblclick', (event) => {
  const handle = event.target.closest?.('[data-sidebar-resizer]');
  if (!handle) return;
  state.sidebarWidth = SIDEBAR_WIDTH_DEFAULT;
  handle.closest('.shell')?.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
  handle.setAttribute('aria-valuenow', String(state.sidebarWidth));
  rememberSidebarWidth(state.sidebarWidth);
});

async function handleAppKeydown(event) {
  if (event.isComposing || event.keyCode === 229 || editorComposition.isBlocked(event.target)) return;
  if(event.defaultPrevented||event.target.closest?.('#director-assistant-panel'))return;
  if (modalRoot.querySelector('.modal')) return;
  if (event.target.matches?.('[data-sidebar-resizer]') && ['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
    event.preventDefault();
    state.sidebarWidth = event.key === 'Home'
      ? SIDEBAR_WIDTH_DEFAULT
      : clampSidebarWidth(state.sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16));
    event.target.closest('.shell')?.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
    event.target.setAttribute('aria-valuenow', String(state.sidebarWidth));
    rememberSidebarWidth(state.sidebarWidth);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && event.target.matches?.('textarea[data-highlight-layer]') && state.project && membershipCanEdit() && !interfaceIsLocked()) {
    event.preventDefault();
    const editor = event.target;
    const hadSelection = editor.selectionEnd > editor.selectionStart;
    const suffixLength = editor.value.length - editor.selectionEnd;
    const result = window.EditorFormatting?.toggleBold(editor.value, editor.selectionStart, editor.selectionEnd);
    if (!result) return;
    editor.value = result.value;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    // Do not leave the original multi-line selection active: the textarea's
    // native selection paint would cover the semantic layer with large blue
    // rectangles and make the editor look scrambled.
    const caret = hadSelection ? result.value.length - suffixLength : result.selectionStart;
    editor.setSelectionRange(caret, caret);
    updateHighlightedEditor(editor);
    showToast(result.enabled ? '已加粗并高亮所选文字。' : '已取消加粗高亮。');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && state.project && !interfaceIsLocked() && ['outline', 'script', 'shotlist', 'storyboard'].includes(state.view)) {
    event.preventDefault();
    return openDocumentFind(state.view);
  }
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's' || !state.project || !membershipCanEdit() || interfaceIsLocked()) return;
  if (event.shiftKey) {
    event.preventDefault();
    await documentSaveQueue.drain();
    for (const kind of dirtyDocumentKinds()) await saveFolderDocument(kind);
    if (state.dirty) await saveProject({ renderAfter: false });
    return showToast(dirtyDocumentKinds().length ? '仍有新修改待保存。' : '所有修改已保存。');
  }
  const kind = state.view === 'project' ? 'source' : state.view === 'outline' ? 'outline' : state.view === 'script' ? 'script' : state.view === 'shotlist' ? 'shotlist' : state.view === 'storyboard' ? 'storyboard' : null;
  if (!kind) return;
  event.preventDefault();
  await saveFolderDocument(kind);
}

document.addEventListener('keydown', (event) => {
  void handleAppKeydown(event).catch(reportRendererFailure);
});

async function handleAppChange(event) {
  if (event.target.matches('[data-template-slot]')) {
    if (!membershipCanUseBuiltinTemplates()) {
      state.membershipModalOpen = true;
      render();
      return showToast('内置提示词需要 Plus、Pro、永久会员、开发者或管理员。');
    }
    const selected = await window.directorApi.selectBuiltinTemplate(event.target.value);
    const slot = event.target.dataset.templateSlot;
    state.project.workflowTemplates = normalizeWorkflowTemplates(state.project.workflowTemplates);
    state.project.workflowTemplates[slot] = selected;
    markDirty();
    await saveProject({ renderAfter: false });
    render();
    return showToast(`已启用内置提示词：${selected.label || selected.name}`);
  }
  if (!membershipCanEdit() && event.target.matches('[data-bind],[data-document-format],[data-rule-id],[data-reference-id],[data-reference-format-id],[data-asset-id]')) return;
  if (event.target.id === 'ai-provider') { aiProviderChanged(); return; }
  if (event.target.matches('[data-document-format]')) {
    await switchDocumentFormat(event.target.dataset.documentFormat, event.target.value);
    return;
  }
  if (event.target.id === 'task-review-reply-mode' && state.taskReview) {
    const task = state.project?.queue?.find((item) => item.id === state.taskReview.taskId);
    const prompt = document.querySelector('#task-review-prompt');
    if (task && prompt) {
      task.replyMode = event.target.value;
      prompt.value = promptForReplyMode(prompt.value, event.target.value);
      state.taskReview.prompt = prompt.value;
    }
    return;
  }
  if (event.target.matches('[data-bind]') && state.project) {
    if (!inputOwnerMatches(event.target)) return;
    const value = event.target.type === 'number' ? Number(event.target.value) : event.target.value;
    setPath(state.project, event.target.dataset.bind, value);
    if (event.target.dataset.bind.startsWith('chatGptRunner.')) state.chromeStatus = null;
    markDirty();
    if (event.target.dataset.bind === 'generationMode') {
      if (value !== 'api') state.project.chatGptRunner.mode = value;
      await saveProject({ renderAfter: false });
      render();
    } else if (event.target.dataset.bind === 'chatGptRunner.mode') {
      state.project.generationMode = value;
      render();
    }
    return;
  }
  if (event.target.id === 'batch-preview-episode' && state.batchDraft && !state.batchRunning) {
    readBatchModalInputs();
    await refreshBatchPreview();
    return;
  }
  if (event.target.id === 'project-switch') {
    const selected = state.projects.find((project) => project.id === event.target.value) || null;
    if (!await switchProject(selected, { openFolder: true }) && !state.projectSwitchPending) render();
  }
  if (event.target.id === 'episode-switch' && state.project) {
    const nextEpisode = Number(event.target.value);
    if (!await selectWorkspaceEpisode(nextEpisode)) render();
  }
  if (event.target.matches('[data-document-select]') && state.project) {
    await openFolderDocument(event.target.dataset.documentSelect, event.target.value);
  }
  if (event.target.matches('[data-rule-id]') && state.project) {
    const rule = state.project.ruleDocuments.find((item) => item.id === event.target.dataset.ruleId);
    if (rule) rule.enabled = event.target.checked;
    markDirty();
  }
  if (event.target.matches('[data-reference-id]') && state.project) {
    const reference = state.project.referenceDocuments.find((item) => item.id === event.target.dataset.referenceId);
    if (reference) reference.enabled = event.target.checked;
    markDirty();
  }
  if (event.target.matches('[data-reference-format-id]') && state.project) {
    const reference = state.project.referenceDocuments.find((item) => item.id === event.target.dataset.referenceFormatId);
    if (reference) reference.outputFormat = event.target.checked;
    markDirty();
  }
  if (event.target.matches('[data-asset-id]') && state.project) {
    const asset = state.project.assets.find((item) => item.id === event.target.dataset.assetId);
    if (asset) asset[event.target.dataset.assetField] = event.target.value;
    markDirty();
  }
}

document.addEventListener('change', (event) => {
  void handleAppChange(event).catch(reportRendererFailure);
});

async function handleAppClick(event) {
  const button = event.target.closest('[data-action], [data-view]');
  if (!button) return;
  const requestedAction = button.dataset.action;
  if (requestedAction?.startsWith('ux-')) return handleUsabilityAction(requestedAction);
  if (requestedAction?.startsWith('workspace-')) return workspaceUI.action(requestedAction, button);
  if(requestedAction?.startsWith('assistant-'))return assistantUI.action(requestedAction,button);
  if(requestedAction?.startsWith('director-'))return directorUI.action(requestedAction,button);
  if(requestedAction?.startsWith('html-'))return htmlLibraryUI.action(requestedAction,button);
  if(requestedAction?.startsWith('flow-')||requestedAction?.startsWith('quality-'))return automationUI.action(requestedAction);
  if (requestedAction === 'open-membership') {
    state.membershipModalOpen = true;
    renderMembershipModal();
    return;
  }
  if (requestedAction === 'close-membership') {
    state.membershipModalOpen = false;
    closeModal();
    return;
  }
  if (requestedAction === 'membership-copy-machine') {
    await window.directorApi.productionCopy(state.membership?.machineCode || '');
    return showToast('电脑识别码已复制。');
  }
  if (requestedAction === 'membership-activate') {
    const token = document.querySelector('#membership-token')?.value.trim();
    if (!token) return showToast('请先粘贴激活码。');
    state.membership = await window.directorApi.membershipActivate(token);
    await refreshMembership();
    state.membershipModalOpen = true;
    render();
    return showToast('会员激活成功。');
  }
  if (requestedAction === 'membership-import') {
    const activated = await window.directorApi.membershipImport();
    if (!activated) return;
    await refreshMembership();
    state.membershipModalOpen = true;
    render();
    return showToast('授权文件已导入。');
  }
  if (requestedAction === 'membership-remove-license') {
    if (!await window.directorConfirm('移除当前授权后，将恢复为当前电脑的免费试用状态。继续吗？')) return;
    state.membership = await window.directorApi.membershipRemoveLicense();
    await refreshMembership();
    state.membershipModalOpen = true;
    render();
    return showToast('当前授权已移除。');
  }
  if (requestedAction === 'close-builtin-template') {
    state.builtinTemplatePreview = null;
    closeModal();
    if(state.builtinTemplateReturnFocus?.isConnected)state.builtinTemplateReturnFocus.focus();
    state.builtinTemplateReturnFocus=null;
    return;
  }
  if (requestedAction === 'preview-builtin-template') {
    state.builtinTemplateReturnFocus=button;
    state.builtinTemplatePreview = await window.directorApi.builtinTemplateContent(button.dataset.templateId);
    renderBuiltinTemplateModal();
    return;
  }
  if (requestedAction === 'copy-builtin-template') {
    await window.directorApi.productionCopy(state.builtinTemplatePreview?.content || '');
    return showToast('内置提示词已复制。');
  }
  if (requestedAction === 'use-builtin-template') {
    if (!state.project) return;
    const selected = await window.directorApi.selectBuiltinTemplate(button.dataset.templateId);
    state.project.workflowTemplates = normalizeWorkflowTemplates(state.project.workflowTemplates);
    state.project.workflowTemplates[selected.slot] = selected;
    if (selected.slot === 'prompt15' || selected.slot === 'prompt30') state.project.workflowTemplates.promptMode = selected.slot === 'prompt15' ? '15' : '30';
    const category = { script: 'script', shotlist: 'storyboard', prompt15: 'shared', prompt30: 'shared' }[selected.slot];
    if (category) state.project.ruleDocuments = (state.project.ruleDocuments || []).map((doc) => doc.category === category ? { ...doc, enabled: false } : doc);
    markDirty();
    await saveProject({ renderAfter: false });
    render();
    return showToast(`已设为当前模板：${selected.label}`);
  }
  if (button.dataset.view) {
    const nextView = button.dataset.view;
    state.view = nextView === 'editor' ? state.editorView : nextView;
    if (['outline', 'script', 'shotlist', 'storyboard'].includes(state.view)) state.editorView = state.view;
    render();
    if (state.view === 'script' && state.project) queuePageCheck('script');
    if (state.view === 'shotlist' && state.project) queuePageCheck('shotlist');
    if (state.view === 'storyboard' && state.project) queuePageCheck('storyboard');
    if (state.view === 'assets' && state.project) await refreshAssetPromptLibrary({ silent: true });
    return;
  }
  const action = button.dataset.action;
  if (!membershipCanEdit() && !membershipSafeActions.has(action)) {
    state.membershipModalOpen = true;
    render();
    return showToast('会员已到期，当前只能阅读。');
  }
  if (action?.startsWith('ai-') && await handleAiAction(action, button)) return;
  if (action?.startsWith('review-')) return reviewUI.action(action.slice(7), button);
  if (action === 'toggle-frog') return assistantUI.action('assistant-open');
  if (action?.startsWith('workbench-')) return workbenchAction(action.slice(10), button);
  if (action?.startsWith('production-')) return productionAction(action.slice(11), button);
  if (action === 'set-ui-theme') {
    state.uiTheme = applyUiTheme(button.dataset.theme);
    rememberUiTheme(state.uiTheme);
    document.querySelectorAll('.theme-choice').forEach(choice=>{
      const active=choice.dataset.theme===state.uiTheme;
      choice.classList.toggle('active',active);choice.setAttribute('aria-pressed',String(active));
    });
    showToast(state.uiTheme === 'dark' ? '已切换为黑色夜间主题。' : state.uiTheme === 'morandi' ? '已切换为莫兰迪护眼主题。' : '已切换为明亮主题。');
    return;
  }
  if (action === 'mascot-next-message') return assistantUI.action('assistant-open');
  if (action === 'unlock-work') {
    state.workLocked = false;
    const movedApiBatchToBackground = state.apiBatch?.status === 'running';
    if (movedApiBatchToBackground) state.apiBatchMinimized = true;
    render();
    return showToast(movedApiBatchToBackground ? '界面已解锁；API 任务已转到右下角后台任务条。' : '界面已解锁。');
  }
  if ((state.batchRunning || state.workflowRunning || state.apiBatch?.status === 'running') && interfaceIsLocked() && !['stop-batch', 'stop-workflow-batch', 'ai-batch-stop', 'open-chatgpt', 'unlock-work'].includes(action)) return;
  if (action === 'open-workflow-review') return openWorkflowReview();
  if (action === 'close-workflow-review') {
    state.workflowReview = null;
    closeModal();
    render();
    return;
  }
  if (action === 'refresh-workflow-review') return refreshWorkflowReview();
  if (action === 'confirm-workflow-review') {
    const review = state.workflowReview;
    if (!review) return;
    review.selection = workflowSelectionFromInputs(review.selection);
    review.promptMode = document.querySelector('#workflow-prompt-mode')?.value === '15' ? '15' : '30';
    review.prompts = workflowPromptInputs(review.prompts);
    try {
      review.plan = await window.directorApi.prepareWorkflow(state.project, { episodeNumber: review.episodeNumber, selection: review.selection, promptMode: review.promptMode, prompts: review.prompts });
      review.error = '';
    } catch (error) {
      review.error = error.message || String(error);
      return renderWorkflowReviewModal();
    }
    return runSingleWorkflow(review);
  }
  if (action === 'open-workflow-batch') return openWorkflowBatch();
  if (action === 'close-workflow-batch') {
    if (!state.workflowRunning) {
      state.workflowBatchDraft = null;
      closeModal();
      render();
    }
    return;
  }
  if (action === 'refresh-workflow-batch') {
    const draft = state.workflowBatchDraft;
    if (!draft) return;
    draft.start = Number(document.querySelector('#workflow-batch-start')?.value) || draft.start;
    draft.end = Number(document.querySelector('#workflow-batch-end')?.value) || draft.end;
    draft.previewEpisode = Number(document.querySelector('#workflow-batch-preview')?.value) || draft.previewEpisode;
    return refreshWorkflowBatchPreview();
  }
  if (action === 'start-workflow-batch') {
    const draft = state.workflowBatchDraft;
    if (!draft) return;
    draft.start = Number(document.querySelector('#workflow-batch-start')?.value) || draft.start;
    draft.end = Number(document.querySelector('#workflow-batch-end')?.value) || draft.end;
    draft.previewEpisode = Number(document.querySelector('#workflow-batch-preview')?.value) || draft.previewEpisode;
    draft.selection = workflowSelectionFromInputs(draft.selection);
    draft.promptMode = document.querySelector('#workflow-prompt-mode')?.value === '15' ? '15' : '30';
    draft.prompts = workflowPromptInputs(draft.prompts);
    if (!draft.status || draft.status !== 'paused') { draft.nextIndex = 0; draft.completed = []; }
    return runWorkflowBatch();
  }
  if (action === 'stop-workflow-batch') {
    state.batchStopRequested = true;
    await window.directorApi.productionStop(state.project);
    if (state.workflowBatchDraft) state.workflowBatchDraft.error = '已请求暂停网页等待，稍后可继续回收。';
    return renderWorkflowBatchModal();
  }
  if (action === 'open-task-review') {
    const task = state.project?.queue?.find((item) => item.id === button.dataset.taskId);
    return openTaskReview(task);
  }
  if (action === 'close-task-review') {
    state.taskReview = null;
    closeModal();
    render();
    return;
  }
  if (action === 'close-action-dialog') return closeActionDialog();
  if (action === 'confirm-action-dialog') return confirmActionDialog();
  if (action === 'navigate-document-find') return navigateInlineDocumentFind(button.dataset.findKind, button.dataset.findDirection);
  if (action === 'locate-document-find') return locateDocumentFind(button.dataset.findKind, button.dataset.findStart, button.dataset.findEnd, button.dataset.findLine);
  if (action === 'confirm-task-review') {
    const review = state.taskReview;
    const task = state.project?.queue?.find((item) => item.id === review?.taskId);
    if (!task) { state.taskReview = null; return closeModal(); }
    task.replyMode = document.querySelector('#task-review-reply-mode')?.value || state.project.chatGptRunner?.replyMode || 'auto';
    task.prompt = promptForReplyMode(document.querySelector('#task-review-prompt')?.value.trim() || review.prompt, task.replyMode);
    if (!task.prompt) return showToast('发送内容不能为空。');
    task.status = '等待发送';
    task.note = '审核通过，正在执行。';
    state.taskReview = null;
    closeModal();
    await sendTask(task);
    return;
  }
  if (action === 'open-batch-script') return openBatchModal('script');
  if (action === 'open-batch-storyboard') return openBatchModal('storyboard');
  if (action === 'close-batch') {
    if (!state.batchRunning) { state.batchDraft = null; closeModal(); }
    return;
  }
  if (action === 'refresh-batch-preview') {
    readBatchModalInputs();
    return refreshBatchPreview();
  }
  if (action === 'capture-batch-reply') return capturePausedBatchReply();
  if (action === 'start-batch') {
    readBatchModalInputs();
    state.batchDraft.nextIndex = 0;
    state.batchDraft.completed = [];
    return runBatchGeneration();
  }
  if (action === 'resume-batch') {
    readBatchModalInputs();
    return runBatchGeneration();
  }
  if (action === 'stop-batch') {
    state.batchStopRequested = true;
    state.batchDraft.error = '将在当前集完成并保存后暂停。';
    renderBatchModal();
    return;
  }
  if (action === 'open-projects') { state.projectHistoryQuery = ''; return renderProjectChooser(); }
  if (action === 'forget-project') return forgetRecentProjects([button.dataset.projectId]);
  if (action === 'forget-all-projects') return forgetRecentProjects(state.projects.map(project => project.id));
  if (action === 'close-projects') { state.projectChooserOpen = false; return closeModal(); }
  if (action === 'select-recent-project') {
    const project = state.projects.find((item) => item.id === button.dataset.projectId);
    if (project) await switchProject(project, { openFolder: true });
    return;
  }
  if (action === 'new-project') return createProjectModal();
  if (action === 'new-project-from-file') {
    const selected = await window.directorApi.chooseProjectSeedFile();
    if (selected) createProjectModal(selected);
    return;
  }
  if (action === 'close-modal') {
    state.projectWizard = null;
    state.projectChooserOpen = false;
    return closeModal();
  }
  if (action === 'wizard-choose-parent') {
    rememberProjectWizardStep();
    const selected = await window.directorApi.chooseProjectParent();
    if (selected) state.projectWizard.parentPath = selected;
    return renderProjectWizard();
  }
  if (action === 'wizard-choose-file') {
    const selected = await window.directorApi.chooseProjectSeedFile();
    if (selected) state.projectWizard.seedFiles[button.dataset.seedKind] = selected.path;
    return renderProjectWizard();
  }
  if (action === 'wizard-remove-file') {
    delete state.projectWizard.seedFiles[button.dataset.seedKind];
    return renderProjectWizard();
  }
  if (action === 'wizard-next' || action === 'wizard-skip' || action === 'wizard-back') {
    rememberProjectWizardStep();
    if (state.projectWizard.step === 0 && action === 'wizard-next' && !state.projectWizard.title) return showToast('请先填写项目名称。');
    state.projectWizard.step = Math.max(0, Math.min(2, state.projectWizard.step + (action === 'wizard-back' ? -1 : 1)));
    return renderProjectWizard();
  }
  if (action === 'toggle-ai-drawer') { state.view = 'generate'; render(); return; }
  if (action === 'toggle-script-mode') { state.scriptMode = state.scriptMode === 'read' ? 'edit' : 'read'; render(); return; }
  if (action === 'toggle-shotlist-mode') { state.shotlistMode = state.shotlistMode === 'edit' ? 'preview' : 'edit'; render(); return; }
  if (action === 'toggle-storyboard-mode') { state.storyboardMode = state.storyboardMode === 'preview' ? 'edit' : 'preview'; render(); return; }
  if (action === 'adopt-folder') {
    const project = await window.directorApi.adoptProjectFolder();
    if (!project) return;
    if (!await switchProject(project)) return;
    const existing = state.projects.findIndex((item) => item.id === project.id || item.projectPath === project.projectPath);
    if (existing >= 0) state.projects[existing] = state.project;
    else state.projects.unshift(state.project);
    render();
    return showToast('项目文件夹已识别并打开。');
  }
  if (action === 'create-project') {
    rememberProjectWizardStep();
    const draft = state.projectWizard;
    if (!draft?.title) return showToast('请先填写项目名称。');
    if (!await saveCurrentProjectBeforeSwitch()) return;
    const project = await window.directorApi.createProject({
      title: draft.title, parentPath: draft.parentPath || undefined,
      seedFiles: draft.seedFiles, genre: draft.genre,
      targetDuration: draft.targetDuration, startEpisode: draft.startEpisode,
      currentEpisode: draft.startEpisode, totalEpisodes: draft.totalEpisodes,
      endEpisode: draft.startEpisode + draft.totalEpisodes - 1
    });
    state.projects.unshift(project);
    await switchProject(project);
    return showToast('项目已创建，已带入所选资料。');
  }
  if (!state.project && action !== 'new-project') return;
  if (action === 'choose-workflow-template') {
    const key = button.dataset.templateKey;
    const selected = await window.directorApi.chooseWorkflowTemplate(state.project, key);
    if (!selected) return;
    state.project.workflowTemplates = normalizeWorkflowTemplates(state.project.workflowTemplates);
    state.project.workflowTemplates[key] = selected;
    markDirty();
    await saveProject();
    render();
    return showToast(`已设置${selected.name}；之后会作为真实文件上传。`);
  }
  if (action === 'open-document-find') return openDocumentFind(button.dataset.kind);
  if (action === 'open-episode-find-replace') return openEpisodeFindReplace(button.dataset.kind);
  if (action === 'open-global-find-replace') return openGlobalFindReplace();
  if (action === 'edit-global-find-replace') {
    if (state.actionDialog?.busy) return;
    if (state.actionDialog?.type === 'find-replace' && state.actionDialog.scope === 'global') {
      state.actionDialog.preview = null;
      state.actionDialog.confirmLabel = '预览替换范围';
      renderActionDialog();
    }
    return;
  }
  if (action === 'save-project') return saveProject();
  if (action === 'rebuild-episodes') { rebuildEpisodes(); markDirty(); render(); return showToast('整季集数计划已更新。'); }
  if (action === 'split-episode') {
    const base = directorEpisodeSlots.baseNumber(state.project.currentEpisode);
    if (!directorEpisodeSlots.episodeByKey(state.project, base) ||
        directorEpisodeSlots.partForKey(state.project, base)) return showToast(`第 ${base} 集已经拆分。`);
    if (!await window.directorConfirm(`把第 ${base} 集拆成 ${base}上、${base}下？\n\n现有内容和文件归 ${base}上；${base}下先为空白。第 ${base + 1} 集及后续编号保持不变。`)) return;
    if (!await confirmSaveBeforeEpisodeChange(base + 0.5)) return;
    syncActiveEpisode();
    const lower = directorEpisodeSlots.splitEpisode(state.project, base);
    await activateEpisode(lower.number);
    markDirty();
    await saveProject({ renderAfter: false });
    render();
    return showToast(`已新增第 ${base} 下集；现有第 ${base} 集内容归上集。`);
  }
  if (action === 'select-episode') {
    const nextEpisode = Number(button.dataset.episode);
    return selectWorkspaceEpisode(nextEpisode);
  }
  if (action === 'import-source') return importSource();
  if (action === 'rescan-project') {
    if (!await saveCurrentProjectBeforeSwitch({ actionLabel: '刷新项目' })) return;
    const currentProject = state.project;
    const revision = state.changeRevision;
    const scanned = await window.directorApi.rescanProject(currentProject);
    if (state.project !== currentProject || state.changeRevision !== revision) return showToast('刷新期间有新编辑，已保留当前内容；保存后可再次刷新。');
    state.project = scanned;
    state.projects = state.projects.map((project) => project.id === state.project.id ? state.project : project);
    await activateEpisode(state.project.currentEpisode);
    state.dirty = false;
    render(); return showToast(`文件夹已重新识别：${state.project.source.files?.length || 0} 个原文，${state.project.episodes?.length || 0} 集。`);
  }
  if (action === 'load-source-file') {
    const sourceFile = (state.project.source.files || []).find((file) => file.path === button.dataset.sourcePath);
    const episodeNumber = Number(sourceFile?.episodeNumber) || episodeNumberFromFileName(sourceFile?.name);
    if (episodeNumber && state.project.episodes.some((episode) => Number(episode.number) === episodeNumber)) {
      if (!await confirmSaveBeforeEpisodeChange(episodeNumber)) return;
      if (!await activateEpisode(episodeNumber)) return;
      markDirty();
      render();
      return showToast(`已切换到第 ${episodeNumber} 集原文。`);
    }
    return openFolderDocument('source', button.dataset.sourcePath);
  }
  if (action === 'save-document') return saveFolderDocument(button.dataset.kind);
  if (action === 'retry-project-sync') return window.directorApi.flushProjectWrites(state.project.projectPath);
  if (action === 'export-document-word') {
    const kind = button.dataset.kind;
    button.disabled = true;
    button.textContent = '正在导出…';
    try {
      const file = await window.directorApi.exportDocumentWord(state.project, kind, contentForKind(kind), state.project.activeFiles?.[kind] || '');
      showToast(`已导出 Word：${file.name}`);
    } finally {
      if (button.isConnected) { button.disabled = false; button.textContent = '导出 Word'; }
    }
    return;
  }
  if (action === 'set-asset-filter') {
    state.assetFilter = assetPromptCategoryMeta[button.dataset.assetFilter] ? button.dataset.assetFilter : 'role';
    render();
    return;
  }
  if (action === 'refresh-asset-prompts') return refreshAssetPromptLibrary();
  if (action === 'add-asset') return addAssets(button.dataset.assetCategory);
  if (action === 'refresh-assets') return refreshAssets();
  if (action === 'save-assets') return saveProject();
  if (action === 'organize-role-asset') return organizeRoleAsset(button.dataset.assetId);
  if (action === 'import-rules') {
    const rules = await window.directorApi.importRules(state.project, button.dataset.ruleCategory);
    if (!rules.length) return;
    state.project.ruleDocuments.push(...rules);
    markDirty(); render(); return showToast(`已导入 ${rules.length} 份规则文档。`);
  }
  if (action === 'import-references') {
    const references = await window.directorApi.importReferences(state.project, button.dataset.referenceCategory);
    if (!references.length) return;
    state.project.referenceDocuments.push(...references);
    markDirty(); render(); return showToast(`已导入 ${references.length} 份参照文档；下次生成会自动发送。`);
  }
  if (action === 'locate-check') return locateStoryboardCheck(button.dataset.checkId);
  if (action === 'dismiss-check') return dismissStoryboardCheck(button.dataset.checkId);
  if (action === 'dismiss-all-checks') return dismissAllStoryboardChecks();
  if (action === 'locate-script-check') return locateScriptCheck(button.dataset.checkId);
  if (action === 'dismiss-script-check') return dismissScriptCheck(button.dataset.checkId);
  if (action === 'dismiss-all-script-checks') return dismissAllScriptChecks();
  if (action === 'run-script-check') return runScriptCheck();
  if (action === 'run-shotlist-check') return runShotlistCheck();
  if (action === 'run-check') return runCheck();
  if (action === 'discard-revisions') return discardRevisions(button.dataset.kind);
  if (action === 'finalize-episode') return finalizeEpisode(button.dataset.kind);
  if (action === 'save-prompt-version') return openPromptVersionDialog(button.dataset.kind);
  if (action === 'save-rule-settings') return saveRuleSettings();
  if (action === 'skip-shotlist') {
    if (!state.project.script.content?.trim()) return showToast('请先生成并确认本集剧本，再跳过分镜生成提示词。');
    const episode = activeEpisode();
    if (episode) episode.shotlistSkipped = true;
    state.aiDrawerOpen = true;
    markDirty();
    const task = await addTask('storyboard');
    return openTaskReview(task);
  }
  if (action === 'enable-shotlist') {
    const episode = activeEpisode();
    if (episode) episode.shotlistSkipped = false;
    markDirty();
    render();
    return showToast('本集已重新启用分镜步骤；后续 Seedance 将优先读取镜头计划。');
  }
  if (action === 'queue-script' || action === 'queue-storyboard') {
    const kind = action === 'queue-script' ? 'script' : 'storyboard';
    const task = await addTask(kind);
    return openTaskReview(task);
  }
  if (action === 'refresh-chrome-status') {
    state.chromeConnecting = true;
    render();
    try {
      state.chromeStatus = await window.directorApi.chromeStatus(state.project);
      showToast(state.chromeStatus.ok ? `已发现 ${state.chromeStatus.tabs.length} 个 ChatGPT 当前聊天。` : state.chromeStatus.reason);
    } finally {
      state.chromeConnecting = false;
      render();
    }
    return;
  }
  if (action === 'reset-chrome') {
    state.chromeStatus = await window.directorApi.resetChrome(state.project);
    render();
    return showToast(state.chromeStatus.ok ? 'Chrome 当前聊天已重新连接。' : state.chromeStatus.reason);
  }
  if (action === 'open-chrome-permission') {
    await window.directorApi.openChromePermission();
    return showToast('已单独打开 Chrome 的远程调试授权页。开启“远程调试”后，回到这里点②；Chrome 的“允许”框会在第②步出现。');
  }
  if (action === 'open-chatgpt') {
    await window.directorApi.openChatGpt(state.project);
    return showToast((state.project.chatGptRunner?.mode || 'chrome') === 'chrome' ? '已在你的默认 Chrome 中打开 ChatGPT。请进入要继续使用的当前聊天后刷新连接。' : 'ChatGPT 官网任务窗口已打开。');
  }
  if (action === 'capture-current-attachment') return captureCurrentEpisodeAttachment(button.dataset.kind === 'storyboard' ? 'storyboard' : 'script');
  if (action === 'capture-task') { const task = state.project.queue.find((item) => item.id === button.dataset.taskId); if (task && !['自动执行中', '已保存'].includes(task.status)) await captureTask(task); return; }
  if (action === 'remove-task') return requestTaskRemoval(button.dataset.taskId);
  if (action === 'export') { const outputPath = await window.directorApi.exportProject(state.project, button.dataset.type, button.dataset.target); return showToast(`已导出：${outputPath}`); }
}

document.addEventListener('click', (event) => {
  void handleAppClick(event).catch(reportRendererFailure);
});

function reportRendererFailure(reason) {
  const message = String(reason?.message || reason || '未知错误').replace(/\s+/g, ' ').trim();
  if (!message) return;
  if (message.includes('检查已由新内容替代')) return;
  console.error('导演台剧场操作失败：', reason);
  showToast('操作未完成：' + message.slice(0, 180));
}

window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  reportRendererFailure(event.reason);
});

window.addEventListener('error', (event) => {
  if (event.error) reportRendererFailure(event.error);
});

let startupSplashWatchdog = window.setTimeout(() => {
  // A failed or stalled background load must never leave the app behind an
  // opaque splash. The visible error state below remains available to the user.
  dismissStartupSplash();
}, 10000);
function dismissStartupSplash() {
  const splash = document.getElementById('startup-splash');
  if (!splash || splash.classList.contains('is-leaving')) return;
  window.clearTimeout(startupSplashWatchdog);
  splash.classList.add('is-leaving');
  window.setTimeout(() => splash.remove(), 480);
}

window.directorCloseState = () => ({
  dirty: Boolean(state.dirty || dirtyDocumentKinds().length || reviewUI.hasDrafts()),
  running: Boolean(state.singleTaskRunning || assistantUI.isBusy() || directorUI.isBusy() || automationUI.isBusy() || state.batchRunning || state.workflowRunning || state.apiBatch?.status === 'running'),
  episodeLabel: state.project ? directorEpisodeSlots.label(state.project, state.project.currentEpisode) : ''
});

window.directorSaveBeforeClose = async () => {
  await documentSaveQueue.drain();
  await projectSaveQueue.drain();
  await reviewUI.saveDrafts();
  if (!state.project) return true;
  const kinds = dirtyDocumentKinds();
  for (const kind of kinds) await saveFolderDocument(kind, { preserveViewport: false });
  if (state.dirty) await saveProject({ renderAfter: false, preserveViewport: false });
  if (dirtyDocumentKinds().length || state.dirty) throw new Error('保存期间仍有新修改，请先保存再退出。');
  return true;
};

window.addEventListener('beforeunload', event => {
  const status = window.directorCloseState();
  if (status.dirty || status.running) { event.preventDefault(); event.returnValue = false; }
});

(async function initialize() {
  try {
    window.directorApi.onProjectWriteStatus?.(event => {
      const key = projectPathKey(event.projectPath);
      if ((state.projectSync.get(key)?.revision || 0) > event.revision) return;
      state.projectSync.set(key, event);
      updateSaveIndicators();
    });
    const runtime = await window.directorApi.runtimeInfo?.();
    window.directorRuntimeInfo = runtime;
    if (runtime?.compatGpu) {
      document.documentElement.dataset.performanceMode = 'compatibility';
      window.DirectorUIMotion?.setLevel('off');
    }
    window.directorApi.onGlobalSearchProgress?.(event => {
      const dialog = state.actionDialog;
      if (!dialog?.busy || dialog.scope !== 'global') return;
      const phase = { listing: '扫描目录', reading: '读取文档', complete: '查找完成', preparing: '准备备份', writing: '写入文件' }[event.phase] || '处理中';
      dialog.progressText = phase + '：' + (event.scanned || 0) + ' / ' + (event.total || 0) + (event.current ? ' · ' + event.current : '');
      const status = document.querySelector('#global-search-progress');
      if (status) status.textContent = dialog.progressText;
    });
    const workspaceBootstrap = await workspaceUI.initialize();
    await refreshMembership();
    aiInitBatchEvents();
    await aiEnsureProviders();
    state.projects = await window.directorApi.listProjects();
    state.storeNotice = await window.directorApi.projectStoreStatus?.();
    const lastPath = workspaceBootstrap.projectPath ? projectPathKey(workspaceBootstrap.projectPath) : lastProjectPath();
    const recentProject = state.projects.find(project => !project.unavailable && projectPathKey(project.projectPath) === lastPath)
      || state.projects.find(project => !project.unavailable);
    state.project = workspaceBootstrap.projectPath ? await window.directorApi.openProjectFolder(workspaceBootstrap.projectPath) : recentProject ? await window.directorApi.openProjectFolder(recentProject.projectPath) : null;
    if (workspaceBootstrap.view) state.view = workspaceBootstrap.view;
    rememberActiveProject(state.project);
    if (state.project) {
      const existing = state.projects.findIndex((item) => item.projectPath === state.project.projectPath);
      if (existing >= 0) state.projects[existing] = state.project;
      else state.projects.unshift(state.project);
    }
    if (state.project) await activateEpisode(workspaceBootstrap.episode || state.project.currentEpisode, { preferKnownFiles: true });
    render();
    dismissStartupSplash();
    window.setInterval(async () => {
      try {
        const previous = state.membership;
        const current = await window.directorApi.membershipStatus();
        const changed = previous?.canEdit !== current.canEdit
          || previous?.canUseBuiltinTemplates !== current.canUseBuiltinTemplates
          || previous?.remainingDays !== current.remainingDays
          || previous?.plan !== current.plan;
        state.membership = current;
        if (!current.canUseBuiltinTemplates) state.builtinTemplates = [];
        if (changed) render();
      } catch (error) {
        console.warn('会员状态刷新失败：', error?.message || error);
      }
    }, 60000);
  } catch (error) {
    appRoot.innerHTML = `<div class="empty" style="margin:40px"><h2>启动失败</h2><p>${escapeHTML(error.message || String(error))}</p></div>`;
    dismissStartupSplash();
  }
})();

