const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker, clipboard, screen } = require('electron');
const productionService = require('./production').createService();
const executionJournal = require('./execution-journal').createJournal();
const mediaProbe = require('./media-probe');
const reviewService = require('./review-service').createReviewService();
const aiCore = require('./ai-core');
const episodeSlots = require('./episode-slots');
const { createApiService } = require('./api-integration');
const { createQualityService } = require('./quality-service');
const { createAutomationService } = require('./automation-service');
const { createHtmlLibrary } = require('./html-library');
const { createDirectorService } = require('./director-service');
const { createAssistantService } = require('./assistant-service');
const htmlLibrary = createHtmlLibrary();
const { createMembershipService } = require('./membership-service');
const { listBuiltinTemplates, builtinTemplateById, builtinDefaults, decryptTemplateFile, readBuiltinTemplate, materializeBuiltinTemplate } = require('./template-library');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');
const crypto = require('crypto');
const { pathToFileURL } = require('node:url');
const { spawn, execFile } = require('child_process');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

let mainWindow;
let workspaceWindows;
const windowTaskCounts = new Map();
const windowTaskChannels = new Set(['chatgpt:execute', 'workflow:execute', 'ai:batch', 'automation:run', 'quality:check', 'quality:propose', 'director:propose', 'assistant:ask', 'documents:replace-project-text', 'documents:undo-replacement']);
const ipcWindowContext = new (require('node:async_hooks').AsyncLocalStorage)();
const activeWorkspaceWindow = () => workspaceWindows?.get(ipcWindowContext.getStore()?.sender)?.win || mainWindow;
const broadcastWorkspace = (channel, payload, except) => workspaceWindows?.broadcast(channel, payload, except);
function sendWorkspaceTaskEvent(channel, event) {
  const win = activeWorkspaceWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, event);
  const projectPath = ipcWindowContext.getStore()?.projectPath;
  if (projectPath && ['saved', 'batch-end', 'complete', 'applied'].includes(event.type)) broadcastWorkspace('workspace:changed', { type: 'refresh', projectPath });
}
const workspaceSync = require('./workspace-service').createWorkspaceService({
  key: normalizedPath,
  projectByPath: projectPath => store.projects.find(p => normalizedPath(p.projectPath) === normalizedPath(projectPath)),
  outputPath: (project, kind, active) => projectDocumentOutputPath(project, kind, active),
  readDocument: file => readTextDocument(file),
  broadcast: broadcastWorkspace
});
let chatGptWindow;
let chromeMcpClient;
let activeAiWork = 0;
let apiBatchController = null;
let apiBatchEvents = [];
let powerSaveBlockerId = null;
let lastChatGptConversationStartedAt = 0;
let chatGptBackoffUntil = 0;
let storePath;
let projectStore;
let store = { projects: [] };
const projectWrites = require('./project-write-queue').createProjectWriteQueue({
  key: normalizedPath,
  write: project => writeProject(project, { ensureFolders: false, updateTimestamp: false }),
  onStatus: event => {
    if (event.status === 'saved' && store.pendingProjectWrites?.[normalizedPath(event.projectPath)] === event.updatedAt) {
      delete store.pendingProjectWrites[normalizedPath(event.projectPath)];
      void persistStore().catch(error => runtimeSupport.record('project-index-save-error', { message: error.message }));
    }
    broadcastWorkspace('projects:write-status', event);
  }
});
const { createProjectSessionCache, recentProject, relocateProjectReferences } = require('./project-session-cache');
const projectSessions = createProjectSessionCache({ key: normalizedPath,
  signature: async projectPath => {
    for (const file of [path.join(projectPath, '.ai-director', 'project.json'), path.join(projectPath, 'project.json')]) {
      try { const stat = await fs.stat(file); return file + ':' + stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    return 'no-project-metadata';
  },
  read: projectPath => {
    const existing = store.projects.find(project => normalizedPath(project.projectPath) === normalizedPath(projectPath));
    const indexed = Array.isArray(existing?.source?.files) && existing?.availableFiles
      && ['outline', 'script', 'storyboard', 'seedance'].every(kind => Array.isArray(existing.availableFiles[kind]));
    return adoptProjectFolder(projectPath, { scan: !indexed });
  }
});
app.setName('导演台剧场');
const isolatedUserData = process.env.DIRECTOR_THEATER_QA_USER_DATA || process.env.DIRECTOR_THEATER_PREVIEW_USER_DATA;
if (isolatedUserData) app.setPath('userData', path.resolve(isolatedUserData));
const runtimeSupport = require('./runtime-support').createRuntimeSupport(app);
const membershipService = createMembershipService({ app, dialog, mainWindow: () => mainWindow });
const smokeMode = process.argv.includes('--smoke');
const uploadSmokeMode = process.argv.includes('--upload-smoke') || process.env.AI_DIRECTOR_UPLOAD_SMOKE === '1';
if (smokeMode || uploadSmokeMode || runtimeSupport.compatGpu) app.disableHardwareAcceleration();
let ownsInstance = true;
if (!smokeMode && !uploadSmokeMode && !process.env.DIRECTOR_THEATER_QA_USER_DATA && app.requestSingleInstanceLock) {
  ownsInstance = app.requestSingleInstanceLock();
  if (!ownsInstance) app.quit();
  else app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
  });
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const apiService = createApiService({
  readTextDocument: (filePath) => readTextDocument(filePath),
  archiveReply: (project, task, content) => archiveChatGptReply(project, task, content),
  assertBuiltinTemplates: () => membershipService.assertCanUseBuiltinTemplates(),
  onEvent: (event) => {
    sendWorkspaceTaskEvent('ai:batch-event', event);
  }
});
const qualityService = createQualityService({
  readDocument: file => readTextDocument(file),
  saveDocument: async (project,kind,content,file) => {
    if (!fileIsInsideDirectory(file,documentFolderForKind(project,kind))) throw Error('当前文件不在项目对应目录内。');
    await writeEditableDocument(file,content);
    return {path:file,content};
  },
  localScript: (content,source) => validateScriptDialogueFidelity(content,source),
  localPrompt: (content,script,shotlist) => validateStoryboard(content,script,shotlist),
  assertEdit: () => membershipService.assertCanEdit(),
  onEvent: event => sendWorkspaceTaskEvent('automation:event', event)
});
const automationService = createAutomationService({
  readDocument: file => readTextDocument(file), quality: qualityService,
  assertEdit: () => membershipService.assertCanEdit(),
  publishDocument: async (project,file,content,kind) => {
    if(!fileIsInsideDirectory(file,documentFolderForKind(project,kind)))throw Error('输出文件不在对应项目目录内。');
    let backup='';
    if(fsSync.existsSync(file)){
      backup=path.join(project.projectPath,'.ai-director','制作备份',Date.now()+'-'+uid(),path.relative(project.projectPath,file));
      await fs.mkdir(path.dirname(backup),{recursive:true});await fs.copyFile(file,backup);
      if(/\.txt$/i.test(file)&&['script','storyboard'].includes(kind))await fs.copyFile(file.replace(/\.txt$/i,'.docx'),backup.replace(/\.txt$/i,'.docx')).catch(e=>{if(e.code!=='ENOENT')throw e;});
    }
    await writeEditableDocument(file,content);
    return {file,backup};
  },
  readTemplate: async (project,stage) => {
    const key = {outline:'seriesOutline',script:'script',shotlist:'shotlist',storyboard:String(project.workflowTemplates?.promptMode)==='15'?'prompt15':'prompt30'}[stage];
    if (!key) return '';
    const category = {script:'script',shotlist:'storyboard',storyboard:'shared'}[stage];
    const selected = (project.ruleDocuments || []).filter(d => d.enabled !== false && d.category === category).at(-1)
      || project.workflowTemplates?.[key];
    if (!selected?.path && !selected?.builtin) return '';
    const descriptor = selected.builtin ? builtinTemplateById(selected.id) : selected;
    if (selected.builtin) await membershipService.assertCanUseBuiltinTemplates();
    if (!descriptor?.path) throw Error('要求文件失效，请重新选择。');
    return readTextDocument(descriptor.path);
  },
  onEvent: event => sendWorkspaceTaskEvent('automation:event', event)
});
const directorService=createDirectorService({loadDocuments:(p,episode)=>loadEpisodeDocuments(p,episode),readDocument:file=>readTextDocument(file),assertEdit:()=>membershipService.assertCanEdit(),loadReview:p=>reviewService.load(p),onEvent:event=>sendWorkspaceTaskEvent('automation:event', event)});
const assistantService=createAssistantService({assertEdit:()=>membershipService.assertCanEdit(),snapshot:p=>directorService.snapshot(p)});
function assertGenerationIdle() {
  if (assistantService.isBusy() || apiService.isBusy() || activeAiWork || automationService.isBusy() || qualityService.isBusy() || directorService.isBusy()) throw Error('已有生成、检查或优化任务运行，请先暂停或等待完成。');
}
const sanitizeName = (name) => name.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80) || '未命名项目';
const defaultRoot = () => {
  return path.join(app.getPath('documents'), '导演台剧场');
};
const editorExtensions = new Set(['.txt', '.md', '.markdown', '.docx']);
const referenceTextExtensions = new Set(['.txt', '.md', '.markdown', '.docx']);
const { createEpisodeFileIndex, createEpisodeDocumentCache } = require('./episode-file-index');
const episodeFileIndex = createEpisodeFileIndex({
  extensions: editorExtensions, identifyName: episodeNumberFromFileName,
  identifyContent: async file => episodeNumberFromDocumentContent(await readEpisodeHint(file))
});
const episodeDocumentCache = createEpisodeDocumentCache({ readDocument: file => readTextDocument(file) });
const backgroundDocumentChecks = require('./background-document-checks').createBackgroundDocumentChecks();
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const audioAssetExtensions = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const assetCategoryFolders = {
  role: '01 人物',
  scene: '02 场景',
  prop: '03 道具',
  voice: '04 配音'
};
const projectFolderDefinitions = [
  { key: 'source', name: '00 小说原文' },
  { key: 'synopsis', name: '01 故事梗概' },
  { key: 'outline', name: '02 大纲' },
  { key: 'script', name: '03 剧本' },
  { key: 'storyboard', name: '04 分镜' },
  { key: 'seedance', name: '05 seedance提示词' },
  { key: 'assets', name: '06 资产' },
  { key: 'rules', name: '07 AI规则与记忆' }
];
const chatGptPacing = {
  // ChatGPT also requests the sidebar/history whenever a fresh page is opened.
  // Keep the workflow deliberately slower than a person switching chats.
  betweenNewChatsMs: 60000,
  afterUploadMs: 3500,
  pollMs: 12000,
  rateLimitBackoffMs: 10 * 60 * 1000
};

const documentFormatDefaults = { source: 'txt', outline: 'txt', script: 'txt', shotlist: 'md', storyboard: 'txt' };
function normalizeDocumentFormats(value = {}) {
  const normalized = { ...documentFormatDefaults };
  for (const kind of Object.keys(normalized)) {
    const format = String(value?.[kind] || '').toLowerCase();
    if (['txt', 'md', 'docx'].includes(format)) normalized[kind] = format;
  }
  return normalized;
}

function documentFormatForKind(project, kind) {
  return normalizeDocumentFormats(project?.documentFormats)[kind] || 'txt';
}

function extensionForDocumentFormat(format) {
  return format === 'docx' ? '.docx' : format === 'md' ? '.md' : '.txt';
}

function fileMatchesDocumentFormat(filePath, format) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  return format === 'md' ? extension === '.md' || extension === '.markdown' : extension === extensionForDocumentFormat(format);
}

function chooseEpisodeFile(files, project, kind, episodeNumber) {
  const format = documentFormatForKind(project, kind);
  const base = episodeSlots.baseNumber(episodeNumber);
  const matching = files.filter((file) => fileMatchesDocumentFormat(file.path || file.name, format)
    && (Number(file.episodeNumber) === base || matchesEpisodeFile(file.name, base))
    && episodeSlots.matchingPart(project, episodeNumber, file.name, kind === 'source'));
  const selectedPath = episodeSlots.episodeByKey(project, episodeNumber)?.activeFiles?.[kind];
  return matching.find((file) => file.path === selectedPath) || matching[0] || null;
}

function isChatGptRateLimit(value) {
  return /(请求过于频繁|too many requests|限制.*对话记录|temporarily limited)/i.test(String(value?.reason || value || ''));
}

function registerChatGptRateLimit() {
  chatGptBackoffUntil = Math.max(chatGptBackoffUntil, Date.now() + chatGptPacing.rateLimitBackoffMs);
  const until = new Date(chatGptBackoffUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `ChatGPT 暂时限制了对话记录访问。软件已暂停到 ${until}，在此之前不会再打开页面、上传文件或发送消息。`;
}

function chatGptBackoffMessage() {
  if (Date.now() >= chatGptBackoffUntil) return '';
  const until = new Date(chatGptBackoffUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `ChatGPT 保护冷却中，将在 ${until} 后再允许执行；期间软件不会继续访问对话记录。`;
}

// The production workflow deliberately sends these as files.  Do not fold the
// templates back into the message body: the user needs ChatGPT to receive the
// original Markdown files and preserve their maintained wording.
const workflowTemplateDefaults = builtinDefaults();

function normalizeWorkflowTemplates(value = {}) {
  const normalize = (key) => {
    const saved = value[key];
    const fallback = workflowTemplateDefaults[key] || { name: '', path: '' };
    if (!saved) return { ...fallback };
    if (saved.builtin === true && (!saved.path || path.extname(saved.path).toLowerCase() === '.dtp')) return builtinTemplateById(saved.id) || { ...fallback };
    return { ...saved, builtin: false, id: undefined };
  };
  return {
    script: normalize('script'), shotlist: normalize('shotlist'),
    prompt15: normalize('prompt15'), prompt30: normalize('prompt30'),
    duration: normalize('duration'), seriesOutline: normalize('seriesOutline'),
    promptMode: String(value.promptMode) === '15' ? '15' : '30'
  };
}

function beginAiWork() {
  activeAiWork += 1;
  if (powerSaveBlockerId === null) powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
}

function endAiWork() {
  activeAiWork = Math.max(0, activeAiWork - 1);
  if (activeAiWork === 0 && powerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
}

function stopAiWakeBlocker() {
  activeAiWork = 0;
  if (powerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
}

async function keepComputerAwakeWhileWorking(work) {
  beginAiWork();
  try {
    return await work();
  } finally {
    endAiWork();
  }
}

function episodeNumberFromFileName(fileName) {
  const name = String(fileName || '').split(/[\\/]/).at(-1);
  const match = name.match(/(?:^|[^a-z0-9])EP\s*(\d{1,4})(?!\d)/i)
    || name.match(/(?:^|[^0-9])(?:第\s*)?(\d{1,4})(?:\s*(?:集|话|章)|[_-]|(?=第))/i);
  return match ? Number(match[1]) : null;
}

function episodeNumberFromDocumentContent(content) {
  const match = String(content || '').slice(0, 65536).match(/(?:第\s*)?(\d{1,4})\s*(?:集|话|章)|\bEP\s*(\d{1,4})\b/i);
  return match ? Number(match[1] || match[2]) : null;
}

const episodeHintCache = new Map();
async function readEpisodeHint(filePath, fileInfo) {
  const stat = fileInfo || await fs.stat(filePath);
  const key = JSON.stringify([filePath, stat.size, stat.modifiedAt || stat.mtime.toISOString()]);
  if (episodeHintCache.has(key)) return episodeHintCache.get(key);
  if (episodeHintCache.size >= 256) episodeHintCache.delete(episodeHintCache.keys().next().value);
  const pending = readEpisodeHintUncached(filePath).catch(error => { episodeHintCache.delete(key); throw error; });
  episodeHintCache.set(key, pending);
  return pending;
}

async function readEpisodeHintUncached(filePath) {
  if (path.extname(filePath).toLowerCase() === '.docx') {
    return (await mammoth.extractRawText({ path: filePath })).value.slice(0, 65536);
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function makeFolderMap(projectPath) {
  return {
    source: path.join(projectPath, '00 小说原文'),
    synopsis: path.join(projectPath, '01 故事梗概'),
    outline: path.join(projectPath, '02 大纲'),
    script: path.join(projectPath, '03 剧本'),
    storyboard: path.join(projectPath, '04 分镜'),
    seedance: path.join(projectPath, '05 seedance提示词'),
    assets: path.join(projectPath, '06 资产'),
    rules: path.join(projectPath, '07 AI规则与记忆'),
    promptTemplates: path.join(projectPath, '07 AI规则与记忆', '00 主提示词版本'),
    scriptReferences: path.join(projectPath, '07 AI规则与记忆', '04 剧本参照文档'),
    storyboardReferences: path.join(projectPath, '07 AI规则与记忆', '05 提示词参照文档'),
    state: path.join(projectPath, '.ai-director')
  };
}

function missingProjectFolders(projectPath) {
  const root = path.resolve(String(projectPath || ''));
  const folders = makeFolderMap(root);
  return projectFolderDefinitions
    .filter(({ key }) => {
      try { return !fsSync.statSync(folders[key]).isDirectory(); } catch { return true; }
    })
    .map(({ key, name }) => ({ key, name, path: folders[key] }));
}

function outputFolderForTask(project, task) {
  const folders = makeFolderMap(project.projectPath);
  if (task.kind === 'script') return folders.script;
  if (task.kind === 'storyboard') return folders.seedance;
  if (task.kind === 'shotlist') return folders.storyboard;
  return path.join(folders.rules, '任务归档');
}

async function resolveEpisodeInput(project, promptKind, episodeNumber, skipShotlist) {
  const folders = makeFolderMap(project.projectPath);
  const readMatchingFile = async (directory, documentKind) => {
    const file = chooseEpisodeFile(
      await listTextFiles(directory, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
      project,
      documentKind,
      episodeNumber
    );
    if (!file) return null;
    try {
      return { name: file.name, content: await readTextDocument(file.path) };
    } catch {
      return null;
    }
  };
  if (promptKind === 'script') return readMatchingFile(folders.source, 'source');
  if (promptKind === 'shotlist') return readMatchingFile(folders.script, 'script');
  if (!skipShotlist) {
    const shotlist = await readMatchingFile(folders.storyboard, 'shotlist');
    if (shotlist) return shotlist;
  }
  return readMatchingFile(folders.script, 'script');
}

async function composeTaskPrompt(project, kind, options = {}) {
  const promptKind = kind === 'script' ? 'script' : kind === 'shotlist' ? 'shotlist' : 'storyboard';
  const fallbackTemplate = promptKind === 'script' ? scriptPrompt : promptKind === 'shotlist' ? shotlistPrompt : storyboardPrompt;
  const template = options.templateOverride || project.promptSets?.[promptKind]?.at(-1)?.content || fallbackTemplate;
  const relevantRules = (project.ruleDocuments || []).filter((doc) => doc.enabled !== false && (doc.category === 'shared' || doc.category === promptKind || (promptKind === 'shotlist' && doc.category === 'storyboard')));
  const ruleBlocks = [];
  for (const doc of relevantRules) {
    try {
      ruleBlocks.push(`【规则文档：${doc.name}】\n${await readTextDocument(doc.path)}`);
    } catch {
      ruleBlocks.push(`【规则文档：${doc.name}】\n（文件无法读取，请在项目规则页重新导入。）`);
    }
  }
  const referenceCategory = promptKind === 'script' ? 'script' : 'storyboard';
  const relevantReferences = (project.referenceDocuments || []).filter((doc) => doc.enabled !== false && doc.category === referenceCategory);
  const referenceBlocks = [];
  for (const doc of relevantReferences) {
    try {
      referenceBlocks.push(`【参照文档：${doc.name}${doc.outputFormat !== false ? '（输出格式范本）' : ''}】\n${await readTextDocument(doc.path)}`);
    } catch {
      referenceBlocks.push(`【参照文档：${doc.name}】\n（文件无法读取，请在对应页面重新导入。）`);
    }
  }
  const formatReferences = relevantReferences.filter((doc) => doc.outputFormat !== false);
  const referenceInstruction = formatReferences.length
    ? `【参照文档格式要求】\n以下标有“输出格式范本”的参照文档会与本次消息一并发送。最终成品必须复用其中可见的标题层级、编号方式、分组顺序、字段名称、标签、换行和标点格式；只替换为本集内容，不要改成其他格式。若格式范本与硬性规则冲突，以硬性规则为准。`
    : '';
  const memoryBlocks = [
    ['项目记忆', project.memory?.project],
    ['角色与素材记忆', project.memory?.characters],
    ['剧情连续性记忆', project.memory?.continuity]
  ].filter(([, value]) => value?.trim()).map(([name, value]) => `【${name}】\n${value.trim()}`);
  const episodeNumber = Number(options.episodeNumber) || Number(project.currentEpisode);
  const episode = (project.episodes || []).find((item) => Number(item.number) === episodeNumber);
  const skipShotlist = promptKind === 'storyboard' && episode?.shotlistSkipped === true;
  const folderInput = await resolveEpisodeInput(project, promptKind, episodeNumber, skipShotlist);
  const outlineInput = promptKind === 'script'
    ? await (async () => {
      const file = await findOutlineDocumentFile(project, project.folders.outline, episodeNumber);
      if (!file) return null;
      try { return { name: file.name, content: await readTextDocument(file.path) }; } catch { return null; }
    })()
    : null;
  const fallbackSource = promptKind === 'script'
    ? project.source?.content
    : promptKind === 'shotlist'
      ? project.script?.content
      : (!skipShotlist && project.shotlist?.content ? project.shotlist.content : project.script?.content);
  const fallbackSourceName = promptKind === 'script'
    ? '本集原文'
    : promptKind === 'shotlist'
      ? '最终手改剧本'
      : (!skipShotlist && project.shotlist?.content ? '已确认镜头计划' : (skipShotlist ? '最终手改剧本（已跳过分镜步骤）' : '最终手改剧本'));
  const source = folderInput?.content || fallbackSource;
  const sourceName = folderInput ? `文件夹对应文件：${folderInput.name}` : fallbackSourceName;
  const outline = outlineInput?.content || (promptKind === 'script' ? project.outline?.content : '');
  const outlineName = outlineInput ? `本集大纲文件：${outlineInput.name}` : '本集大纲';
  const executionPriority = String(project.executionPriority || defaultExecutionPriority).trim() || defaultExecutionPriority;
  return `${template}\n\n【执行优先级】\n${executionPriority}\n\n${ruleBlocks.join('\n\n')}\n\n${referenceInstruction}\n\n${referenceBlocks.join('\n\n')}\n\n${memoryBlocks.join('\n\n')}\n\n【项目】${project.title}\n【当前集数】第${episodeSlots.label(project, episodeNumber)}集${promptKind === 'script' ? `\n\n【${outlineName}】\n${outline || '（本集尚未填写大纲）'}` : ''}\n\n【${sourceName}】\n${source || '（文件夹中未找到本集对应文件，请人工补充或调整文件名后重试）'}`;
}

const workflowStepDefinitions = {
  script: {
    label: '原文 → 剧本',
    inputFolder: 'source',
    inputKind: 'source',
    outputKind: 'script',
    templateKey: 'script',
    inputLabel: '小说原文'
  },
  shotlist: {
    label: '剧本 → 分镜',
    inputFolder: 'script',
    inputKind: 'script',
    outputKind: 'shotlist',
    templateKey: 'shotlist',
    inputLabel: '剧本'
  },
  storyboard: {
    label: '分镜 → 提示词',
    inputFolder: 'storyboard',
    inputKind: 'shotlist',
    outputKind: 'storyboard',
    templateKey: 'prompt',
    inputLabel: '分镜'
  }
};

function normalizeWorkflowSelection(selection = {}) {
  return {
    script: selection.script !== false,
    shotlist: selection.shotlist !== false,
    storyboard: selection.storyboard !== false
  };
}

function workflowStepKeys(selection) {
  const selected = normalizeWorkflowSelection(selection);
  return ['script', 'shotlist', 'storyboard'].filter((key) => selected[key]);
}

async function findEpisodeDocumentFile(project, kind, directory, episodeNumber) {
  const files = await listTextFiles(directory, 1600, { identifyEpisodes: true, extensions: editorExtensions });
  return chooseEpisodeFile(files, project, kind, episodeNumber);
}

async function findOutlineDocumentFile(project, directory, episodeNumber) {
  const files = await listTextFiles(directory, 1600, { identifyEpisodes: true, extensions: editorExtensions });
  const exact = chooseEpisodeFile(files, project, 'outline', episodeNumber);
  if (exact) return exact;
  const selected = selectedPathForOutline(project, episodeNumber);
  const selectedFile = selected && files.find((file) => path.resolve(file.path).toLowerCase() === path.resolve(selected).toLowerCase());
  return selectedFile || (files.length === 1 ? files[0] : null);
}

function selectedPathForOutline(project, episodeNumber) {
  return episodeSlots.episodeByKey(project, episodeNumber)?.activeFiles?.outline
    || (Number(project.currentEpisode) === Number(episodeNumber) ? project.activeFiles?.outline : '')
    || project.activeFiles?.outline
    || '';
}

function workflowTemplateFor(project, step, promptMode) {
  const templates = normalizeWorkflowTemplates(project.workflowTemplates);
  const key = step === 'storyboard'
    ? (String(promptMode || templates.promptMode) === '15' ? 'prompt15' : 'prompt30')
    : workflowStepDefinitions[step].templateKey;
  return { key, descriptor: templates[key], promptMode: templates.promptMode };
}

function workflowMessage({ project, episodeNumber, step }) {
  const definition = workflowStepDefinitions[step];
  return [
    `本次只执行「${definition.label}」的第${episodeSlots.label(project, episodeNumber)}集。`,
    step === 'script'
      ? '请先完整阅读本消息附带的真实文件：本步骤模板、本集大纲（如有）和本集小说原文。'
      : '请先完整阅读本消息附带的两个真实文件：一份为本步骤模板，一份为本集输入文件。',
    step === 'script'
      ? '以模板文件规定的任务、格式和限制为准；以本集小说原文作为事实来源，并按本集大纲组织剧情。'
      : '以模板文件规定的任务、格式和限制为准；以本集输入文件作为唯一内容来源。',
    `项目：${project.title}。`,
    `直接完成本步骤，不要解释过程。请优先在聊天框输出完整最终成品；也可附上“${episodeSlots.fileStem(project, episodeNumber)}.txt”。`,
    '软件会优先保存聊天框中的完整正文；若正文不可用，才读取 TXT 附件。'
  ].join('\n');
}

async function prepareWorkflowStep(project, { episodeNumber, step, selection, promptMode, promptOverride = '' }) {
  const definition = workflowStepDefinitions[step];
  if (!definition) throw new Error('未识别的工作流步骤。');
  const folders = makeFolderMap(project.projectPath);
  const selected = normalizeWorkflowSelection(selection);
  let template = workflowTemplateFor(project, step, promptMode);
  if (template.descriptor.builtin) {
    await membershipService.assertCanUseBuiltinTemplates();
    template = { ...template, descriptor: await materializeBuiltinTemplate(template.descriptor.id, app.getPath('temp')) };
  }
  if (!template.descriptor.path) {
    throw new Error(`请在“规则”页选择${definition.label}模板文件。`);
  }
  try { await fs.access(template.descriptor.path); } catch {
    throw new Error(`找不到${definition.label}模板文件：${template.descriptor.path}。请在“规则”页重新选择该模板。`);
  }
  const precedingSelected = (step === 'shotlist' && selected.script) || (step === 'storyboard' && selected.shotlist);
  const input = await findEpisodeDocumentFile(project, definition.inputKind, folders[definition.inputFolder], episodeNumber);
  const outline = step === 'script'
    ? await findOutlineDocumentFile(project, folders.outline, episodeNumber)
    : null;
  const inputFormat = documentFormatForKind(project, definition.inputKind);
  const inputFormatLabel = inputFormat === 'docx' ? 'Word' : inputFormat.toUpperCase();
  if (!input && !precedingSelected) {
    throw new Error(`第${episodeSlots.label(project, episodeNumber)}集未找到可用的${definition.inputLabel} ${inputFormatLabel} 文件。请先在“${path.basename(folders[definition.inputFolder])}”保存本集文件，或勾选上一步一起生成。`);
  }
  const expectedInputName = input?.name || `${episodeSlots.fileStem(project, episodeNumber)}${extensionForDocumentFormat(inputFormat)}（由上一步生成后上传）`;
  const prompt = String(promptOverride || '').trim() || workflowMessage({
    project,
    episodeNumber,
    step
  });
  return {
    step,
    label: definition.label,
    outputKind: definition.outputKind,
    inputName: expectedInputName,
    inputPath: input?.path || '',
    outlineName: outline?.name || '',
    outlinePath: outline?.path || '',
    inputWillBeGenerated: !input && precedingSelected,
    template: { ...template.descriptor, key: template.key },
    outputFolder: outputFolderForTask(project, { kind: definition.outputKind }),
    prompt,
    files: [template.descriptor.path, outline?.path, input?.path].filter(Boolean)
  };
}

async function prepareEpisodeWorkflow(project, payload = {}) {
  const episodeNumber = Number(payload.episodeNumber) || Number(project.currentEpisode);
  const selection = normalizeWorkflowSelection(payload.selection);
  const steps = workflowStepKeys(selection);
  if (!steps.length) throw new Error('请至少选择一个生成步骤。');
  const promptMode = String(payload.promptMode || project.workflowTemplates?.promptMode) === '15' ? '15' : '30';
  const overrides = payload.prompts || {};
  const plan = [];
  for (const step of steps) {
    plan.push(await prepareWorkflowStep(project, {
      episodeNumber,
      step,
      selection,
      promptMode,
      promptOverride: overrides[step]
    }));
  }
  return { episodeNumber, selection, promptMode, steps: plan };
}

const defaultExecutionPriority = `1. 下方规则文档、参照文档和项目记忆必须严格遵守。
2. 未经允许不得增删、改写台词或临时改变素材标准名称。
3. 只输出最终成品，不要输出分析过程。`;

const scriptPrompt = `你是经验丰富的中文短剧编剧，熟悉动漫、微短剧、电视剧与电影的节奏。请通读原文，并改编为约2分钟的一集短剧。

必须严格遵守：
1. 最前面列出本集出场人物名称并加粗。
2. 场景题头写作“场号 场景名 [内/外] [日/夜]”，并加粗。
3. 所有环境、动作和镜头画面均以“△”开头；禁止心理描写，改写为可见动作或表情。
4. 对白采用紧凑格式：**角色名**：(情绪/动作提示) 台词内容。
5. 重要声音使用【音效】，屏幕文字使用【字幕】。
6. 画外真实开口用 (O.S.)，内心声音用 (V.O.)。
7. 不要输出“场景题头、画面/动作、对白”等说明字样；每一句另起一行；遵守原剧情路线。`;

const storyboardPrompt = `你是即梦 Seedance 2.0 漫剧分镜导演。请依据最终手改剧本，生成可直接投喂的中文分镜提示词。

硬性规则：整集90-150秒；不超过12组；每组≤15秒、≤6镜头、整数秒且从0秒连续计时。每个镜头显式写@场景。普通对白一镜只能有一名发声人物；每句台词均使用完整格式@[角色]说{台词}。V.O.必须写@[角色](V.O.)并让入镜角色闭口无口型；O.S.仅限同场景的画外真实开口。每组先在“参考素材”中定义本组实际使用的@[角色]、@[场景]、@[道具]，之后逐字一致，不得临时新增或改名。构图仅用中心构图、三分法构图、局部构图；机位仅用正面机位、侧面机位、斜45度侧面机位；普通对白以单一清晰主体为主，无背景音乐。

整集开头只输出一次【统一风格与约束】；每组按“第X组、任务类型、参考素材、声音、分镜序列”排列；最后输出【台词整合】和【台词文稿匹配】。不要输出创作分析。`;

const shotlistPrompt = `你是短剧分镜导演。请根据最终手改剧本，先输出一份清晰的结构化镜头计划，供后续生成 Seedance 提示词使用。

每个镜头写明：镜头编号、场景、人物主体、动作、台词归属、景别、时长、关键道具与转场关系。普通对白坚持一镜一名发声人物；保留剧本全部台词顺序，不新增台词。只输出镜头计划，不输出解释。`;

function createProject(input = {}) {
  const title = input.title?.trim() || '未命名漫剧项目';
  const folderName = `${sanitizeName(title)}-${new Date().toISOString().slice(0, 10)}`;
  const projectPath = input.projectPath || path.join(defaultRoot(), 'projects', folderName);
  return {
    id: uid(),
    title,
    genre: input.genre || '动漫微短剧',
    targetDuration: Number(input.targetDuration) || 120,
    currentEpisode: Number(input.currentEpisode) || Number(input.startEpisode) || 1,
    status: '创作中',
    projectPath,
    folders: makeFolderMap(projectPath),
    source: { name: '', content: '', files: [], updatedAt: null },
    outline: { content: '', versions: [], updatedAt: null },
    script: { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null },
    shotlist: { content: '', versions: [], updatedAt: null },
    storyboard: { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null },
    activeFiles: { source: '', outline: '', script: '', shotlist: '', storyboard: '' },
    documentFormats: normalizeDocumentFormats(),
    assets: [],
    ruleDocuments: [],
    referenceDocuments: [],
    executionPriority: defaultExecutionPriority,
    memory: { project: '', characters: '', continuity: '' },
    chatGptProjects: { script: '剧本工程', prompt: '提示词工程' },
    chatGptRunner: { mode: 'chrome', tabId: '', port: 9222, waitMinutes: 50, replyMode: 'auto' },
    generationMode: 'api',
    aiRunner: aiCore.normalizeRunnerConfig({}),
    validationChecks: aiCore.defaultValidationChecks(),
    workflowTemplates: normalizeWorkflowTemplates(),
    promptSets: {
      script: [{ id: uid(), name: '剧本模板 v1.0', content: scriptPrompt, createdAt: now() }],
      storyboard: [{ id: uid(), name: 'Seedance 规范 v5.0', content: storyboardPrompt, createdAt: now() }],
      shotlist: [{ id: uid(), name: '镜头计划模板 v1.0', content: shotlistPrompt, createdAt: now() }]
    },
    season: { startEpisode: Number(input.startEpisode) || 1, endEpisode: Number(input.endEpisode) || Number(input.startEpisode) || 1, totalEpisodes: Number(input.totalEpisodes) || 1, totalMinutes: Number(input.totalMinutes) || 2 },
    episodes: [{ number: Number(input.startEpisode) || 1, title: '', targetSeconds: Number(input.targetDuration) || 120, status: '待创作' }],
    queue: [],
    createdAt: now(),
    updatedAt: now()
  };
}

function numberedEpisodePlan(project, start, count) {
  return episodeSlots.numberedEpisodePlan(project, start, count);
}

function ensureSeasonPlan(project) {
  const fallbackEpisode = episodeSlots.baseNumber(project.currentEpisode) || 1;
  project.season = {
    startEpisode: fallbackEpisode,
    endEpisode: fallbackEpisode,
    totalEpisodes: 1,
    totalMinutes: Math.max(1, Math.round((Number(project.targetDuration) || 120) / 60)),
    ...(project.season || {})
  };
  const numberedCount = Math.max(1, Number(project.season.numberedEpisodes) || Number(project.season.totalEpisodes) || 1);
  project.season.startEpisode = Number(project.season.startEpisode) || fallbackEpisode;
  project.season.endEpisode = project.season.startEpisode + numberedCount - 1;
  project.episodes = numberedEpisodePlan(project, project.season.startEpisode, numberedCount);
  project.season.numberedEpisodes = numberedCount;
  project.season.totalEpisodes = project.episodes.length;
  if (!project.episodes.some((episode) => Number(episode.number) === Number(project.currentEpisode))) project.currentEpisode = project.season.startEpisode;
  const current = project.episodes.find((episode) => episode.number === Number(project.currentEpisode));
  if (current) project.targetDuration = Number(current.targetSeconds) || Number(project.targetDuration) || 120;
  return project;
}

function applyDetectedSeasonRange(project, files) {
  if (!files.length) return;
  const detectedEpisodes = [...new Set(files
    .map((file) => Number(file.episodeNumber))
    .filter((episode) => Number.isFinite(episode) && episode > 0))];
  if (detectedEpisodes.length) {
    const detectedStart = Math.min(...detectedEpisodes);
    const detectedEnd = Math.max(...detectedEpisodes);
    const configuredStart = Number(project.season?.startEpisode);
    const configuredEnd = Number(project.season?.endEpisode);
    const hasConfiguredRange = Number(project.season?.numberedEpisodes || project.season?.totalEpisodes) > 1 && Number.isFinite(configuredStart) && Number.isFinite(configuredEnd);
    const startEpisode = hasConfiguredRange ? Math.min(configuredStart, detectedStart) : detectedStart;
    const endEpisode = hasConfiguredRange ? Math.max(configuredEnd, detectedEnd) : detectedEnd;
    const totalEpisodes = endEpisode - startEpisode + 1;
    project.season = { ...(project.season || {}), startEpisode, endEpisode,
      numberedEpisodes: totalEpisodes, totalMinutes: Math.round((totalEpisodes * (Number(project.targetDuration) || 120)) / 60) };
    if (Number(project.currentEpisode) < startEpisode || Number(project.currentEpisode) > endEpisode) project.currentEpisode = startEpisode;
    project.episodes = numberedEpisodePlan(project, startEpisode, totalEpisodes);
    project.season.totalEpisodes = project.episodes.length;
    return;
  }
  if (project.season?.totalEpisodes > 1) return;
  const ranges = files.flatMap((file) => {
    const episodeRanges = [...file.name.matchAll(/EP\s*(\d+)\s*[-—]\s*(\d+)/ig)].map((match) => [Number(match[1]), Number(match[2])]);
    const chapterMatch = file.name.match(/^(\d{1,4})[_-](?:第)?\d*章?/);
    return chapterMatch ? [...episodeRanges, [Number(chapterMatch[1]), Number(chapterMatch[1])]] : episodeRanges;
  });
  if (!ranges.length) return;
  const startEpisode = Math.min(...ranges.map(([start]) => start));
  const endEpisode = Math.max(...ranges.map(([, end]) => end));
  const totalEpisodes = endEpisode - startEpisode + 1;
  project.season = { ...(project.season || {}), startEpisode, endEpisode,
    numberedEpisodes: totalEpisodes, totalEpisodes, totalMinutes: Math.round((totalEpisodes * (Number(project.targetDuration) || 120)) / 60) };
  project.currentEpisode = startEpisode;
  project.episodes = Array.from({ length: totalEpisodes }, (_, index) => ({ number: startEpisode + index, title: '', targetSeconds: Number(project.targetDuration) || 120, status: '待创作' }));
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

// Keep every editable project file recoverable if the app, the network share,
// or Windows interrupts a save.  The temporary file lives beside the target so
// the final rename stays on the same volume and is atomic where the filesystem
// supports it (including normal NTFS and most shared drives).
async function writeFileAtomically(filePath, content, options) {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let committed = false;
  try {
    await fs.writeFile(temporaryPath, content, options);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rename(temporaryPath, filePath);
        committed = true;
        return;
      } catch (error) {
        lastError = error;
        // Word, Explorer preview, and a sync client may briefly hold a file.
        // A short retry avoids reporting a false save failure without risking a
        // delete-and-rewrite of the original file.
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code) || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
      }
    }
    throw lastError || new Error('文件替换失败。');
  } finally {
    if (!committed) await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function initStore() {
  storePath = path.join(app.getPath('userData'), 'director-theater-store.json');
  projectStore = require('./project-store').createProjectStore({ filePath: storePath, writeAtomic: writeFileAtomically });
  store = await projectStore.load();
}

const membershipProtectedChannels = new Set([
  'automation:run', 'automation:preview', 'quality:check', 'quality:propose', 'quality:apply', 'quality:undo',
  'production:execute', 'workflow:batch-state', 'production:act',
  'projects:create', 'projects:rescan', 'projects:save',
  'source:import', 'documents:save', 'documents:export-word', 'documents:replace-project-text',
  'assets:add', 'assets:organize-role', 'rules:import', 'rules:save-prompt-template',
  'rules:save-settings', 'references:import', 'episodes:finalize-output', 'episodes:discard-revisions',
  'tasks:prepare', 'batches:preview', 'workflow:prepare', 'workflow:execute', 'workflow:choose-template',
  'chatgpt:open', 'chatgpt:send', 'chatgpt:capture', 'chatgpt:archive', 'chatgpt:download-latest',
  'chatgpt:execute', 'chrome:reset', 'chrome:open-permission',
  'ai:save-config', 'ai:test', 'ai:batch', 'ai:clear-batch-state', 'ai:preview-messages'
  , 'review:act', 'review:choose-folder'
]);

function registerIpcHandle(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    if (membershipProtectedChannels.has(channel)) await membershipService.assertCanEdit();
    if (activeGlobalTextSearch && ['write', 'undo'].includes(activeGlobalTextSearch.phase) && ['documents:save', 'documents:export-word'].includes(channel)) throw new Error('正在执行批量替换或撤销，请完成后再保存。本窗编辑仍保留。');
    const sender = args[0]?.sender;
    const tracksWork = sender?.id && windowTaskChannels.has(channel);
    if (tracksWork) windowTaskCounts.set(sender.id, (windowTaskCounts.get(sender.id) || 0) + 1);
    try {
      return await ipcWindowContext.run({ sender, projectPath: (args[1]?.project || args[1])?.projectPath }, () => workspaceSync.handle(channel, args, () => handler(...args)));
    } finally {
      if (tracksWork) { const count = (windowTaskCounts.get(sender.id) || 1) - 1; if (count) windowTaskCounts.set(sender.id, count); else windowTaskCounts.delete(sender.id); }
    }
  });
}

function workflowUsesBuiltinTemplate(project, payload = {}) {
  const selection = normalizeWorkflowSelection(payload.selection);
  const templates = normalizeWorkflowTemplates(project?.workflowTemplates);
  const keys = [];
  if (selection.script) keys.push('script');
  if (selection.shotlist) keys.push('shotlist');
  if (selection.storyboard) keys.push(String(payload.promptMode || templates.promptMode) === '15' ? 'prompt15' : 'prompt30');
  return keys.some((key) => templates[key]?.builtin === true);
}

async function persistStore() {
  await projectStore.save(store);
}

async function writeProject(project, { ensureFolders = true, updateTimestamp = true } = {}) {
  if (updateTimestamp) project.updatedAt = now();
  ensureSeasonPlan(project);
  project.workflowTemplates = normalizeWorkflowTemplates(project.workflowTemplates);
  project.documentFormats = normalizeDocumentFormats(project.documentFormats);
  project.projectPath = path.resolve(project.projectPath);
  project.folders = makeFolderMap(project.projectPath);
  // Adoption/creation builds the workspace. Ordinary saves only need the state
  // directory, which the atomic writer creates if it is missing.
  if (ensureFolders) {
    await ensureDirectory(project.projectPath);
    for (const folder of Object.values(project.folders)) await ensureDirectory(folder);
    await ensureDirectory(path.join(project.folders.assets, 'images'));
    await ensureDirectory(path.join(project.folders.assets, 'audio'));
    for (const folder of Object.values(assetCategoryFolders)) {
      await ensureDirectory(path.join(project.folders.assets, 'images', folder));
    }
  }
  await writeFileAtomically(path.join(project.folders.state, 'project.json'), JSON.stringify(project, null, 2), 'utf8');
  projectSessions.invalidate(project.projectPath);
}

async function hydrateProject(project) {
  const selectedProjectPath = path.resolve(project.projectPath);
  const candidates = [
    path.join(selectedProjectPath, '.ai-director', 'project.json'),
    path.join(selectedProjectPath, 'project.json')
  ];
  for (const candidate of candidates) {
    try {
      const diskProject = JSON.parse(await fs.readFile(candidate, 'utf8'));
      relocateProjectReferences(diskProject, diskProject.projectPath, selectedProjectPath);
      // A copied .ai-director folder may still contain the previous computer's
      // drive path. The folder that was selected in the app is always the
      // source of truth, especially for shared drives.
      const pendingLocal = store.pendingProjectWrites?.[normalizedPath(selectedProjectPath)]
        && Date.parse(project.updatedAt) > Date.parse(diskProject.updatedAt || 0);
      const hydrated = { ...project, ...diskProject, ...(pendingLocal ? project : {}),
        id: diskProject.id || project.id || uid(), projectPath: selectedProjectPath };
      hydrated.folders = makeFolderMap(selectedProjectPath);
      hydrated.source = { name: '', content: '', files: [], updatedAt: null, ...(hydrated.source || {}) };
      hydrated.outline = { content: '', versions: [], updatedAt: null, ...(hydrated.outline || {}) };
      hydrated.script = { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null, ...(hydrated.script || {}) };
      hydrated.shotlist = { content: '', versions: [], updatedAt: null, ...(hydrated.shotlist || {}) };
      hydrated.storyboard = { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null, ...(hydrated.storyboard || {}) };
      hydrated.activeFiles = { source: '', outline: '', script: '', shotlist: '', storyboard: '', ...(hydrated.activeFiles || {}) };
      hydrated.documentFormats = normalizeDocumentFormats(hydrated.documentFormats);
      hydrated.promptSets = { script: [], shotlist: [], storyboard: [], ...(hydrated.promptSets || {}) };
      hydrated.ruleDocuments = hydrated.ruleDocuments || [];
      hydrated.referenceDocuments = hydrated.referenceDocuments || [];
      hydrated.assets = hydrated.assets || [];
      hydrated.executionPriority = String(hydrated.executionPriority || defaultExecutionPriority).trim() || defaultExecutionPriority;
      hydrated.memory = { project: '', characters: '', continuity: '', ...(hydrated.memory || {}) };
      hydrated.chatGptProjects = { script: '剧本工程', prompt: '提示词工程', ...(hydrated.chatGptProjects || {}) };
      hydrated.chatGptRunner = { mode: 'chrome', tabId: '', port: 9222, waitMinutes: 50, replyMode: 'auto', ...(hydrated.chatGptRunner || {}) };
      hydrated.generationMode = ['api', 'chrome', 'embedded'].includes(hydrated.generationMode)
        ? hydrated.generationMode
        : (hydrated.aiRunner?.mode === 'api' ? 'api' : hydrated.chatGptRunner.mode);
      hydrated.aiRunner = aiCore.normalizeRunnerConfig(hydrated);
      hydrated.validationChecks = { ...aiCore.defaultValidationChecks(), ...(hydrated.validationChecks || {}) };
      hydrated.workflowTemplates = normalizeWorkflowTemplates(hydrated.workflowTemplates);
      hydrated.chatGptRunner.waitMinutes = Number(hydrated.chatGptRunner.waitMinutes) === 30 ? 30 : 50;
      hydrated.chatGptRunner.replyMode = normalizeChatGptReplyMode(hydrated.chatGptRunner.replyMode);
      return ensureSeasonPlan(hydrated);
    } catch {
      // Continue to the fallback state location.
    }
  }
  return {
    ...project,
    projectPath: selectedProjectPath,
    folders: makeFolderMap(selectedProjectPath),
    documentFormats: normalizeDocumentFormats(project.documentFormats),
    workflowTemplates: normalizeWorkflowTemplates(project.workflowTemplates)
  };
}

async function listTextFiles(directory, limit = 300, { identifyEpisodes = false, extensions = referenceTextExtensions } = {}) {
  const files = [];
  async function visit(current) {
    if (files.length >= limit) return;
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit || entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (extensions.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(fullPath);
        files.push({ name: entry.name, path: fullPath, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    }
  }
  await visit(directory);
  const sorted = files.sort((a, b) => {
    const episodeA = episodeNumberFromFileName(a.name);
    const episodeB = episodeNumberFromFileName(b.name);
    if (episodeA !== null && episodeB !== null && episodeA !== episodeB) return episodeA - episodeB;
    if (episodeA !== null && episodeB === null) return -1;
    if (episodeA === null && episodeB !== null) return 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  if (!identifyEpisodes) return sorted;
  const identify = async (file) => {
    const fromFileName = episodeNumberFromFileName(file.name);
    if (fromFileName !== null) return { ...file, episodeNumber: fromFileName, episodeDetectedFrom: 'fileName' };
    try {
      const episodeNumber = episodeNumberFromDocumentContent(await readEpisodeHint(file.path, file));
      return { ...file, episodeNumber, episodeDetectedFrom: episodeNumber !== null ? 'content' : '' };
    } catch {
      return { ...file, episodeNumber: null, episodeDetectedFrom: '' };
    }
  };
  const identified = new Array(sorted.length);
  let nextFile = 0;
  await Promise.all(Array.from({ length: Math.min(4, sorted.length) }, async () => {
    for (;;) {
      const index = nextFile++;
      if (index >= sorted.length) return;
      identified[index] = await identify(sorted[index]);
    }
  }));
  return identified.sort((a, b) => {
    if (a.episodeNumber !== null && b.episodeNumber !== null && a.episodeNumber !== b.episodeNumber) return a.episodeNumber - b.episodeNumber;
    if (a.episodeNumber !== null && b.episodeNumber === null) return -1;
    if (a.episodeNumber === null && b.episodeNumber !== null) return 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
}

function normalizedPath(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/').toLocaleLowerCase();
}

function assetTypeFromPath(filePath) {
  return audioAssetExtensions.has(path.extname(filePath).toLowerCase()) ? 'audio' : 'image';
}

function normalizedAssetCategory(category, type = 'image') {
  if (Object.prototype.hasOwnProperty.call(assetCategoryFolders, category)) return category;
  return type === 'audio' ? 'voice' : 'role';
}

function assetCategoryFromPath(filePath, fallbackCategory, type) {
  const normalized = normalizedPath(filePath);
  for (const [category, folder] of Object.entries(assetCategoryFolders)) {
    if (normalized.includes(`/${folder.toLocaleLowerCase()}/`)) return category;
  }
  return normalizedAssetCategory(fallbackCategory, type);
}

async function listAssetFiles(directory, limit = 1200) {
  const files = [];
  async function visit(current) {
    if (files.length >= limit) return;
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit || entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (assetExtensions.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  }
  await visit(directory);
  return files;
}

async function assetEpisodeUsage(project, assets) {
  if (!assets.length) return assets;
  const folders = makeFolderMap(project.projectPath);
  const [scriptFiles, shotlistFiles, storyboardFiles] = await Promise.all([
    listTextFiles(folders.script, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
    listTextFiles(folders.storyboard, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
    listTextFiles(folders.seedance, 1600, { identifyEpisodes: true, extensions: editorExtensions })
  ]);
  const aliases = [...new Set(assets.flatMap((asset) => [asset.standardName, asset.name])
    .map((name) => normalizeTagName(name || ''))
    .filter((name) => name.length >= 2))];
  if (!aliases.length) return assets.map((asset) => ({ ...asset, episodes: [] }));
  const textsByEpisode = new Map();
  for (const file of [...scriptFiles, ...shotlistFiles, ...storyboardFiles]) {
    const episodeNumber = Number(file.episodeNumber);
    if (!Number.isFinite(episodeNumber)) continue;
    try {
      const existing = textsByEpisode.get(episodeNumber) || '';
      textsByEpisode.set(episodeNumber, `${existing}\n${await readTextDocument(file.path)}`);
    } catch {
      // A single unreadable document must not prevent the rest of the asset library from loading.
    }
  }
  const usageByAlias = new Map(aliases.map((alias) => [alias, new Set()]));
  for (const [episodeNumber, content] of textsByEpisode) {
    const tags = new Set(extractAtTags(content, aliases).map((tag) => normalizeTagName(tag)));
    for (const tag of tags) usageByAlias.get(tag)?.add(episodeNumber);
  }
  return assets.map((asset) => {
    const assetAliases = [asset.standardName, asset.name].map((name) => normalizeTagName(name || '')).filter(Boolean);
    const episodes = [...new Set(assetAliases.flatMap((alias) => [...(usageByAlias.get(alias) || [])]))].sort((a, b) => a - b);
    return { ...asset, episodes };
  });
}

async function scanAssetLibrary(project) {
  const folders = makeFolderMap(project.projectPath);
  const imagesRoot = path.join(folders.assets, 'images');
  const audioRoot = path.join(folders.assets, 'audio');
  const [imageFiles, audioFiles] = await Promise.all([listAssetFiles(imagesRoot), listAssetFiles(audioRoot)]);
  const stored = new Map((project.assets || []).filter((asset) => asset?.localPath)
    .map((asset) => [normalizedPath(asset.localPath), asset]));
  const paths = [...new Set([...imageFiles, ...audioFiles].map((filePath) => path.resolve(filePath)))];
  const assets = paths.map((localPath) => {
    const existing = stored.get(normalizedPath(localPath)) || {};
    const type = assetTypeFromPath(localPath);
    const extension = path.extname(localPath);
    const category = assetCategoryFromPath(localPath, existing.category, type);
    return {
      id: existing.id || uid(),
      name: existing.name || path.basename(localPath, extension),
      type,
      category,
      fileName: path.basename(localPath),
      localPath,
      prompt: existing.prompt || '',
      standardName: existing.standardName || '',
      createdAt: existing.createdAt || now()
    };
  }).sort((a, b) => {
    const categoryOrder = ['role', 'scene', 'prop', 'voice'];
    const byCategory = categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    if (byCategory) return byCategory;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  return assetEpisodeUsage(project, assets);
}

const assetPromptDocumentTypes = [
  { category: 'role', label: '人物', pattern: /(?:角色|人物).*资产提示词/i },
  { category: 'scene', label: '场景', pattern: /场景.*资产提示词/i },
  { category: 'prop', label: '道具', pattern: /道具.*资产提示词/i }
];

function assetPromptAppliesToEpisode(text, episodeNumber) {
  const episode = Number(episodeNumber);
  if (!Number.isFinite(episode)) return false;
  const value = String(text || '').replace(/\s+/g, '');
  const ranges = [...value.matchAll(/(?:第|EP)?(\d{1,4})(?:集)?(?:[-—~至到](?:第|EP)?(\d{1,4})(?:集)?)?/gi)];
  return ranges.some((match) => {
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    return episode >= Math.min(start, end) && episode <= Math.max(start, end);
  });
}

function assetPromptTitle(line) {
  return String(line || '')
    .replace(/^[-•\s]+/, '')
    .replace(/[（(].*$/, '')
    .replace(/^[【\[]|[】\]]$/g, '')
    .trim();
}

function parseAssetPromptEntries(content, episodeNumber) {
  const entries = [];
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let assetName = '';
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    const prompt = current.prompt.join('\n').trim();
    if (prompt) entries.push({ ...current, prompt });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/首次出现|出现[：:]/.test(line) && !/适用[：:]/.test(line)) {
      finishCurrent();
      assetName = assetPromptTitle(line);
      continue;
    }
    if (/适用[：:]/.test(line)) {
      finishCurrent();
      if (assetPromptAppliesToEpisode(line, episodeNumber)) {
        current = {
          name: assetName || assetPromptTitle(line) || '未命名素材',
          variant: assetPromptTitle(line) || '当前集版本',
          appliesTo: line
            .replace(/^[-•\s]*/, '')
            .match(/[（(].*[)）]/)?.[0]
            ?.replace(/[（）()]/g, '') || `适用：第${episodeNumber}集`,
          prompt: []
        };
      }
      continue;
    }
    if (current) {
      const promptStart = line.match(/^提示词[：:](.*)$/);
      if (promptStart) current.prompt.push(promptStart[1].trim());
      else if (current.prompt.length) current.prompt.push(line);
    }
  }
  finishCurrent();
  return entries;
}

async function loadAssetPromptLibrary(project, episodeNumber) {
  const folders = makeFolderMap(project.projectPath);
  const response = { episodeNumber: Number(episodeNumber), categories: {} };
  let files = [];
  try {
    files = await fs.readdir(folders.assets, { withFileTypes: true });
  } catch {
    return response;
  }
  await Promise.all(assetPromptDocumentTypes.map(async (type) => {
    const file = files.find((entry) => entry.isFile() && type.pattern.test(entry.name));
    if (!file) {
      response.categories[type.category] = { ...type, fileName: '', path: '', entries: [] };
      return;
    }
    const filePath = path.join(folders.assets, file.name);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      // A missing or externally edited asset prompt document should leave its tab empty.
    }
    response.categories[type.category] = {
      category: type.category,
      label: type.label,
      fileName: file.name,
      path: filePath,
      entries: parseAssetPromptEntries(content, episodeNumber)
    };
  }));
  return response;
}

async function readTextDocument(filePath) {
  if (path.extname(filePath).toLowerCase() === '.dtp') {
    await membershipService.assertCanUseBuiltinTemplates();
    return decryptTemplateFile(filePath);
  }
  if (path.extname(filePath).toLowerCase() === '.docx') return (await mammoth.extractRawText({ path: filePath })).value;
  return fs.readFile(filePath, 'utf8');
}

async function writeTextDocx(content, outputPath) {
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const paragraphs = (lines.length ? lines : ['']).map((line) => new Paragraph({
    children: [new TextRun(line || ' ')]
  }));
  const document = new Document({ sections: [{ children: paragraphs }] });
  await writeFileAtomically(outputPath, await Packer.toBuffer(document));
}

async function writeEditableDocument(filePath, content) {
  if (path.extname(filePath).toLowerCase() === '.docx') {
    await writeTextDocx(content, filePath);
    return;
  }
  await writeFileAtomically(filePath, content || '', 'utf8');
}

function classifyRuleDocument(name) {
  if (/(剧本|拆剧本|编剧)/i.test(name)) return 'script';
  if (/(分镜|seedance|镜头|时长|提示词|检查|准则|规范)/i.test(name)) return 'storyboard';
  return 'shared';
}

async function scanProjectFolder(project) {
  project.projectPath = path.resolve(project.projectPath);
  project.folders = makeFolderMap(project.projectPath);
  project.source = { name: '', content: '', files: [], updatedAt: null, ...(project.source || {}) };
  project.outline = { content: '', versions: [], updatedAt: null, ...(project.outline || {}) };
  project.activeFiles = { source: '', outline: '', script: '', shotlist: '', storyboard: '', ...(project.activeFiles || {}) };
  project.ruleDocuments = project.ruleDocuments || [];
  project.referenceDocuments = project.referenceDocuments || [];
  project.executionPriority = String(project.executionPriority || defaultExecutionPriority).trim() || defaultExecutionPriority;
  project.memory = { project: '', characters: '', continuity: '', ...(project.memory || {}) };
  project.workflowTemplates = normalizeWorkflowTemplates(project.workflowTemplates);
  project.documentFormats = normalizeDocumentFormats(project.documentFormats);

  const [sourceFiles, outlineFiles, scriptFiles, boardFiles, seedanceFiles, ruleFiles, scriptReferenceFiles, storyboardReferenceFiles] = await Promise.all([
    listTextFiles(project.folders.source, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
    listTextFiles(project.folders.outline, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
    listTextFiles(project.folders.script, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
    listTextFiles(project.folders.storyboard, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
    listTextFiles(project.folders.seedance, 1600, { identifyEpisodes: true, extensions: editorExtensions }),
    listTextFiles(project.folders.rules),
    listTextFiles(project.folders.scriptReferences),
    listTextFiles(project.folders.storyboardReferences)
  ]);
  project.source.files = sourceFiles;
  const chooseFile = (files, activePath, kind, preferred) => {
    const matching = files.filter((file) => fileMatchesDocumentFormat(file.path || file.name, documentFormatForKind(project, kind)));
    return matching.find((file) => file.path === activePath) || preferred?.(matching) || matching[0];
  };
  const primarySource = chooseFile(sourceFiles, project.activeFiles.source, 'source', (files) => files.find((file) => /高潮拆分|EP\d+/i.test(file.name)) || files.at(-1));
  const primaryOutline = chooseFile(outlineFiles, project.activeFiles.outline, 'outline');
  const primaryScript = chooseFile(scriptFiles, project.activeFiles.script, 'script');
  const primaryShotlist = chooseFile(boardFiles, project.activeFiles.shotlist, 'shotlist');
  const primaryStoryboard = chooseFile(seedanceFiles, project.activeFiles.storyboard, 'storyboard');
  const readScannedDocument = async (file) => {
    if (!file) return null;
    try {
      return { ...file, content: await readTextDocument(file.path) };
    } catch {
      return null;
    }
  };
  const [sourceDocument, outlineDocument, scriptDocument, shotlistDocument, storyboardDocument] = await Promise.all([
    readScannedDocument(primarySource),
    readScannedDocument(primaryOutline),
    readScannedDocument(primaryScript),
    readScannedDocument(primaryShotlist),
    readScannedDocument(primaryStoryboard)
  ]);
  if (sourceDocument) {
    project.source = { ...project.source, name: sourceDocument.name, content: sourceDocument.content, updatedAt: sourceDocument.modifiedAt };
    project.activeFiles.source = sourceDocument.path;
  }
  if (outlineDocument) {
    project.outline.content = outlineDocument.content;
    project.outline.updatedAt = outlineDocument.modifiedAt;
    project.activeFiles.outline = outlineDocument.path;
  }
  if (scriptDocument) {
    project.script.content = scriptDocument.content;
    project.script.updatedAt = scriptDocument.modifiedAt;
    project.activeFiles.script = scriptDocument.path;
  }
  if (shotlistDocument) {
    project.shotlist.content = shotlistDocument.content;
    project.shotlist.updatedAt = shotlistDocument.modifiedAt;
    project.activeFiles.shotlist = shotlistDocument.path;
  }
  if (storyboardDocument) {
    project.storyboard.content = storyboardDocument.content;
    project.storyboard.updatedAt = storyboardDocument.modifiedAt;
    project.activeFiles.storyboard = storyboardDocument.path;
  }
  const referencePaths = new Set([...scriptReferenceFiles, ...storyboardReferenceFiles].map((file) => file.path));
  const oldRules = new Map(project.ruleDocuments.map((doc) => [doc.path, doc]));
  const scannedRules = [];
  for (const ruleFile of ruleFiles.filter((file) => !referencePaths.has(file.path) && !file.path.startsWith(project.folders.promptTemplates) && file.name !== '导演台-项目记忆.txt')) {
    const existing = oldRules.get(ruleFile.path);
    scannedRules.push(existing || {
      id: uid(), name: ruleFile.name, path: ruleFile.path, category: classifyRuleDocument(ruleFile.name), enabled: true, importedAt: ruleFile.modifiedAt
    });
  }
  project.ruleDocuments = scannedRules;
  const oldReferences = new Map(project.referenceDocuments.map((doc) => [doc.path, doc]));
  project.referenceDocuments = [
    ...scriptReferenceFiles.map((file) => oldReferences.get(file.path) || ({ id: uid(), name: file.name, path: file.path, category: 'script', enabled: true, outputFormat: true, importedAt: file.modifiedAt })),
    ...storyboardReferenceFiles.map((file) => oldReferences.get(file.path) || ({ id: uid(), name: file.name, path: file.path, category: 'storyboard', enabled: true, outputFormat: true, importedAt: file.modifiedAt }))
  ];
  project.availableFiles = { outline: outlineFiles, script: scriptFiles, storyboard: boardFiles, seedance: seedanceFiles };
  // Document cache entries validate their own stat signatures. Opening one
  // project must not evict the other project's verified document reads.
  for (const [directory, files] of [[project.folders.outline, outlineFiles], [project.folders.script, scriptFiles],
      [project.folders.storyboard, boardFiles], [project.folders.seedance, seedanceFiles]]) episodeFileIndex.seed(directory, files);
  applyDetectedSeasonRange(project, [...sourceFiles, ...outlineFiles, ...scriptFiles, ...seedanceFiles]);
  project.assets = await scanAssetLibrary(project);
  return ensureSeasonPlan(project);
}

function matchesEpisodeFile(fileName, episodeNumber) {
  const episode = String(Number(episodeNumber));
  const escaped = episode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^0-9])(?:第\\s*)?${escaped}(?:\\s*(?:集|话|章)|[_-]|$)`, 'i').test(fileName)
    || new RegExp(`EP\\s*${escaped}(?:[^0-9]|$)`, 'i').test(fileName);
}

async function loadEpisodeDocuments(project, episodeNumber) {
  const folders = makeFolderMap(project.projectPath);
  if (project.preferKnownFiles === true) {
    const registered = store.projects.find(item => normalizedPath(item.projectPath) === normalizedPath(project.projectPath));
    const folderKinds = { outline: 'outline', script: 'script', shotlist: 'storyboard', storyboard: 'seedance' };
    const readKnown = async kind => {
      const files = registered?.availableFiles?.[folderKinds[kind]];
      if (!Array.isArray(files)) return null;
      const selected = episodeSlots.episodeByKey(project, episodeNumber)?.activeFiles?.[kind];
      const match = chooseEpisodeFile(files, project, kind, episodeNumber)
        || (kind === 'outline' ? files.find(file => file.path === selectedPathForOutline(project, episodeNumber)) || (files.length === 1 ? files[0] : null)
          : selected ? files.find(file => file.path === selected && episodeNumberFromFileName(file.name) === null) : null);
      if (!match || !fileIsInsideDirectory(match.path, folders[folderKinds[kind]]) || !fileMatchesDocumentFormat(match.path, documentFormatForKind(project, kind))) return null;
      try { return await episodeDocumentCache.read(match.path); }
      catch { return null; }
    };
    const [outline, script, shotlist, storyboard] = await Promise.all(['outline', 'script', 'shotlist', 'storyboard'].map(readKnown));
    return { episodeNumber: Number(episodeNumber), outline, script, shotlist, storyboard };
  }
  // Filter before identifying episodes: a TXT reader must not parse every Word
  // companion on the shared drive just to find the selected episode.
  const listForKind = (directory, kind) => {
    const format = documentFormatForKind(project, kind);
    return episodeFileIndex.list(directory, { extensions: new Set(format === 'md'
      ? ['.md', '.markdown'] : [extensionForDocumentFormat(format)]) });
  };
  const [outlineFiles, scriptFiles, shotlistFiles, storyboardFiles] = await Promise.all([
    listForKind(folders.outline, 'outline'),
    listForKind(folders.script, 'script'),
    listForKind(folders.storyboard, 'shotlist'),
    listForKind(folders.seedance, 'storyboard')
  ]);
  const readMatch = async (files, kind) => {
    const match = kind === 'outline'
      ? chooseEpisodeFile(files, project, kind, episodeNumber)
        || files.find((file) => selectedPathForOutline(project, episodeNumber)
          && path.resolve(file.path).toLowerCase() === path.resolve(selectedPathForOutline(project, episodeNumber)).toLowerCase())
        || (files.length === 1 ? files[0] : null)
      : chooseEpisodeFile(files, project, kind, episodeNumber);
    if (!match) return null;
    try {
      return await episodeDocumentCache.read(match.path);
    } catch {
      return null;
    }
  };
  const [outline, script, shotlist, storyboard] = await Promise.all([
    readMatch(outlineFiles, 'outline'),
    readMatch(scriptFiles, 'script'),
    readMatch(shotlistFiles, 'shotlist'),
    readMatch(storyboardFiles, 'storyboard')
  ]);
  return { episodeNumber: Number(episodeNumber), outline, script, shotlist, storyboard };
}

async function runProjectSmokeChecks(project) {
  if (!project.source.files?.length || !project.folders?.script || !project.folders?.seedance) {
    throw new Error('Project-folder scan did not discover the expected 00–05 structure.');
  }
  const episodeNumber = Number(project.currentEpisode) || Number(project.episodes?.[0]?.number) || 1;
  const documents = await loadEpisodeDocuments(project, episodeNumber);
  const prompt = await composeTaskPrompt(project, 'script', { episodeNumber });
  if (!prompt.includes('【项目】') || !prompt.includes('第' + episodeNumber + '集')) {
    throw new Error('Script task prompt did not include the selected project and episode.');
  }
  if (documents.outline?.content && !prompt.includes(documents.outline.content.slice(0, 20))) {
    throw new Error('Script task prompt did not include the selected outline.');
  }
  if (documents.storyboard) {
    const checks = validateStoryboard(documents.storyboard.content, documents.script?.content || '', documents.shotlist?.content || '');
    if (!Array.isArray(checks) || !checks.length) throw new Error('Storyboard check did not return a result.');
  }
  console.log('Project-folder scan passed: ' + project.source.files.length + ' source files found; episode range ' + project.season.startEpisode + '-' + project.season.endEpisode + '; episode ' + episodeNumber + ' document workflow checked.');
}

async function runDocumentFormatSmokeChecks(project) {
  const episodeNumber = Number(project.currentEpisode) || Number(project.episodes?.[0]?.number) || 1;
  project.currentEpisode = episodeNumber;
  project.documentFormats = normalizeDocumentFormats({ source: 'txt', outline: 'txt', script: 'docx', shotlist: 'md', storyboard: 'txt' });

  const outline = await saveProjectDocument(project, 'outline', `第${episodeNumber}集大纲格式验证\n开场、转折、结尾钩子。`);
  const word = await saveProjectDocument(project, 'script', `第${episodeNumber}集 Word 格式验证\n角色：这是一段可以重新读取的剧本。`);
  const markdown = await saveProjectDocument(project, 'shotlist', `# 第${episodeNumber}集分镜\n\n- 镜头1：Markdown 格式验证。`);
  const text = await saveProjectDocument(project, 'storyboard', `第${episodeNumber}集提示词\nTXT 格式验证。`);
  const reopenedOutline = await openProjectDocument(project, 'outline', outline.path);
  const reopenedWord = await openProjectDocument(project, 'script', word.path);
  const reopenedMarkdown = await openProjectDocument(project, 'shotlist', markdown.path);
  const reopenedText = await openProjectDocument(project, 'storyboard', text.path);

  if (path.extname(outline.path).toLowerCase() !== '.txt' || !reopenedOutline.content.includes('大纲格式验证')) {
    throw new Error('Outline document format smoke check failed.');
  }
  if (path.extname(word.path).toLowerCase() !== '.docx' || !reopenedWord.content.includes('Word 格式验证')) {
    throw new Error('Word document format smoke check failed.');
  }
  if (path.extname(markdown.path).toLowerCase() !== '.md' || !reopenedMarkdown.content.includes('Markdown 格式验证')) {
    throw new Error('Markdown document format smoke check failed.');
  }
  if (path.extname(text.path).toLowerCase() !== '.txt' || !reopenedText.content.includes('TXT 格式验证') || text.docxPath) {
    throw new Error('TXT document format smoke check failed.');
  }
  console.log(`Document formats passed: ${path.basename(outline.path)}, ${path.basename(word.path)}, ${path.basename(markdown.path)}, ${path.basename(text.path)}; each save uses its selected format.`);
}

async function adoptProjectFolder(projectPath, { scan = true } = {}) {
  const selectedProjectPath = path.resolve(projectPath);
  const title = path.basename(selectedProjectPath);
  const existing = store.projects.find(item => normalizedPath(item.projectPath) === normalizedPath(selectedProjectPath));
  const candidate = { ...existing, projectPath: selectedProjectPath, title: existing?.title || title };
  const hydrated = await hydrateProject(candidate);
  const project = { ...createProject({ title, projectPath: selectedProjectPath }), ...hydrated, projectPath: selectedProjectPath, folders: makeFolderMap(selectedProjectPath) };
  if (!project.id) project.id = uid();
  project.title = hydrated.title || title;
  if (scan) await scanProjectFolder(project);
  return project;
}

async function openProjectFolder(projectPath) {
  const registered = store.projects.find(project => normalizedPath(project.projectPath) === normalizedPath(projectPath));
  const project = registered && projectWrites.hasWork(projectPath) ? registered : await projectSessions.load(projectPath);
  if (store.pendingProjectWrites?.[normalizedPath(project.projectPath)] && !projectWrites.hasWork(project.projectPath)) projectWrites.enqueue(project);
  // Reuse the saved index on the first episode click too. Hints are verified
  // against file metadata before being trusted; directory listings stay live.
  for (const kind of ['outline', 'script', 'storyboard', 'seedance']) {
    if (Array.isArray(project.availableFiles?.[kind])) episodeFileIndex.seed(project.folders[kind], project.availableFiles[kind]);
  }
  // Registered projects have already been adopted. Check the working folders
  // when first adopting, or when saving/refreshing explicitly needs them.
  const missingFolders = registered ? [] : missingProjectFolders(project.projectPath);
  if (missingFolders.length) {
    const canCreate = (await membershipService.status()).canEdit;
    const dialogResult = await dialog.showMessageBox(activeWorkspaceWindow(), {
      type: 'question',
      title: '项目文件夹不完整',
      message: `这个项目还缺少 ${missingFolders.length} 个工作文件夹，要现在创建吗？`,
      detail: `${missingFolders.map((folder) => folder.name).join('、')}\n\n选择“现在创建”会补齐导演台的标准目录；选择“保持现状”会直接打开项目，之后在保存或生成需要时再创建对应目录。${canCreate ? '' : '\n\n当前会员没有编辑权限，暂不能创建目录。'}`,
      buttons: canCreate ? ['现在创建', '保持现状'] : ['保持现状'],
      defaultId: 0,
      cancelId: canCreate ? 1 : 0,
      noLink: true
    });
    if (canCreate && dialogResult.response === 0) await writeProject(project);
  }
  const existingIndex = store.projects.findIndex((item) => normalizedPath(item.projectPath) === normalizedPath(project.projectPath));
  if (existingIndex >= 0) store.projects[existingIndex] = project;
  else store.projects.push(project);
  if (!registered || registered.id !== project.id) await persistStore();
  return project;
}

async function listProjects() {
  const projectsByPath = new Map();
  for (const storedProject of store.projects) {
    const projectPath = String(storedProject?.projectPath || '').trim();
    if (!projectPath) continue;
    let stat;
    try {
      stat = await fs.stat(path.resolve(projectPath));
    } catch {
      // A removable/shared drive may only be temporarily unavailable. Keep
      // its identity and recent entry so reconnecting restores the project.
      projectsByPath.set(normalizedPath(projectPath), { ...storedProject, unavailable: true });
      continue;
    }
    if (!stat.isDirectory()) {
      projectsByPath.set(normalizedPath(projectPath), { ...storedProject, unavailable: true });
      continue;
    }
    // Recent entries need names and paths, not every project's full script.
    // Hydrate only the project the user actually opens.
    const scanned = { ...storedProject, projectPath: path.resolve(projectPath) };
    delete scanned.unavailable;
    const key = normalizedPath(scanned.projectPath);
    const previous = projectsByPath.get(key);
    if (!previous || new Date(scanned.updatedAt).getTime() >= new Date(previous.updatedAt).getTime()) projectsByPath.set(key, scanned);
  }
  store.projects = [...projectsByPath.values()];
  return [...store.projects].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(recentProject);
}

async function forgetProjects(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error('请选择要移除的项目记录。');
  assertGenerationIdle();
  const selected = new Set(ids);
  const removed = store.projects.filter(project => selected.has(project.id));
  if (removed.some(project => projectSessions.isLoading(project.projectPath))) throw new Error('项目正在打开，请等待切换完成后再移除记录。');
  store.projects = store.projects.filter(project => !selected.has(project.id));
  try { await persistStore(); }
  catch (error) {
    for (const project of removed) if (!store.projects.some(item => normalizedPath(item.projectPath) === normalizedPath(project.projectPath))) store.projects.push(project);
    throw error;
  }
  for (const project of removed) {
    projectSessions.invalidate(project.projectPath);
    episodeFileIndex.removeProject(project.projectPath);
    episodeDocumentCache.removeProject(project.projectPath);
  }
  return { removed: removed.length, projects: [...store.projects].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(recentProject) };
}

function checkResult(level, title, detail, group = null, shot = null) {
  return { id: uid(), level, title, detail, group, shot };
}

function extractGroups(content) {
  // 同时兼容“镜头1-4”和“镜头257-1-07—257-1-13”两种项目编号。
  const header = /第\s*(\d+)\s*组\s*[（(]\s*镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[-—–]\s*(\d+(?:\s*-\s*\d+)*)\s*[，,]\s*总时长(?:约)?\s*(\d+)\s*秒\s*[）)]/g;
  const matches = [...content.matchAll(header)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    firstShot: match[2].replace(/\s+/g, ''),
    lastShot: match[3].replace(/\s+/g, ''),
    duration: Number(match[4]),
    raw: content.slice(match.index, matches[index + 1]?.index ?? content.length)
  }));
}

function extractShots(group) {
  const pattern = /镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[：:]\s*\[\s*(\d+)\s*秒\s*[-—–]\s*(\d+)\s*秒\s*\]([\s\S]*?)(?=镜头\s*\d+(?:\s*-\s*\d+)*\s*[：:]\s*\[|$)/g;
  return [...group.raw.matchAll(pattern)].map((match) => ({
    number: match[1].replace(/\s+/g, ''),
    start: Number(match[2]),
    end: Number(match[3]),
    text: match[0]
  }));
}

function chineseCharacters(text) {
  return (text.match(/[\u3400-\u9fff]/g) || []).length;
}

function normalizeTagName(value = '') {
  return String(value)
    .replace(/\s+/g, '')
    .replace(/(?:的)?(?:参考)?(?:角色|人物|场景|道具|空间结构)$/u, '')
    .trim();
}

function extractAtTags(text, knownTags = []) {
  const known = [...new Set(knownTags.map(normalizeTagName).filter(Boolean))].sort((a, b) => b.length - a.length);
  const tags = [];
  const pattern = /@\[([^\]\r\n]+)\]|@([^\s@[\]{}<>"'`，。；：、,.!?！？;:()（）]+)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = normalizeTagName(match[1] || match[2]);
    if (!raw) continue;
    const resolved = known.find((tag) => raw.startsWith(tag)) || raw;
    tags.push(resolved);
  }
  return tags;
}

function sectionHeaderMatch(content, title) {
  const escapedTitle = String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${escapedTitle}\\s*(?:(?:[：:]\\s*)|(?=\\r?$))`, 'm').exec(String(content));
}

function extractReferenceMaterial(groupRaw) {
  const referenceHeader = sectionHeaderMatch(groupRaw, '参考素材');
  if (!referenceHeader) return '';
  const contentStart = referenceHeader.index + referenceHeader[0].length;
  const sequenceHeader = sectionHeaderMatch(groupRaw.slice(contentStart), '分镜序列');
  const contentEnd = sequenceHeader ? contentStart + sequenceHeader.index : groupRaw.length;
  return groupRaw.slice(contentStart, contentEnd);
}

function extractStoryboardSequence(groupRaw) {
  const sequenceHeader = sectionHeaderMatch(groupRaw, '分镜序列');
  if (!sequenceHeader) return '';
  const contentStart = sequenceHeader.index + sequenceHeader[0].length;
  const remaining = groupRaw.slice(contentStart);
  // The final group is followed by whole-episode sections. They are summaries,
  // not shots, and must never participate in material or dialogue checking.
  const afterSequenceHeader = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:【\s*)?(?:台词整合|台词文稿匹配|统一风格与约束|实际总时长|分镜组数)(?:\s*】)?\s*(?:[：:]|$)/m.exec(remaining);
  const contentEnd = afterSequenceHeader ? contentStart + afterSequenceHeader.index : groupRaw.length;
  return groupRaw.slice(contentStart, contentEnd);
}

function extractCheckableStoryboardContent(content) {
  const raw = String(content || '');
  // “台词整合” and the matching table are delivery summaries. Everything from
  // the first summary heading to EOF is deliberately outside the checker.
  const summaryHeader = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:【\s*)?(?:台词整合|台词文稿匹配)(?:\s*】)?\s*(?:[：:]|$)/m.exec(raw);
  return summaryHeader ? raw.slice(0, summaryHeader.index) : raw;
}

function extractDialogueMarkers(text) {
  return [...new Set([...String(text).matchAll(/[（(]\s*(V\.O\.|O\.S\.)\s*[）)]/gi)].map((match) => match[1].toUpperCase()))];
}

function normalizeSpeakerName(value = '') {
  return normalizeTagName(String(value)
    .replace(/\*\*/g, '')
    .replace(/[【】\[\]]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^@\[/, '')
    .replace(/^@/, '')
    .replace(/\]$/g, '')
    .trim());
}

function isScriptSceneHeading(line = '') {
  // 剧本从“162-1”或“1-1”这类场景题头开始；前置项目说明中的冒号
  // 不能被误当作人物对白。
  return /^\s*\d{1,4}\s*[-—]\s*\d+\s+\S+/.test(String(line));
}

function isScriptDialogueSpeaker(value = '') {
  const raw = String(value).replace(/\*\*/g, '').trim();
  if (!raw || raw.length > 48 || /^△/.test(raw)) return false;
  if (/^(?:【\s*)?(?:音效|字幕|制作说明|画面|动作|场景题头|对白|专业术语)(?:\s*】)?/.test(raw)) return false;
  const name = normalizeSpeakerName(raw);
  if (!name || name.length > 16) return false;
  if (!/^[\u3400-\u9fffA-Za-z0-9·\-]+$/.test(name)) return false;
  return !/^(镜头|声音|参考素材|分镜序列|任务类型|实际总时长|分镜组数|目标总时长|目标时长|总时长|时长|出场人物|人物|场景|画面|字幕|音效|AI生成模型|第\s*\d+\s*(?:集|话|章))/.test(name);
}

function normalizeDialogueText(text) {
  return String(text)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[“”"'`]/g, '')
    .replace(/[\s，。！？、；：,.!?;:]/g, '')
    .trim();
}

function extractScriptDialogues(content, { excludeRecap = false } = {}) {
  const dialogues = [];
  let insideScene = false;
  let includeScene = true;
  for (const [lineIndex, line] of String(content).split(/\r?\n/).entries()) {
    if (isScriptSceneHeading(line)) {
      insideScene = true;
      includeScene = !excludeRecap || !/^\s*0\s*[-—]\s*\d+\s+\S+/.test(line);
      continue;
    }
    if (!insideScene || !includeScene) continue;
    if (/^\s*△/.test(line)) continue;
    if (/^\s*【\s*AI生成模型\s*[：:]/.test(line)) continue;
    if (/^\s*第\s*\d+\s*(?:集|话|章)\s*[：:]/.test(line)) continue;
    if (/^\s*(?:目标)?总时长\s*[：:]/.test(line)) continue;
    const match = line.match(/^\s*(?:\*\*)?(.{1,32}?)(?:\*\*)?[：:]\s*(.+?)\s*$/);
    if (!match) continue;
    const speaker = match[1].replace(/\*\*/g, '').trim();
    if (!isScriptDialogueSpeaker(speaker)) continue;
    const raw = match[2].replace(/【[^】]*】/g, '').trim();
    const spoken = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
    const normalized = normalizeDialogueText(spoken);
    if (normalized.length < 2) continue;
    dialogues.push({ speaker, speakerName: normalizeSpeakerName(speaker), raw, spoken, normalized, markers: extractDialogueMarkers(speaker + ' ' + raw), line: lineIndex + 1 });
  }
  return dialogues;
}

function normalizeOriginalDialogueText(text = '') {
  return normalizeDialogueText(text).replace(/[…—－]/g, '');
}

function extractSourceDialogues(content = '') {
  const dialogues = [];
  const pattern = /“([^”\r\n]{1,800})”|「([^」\r\n]{1,800})」/g;
  for (const match of String(content).matchAll(pattern)) {
    const spoken = String(match[1] || match[2] || '').trim();
    const normalized = normalizeOriginalDialogueText(spoken);
    if (normalized.length >= 2) dialogues.push({ spoken, normalized });
  }
  return dialogues;
}

function validateScriptDialogueFidelity(script = '', source = '') {
  return require('./document-checks').validateScriptDialogueFidelity(script, source);
}

function normalizeStoryboardSpeakerTag(value = '') {
  return normalizeSpeakerName(String(value)
    // 兼容“@人物使用音频说”“@人物开口说”等没有空格的 Seedance 写法。
    .replace(/(?:使用)?(?:音频|音色|声线|配音)[^，。；：{}]*/g, '')
    .replace(/(?:开口|继续|开始|随后|随即)?(?:说|发声|画外音)[^，。；：{}]*/g, '')
    .replace(/(?:正在)?(?:说话|讲话)[^，。；：{}]*/g, ''));
}

function extractStoryboardSpeaker(context, knownSpeakers = []) {
  const source = String(context || '');
  const known = [...new Set(knownSpeakers.map(normalizeSpeakerName).filter(Boolean))];
  // Seedance 的发声写法既可能是“开口说”，也可能是“画外音”。取最后一个
  // 发声提示之前的同一句片段，避免把画面里最后出现的道具或人物当作说话人。
  const cues = [...source.matchAll(/(?:开口|继续)?说|画外音/g)];
  const cue = cues.at(-1);
  const beforeSpeech = source.slice(0, cue ? cue.index : source.length);
  const recent = beforeSpeech.slice(-220);
  const clauseStart = Math.max(recent.lastIndexOf('，'), recent.lastIndexOf('。'), recent.lastIndexOf('；'), recent.lastIndexOf('：')) + 1;
  const clauseTags = extractAtTags(recent.slice(clauseStart), known).map(normalizeStoryboardSpeakerTag).filter(Boolean);
  // 在“@[江娟]指着@[鸡汤砂锅]开口说”这类结构中，发声子句里的第一个
  // @ 标签才是人物；最后一个标签可能只是道具或场景。优先按剧本已知人物名消歧。
  const knownSpeaker = clauseTags.find((tag) => known.includes(tag));
  if (knownSpeaker) return knownSpeaker;
  return clauseTags[0] || extractAtTags(recent, known).map(normalizeStoryboardSpeakerTag).filter(Boolean).at(-1) || '';
}

function extractStoryboardDialogues(content, knownSpeakers = []) {
  const dialogues = [];
  const pattern = /\{([^}\r\n]*)\}/g;
  for (const group of extractGroups(content)) {
    const sequence = extractStoryboardSequence(group.raw);
    for (const match of sequence.matchAll(pattern)) {
      const shotStart = Math.max(0, sequence.lastIndexOf('镜头', match.index));
      const context = sequence.slice(shotStart, match.index);
      const spoken = match[1].trim();
      const normalized = normalizeDialogueText(spoken);
      if (normalized.length < 2) continue;
      const speakerName = extractStoryboardSpeaker(context, knownSpeakers);
      const shot = context.match(/镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[：:]/)?.[1]?.replace(/\s+/g, '') || null;
      dialogues.push({ spoken, normalized, speakerName, markers: extractDialogueMarkers(context), index: match.index, group: group.number, shot });
    }
  }
  return dialogues;
}

function speakerCompatible(scriptDialogue, storyboardDialogue) {
  const scriptSpeaker = normalizeSpeakerName(scriptDialogue?.speakerName || scriptDialogue?.speaker);
  const storyboardSpeaker = normalizeSpeakerName(storyboardDialogue?.speakerName || '');
  // 台词核对必须同时对上人物。提示词缺少发声人物、或由其他人物说出，
  // 都属于“提示词台词与剧本不一致”，不能当作已复刻。
  return Boolean(scriptSpeaker && storyboardSpeaker && scriptSpeaker === storyboardSpeaker);
}

function isLikelyDialogueVariant(first = '', second = '') {
  const left = String(first);
  const right = String(second);
  const shorter = Math.min(left.length, right.length);
  if (shorter < 3) return false;
  let prefix = 0;
  while (prefix < shorter && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  // 只把文本主体明显相同、但有少量改字/漏字的同一句定位为“不一致”。
  // 完全不同的台词不会被强行配对，仍按“缺少人物台词”处理。
  return prefix >= 2 && (prefix + suffix) / shorter >= 0.5;
}

function findStoryboardDialogueCoverage(scriptDialogue, storyboardDialogues) {
  const target = scriptDialogue.normalized;
  const compatible = storyboardDialogues.filter((item) => speakerCompatible(scriptDialogue, item));
  const direct = compatible.find((item) => item.normalized === target);
  if (direct) return { matched: true, items: [direct] };

  // Seedance 可能把同一句台词拆到相邻镜头中：只合并同一发声人的连续片段，
  // 且规范化后必须完全一致，避免不同人物的台词被误拼接。
  for (let start = 0; start < storyboardDialogues.length; start += 1) {
    const first = storyboardDialogues[start];
    if (!speakerCompatible(scriptDialogue, first)) continue;
    let combined = '';
    const items = [];
    for (let end = start; end < storyboardDialogues.length && end < start + 12; end += 1) {
      const item = storyboardDialogues[end];
      if (!speakerCompatible(scriptDialogue, item)) break;
      combined += item.normalized;
      items.push(item);
      if (combined === target) return { matched: true, items };
      if (!target.startsWith(combined)) break;
    }
  }

  // 文字相同但发声人物不同，不能被当成“缺少台词”；应明确提示为人物/台词不一致。
  const sameTextWrongSpeaker = storyboardDialogues.find((item) => item.normalized === target) || null;
  if (sameTextWrongSpeaker) return { matched: false, items: [], partial: sameTextWrongSpeaker, reason: 'speaker' };
  const partial = compatible.find((item) =>
    item.normalized.includes(target) || target.includes(item.normalized) || isLikelyDialogueVariant(item.normalized, target)) || null;
  return { matched: false, items: [], partial, reason: partial ? 'text' : 'missing' };
}

// 提示词质检只保留导演台实际要拦截的五类问题：缺少 @ 引用、单镜头多人
// 发声、口播时间不足、台词与剧本不一致、缺少人物台词。其余格式、组号、
// 机位、时长闭合、V.O./O.S. 等规则不再产生问题卡片。
function validateStoryboard(content, script = '', shotlist = '') {
  const results = [];
  const checkableContent = extractCheckableStoryboardContent(content);
  if (!checkableContent.trim()) return [checkResult('info', '暂无可检查提示词', '当前集还没有可检查的 Seedance 提示词，尚未执行结构核对。')];

  const groups = extractGroups(checkableContent);
  const scriptDialogues = extractScriptDialogues(script);
  const knownSpeakers = scriptDialogues.map((item) => item.speakerName);
  // 素材定义按“当前集”汇总：角色、场景、道具只要在本集任意一组参考素材中
  // 定义过，后续分镜组复用时就视为有效，不要求每组重复写一次。
  const episodeDefinedTags = new Set(groups.flatMap((group) => extractAtTags(extractReferenceMaterial(group.raw))));
  for (const group of groups) {
    const sequence = extractStoryboardSequence(group.raw);
    const usedTags = new Set(extractAtTags(sequence, [...episodeDefinedTags]));

    // @ 检查只看分镜序列：序列中使用的 @ 必须在当前集参考素材中提及；
    // 参考素材多写了什么不报错。同组缺失合并成一张问题卡，避免刷屏。
    if (sequence.trim() && usedTags.size) {
        const missingTags = [...usedTags].filter((tag) => !episodeDefinedTags.has(tag));
        if (missingTags.length) results.push(checkResult('error', '缺少@', `第${group.number}组分镜序列中的@${missingTags.join('、@')}未在本集“参考素材”中提及。`, group.number));
    }

    for (const shot of extractShots(group)) {
      const shotTags = extractAtTags(shot.text, [...episodeDefinedTags]);
      // 不强制每个镜头重复写 @场景；只要该镜头已明确引用任意角色、场景或
      // 道具 @ 素材即可。只有完全没有 @ 时才判为缺少引用。
      if (!shotTags.length) {
        results.push(checkResult('error', '缺少@', `镜头${shot.number}没有任何@人物、@场景或@道具引用。`, group.number, shot.number));
      }

      const speech = [...shot.text.matchAll(/\{([^}\r\n]*)\}/g)];
      if (speech.length > 1) {
        const speakers = [...new Set(speech
          .map((item) => extractStoryboardSpeaker(shot.text.slice(0, item.index), knownSpeakers))
          .map(normalizeSpeakerName)
          .filter(Boolean))];
        if (speakers.length > 1) {
          results.push(checkResult('error', '单镜头多人发声', `镜头${shot.number}中${speakers.map((speaker) => '@' + speaker).join('、')}均有{ }台词，需要拆为独立镜头。`, group.number, shot.number));
        }
      } else if (speech.length === 1) {
        const words = chineseCharacters(speech[0][1]);
        const available = shot.end - shot.start;
        if (available > 0 && words / 6 > available) {
          results.push(checkResult('warning', '口播时间不足', `镜头${shot.number}约${words}字，当前约${(words / available).toFixed(1)}字/秒；4–6字/秒为正常范围，至少需要${Math.ceil(words / 6)}秒。`, group.number, shot.number));
        }
      }
    }
  }

  const storyboardDialogues = extractStoryboardDialogues(checkableContent, knownSpeakers);
  if (scriptDialogues.length) {
    const matchedStoryboardDialogues = new Set();
    const reportedStoryboardDialogues = new Set();
    for (const dialogue of scriptDialogues) {
      const coverage = findStoryboardDialogueCoverage(dialogue, storyboardDialogues);
      if (!coverage.matched) {
        const partial = coverage.partial;
        const excerpt = dialogue.spoken.slice(0, 32) + (dialogue.spoken.length > 32 ? '…' : '');
        const title = partial ? '台词和剧本不一致' : '缺少人物台词';
        const detail = coverage.reason === 'speaker'
          ? '剧本中“' + excerpt + '”应由@' + dialogue.speakerName + '说出；提示词中的发声人物不一致。'
          : partial
            ? '剧本中“' + excerpt + '”与分镜序列中的{ }台词不一致；同一人物连续拆句会自动合并后再比对。'
            : '剧本中@' + dialogue.speakerName + '的“' + excerpt + '”未在分镜序列的{ }中找到。';
        results.push(checkResult('error', title, detail, partial?.group || null, partial?.shot || null));
        if (partial) reportedStoryboardDialogues.add(partial);
        continue;
      }
      for (const item of coverage.items) matchedStoryboardDialogues.add(item);
    }
    for (const dialogue of storyboardDialogues) {
      if (matchedStoryboardDialogues.has(dialogue) || reportedStoryboardDialogues.has(dialogue)) continue;
      const relatedScriptLine = scriptDialogues.some((scriptDialogue) =>
        scriptDialogue.normalized.includes(dialogue.normalized) || dialogue.normalized.includes(scriptDialogue.normalized));
      if (relatedScriptLine) continue;
      const speaker = dialogue.speakerName ? '@' + dialogue.speakerName : '未标注人物';
      const excerpt = dialogue.spoken.slice(0, 32) + (dialogue.spoken.length > 32 ? '…' : '');
      results.push(checkResult('error', '台词和剧本不一致', '分镜序列中' + speaker + '的“' + excerpt + '”未在剧本人物台词中找到。', dialogue.group, dialogue.shot));
    }
  }

  if (!results.length) results.push(checkResult('pass', '质检通过', '未发现缺少@、多人发声、口播时间、台词不一致或缺少人物台词的问题。'));
  return results;
}

// 保留旧实现仅用于兼容历史数据；运行时不会调用。
function validateStoryboardLegacy(content, script = '', shotlist = '') {
  const results = [];
  const checkableContent = extractCheckableStoryboardContent(content);
  const groups = extractGroups(checkableContent);
  const totalMatch = checkableContent.match(/实际总时长：(?:约)?\s*(\d+)\s*秒/);
  const groupCountMatch = checkableContent.match(/分镜组数\s*[：:]\s*(\d+)\s*组/);
  const claimedTotal = totalMatch ? Number(totalMatch[1]) : 0;
  const styleCount = (checkableContent.match(/【统一风格与约束】/g) || []).length;

  if (!checkableContent.trim()) return [checkResult('error', '还没有分镜内容', '请先生成或粘贴一集 Seedance 分镜提示词。')];
  if (!claimedTotal) results.push(checkResult('error', '缺少实际总时长', '请在开头写“实际总时长：约X秒”。'));
  if (claimedTotal && (claimedTotal < 90 || claimedTotal > 150)) results.push(checkResult('error', '整集时长超出范围', `当前标注${claimedTotal}秒，要求为90–150秒。`));
  if (!groupCountMatch) results.push(checkResult('error', '缺少分镜组数', '请在开头写“分镜组数：X组”。'));
  if (styleCount !== 1) results.push(checkResult('error', '统一风格位置或次数错误', `【统一风格与约束】应仅在整集开头出现一次，当前为${styleCount}次。`));
  if (!groups.length) results.push(checkResult('error', '未识别到分镜组', '请使用“第X组（镜头1-4，总时长XX秒）”格式。'));
  if (groups.length > 12) results.push(checkResult('error', '分镜组数过多', `当前${groups.length}组，整集最多12组。`));
  if (groupCountMatch && Number(groupCountMatch[1]) !== groups.length) results.push(checkResult('error', '分镜组数不匹配', `开头标注${groupCountMatch[1]}组，正文实际识别到${groups.length}组。`));
  for (const heading of ['【核心角色】', '【核心场景】', '【核心道具】', '【音色参考】']) {
    if (!checkableContent.includes(heading)) results.push(checkResult('warning', '缺少整集基础信息', `成品开头建议包含${heading}。`));
  }
  if (/将\s*\[[^\]\s][^\]]*\]/.test(checkableContent) || /音频\s*\[[^\]\s][^\]]*\]/.test(checkableContent)) {
    results.push(checkResult('error', '固定占位符被填写', '参考素材与音频中的[ ]必须保持空白，不能填写图号、文件名或音频编号。'));
  }
  if (/后期字幕/.test(checkableContent)) results.push(checkResult('warning', '后期字幕混入主提示词', '统一约束要求无字幕；后期字幕应独立管理，不直接投喂 Seedance。'));

  let accumulatedDuration = 0;
  let expectedGroup = 1;
  let expectedShot = 1;
  for (const group of groups) {
    accumulatedDuration += group.duration;
    if (group.number !== expectedGroup) results.push(checkResult('error', '分镜组号不连续', `应为第${expectedGroup}组，实际为第${group.number}组。`, group.number));
    expectedGroup += 1;
    if (group.duration > 15) results.push(checkResult('error', '单组时长超限', `第${group.number}组为${group.duration}秒，单组不得超过15秒。`, group.number));
    const referenceHeader = sectionHeaderMatch(group.raw, '参考素材');
    const sequenceHeader = sectionHeaderMatch(group.raw, '分镜序列');
    const hasReferenceMaterial = Boolean(referenceHeader);
    const hasSequence = Boolean(sequenceHeader);
    if (!hasReferenceMaterial) results.push(checkResult('error', '缺少参考素材', `第${group.number}组需要先定义实际使用的角色、场景和关键道具。`, group.number));
    if (!hasSequence) results.push(checkResult('error', '缺少分镜序列', `第${group.number}组没有“分镜序列”栏目。`, group.number));

    const sequence = hasSequence ? extractStoryboardSequence(group.raw) : '';
    const referenceMaterial = extractReferenceMaterial(group.raw);
    const definedTags = new Set(extractAtTags(referenceMaterial));
    const usedTags = new Set(extractAtTags(sequence, [...definedTags]));
    const definedScenes = new Set(referenceMaterial.split(/\r?\n/)
      .filter((line) => /空间结构|场景/.test(line))
      .flatMap((line) => extractAtTags(line, [...definedTags])));
    const definedCharacters = new Set(referenceMaterial.split(/\r?\n/)
      .filter((line) => /角色|人物/.test(line))
      .flatMap((line) => extractAtTags(line, [...definedTags])));
    if (hasReferenceMaterial && !definedTags.size) results.push(checkResult('error', '参考素材未标注@素材', `第${group.number}组的“参考素材”中没有可识别的@角色、@场景或@道具。`, group.number));
    if (hasReferenceMaterial && !definedScenes.size) results.push(checkResult('warning', '参考素材未标注场景', `第${group.number}组没有在参考素材中用@标注空间结构或场景。`, group.number));
    if (hasReferenceMaterial && hasSequence) {
      for (const tag of usedTags) {
        if (!definedTags.has(tag)) results.push(checkResult('error', '使用了未提及参考素材', `第${group.number}组分镜序列中的@${tag}未在“参考素材”中提及。`, group.number));
      }
    }

    const shots = extractShots(group);
    if (!shots.length) results.push(checkResult('error', '未识别到镜头时间', `第${group.number}组镜头必须使用“镜头X：[0秒-3秒]”格式。`, group.number));
    if (shots.length > 6) results.push(checkResult('error', '单组镜头过多', `第${group.number}组有${shots.length}个镜头，最多6个。`, group.number));
    let expectedStart = 0;
    for (const shot of shots) {
      expectedShot += 1;
      if (shot.start !== expectedStart) results.push(checkResult('error', '组内时间不连续', `镜头${shot.number}应从${expectedStart}秒开始，实际从${shot.start}秒开始。`, group.number, shot.number));
      if (shot.end <= shot.start) results.push(checkResult('error', '镜头时间倒挂', `镜头${shot.number}的结束时间必须大于开始时间。`, group.number, shot.number));
      if (shot.end - shot.start < 1) results.push(checkResult('error', '镜头过短', `镜头${shot.number}不得使用0.5秒等极短时长。`, group.number, shot.number));
      expectedStart = shot.end;
      const shotTags = extractAtTags(shot.text, [...definedTags]);
      const shotScene = shotTags.find((tag) => definedScenes.has(tag)) || '';
      if (definedScenes.size && !shotScene) results.push(checkResult('error', '镜头缺少@场景', `镜头${shot.number}必须显式写出本组“参考素材”中定义的@场景。`, group.number, shot.number));
      const shotCharacter = shotTags.find((tag) => definedCharacters.has(tag)) || '';
      if (/中心构图/.test(shot.text) && !shotCharacter) results.push(checkResult('error', '中心构图缺少人物主体', `镜头${shot.number}使用“中心构图”时，需要明确以@人物为画面中心。`, group.number, shot.number));
      const speech = [...shot.text.matchAll(/\{([^}\r\n]*)\}/g)];
      if (speech.length > 1) results.push(checkResult('error', '单镜头多人发声', `镜头${shot.number}出现${speech.length}句发声内容，需要拆为独立镜头。`, group.number, shot.number));
      if (speech.length === 1) {
        const words = chineseCharacters(speech[0][1]);
        const available = shot.end - shot.start;
        if (words / 6 > available) results.push(checkResult('warning', '口播时间可能不足', `镜头${shot.number}约${words}字，当前约${(words / available).toFixed(1)}字/秒；4–6字/秒均为正常范围，建议至少预留${Math.ceil(words / 6)}秒。`, group.number, shot.number));
      }
      if (/[（(]\s*V\.O\.\s*[）)]/i.test(shot.text) && !/(闭口|无说话口型)/.test(shot.text)) results.push(checkResult('error', 'V.O.口型风险', `镜头${shot.number}使用V.O.时需注明“闭口、无说话口型”。`, group.number, shot.number));
    }
    if (shots.length && expectedStart !== group.duration) results.push(checkResult('error', '组内时长未闭合', `第${group.number}组标注${group.duration}秒，镜头实际结束于${expectedStart}秒。`, group.number));
    if (shots.length && (shots[0].number !== group.firstShot || shots.at(-1).number !== group.lastShot)) results.push(checkResult('error', '组标题镜头范围不匹配', `第${group.number}组标题为镜头${group.firstShot}-${group.lastShot}，正文范围不一致。`, group.number));
  }
  const scriptDialogues = extractScriptDialogues(script);
 const storyboardDialogues = extractStoryboardDialogues(checkableContent);
 const matchedStoryboardDialogues = new Set();
 const reportedStoryboardDialogues = new Set();
 for (const dialogue of scriptDialogues) {
    const coverage = findStoryboardDialogueCoverage(dialogue, storyboardDialogues);
    if (!coverage.matched) {
      const partial = coverage.partial;
      const excerpt = dialogue.spoken.slice(0, 32) + (dialogue.spoken.length > 32 ? '…' : '');
      const title = partial ? '提示词台词与剧本不一致' : '缺少人物台词';
      const detail = coverage.reason === 'speaker'
        ? '剧本中“' + excerpt + '”应由@' + dialogue.speakerName + '说出；提示词中的发声人物不一致。'
        : partial
          ? '剧本中“' + excerpt + '”与提示词分镜序列中的{ }台词不一致；连续拆到多个镜头的同一人物台词会自动合并检查。'
          : '剧本中@' + dialogue.speakerName + '的“' + excerpt + '”未在分镜序列的{ }中找到。';
      results.push(checkResult('error', title, detail, partial?.group || null, partial?.shot || null));
      if (partial) reportedStoryboardDialogues.add(partial);
     continue;
   }
    for (const item of coverage.items) matchedStoryboardDialogues.add(item);
 }
 for (const dialogue of storyboardDialogues) {
   if (matchedStoryboardDialogues.has(dialogue) || reportedStoryboardDialogues.has(dialogue)) continue;
   // 已由“剧本台词缺失/不一致”指出的拆句，不再重复报一次提示词多余台词。
   const relatedScriptLine = scriptDialogues.some((scriptDialogue) =>
     scriptDialogue.normalized.includes(dialogue.normalized) || dialogue.normalized.includes(scriptDialogue.normalized));
   if (relatedScriptLine) continue;
   const speaker = dialogue.speakerName ? '@' + dialogue.speakerName : '未标注人物';
   const excerpt = dialogue.spoken.slice(0, 32) + (dialogue.spoken.length > 32 ? '…' : '');
   results.push(checkResult('error', '提示词台词与剧本不一致', '分镜序列中' + speaker + '的“' + excerpt + '”未在剧本人物台词中找到。', dialogue.group, dialogue.shot));
 }
  if (shotlist?.trim() && !groups.length) results.push(checkResult('error', '缺少可执行分镜', '本集已有分镜计划，但 Seedance 提示词未识别到分镜组和镜头序列。'));
  if (!results.length) results.push(checkResult('pass', '质检通过', '未发现已配置规则中的结构、时长、标签和口型风险。'));
  return results;
}

async function exportProject(project, type, target = 'storyboard') {
  const isScript = target === 'script';
  const baseName = episodeFileStem(project);
  const outputDirectory = isScript ? outputFolderForTask(project, { kind: 'script' }) : outputFolderForTask(project, { kind: 'storyboard' });
  await ensureDirectory(outputDirectory);
  const content = isScript ? project.script.content : project.storyboard.content;
  const markdown = `# ${project.title} · 第${project.currentEpisode}集 · ${isScript ? '剧本' : 'Seedance提示词'}\n\n${content || '（尚未生成）'}\n`;
  let outputPath;
  if (type === 'txt') {
    outputPath = path.join(outputDirectory, `${baseName}.txt`);
    await writeFileAtomically(outputPath, content || '（尚未生成）', 'utf8');
  } else if (type === 'docx') {
    outputPath = path.join(outputDirectory, `${baseName}.docx`);
    const paragraphs = markdown.split(/\r?\n/).map((line) => {
      if (line.startsWith('# ')) return new Paragraph({ text: line.slice(2), heading: HeadingLevel.TITLE });
      if (line.startsWith('## ')) return new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_1 });
      return new Paragraph({ children: [new TextRun(line || ' ')] });
    });
    const file = new Document({ sections: [{ children: paragraphs }] });
    await writeFileAtomically(outputPath, await Packer.toBuffer(file));
  } else {
    outputPath = path.join(outputDirectory, `${baseName}.md`);
    await writeFileAtomically(outputPath, markdown, 'utf8');
  }
  return outputPath;
}

async function importSource(project) {
  const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
    title: '导入原文',
    filters: [{ name: 'TXT、Markdown 与 Word', extensions: ['txt', 'md', 'markdown', 'docx'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  const sourceFolder = documentFolderForKind(project, 'source');
  await ensureDirectory(sourceFolder);
  let storedPath = filePath;
  if (!fileIsInsideDirectory(filePath, sourceFolder)) {
    storedPath = path.join(sourceFolder, path.basename(filePath));
    try {
      await fs.access(storedPath);
      storedPath = path.join(sourceFolder, `${Date.now()}-${sanitizeName(path.basename(filePath))}`);
    } catch { /* Keep the original file name when it is available. */ }
    await fs.copyFile(filePath, storedPath);
  }
  const stat = await fs.stat(storedPath);
  return { name: path.basename(storedPath), path: storedPath, content: await readTextDocument(storedPath), updatedAt: stat.mtime.toISOString() };
}

function documentFolderForKind(project, kind) {
  const folders = makeFolderMap(project.projectPath);
  if (kind === 'outline') return folders.outline;
  if (kind === 'script') return folders.script;
  if (kind === 'shotlist') return folders.storyboard;
  if (kind === 'storyboard') return folders.seedance;
  if (kind === 'source') return folders.source;
  throw new Error('未知文件类型。');
}

function fileIsInsideDirectory(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function openProjectDocument(project, kind, filePath) {
  const directory = documentFolderForKind(project, kind);
  if (!fileIsInsideDirectory(filePath, directory)) throw new Error('只能读取当前项目对应文件夹中的文件。');
  if (!editorExtensions.has(path.extname(filePath).toLowerCase())) throw new Error('阅读和编辑仅支持 TXT、Markdown 和 Word 文件。');
  const fileEpisode = episodeNumberFromFileName(path.basename(filePath));
  if (!['source', 'outline'].includes(kind) && (fileEpisode === null && episodeSlots.partForKey(project, project.currentEpisode) === '下' ||
      fileEpisode !== null && (fileEpisode !== episodeSlots.baseNumber(project.currentEpisode) ||
        !episodeSlots.matchingPart(project, project.currentEpisode, path.basename(filePath))))) {
    throw new Error(`当前是第${episodeSlots.label(project, project.currentEpisode)}集，不能载入其他分段的文件。请先切换集数。`);
  }
  return episodeDocumentCache.read(filePath);
}

function projectDocumentOutputPath(project, kind, activePath = '') {
  const directory = documentFolderForKind(project, kind);
  const format = documentFormatForKind(project, kind);
  const desiredExtension = extensionForDocumentFormat(format);
  const activeExtension = path.extname(activePath).toLowerCase();
  const activeEpisode = episodeNumberFromFileName(path.basename(activePath || ''));
  const isCurrentEpisodeFile = kind === 'outline' || (activeEpisode === null && (kind === 'source' || episodeSlots.partForKey(project, project.currentEpisode) !== '下'))
    || (activeEpisode === episodeSlots.baseNumber(project.currentEpisode)
    && episodeSlots.matchingPart(project, project.currentEpisode, path.basename(activePath), kind === 'source'));
  const activeMatchesFormat = fileMatchesDocumentFormat(activePath, format);
  const canWriteActive = activePath && fileIsInsideDirectory(activePath, directory) && activeMatchesFormat && isCurrentEpisodeFile;
  const sourceStem = kind === 'source' && activePath
    ? path.basename(activePath, activeExtension)
    : episodeFileStem(project);
  return canWriteActive ? activePath : path.join(directory, `${sourceStem}${desiredExtension}`);
}

async function saveProjectDocument(project, kind, content, activePath = '') {
  const format = documentFormatForKind(project, kind);
  const outputPath = projectDocumentOutputPath(project, kind, activePath);
  await writeEditableDocument(outputPath, content || '');
  const stat = await fs.stat(outputPath);
  const docxPath = format === 'docx' ? outputPath : '';
  return { name: path.basename(outputPath), path: outputPath, content: await readTextDocument(outputPath), updatedAt: stat.mtime.toISOString(), docxPath };
}

async function exportDocumentWord(project, kind, content, activePath = '') {
  const directory = documentFolderForKind(project, kind);
  const wordPath = activePath && fileIsInsideDirectory(activePath, directory)
    ? activePath.replace(/\.(?:txt|md|markdown|docx)$/i, '.docx') : '';
  const wordProject = { ...project, documentFormats: { ...project.documentFormats, [kind]: 'docx' } };
  return saveProjectDocument(wordProject, kind, content, wordPath);
}

function literalReplaceCount(content, findText) {
  if (!findText) return 0;
  return String(content).split(findText).length - 1;
}

let activeGlobalTextSearch = null;
async function replaceProjectTextFiles(project, findText, replaceText, previewOnly = false, expectedRevision = '', options = {}) {
  const needle = String(findText || '');
  if (!needle) throw new Error('请填写要查找的内容。');
  if (activeGlobalTextSearch) throw new Error('已有全局查找或替换正在进行，请等待完成或取消查找。');
  const folders = makeFolderMap(project.projectPath);
  const scopeKeys = ['source', 'synopsis', 'outline', 'script', 'storyboard', 'seedance', 'rules'];
  const scopes = Array.isArray(options.scopes) ? scopeKeys.filter(key => options.scopes.includes(key)) : scopeKeys;
  if (!scopes.length) throw new Error('请至少选择一种文档范围。');
  if (Array.isArray(options.extensions) && !options.extensions.length) throw new Error('请至少选择一种文件类型。');
  if (!previewOnly && !expectedRevision) throw new Error('请先查找预览，再确认需要替换的文件。');
  const search = require('./global-text-search');
  const operation = { controller: new AbortController(), phase: 'scan' };
  activeGlobalTextSearch = operation;
  const notify = event => {
    activeWorkspaceWindow()?.webContents.send('documents:search-progress', event);
  };
  try {
    const plan = await search.runSearch({ projectPath: project.projectPath,
      directories: scopes.map(key => folders[key]), extensions: options.extensions,
      needle, replacement: String(replaceText ?? ''), previewOnly },
      { signal: operation.controller.signal, onProgress: notify });
    if (previewOnly) return plan;
    if (!plan.complete) throw new Error('有 ' + plan.errors.length + ' 个文件或目录无法读取，尚未修改任何文件。请先查看查找结果中的错误。');
    if (expectedRevision && expectedRevision !== plan.revision) throw new Error('文件在预览后发生了变化，尚未替换。请重新查找确认。');
    if (Array.isArray(options.selectedPaths)) {
      const selected = new Set(options.selectedPaths);
      plan.changes = plan.changes.filter(change => selected.has(path.relative(project.projectPath, change.path)));
      plan.matches = plan.matches.filter(match => selected.has(match.path));
      plan.files = plan.changes.length;
      plan.replacements = plan.changes.reduce((total, change) => total + change.count, 0);
    }
    if (!plan.changes.length) return { ...plan, paths: [] };
    operation.phase = 'write';
    notify({ phase: 'preparing', total: plan.changes.length, scanned: 0 });
    const backupBase = options.backupRoot
      ? path.join(path.resolve(options.backupRoot), '导演台替换备份', sanitizeName(project.title || '项目'))
      : path.join(project.projectPath, '.ai-director', '全局替换备份');
    const backupDirectory = path.join(backupBase, Date.now() + '-' + uid());
    const targets = new Map();
    const addTarget = async (target, content, expectedFingerprint) => {
      if (!fileIsInsideDirectory(target, project.projectPath)) throw new Error('替换文件超出项目目录。');
      const relative = path.relative(project.projectPath, target);
      const staged = path.join(backupDirectory, 'staged', relative);
      await writeEditableDocument(staged, content);
      let original = null;
      try { original = await fs.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const originalHash = original === null ? null : search.fingerprint(original);
      if (expectedFingerprint && expectedFingerprint !== originalHash) throw new Error('文件在查找后发生变化：' + relative);
      const backup = path.join(backupDirectory, 'original', relative);
      if (original !== null) { await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.writeFile(backup, original); }
      targets.set(normalizedPath(target), { target, relative, staged, backup, originalHash,
        stagedHash: search.fingerprint(await fs.readFile(staged)) });
    };
    for (const change of plan.changes) {
      await addTarget(change.path, change.content, change.fingerprint);
    }
    const currentHash = async target => {
      try { return search.fingerprint(await fs.readFile(target)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    for (const item of targets.values()) {
      if (await currentHash(item.target) !== item.originalHash) throw new Error('文件在准备期间发生变化：' + item.relative);
    }
    await writeFileAtomically(path.join(backupDirectory, 'manifest.json'), JSON.stringify({
      createdAt: now(), projectPath: project.projectPath, replacements: plan.replacements,
      needle, replacement: String(replaceText ?? ''), scopes, format: 2,
      files: [...targets.values()].map(({ relative, originalHash, stagedHash }) => ({ relative, originalHash, stagedHash }))
    }, null, 2), 'utf8');
    const touched = [];
    try {
      for (const item of targets.values()) {
        if (await currentHash(item.target) !== item.originalHash) throw new Error('文件在写入前发生变化：' + item.relative);
        touched.push(item);
        await writeFileAtomically(item.target, await fs.readFile(item.staged));
        notify({ phase: 'writing', total: targets.size, scanned: touched.length });
      }
    } catch (error) {
      const restoreErrors = [];
      for (const item of touched.reverse()) {
        try {
          const current = await currentHash(item.target);
          if (current === item.originalHash) continue;
          if (current !== item.stagedHash) throw new Error('文件被外部程序再次修改');
          if (item.originalHash === null) await fs.unlink(item.target);
          else await writeFileAtomically(item.target, await fs.readFile(item.backup));
        } catch (restoreError) { restoreErrors.push(item.relative + ': ' + restoreError.message); }
      }
      throw new Error(error.message + (restoreErrors.length ? '；部分文件需从备份手动恢复：' + restoreErrors.join('；') : '；本次已经写入的文件已恢复。') + ' 备份：' + backupDirectory);
    }
    return { files: plan.files, replacements: plan.replacements, paths: plan.changes.map(c => c.path),
      matches: plan.matches, backupDirectory };
  } finally { if (activeGlobalTextSearch === operation) activeGlobalTextSearch = null; }
}

async function addAsset(project, requestedCategory = 'role') {
  const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
    title: '添加素材',
    filters: [{ name: '图片与音频', extensions: [...assetExtensions].map((extension) => extension.slice(1)) }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  const category = normalizedAssetCategory(requestedCategory);
  const assets = [];
  for (const sourcePath of result.filePaths) {
    const ext = path.extname(sourcePath).toLowerCase();
    const type = assetTypeFromPath(sourcePath);
    const assetRoot = makeFolderMap(project.projectPath).assets;
    const categoryFolder = assetCategoryFolders[type === 'audio' ? 'voice' : category];
    const destinationFolder = path.join(assetRoot, 'images', categoryFolder);
    await ensureDirectory(destinationFolder);
    const destination = await uniqueFileDestination(destinationFolder, `${Date.now()}-${sanitizeName(path.basename(sourcePath))}`);
    await fs.copyFile(sourcePath, destination);
    assets.push({ id: uid(), name: path.basename(sourcePath, ext), type, category: type === 'audio' ? 'voice' : category, fileName: path.basename(destination), localPath: destination, prompt: '', standardName: '', createdAt: now(), episodes: [] });
  }
  return assets;
}

async function uniqueFileDestination(directory, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  let number = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${parsed.name} (${number})${parsed.ext}`);
      number += 1;
    } catch {
      return candidate;
    }
  }
}

async function organizeRoleAsset(project, assetId) {
  const asset = (project.assets || []).find((item) => item.id === assetId);
  if (!asset) throw new Error('没有找到要收纳的人物素材。');
  if (asset.category !== 'role') throw new Error('只有“人物”素材可以收纳到角色专属文件夹。');
  const folders = makeFolderMap(project.projectPath);
  const imagesRoot = path.resolve(folders.assets, 'images');
  const sourcePath = path.resolve(asset.localPath || '');
  if (!fileIsInsideDirectory(sourcePath, imagesRoot)) throw new Error('只能收纳当前项目 06 资产/images 中的素材。');
  try { await fs.access(sourcePath); } catch { throw new Error('该素材文件已不存在，请先点击“刷新素材”。'); }
  const roleName = sanitizeName(asset.standardName || asset.name || '未命名人物');
  const destinationFolder = path.join(imagesRoot, assetCategoryFolders.role, roleName);
  await ensureDirectory(destinationFolder);
  const sourceFolder = path.dirname(sourcePath);
  if (normalizedPath(sourceFolder) === normalizedPath(destinationFolder)) return { ...asset, localPath: sourcePath, fileName: path.basename(sourcePath) };
  const destination = await uniqueFileDestination(destinationFolder, path.basename(sourcePath));
  try {
    await fs.rename(sourcePath, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.copyFile(sourcePath, destination);
    await fs.unlink(sourcePath);
  }
  return { ...asset, localPath: destination, fileName: path.basename(destination), category: 'role' };
}

async function importRuleDocuments(project, category) {
  const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
    title: '导入 AI 规则与记忆文档',
    filters: [{ name: '文本与 Word 文件', extensions: ['txt', 'md', 'markdown', 'docx'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  const folders = makeFolderMap(project.projectPath);
  const categoryFolder = path.join(folders.rules, category === 'script' ? '01 剧本生成规则' : category === 'storyboard' ? '02 Seedance分镜规则' : '03 项目记忆');
  await ensureDirectory(categoryFolder);
  const imported = [];
  for (const sourcePath of result.filePaths) {
    const targetName = `${Date.now()}-${sanitizeName(path.basename(sourcePath))}`;
    const targetPath = await uniqueFileDestination(categoryFolder, targetName);
    await fs.copyFile(sourcePath, targetPath);
    imported.push({ id: uid(), name: path.basename(sourcePath), path: targetPath, category, enabled: true, importedAt: now() });
  }
  return imported;
}

async function savePromptTemplateFile(project, kind, name, content) {
  const folders = makeFolderMap(project.projectPath);
  await ensureDirectory(folders.promptTemplates);
  const prefix = kind === 'script' ? '剧本主提示词' : 'Seedance主提示词';
  const outputPath = path.join(folders.promptTemplates, `${prefix}-${sanitizeName(name)}.txt`);
  await writeFileAtomically(outputPath, content, 'utf8');
  return { name: path.basename(outputPath), path: outputPath };
}

async function saveRuleSettingsFile(project) {
  const folders = makeFolderMap(project.projectPath);
  const directory = path.join(folders.rules, '03 项目记忆');
  await ensureDirectory(directory);
  const outputPath = path.join(directory, '导演台-项目记忆.txt');
  const workflow = normalizeWorkflowTemplates(project.workflowTemplates);
  const content = `【执行优先级】\n${String(project.executionPriority || defaultExecutionPriority).trim() || defaultExecutionPriority}\n\n【项目记忆】\n${project.memory?.project || ''}\n\n【角色与素材记忆】\n${project.memory?.characters || ''}\n\n【剧情连续性记忆】\n${project.memory?.continuity || ''}\n\n【文件工作流】\n每集使用一个普通 ChatGPT 新聊天，连续执行原文→剧本→分镜→提示词；不使用 ChatGPT 工程。\n默认提示词模板：${workflow.promptMode === '15' ? '15 秒' : '30 秒'}。\n`;
  await writeFileAtomically(outputPath, content, 'utf8');
  return { name: path.basename(outputPath), path: outputPath };
}

async function importReferenceDocuments(project, category) {
  const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
    title: category === 'script' ? '导入剧本参照文档' : '导入提示词参照文档',
    filters: [{ name: '文本与 Word 文件', extensions: ['txt', 'md', 'markdown', 'docx'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  const folders = makeFolderMap(project.projectPath);
  const destinationFolder = category === 'script' ? folders.scriptReferences : folders.storyboardReferences;
  await ensureDirectory(destinationFolder);
  const imported = [];
  for (const sourcePath of result.filePaths) {
    const targetPath = await uniqueFileDestination(destinationFolder, `${Date.now()}-${sanitizeName(path.basename(sourcePath))}`);
    await fs.copyFile(sourcePath, targetPath);
    imported.push({ id: uid(), name: path.basename(sourcePath), path: targetPath, category, enabled: true, outputFormat: true, importedAt: now() });
  }
  return imported;
}

function createChatWindow() {
  if (chatGptWindow && !chatGptWindow.isDestroyed()) {
    chatGptWindow.show();
    chatGptWindow.focus();
    return;
  }
  chatGptWindow = new BrowserWindow({
    title: 'ChatGPT 任务窗口',
    icon: path.join(__dirname, 'assets', 'brand-v008', 'app-icon.ico'),
    width: 1160,
    height: 820,
    webPreferences: { partition: 'persist:manju-chatgpt', contextIsolation: true, sandbox: true }
  });
  chatGptWindow.loadURL('https://chatgpt.com/');
  chatGptWindow.on('closed', () => { chatGptWindow = null; });
}

async function sendPromptToChatGpt(prompt) {
  createChatWindow();
  await new Promise((resolve) => setTimeout(resolve, 700));
  return chatGptWindow.webContents.executeJavaScript(`(async () => {
    const visible = (el) => !!(el && el.offsetParent !== null);
    const pageText = () => String(document.body?.innerText || '');
    if (/(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(pageText())) {
      return { ok: false, reason: 'ChatGPT 官网暂时限制了本次对话访问。软件没有发送新消息，请等待官网提示的时间后再继续。' };
    }
    const readLastReply = () => [...document.querySelectorAll('[data-message-author-role="assistant"], .markdown')]
      .filter(visible).map((el) => el.innerText?.trim()).filter(Boolean).at(-1) || '';
    const previousReply = readLastReply();
    const editors = [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')].filter(visible);
    const editor = editors.find((el) => /prompt-textarea|message|chat/i.test([el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.dataset?.testid].filter(Boolean).join(' '))) || editors.at(-1);
    if (!editor) return { ok: false, reason: '未找到项目内的新聊天输入框。请先在任务窗口登录，并确认项目主页已打开。', previousReply };
    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, ${JSON.stringify(prompt)});
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
    }
    await new Promise((r) => setTimeout(r, 250));
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const send = buttons.find((button) => /send|发送|submit/i.test([button.getAttribute('aria-label'), button.getAttribute('title'), button.dataset?.testid, button.innerText].filter(Boolean).join(' ')));
    if (!send || send.disabled) return { ok: false, reason: '提示词已填入，但未找到可用发送按钮。请在任务窗口手动发送。', previousReply };
    send.click();
    return { ok: true, previousReply };
  })()`);
}

async function getChatGptReplySnapshot() {
  if (!chatGptWindow || chatGptWindow.isDestroyed()) return { ok: false, reason: 'ChatGPT 任务窗口已关闭。' };
  return chatGptWindow.webContents.executeJavaScript(`(() => {
    const visible = (el) => !!(el && el.offsetParent !== null);
    const replies = [...document.querySelectorAll('[data-message-author-role="assistant"], .markdown')]
      .filter(visible).map((el) => el.innerText?.trim()).filter(Boolean);
    const controls = [...document.querySelectorAll('button')].filter(visible)
      .map((button) => [button.ariaLabel, button.title, button.dataset?.testid, button.innerText].filter(Boolean).join(' '));
    const pageText = String(document.body?.innerText || '');
    const rateLimited = /(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(pageText);
    return { ok: true, content: replies.at(-1) || '', generating: controls.some((label) => /stop|停止|正在生成/i.test(label)), rateLimited };
  })()`);
}

async function captureChatGptReply() {
  const snapshot = await getChatGptReplySnapshot();
  return snapshot.ok && snapshot.content ? snapshot : { ok: false, reason: snapshot.reason || '还没有读到回复；请等生成完成后重试。' };
}

function episodeFileStem(project) {
  return episodeSlots.fileStem(project, project.currentEpisode);
}

function episodeArchiveMatcher(project) {
  const stem = episodeFileStem(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacy = episodeSlots.partForKey(project, project.currentEpisode) === '下'
    ? 'NO_LEGACY_FOR_LOWER_PART'
    : `第?${String(episodeSlots.baseNumber(project.currentEpisode) || 1).padStart(3, '0')}集`;
  return new RegExp(`^(?:${stem}(?:（改(\\d+)）)?|${legacy}[-（].*)\\.(?:md|markdown|txt)$`, 'i');
}

async function listEpisodeArchiveFiles(project, task, { includeOriginal = true, includeLegacy = false, includeWord = true } = {}) {
  const directory = outputFolderForTask(project, task);
  let names = [];
  try { names = await fs.readdir(directory); } catch { return []; }
  const stem = episodeFileStem(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`^${stem}(?:（改(\\d+)）)?\\.(?:md|markdown|txt)$`, 'i');
  const matcher = includeLegacy ? episodeArchiveMatcher(project) : direct;
  return names.flatMap((name) => {
    if (!includeWord && /\.docx$/i.test(name)) return [];
    const archiveName = path.extname(name).toLowerCase() === '.docx' ? `${path.basename(name, '.docx')}.txt` : name;
    const match = archiveName.match(matcher);
    if (!match) return [];
    const isOriginal = new RegExp(`^${stem}\\.(?:md|markdown|txt)$`, 'i').test(name);
    if (!includeOriginal && isOriginal) return [];
    if (!includeOriginal && name.toLowerCase() === `${episodeFileStem(project)}.docx`.toLowerCase()) return [];
    return [{ name, path: path.join(directory, name), revision: Number(match[1]) || 0, isOriginal }];
  });
}

async function removeEpisodeArchiveFiles(project, task, options = {}) {
  const files = await listEpisodeArchiveFiles(project, task, options);
  await Promise.all(files.map(async (file) => {
    try { await fs.unlink(file.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }));
  return files.length;
}

async function archiveChatGptReply(project, task, content) {
  if (task.rawOnly) return {content, rawOnly: true};
  const directory = outputFolderForTask(project, task);
  await ensureDirectory(directory);
  const stem = episodeFileStem(project);
  const format = documentFormatForKind(project, task.kind);
  const fileName = `${stem}${extensionForDocumentFormat(format)}`;
  const outputPath = path.join(directory, fileName);
  await writeEditableDocument(outputPath, content);
  const docxPath = format === 'docx' ? outputPath : '';
  await removeEpisodeArchiveFiles(project, task, { includeOriginal: false, includeLegacy: true, includeWord: false });
  return { outputPath, plainTextPath: format === 'docx' ? '' : outputPath, docxPath, fileName, format };
}

async function nextEpisodeTextOutput(project, task) {
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'manju-reply-'));
  const stem = episodeFileStem(project);
  const fileName = `${stem}.txt`;
  return { directory, fileName, outputPath: path.join(directory, fileName) };
}

async function clickLatestChatGptTxtAttachment(project, episodeNumber) {
  if (!chatGptWindow || chatGptWindow.isDestroyed()) return { ok: false, reason: 'ChatGPT 任务窗口已关闭。' };
  return chatGptWindow.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (element) => !!(element && element.offsetParent !== null);
    const labelOf = (element) => [element.getAttribute('download'), element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent].filter(Boolean).join(' ').trim();
    const expected = ${JSON.stringify(episodeSlots.fileStem(project, episodeNumber))};
    const splitPart = ${JSON.stringify(episodeSlots.partForKey(project, episodeNumber))};
    const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    const latestMessage = messages.at(-1);
    if (!latestMessage) return { ok: false, reason: '还没有找到 ChatGPT 的最新回复。' };
    const clickable = (element) => element.closest('a, button, [role="button"]') || element;
    const candidates = [...latestMessage.querySelectorAll('a, button, [role="button"]')]
      .filter(visible)
      .map((element) => ({ element: clickable(element), label: labelOf(element) }))
      .filter((item) => /\.txt(?:\\s|$)/i.test(item.label));
    const matching = candidates.filter((item) => item.label.replace(/\\s+/g, '').includes(expected)
      && (splitPart !== '上' || !item.label.replace(/\\s+/g, '').includes(expected + '下')));
    const chosen = matching.at(-1) || (splitPart ? null : candidates.at(-1));
    if (!chosen?.element) return { ok: false, reason: '最新回复未检测到可下载的 TXT 附件。请让 ChatGPT 以 TXT 文件形式返回。' };
    chosen.element.click();
    let download;
    for (let attempt = 0; attempt < 8 && !download; attempt += 1) {
      await wait(500);
      const controls = [...document.querySelectorAll('a, button, [role="button"]')].filter(visible);
      download = controls.filter((element) => /download|下载/i.test(labelOf(element))).at(-1);
    }
    if (download && download !== chosen.element) download.click();
    return { ok: true, attachmentName: chosen.label };
  })()`);
}

async function downloadLatestChatGptAttachment(project, task) {
  if (!chatGptWindow || chatGptWindow.isDestroyed()) return { ok: false, reason: 'ChatGPT 任务窗口已关闭。' };
  const destination = await nextEpisodeTextOutput(project, task);
  const session = chatGptWindow.webContents.session;
  return new Promise(async (resolve) => {
    let settled = false;
    let downloadStarted = false;
    let timeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      session.removeListener('will-download', onWillDownload);
      void fs.rm(destination.directory, { recursive: true, force: true }).catch(() => {});
      resolve(result);
    };
    const onWillDownload = (_event, item, webContents) => {
      if (webContents !== chatGptWindow.webContents || downloadStarted) return;
      downloadStarted = true;
      item.setSavePath(destination.outputPath);
      item.once('done', async (_downloadEvent, state) => {
        if (state === 'completed') {
          try {
            const content = await fs.readFile(destination.outputPath, 'utf8');
            const archive = await archiveChatGptReply(project, task, content);
            finish({ ok: true, ...archive });
          } catch (error) {
            finish({ ok: false, reason: `TXT 附件已下载，但按当前格式保存失败：${error.message || String(error)}` });
          }
        }
        else finish({ ok: false, reason: `附件下载未完成：${state}` });
      });
    };
    session.on('will-download', onWillDownload);
    timeout = setTimeout(() => finish({ ok: false, reason: '未在 20 秒内收到 TXT 附件下载。请确认 ChatGPT 回复中含有可下载的 TXT 文件。' }), 20000);
    try {
      const click = await clickLatestChatGptTxtAttachment(project, task.episodeNumber || project.currentEpisode);
      if (!click?.ok) finish(click || { ok: false, reason: '未能触发附件下载。' });
    } catch (error) {
      finish({ ok: false, reason: error.message || String(error) });
    }
  });
}

async function findChromeExecutable() {
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(app.getPath('home'), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
    ];
    for (const executable of candidates) {
      try { await fs.access(executable); return executable; } catch { /* try the next location */ }
    }
    return '';
  }
  if (process.platform === 'linux') {
    const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    for (const executable of candidates) {
      try { await fs.access(executable); return executable; } catch { /* try the next location */ }
    }
    return '';
  }
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of bases) {
    const executable = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    try { await fs.access(executable); return executable; } catch { /* try the next location */ }
  }
  return '';
}

async function isChromeRunning() {
  if (process.platform !== 'win32') return true;
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout = '') => {
      resolve(!error && /"chrome\.exe"/i.test(stdout));
    });
  });
}

async function chromeDebugBridgeState() {
  if (!(await isChromeRunning())) {
    return {
      ready: false,
      chromeRunning: false,
      reason: 'Chrome 当前没有打开。请先点“① 打开 Chrome 远程调试授权”，并保持 Chrome 窗口打开。'
    };
  }
  // Chrome 144+ manages this authorization channel itself. Do not probe the
  // legacy /json/version endpoint: it can reject a valid authorized channel.
  return { ready: true, chromeRunning: true, mode: 'chrome-remote-debugging' };
}

async function openChromePermissionPage() {
  const chrome = await findChromeExecutable();
  if (chrome) {
    // Open the authorization page on its own. Combining it with chatgpt.com
    // lets Chrome foreground only ChatGPT on some Windows installations.
    const child = spawn(chrome, ['--new-window', 'chrome://inspect/#remote-debugging'], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return true;
  }
  await shell.openExternal('chrome://inspect/#remote-debugging');
  return true;
}

function stopChromeMcpClient() {
  const client = chromeMcpClient;
  chromeMcpClient = null;
  client?.close();
}

function isChromeMcpConnectionMessage(message) {
  return /(connection|connect|disconnected|closed|target|session|browser|devtools|protocol|econn|pipe|websocket|授权服务已停止|超时|could not)/i.test(String(message || ''));
}

function chromeMcpRuntimePaths() {
  // A child Electron process cannot execute a JavaScript entry that lives
  // inside app.asar. The packaged app therefore carries this runtime as a
  // physical resource next to the application.
  const bundledRoot = app.isPackaged ? path.join(process.resourcesPath, 'chrome-devtools-mcp') : '';
  const bundledEntry = bundledRoot && path.join(bundledRoot, 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
  if (bundledEntry && fsSync.existsSync(bundledEntry)) return { packageRoot: bundledRoot, entryPoint: bundledEntry };
  const packageRoot = path.dirname(require.resolve('chrome-devtools-mcp/package.json'));
  return { packageRoot, entryPoint: path.join(packageRoot, 'build', 'src', 'bin', 'chrome-devtools-mcp.js') };
}

function createChromeMcpClient() {
  if (chromeMcpClient?.child && !chromeMcpClient.child.killed) return chromeMcpClient;
  const { packageRoot, entryPoint } = chromeMcpRuntimePaths();
  const child = spawn(process.execPath, [entryPoint, '--autoConnect', '--no-usage-statistics'], {
    cwd: packageRoot,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: 'true',
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true'
    }
  });
  let sequence = 0;
  let outputBuffer = '';
  const pending = new Map();
  const client = {
    child,
    lastError: '',
    request(method, params = {}, timeoutMs = 90000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`浏览器授权连接超时：${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
        try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
        catch (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params = {}) {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* process has already stopped */ }
    },
    closing: false,
    close() {
      client.closing = true;
      for (const item of pending.values()) {
        clearTimeout(item.timeout);
        item.reject(new Error('浏览器授权连接已关闭。'));
      }
      pending.clear();
      try { child.kill(); } catch { /* ignore */ }
    }
  };
  const rejectAll = (message) => {
    client.lastError = message;
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new Error(message));
    }
    pending.clear();
  };
  child.stdout.on('data', (chunk) => {
    outputBuffer += String(chunk);
    const lines = outputBuffer.split(/\r?\n/);
    outputBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || !pending.has(message.id)) continue;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timeout);
      if (message.error) item.reject(new Error(message.error.message || '浏览器授权连接失败。'));
      else item.resolve(message.result || {});
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) client.lastError = text.slice(-700);
  });
  child.on('error', (error) => {
    rejectAll(error.message || '浏览器授权服务无法启动。');
    if (chromeMcpClient === client) chromeMcpClient = null;
  });
  child.on('exit', (code) => {
    if (!client.closing) rejectAll(`浏览器授权服务已停止（${code ?? '未知'}）。`);
    if (chromeMcpClient === client) chromeMcpClient = null;
  });
  client.ready = client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: '导演台剧场', version: '0.0.2' }
  }).then((result) => {
    client.notify('notifications/initialized');
    return result;
  }).catch((error) => {
    if (chromeMcpClient === client) chromeMcpClient = null;
    client.close();
    throw error;
  });
  chromeMcpClient = client;
  return client;
}

async function chromeMcpTool(name, args = {}, timeoutMs = 90000) {
  const client = createChromeMcpClient();
  try {
    await client.ready;
    const result = await client.request('tools/call', { name, arguments: args }, timeoutMs);
    if (result.isError) {
      const message = result.content?.map((item) => item.text || '').filter(Boolean).join('\n') || 'Chrome 没有完成该操作。';
      if (isChromeMcpConnectionMessage(message)) stopChromeMcpClient();
      throw new Error(message);
    }
    return result;
  } catch (error) {
    if (isChromeMcpConnectionMessage(error?.message || error)) stopChromeMcpClient();
    throw error;
  }
}

function chromeMcpText(result) {
  return result?.structuredContent?.message || result?.content?.map((item) => item.text || '').filter(Boolean).join('\n') || '';
}

function chromeMcpJson(result) {
  const text = chromeMcpText(result);
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error('Chrome 当前聊天没有返回可读取的数据。');
  return JSON.parse(blocks.at(-1)[1]);
}

function chromeAuthorizationHelp(detail = '') {
  const suffix = detail ? ` 连接反馈：${String(detail).replace(/\s+/g, ' ').slice(-260)}` : '';
  return `请保持 Chrome 打开：先点“① 打开 Chrome 远程调试授权”，确认 Chrome 显示的“远程调试”开关已开启；再回到本软件点“② 连接并刷新当前聊天”。Chrome 的“允许”框会在第二步出现。${suffix}`;
}

function chromeRunnerOptions(project) {
  const runner = project?.chatGptRunner || {};
  return {
    mode: runner.mode || 'chrome',
    port: Math.max(1, Math.min(65535, Number(runner.port) || 9222)),
    tabId: String(runner.tabId || '')
  };
}

function normalizeChatGptReplyMode(value) {
  return ['auto', 'attachment', 'message'].includes(String(value || '')) ? String(value) : 'auto';
}

function chatGptReplyMode(project, task) {
  return normalizeChatGptReplyMode(task?.replyMode || project?.chatGptRunner?.replyMode);
}

function chatGptReplyModeLabel(mode) {
  const value = normalizeChatGptReplyMode(mode);
  return value === 'attachment' ? 'TXT 附件' : value === 'message' ? '聊天正文' : '自动识别（正文优先）';
}

function chatGptReplyWaitMinutes(project) {
  return Number(project?.chatGptRunner?.waitMinutes) === 30 ? 30 : 50;
}

function chromeMcpPages(response) {
  const structuredPages = response?.structuredContent?.pages;
  if (Array.isArray(structuredPages) && structuredPages.length) return structuredPages;

  // Chrome DevTools MCP also describes pages as text. Keep this fallback for
  // browser versions that omit structuredContent on a freshly authorized tab.
  const text = chromeMcpText(response);
  const pages = [];
  for (const match of text.matchAll(/^\s*(\d+):\s*(.*?)\s+\((https?:\/\/[^\s)]+)\)(?:\s+\[selected\])?/gmi)) {
    pages.push({ id: match[1], title: match[2].trim(), url: match[3], selected: /\[selected\]/i.test(match[0]) });
  }
  return pages;
}

function isChatGptPage(page) {
  const url = String(page?.url || page?.href || page?.urlString || '');
  const title = String(page?.title || page?.name || '');
  return /(?:^|[/:.])chatgpt\.com(?:[/?#:]|$)/i.test(url) || /\bchatgpt\b/i.test(title);
}

async function listChromeDebugTabs(project) {
  const bridge = await chromeDebugBridgeState();
  if (!bridge.ready) {
    return { ok: false, tabs: [], bridge, reason: chromeAuthorizationHelp(bridge.reason) };
  }
  try {
    // Chrome DevTools performs the actual authorized connection. Its result is
    // the only reliable readiness check for current Chrome versions.
    const response = await chromeMcpTool('list_pages', {}, 35000);
    const pages = chromeMcpPages(response);
    const tabs = pages
      .filter((page) => page?.id !== undefined && isChatGptPage(page))
      .map((page) => ({ id: String(page.id), title: page.title || page.url || 'ChatGPT 当前聊天', url: page.url || '' }));
    return { ok: true, tabs, bridge };
  } catch (error) {
    return {
      ok: false,
      tabs: [],
      bridge,
      reason: chromeAuthorizationHelp(error.message || '')
    };
  }
}

async function chromeDebugStatus(project) {
  const result = await listChromeDebugTabs(project);
  if (!result.ok) return result;
  return result.tabs.length
    ? result
    : { ...result, ok: false, reason: '已连接你的 Chrome，但没有发现打开中的 ChatGPT 聊天页。请先在 Chrome 中打开并进入要继续使用的聊天，再点“刷新当前聊天”。' };
}

function openChromeCdp(tab) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sequence = 0;
    const pending = new Map();
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const rejectPending = (error) => {
      for (const item of pending.values()) {
        clearTimeout(item.timeout);
        item.reject(error);
      }
      pending.clear();
    };
    const connectTimeout = setTimeout(() => fail(new Error('连接 Chrome 当前聊天超时。')), 8000);
    socket.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      resolve({
        send(method, params = {}) {
          return new Promise((resolveCommand, rejectCommand) => {
            const id = ++sequence;
            const timeout = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`Chrome 操作超时：${method}`));
            }, 25000);
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          rejectPending(new Error('Chrome 连接已关闭。'));
          try { socket.close(); } catch { /* ignore */ }
        }
      });
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timeout);
      if (message.error) item.reject(new Error(message.error.message || 'Chrome 当前聊天操作失败。'));
      else item.resolve(message.result || {});
    });
    socket.addEventListener('error', () => fail(new Error('无法连接 Chrome 当前聊天。请刷新连接状态后重试。')));
    socket.addEventListener('close', () => {
      if (!settled) fail(new Error('Chrome 当前聊天连接被关闭。'));
      else rejectPending(new Error('Chrome 当前聊天连接被关闭。'));
    });
  });
}

async function chromeEvaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Chrome 当前聊天脚本执行失败。');
  return result.result?.value;
}

async function selectChromeChatTab(project) {
  const status = await chromeDebugStatus(project);
  if (!status.ok) throw new Error(status.reason);
  const { tabId } = chromeRunnerOptions(project);
  const tab = status.tabs.find((item) => item.id === tabId) || status.tabs[0];
  if (!tab) throw new Error('没有可用的 ChatGPT 当前聊天。');
  await chromeMcpTool('select_page', { pageId: Number(tab.id), bringToFront: false });
  return tab;
}

function isRecoverableChromeError(error) {
  return isChromeMcpConnectionMessage(error?.message || error || '');
}

async function withChromeReconnect(project, action, { retry = true } = {}) {
  let lastError;
  const attempts = retry ? 6 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!retry || !isRecoverableChromeError(error) || attempt === attempts - 1) throw error;
      stopChromeMcpClient();
      await delay(Math.min(6500, 1200 * (attempt + 1)));
      try {
        await selectChromeChatTab(project);
      } catch (reconnectError) {
        lastError = reconnectError;
        if (!isRecoverableChromeError(reconnectError) && !/授权|远程调试|当前聊天/.test(String(reconnectError?.message || ''))) throw reconnectError;
      }
    }
  }
  throw lastError || new Error('Chrome 当前聊天连接未恢复。');
}

async function collectChromeUploadPaths(project, task) {
  if (Array.isArray(task.uploadPaths)) {
    const uploaded = [];
    for (const filePath of task.uploadPaths.filter(Boolean)) {
      if (uploaded.includes(filePath)) continue;
      try { await fs.access(filePath); uploaded.push(filePath); } catch { /* report below if every file is missing */ }
    }
    return uploaded;
  }
  const folders = makeFolderMap(project.projectPath);
  const episodeNumber = Number(task.episodeNumber) || Number(project.currentEpisode);
  const promptKind = task.kind === 'script' ? 'script' : task.kind === 'shotlist' ? 'shotlist' : 'storyboard';
  const episode = (project.episodes || []).find((item) => Number(item.number) === episodeNumber);
  const skipShotlist = promptKind === 'storyboard' && episode?.shotlistSkipped === true;
  const candidates = [];
  const findEpisodePath = async (directory, kind) => {
    const files = await listTextFiles(directory, 1600, { identifyEpisodes: true, extensions: editorExtensions });
    return chooseEpisodeFile(files, project, kind, episodeNumber)?.path;
  };
  if (promptKind === 'script') candidates.push(await findEpisodePath(folders.source, 'source'));
  else if (promptKind === 'shotlist') candidates.push(await findEpisodePath(folders.script, 'script'));
  else {
    if (!skipShotlist) candidates.push(await findEpisodePath(folders.storyboard, 'shotlist'));
    candidates.push(await findEpisodePath(folders.script, 'script'));
  }
  const relevantRules = (project.ruleDocuments || []).filter((doc) => doc.enabled !== false && (doc.category === 'shared' || doc.category === promptKind || (promptKind === 'shotlist' && doc.category === 'storyboard')));
  const referenceCategory = promptKind === 'script' ? 'script' : 'storyboard';
  const references = (project.referenceDocuments || []).filter((doc) => doc.enabled !== false && doc.category === referenceCategory);
  candidates.push(...relevantRules.map((doc) => doc.path), ...references.map((doc) => doc.path));
  const unique = [];
  for (const filePath of candidates.filter(Boolean)) {
    if (unique.includes(filePath)) continue;
    try { await fs.access(filePath); unique.push(filePath); } catch { /* missing documents are already described in the prompt */ }
  }
  return unique.slice(0, 12);
}

async function stageChatGptUploadFiles(filePaths) {
  if (!filePaths.length) return { paths: [], cleanup: async () => {} };
  // ChatGPT's embedded Electron window can reject a perfectly valid file when
  // it comes straight from a mapped drive or has a non-ASCII display name.
  // Copying the exact bytes to a short local temporary path gives Chromium a
  // normal desktop file handle without changing the source files themselves.
  const directory = path.join(app.getPath('temp'), 'director-theater-upload', `${process.pid}-${Date.now()}-${uid().slice(0, 8)}`);
  await ensureDirectory(directory);
  const paths = [];
  try {
    for (let index = 0; index < filePaths.length; index += 1) {
      const sourcePath = filePaths[index];
      const sourceExt = path.extname(sourcePath).toLowerCase() || '.txt';
      // Some ChatGPT accounts currently reject Markdown attachments even
      // though the same text can be uploaded as TXT.  Only the short-lived
      // upload copy changes extension; the project/template file stays intact.
      const ext = ['.md', '.markdown'].includes(sourceExt) ? '.txt' : sourceExt;
      const stagedPath = path.join(directory, `upload-${String(index + 1).padStart(2, '0')}${ext}`);
      await fs.copyFile(sourcePath, stagedPath);
      paths.push(stagedPath);
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new Error(`准备 ChatGPT 上传文件失败：${error?.message || String(error)}`);
  }
  return {
    paths,
    cleanup: async () => fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  };
}

async function uploadFilesToChromeChat(cdp, filePaths) {
  if (!filePaths.length) return { ok: true, uploaded: 0 };
  await cdp.send('DOM.enable');
  const document = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const inputs = await cdp.send('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector: 'input[type="file"]' });
  const candidates = [];
  for (const nodeId of inputs.nodeIds || []) {
    let attributes = [];
    try { attributes = (await cdp.send('DOM.getAttributes', { nodeId })).attributes || []; } catch { /* stale input */ }
    const attrs = {};
    for (let index = 0; index < attributes.length; index += 2) attrs[String(attributes[index]).toLowerCase()] = String(attributes[index + 1] || '');
    const accept = String(attrs.accept || '').toLowerCase();
    const detail = Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join(' ').toLowerCase();
    const supportsDocuments = !accept
      || /text|plain|application|\.txt|\.md|\.markdown|\.doc|\.docx|\.pdf|\*\/\*/.test(accept);
    const mediaOnly = Boolean(accept) && /image|audio|video/.test(accept) && !supportsDocuments;
    let score = supportsDocuments ? 80 : 0;
    if (!accept) score += 20;
    if (/attach|upload|file|附件|上传/.test(detail)) score += 25;
    if (Object.hasOwn(attrs, 'multiple')) score += 10;
    if (mediaOnly) score -= 300;
    candidates.push({ nodeId, accept, score });
  }
  const chosen = candidates.sort((left, right) => right.score - left.score)[0];
  const inputNodeId = chosen?.score >= 0 ? chosen.nodeId : null;
  if (!inputNodeId) return { ok: false, reason: '当前 ChatGPT 聊天没有可用的上传入口。请先在该聊天中点开“添加附件”，再重新执行。' };
  const injected = await setUploadInputFilesWithMime(cdp, { nodeId: inputNodeId }, filePaths);
  await delay(500);
  return { ok: true, uploaded: filePaths.length, fileTypes: injected.fileTypes || [] };
}

function mimeTypeForUpload(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (['.txt', '.md', '.markdown'].includes(extension)) return 'text/plain';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.doc') return 'application/msword';
  if (extension === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

async function setUploadInputFilesWithMime(cdp, nodeReference, filePaths) {
  const payloads = [];
  for (const filePath of filePaths) {
    const bytes = await fs.readFile(filePath);
    payloads.push({
      name: path.basename(filePath),
      type: mimeTypeForUpload(filePath),
      base64: bytes.toString('base64'),
      lastModified: Date.now()
    });
  }
  const resolved = await cdp.send('DOM.resolveNode', nodeReference);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new Error('无法定位 ChatGPT 当前的附件输入框。');
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(items) {
      const transfer = new DataTransfer();
      for (const item of items) {
        const binary = atob(item.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        transfer.items.add(new File([bytes], item.name, { type: item.type, lastModified: item.lastModified }));
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
      if (!setter) throw new Error('当前页面不允许设置附件。');
      setter.call(this, transfer.files);
      this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { files: [...this.files].map((file) => ({ name: file.name, type: file.type, size: file.size })) };
    }`,
    arguments: [{ value: payloads }],
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  const exception = embeddedChatGptExceptionFromCdp(result);
  if (exception) throw new Error(exception);
  const files = result?.result?.value?.files || [];
  if (files.length !== filePaths.length) throw new Error('ChatGPT 附件输入框没有接收完整文件。');
  return { files, fileTypes: files.map((file) => file.type) };
}

function embeddedChatGptExceptionMessage(error) {
  const raw = String(error?.message || error || '').trim();
  if (/Script failed to execute/i.test(raw)) {
    return 'ChatGPT 页面在切换或刷新时中断了附件操作';
  }
  if (/Execution context was destroyed|Cannot find context|Inspected target navigated|frame was detached/i.test(raw)) {
    return 'ChatGPT 页面刚刚发生了切换，原来的操作环境已经失效';
  }
  if (/No target with given id|Target closed|Render frame was disposed|WebContents was destroyed/i.test(raw)) {
    return 'ChatGPT 任务窗口已经关闭或正在重新载入';
  }
  if (/Debugger is not attached|Another debugger is already attached/i.test(raw)) {
    return 'ChatGPT 任务窗口的上传通道暂时不可用';
  }
  return raw || 'ChatGPT 页面没有返回具体错误';
}

function embeddedChatGptExceptionFromCdp(result) {
  const details = result?.exceptionDetails;
  if (!details) return '';
  return String(
    details.exception?.description
      || details.exception?.value
      || details.text
      || 'ChatGPT 页面脚本执行异常'
  ).trim();
}

function isTransientEmbeddedChatGptError(error) {
  return /Script failed to execute|Execution context was destroyed|Cannot find context|Inspected target navigated|frame was detached|No target with given id|Target closed|Render frame was disposed|WebContents was destroyed|Debugger is not attached/i
    .test(String(error?.message || error || ''));
}

async function evaluateEmbeddedChatGpt(debuggerApi, expression, { attempts = 4, userGesture = false } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
      const result = await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: String(expression),
        awaitPromise: true,
        returnByValue: true,
        userGesture
      });
      const exception = embeddedChatGptExceptionFromCdp(result);
      if (exception) throw new Error(exception);
      return result?.result?.value;
    } catch (error) {
      lastError = error;
      if (!isTransientEmbeddedChatGptError(error) || attempt === attempts - 1) break;
      await delay(650 + attempt * 450);
    }
  }
  throw new Error(embeddedChatGptExceptionMessage(lastError));
}

function snapshotNodes(node, list = []) {
  if (!node || typeof node !== 'object') return list;
  list.push(node);
  for (const child of node.children || []) snapshotNodes(child, list);
  return list;
}

async function chromeMcpEvaluate(expression) {
  const functionDeclaration = String(expression).replace(/^\(/, '').replace(/\)\(\)$/, '');
  return chromeMcpJson(await chromeMcpTool('evaluate_script', { function: functionDeclaration }));
}

async function findChromeUploadUid() {
  return require('./upload-controls').uploadUid(await chromeMcpTool('take_snapshot', { verbose: true }));
}

function chromeOpenUploadMenuExpression() {
  return `(async () => {
    const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
    const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.dataset?.testid, el.innerText, el.textContent]
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    const composer = [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')]
      .filter(visible).find((el) => /prompt-textarea|message|chat/i.test([el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.dataset?.testid].filter(Boolean).join(' ')));
    if (!composer) return { ok: false, reason: '未找到 ChatGPT 输入框。' };
    const composerRect = composer.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const concreteUpload = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [tabindex="0"]')]
      .filter(visible)
      .find((button) => /(add photos|photos and files|upload from computer|添加照片和文件|添加照片与文件|从电脑上传|上传文件|选择文件)/i.test(label(button)));
    // Retrying must be idempotent.  If the plus menu is already open, leave
    // its concrete upload action untouched; clicking it here would open a
    // native chooser before Electron/CDP is ready to own that chooser.
    if (concreteUpload) return { ok: true, opened: label(concreteUpload), uploadControlReady: true, reused: true };
    const attachmentButton = buttons.find((button) => /(attach files|add files|附件|添加附件|添加文件)/i.test(label(button)));
    const plusButton = buttons.find((button) => ['+', '添加', '更多', 'add', 'more'].includes(label(button).trim().toLowerCase()));
    const adjacentButton = buttons
      .map((button) => ({ button, rect: button.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.right >= composerRect.left - 120 && rect.right <= composerRect.left + 20 && Math.abs((rect.top + rect.bottom) / 2 - (composerRect.top + composerRect.bottom) / 2) < 70)
      .sort((a, b) => Math.abs(a.rect.right - composerRect.left) - Math.abs(b.rect.right - composerRect.left))[0]?.button;
    const target = attachmentButton || plusButton || adjacentButton;
    if (!target) return { ok: false, reason: '未找到项目聊天输入框旁的附件按钮。' };
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 380));
    // Recent ChatGPT versions place “添加照片和文件” inside the plus menu.
    // Do not click that item here: a click made by an arbitrary page script
    // opens a native file chooser without a handler, leaving the browser stuck.
    // upload_file below clicks that exact item while it owns the chooser.
    const menuAction = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [tabindex="0"]')]
      .filter(visible)
      .find((button) => button !== target && /(add photos|photos and files|upload from computer|添加照片和文件|添加照片与文件|从电脑上传|上传文件|选择文件|添加附件)/i.test(label(button)));
    return { ok: true, opened: label(menuAction || target) || '＋', uploadControlReady: Boolean(menuAction) };
  })()`;
}

function chromeActivateUploadActionExpression() {
  return `(() => {
    const visible = (element) => !!(element && element.offsetParent !== null && !element.disabled);
    const label = (element) => [element.getAttribute('aria-label'), element.getAttribute('title'), element.dataset?.testid, element.innerText, element.textContent]
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    const action = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [tabindex="0"]')]
      .filter(visible)
      .find((element) => /(add photos|photos and files|upload from computer|添加照片和文件|添加照片与文件|从电脑上传|上传文件|选择文件)/i.test(label(element)));
    if (!action) return { ok: false, reason: '附件菜单已经打开，但没有找到“从电脑上传”。' };
    action.click();
    return { ok: true, label: label(action) };
  })()`;
}

async function uploadFilesThroughEmbeddedChooser(debuggerApi, filePaths) {
  let chooser = null;
  let resolveChooser;
  const chooserPromise = new Promise((resolve) => { resolveChooser = resolve; });
  const onDebuggerMessage = (_event, method, params) => {
    if (method !== 'Page.fileChooserOpened' || chooser) return;
    chooser = params || {};
    resolveChooser(chooser);
  };
  debuggerApi.on('message', onDebuggerMessage);
  try {
    await debuggerApi.sendCommand('Page.enable');
    await debuggerApi.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    const menu = await evaluateEmbeddedChatGpt(debuggerApi, chromeOpenUploadMenuExpression(), { attempts: 4, userGesture: true });
    if (!menu?.ok) return menu || { ok: false, reason: '未能打开 ChatGPT 的附件菜单。' };
    // Some ChatGPT layouts open the chooser directly from the paperclip;
    // others reveal a second “添加照片和文件” action.
    await Promise.race([chooserPromise, delay(220)]);
    if (!chooser) {
      const activated = await evaluateEmbeddedChatGpt(debuggerApi, chromeActivateUploadActionExpression(), { attempts: 3, userGesture: true });
      if (!activated?.ok) {
        // Keep a scored DOM fallback for layouts that expose a document input
        // but do not emit Page.fileChooserOpened.
        return uploadFilesToChromeChat({ send: (method, params) => debuggerApi.sendCommand(method, params) }, filePaths);
      }
      await Promise.race([chooserPromise, delay(2500)]);
    }
    if (chooser?.backendNodeId) {
      const injected = await setUploadInputFilesWithMime(
        { send: (method, params) => debuggerApi.sendCommand(method, params) },
        { backendNodeId: chooser.backendNodeId },
        filePaths
      );
      await delay(500);
      return { ok: true, uploaded: filePaths.length, exactChooser: true, fileTypes: injected.fileTypes || [] };
    }
    return uploadFilesToChromeChat({ send: (method, params) => debuggerApi.sendCommand(method, params) }, filePaths);
  } finally {
    debuggerApi.removeListener('message', onDebuggerMessage);
    try { await debuggerApi.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch { /* page changed */ }
  }
}

function chatGptUploadStatusExpression(filePaths) {
  const names = filePaths.map((filePath) => path.basename(filePath));
  return `(() => {
    const names = ${JSON.stringify(names)};
    const accessible = [...document.querySelectorAll('[aria-label], [title], [data-testid], input[type="file"]')]
      .map((element) => [element.getAttribute('aria-label'), element.getAttribute('title'), element.dataset?.testid]
        .filter(Boolean).join(' '))
      .join(' ');
    const rawText = String(document.body?.innerText || '') + '\\n' + accessible;
    const text = rawText.replace(/\\s+/g, ' ').trim();
    const rateLimited = /(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(text);
    const failed = rawText.match(/(?:无法上传|上传失败|文件上传失败|不支持此文件类型|不支持的文件类型|upload failed|failed to upload|unsupported file type)[^\\r\\n]{0,180}/ig) || [];
    const busy = /(正在上传|上传中|uploading|processing attachment|处理中)/i.test(text);
    const seen = names.filter((name) => text.includes(name));
    const inputFiles = [...document.querySelectorAll('input[type="file"]')]
      .flatMap((input) => [...(input.files || [])].map((file) => ({ name: file.name, type: file.type || '(空类型)', size: file.size })));
    return { ok: !rateLimited && failed.length === 0 && !busy && seen.length === names.length, rateLimited, failed: failed.slice(-3), busy, seen, expected: names, inputFiles };
  })()`;
}

async function waitForChatGptUploads(readStatus, filePaths) {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await readStatus();
    last = status || last;
    if (status?.rateLimited) {
      return { ok: false, reason: registerChatGptRateLimit() };
    }
    if (status?.failed?.length) {
      const fileDetail = status.inputFiles?.length
        ? `（${status.inputFiles.map((file) => `${file.name}：${file.type}`).join('，')}）`
        : '';
      return { ok: false, reason: `ChatGPT 未能上传${fileDetail}：${status.failed.join('；')}。本步骤没有发送，请重新打开 ChatGPT 后再试。` };
    }
    if (status?.ok) return { ok: true, uploaded: filePaths.length };
    await delay(1000);
  }
  const missing = (last?.expected || filePaths.map((filePath) => path.basename(filePath))).filter((name) => !(last?.seen || []).includes(name));
  return { ok: false, reason: `等待文件上传超过 60 秒，尚未确认${missing.length ? `：${missing.join('、')}` : ''}。本步骤没有发送，请在 ChatGPT 完成上传后重新执行。` };
}

async function waitForChromeMcpUploads(filePaths) {
  return waitForChatGptUploads(
    () => chromeMcpEvaluate(chatGptUploadStatusExpression(filePaths)),
    filePaths
  );
}

async function waitForEmbeddedUploads(filePaths, debuggerApi = null) {
  if (!chatGptWindow || chatGptWindow.isDestroyed()) return { ok: false, reason: 'ChatGPT 任务窗口已关闭。' };
  return waitForChatGptUploads(
    () => debuggerApi?.isAttached()
      ? evaluateEmbeddedChatGpt(debuggerApi, chatGptUploadStatusExpression(filePaths), { attempts: 3 })
      : chatGptWindow.webContents.executeJavaScript(chatGptUploadStatusExpression(filePaths)),
    filePaths
  );
}

async function uploadFilesToChromeMcp(filePaths) {
  if (!filePaths.length) return { ok: true, uploaded: 0 };
  for (const filePath of filePaths) {
    // Always reveal the composer menu freshly for every file.  It prevents a
    // stale attachment control from an earlier message being reused on the
    // next workflow step.
    const opened = await chromeMcpEvaluate(chromeOpenUploadMenuExpression());
    if (!opened?.ok) return opened || { ok: false, reason: '未能展开 ChatGPT 的附件菜单。' };
    await delay(380);
    const uid = await findChromeUploadUid({ includeComposerPlus: true });
    if (!uid) return { ok: false, reason: '已展开 ChatGPT 的附件菜单，但没有找到真正的文件选择入口；本步骤没有发送。请刷新 Chrome 后重试。' };
    try {
      await chromeMcpTool('upload_file', { uid, filePath });
      await delay(chatGptPacing.afterUploadMs);
    } catch (error) {
      if (isRecoverableChromeError(error)) throw error;
      return { ok: false, reason: `上传文件失败：${path.basename(filePath)}。${error.message || String(error)}` };
    }
  }
  return waitForChromeMcpUploads(filePaths);
}

function chromeSendPromptExpression(prompt) {
  return `(async () => {
    const visible = (el) => !!(el && el.offsetParent !== null);
    if (/(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(String(document.body?.innerText || ''))) {
      return { ok: false, reason: 'ChatGPT 官网暂时限制了本次对话访问。软件没有发送新消息，请等待官网提示的时间后再继续。' };
    }
    const replies = () => [...document.querySelectorAll('[data-message-author-role="assistant"], .markdown')].filter(visible).map((el) => el.innerText?.trim()).filter(Boolean);
    const previousReply = replies().at(-1) || '';
    const editors = [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')].filter(visible);
    const editor = editors.find((el) => /prompt-textarea|message|chat/i.test([el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.dataset?.testid].filter(Boolean).join(' '))) || editors.at(-1);
    if (!editor) return { ok: false, reason: '未找到当前 ChatGPT 聊天的输入框。', previousReply };
    editor.focus();
    const text = ${JSON.stringify(prompt)};
    if (editor.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const send = buttons.find((button) => /send|发送|submit/i.test([button.getAttribute('aria-label'), button.getAttribute('title'), button.dataset?.testid, button.innerText].filter(Boolean).join(' ')));
    if (!send || send.disabled) return { ok: false, reason: '提示词和附件已就绪，但未找到可用发送按钮；请在当前聊天手动发送，然后点“下载官网附件”。', previousReply };
    send.click();
    return { ok: true, previousReply };
  })()`;
}

const chromeReplySnapshotExpression = `(() => {
  const visible = (el) => !!(el && el.offsetParent !== null);
  const replies = [...document.querySelectorAll('[data-message-author-role="assistant"], .markdown')].filter(visible).map((el) => el.innerText?.trim()).filter(Boolean);
  const labels = [...document.querySelectorAll('button, [role="button"]')].filter(visible).map((el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.dataset?.testid, el.innerText].filter(Boolean).join(' '));
  const pageText = String(document.body?.innerText || '');
  const rateLimited = /(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(pageText);
  return { ok: true, content: replies.at(-1) || '', generating: labels.some((label) => /stop|停止|正在生成/i.test(label)), rateLimited };
})()`;

function chromeTxtAttachmentExpression(project, episodeNumber) {
  return `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => !!(el && el.offsetParent !== null);
    const label = (el) => [
      el.getAttribute('download'), el.getAttribute('aria-label'), el.getAttribute('title'),
      el.getAttribute('data-testid'), el.getAttribute('data-filename'), el.getAttribute('data-download-url'),
      el.innerText, el.textContent
    ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    const expected = ${JSON.stringify(episodeSlots.fileStem(project, episodeNumber))};
    const splitPart = ${JSON.stringify(episodeSlots.partForKey(project, episodeNumber))};
    const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    if (!messages.length) return { ok: false, reason: '还没有读到 ChatGPT 最新回复。' };
    const recentMessages = messages.slice(-3).reverse();
    const clicked = new Set();
    const isTextAttachment = (value) => /\.txt(?:\\s|$)|txt 文件|text file|文本文件/i.test(value || '');
    const belongsToEpisode = (value) => {
      const compact = String(value || '').replace(/\\s+/g, '');
      return compact.includes(expected) && (splitPart !== '上' || !compact.includes(expected + '下'));
    };
    const collect = (includePage = false) => {
      const scopes = recentMessages.map((element, rank) => ({ element, rank }));
      if (includePage) scopes.push({ element: document, rank: 9 });
      const found = [];
      const seen = new Set();
      for (const scope of scopes) {
        const elements = [...scope.element.querySelectorAll('a, button, [role="button"], [data-testid], [data-filename], [data-download-url]')].filter(visible);
        for (const element of elements) {
          const target = element.closest('a, button, [role="button"], [data-testid*="file"], [data-filename], [data-download-url]') || element;
          if (seen.has(target)) continue;
          seen.add(target);
          const anchor = target.closest('a') || target.querySelector?.('a') || element.closest('a') || element.querySelector?.('a');
          const text = [label(target), label(element), anchor ? label(anchor) : ''].filter(Boolean).join(' ');
          if (!isTextAttachment(text)) continue;
          const href = anchor?.href || target.href || element.href || anchor?.getAttribute('data-download-url') || target.getAttribute?.('data-download-url') || element.getAttribute?.('data-download-url') || '';
          found.push({ target, anchor, label: text, href, rank: scope.rank });
        }
      }
      return found;
    };
    const choose = (candidates) => {
      const matching = candidates.filter((item) => belongsToEpisode(item.label));
      const pool = matching.length ? matching : (splitPart ? [] : candidates.filter((item) => item.rank === 0));
      return pool.sort((a, b) => a.rank - b.rank);
    };
    const read = async (candidate) => {
      const href = candidate?.href;
      if (!href || /^(?:javascript:|#)/i.test(href)) return null;
      try {
        const response = await fetch(href, { credentials: 'include' });
        if (!response.ok) return { error: 'TXT 附件下载失败（' + response.status + '）。' };
        const content = await response.text();
        if (!content.trim()) return { error: '读取到的 TXT 附件为空。' };
        if (/^\\s*<(?:!doctype|html)/i.test(content)) return { error: '附件地址返回了网页，尚未取得 TXT 正文。' };
        const name = (candidate.anchor?.getAttribute('download') || candidate.target?.getAttribute?.('download') || candidate.label.match(/[^\\s/]+\.txt/i)?.[0] || 'ChatGPT附件.txt').trim();
        return { ok: true, name, content };
      } catch (error) {
        return { error: error?.message || 'TXT 附件读取失败。' };
      }
    };
    let lastError = '';
    let detected = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidates = choose(collect(attempt > 0));
      detected = Math.max(detected, candidates.length);
      for (const candidate of candidates.filter((item) => item.href)) {
        const result = await read(candidate);
        if (result?.ok) return result;
        if (result?.error) lastError = result.error;
      }
      for (const candidate of candidates.filter((item) => !item.href && !clicked.has(item.target)).slice(0, 2)) {
        clicked.add(candidate.target);
        try { candidate.target.click(); } catch { /* continue after the attachment card opens */ }
      }
      await wait(700);
    }
    const suffix = detected ? '已检测到 TXT 文件卡片，但尚未取得可读取的下载地址。' : '最新回复未检测到 TXT 文件卡片。';
    return { ok: false, reason: (lastError ? lastError + ' ' : '') + suffix + '请在当前 ChatGPT 回复中点开该 TXT 文件后，再点击“下载官网附件”重试。' };
  })()`;
}

async function captureChromeLatestAttachment(project, task) {
  await selectChromeChatTab(project);
  const attachment = await withChromeReconnect(project, () => chromeMcpEvaluate(chromeTxtAttachmentExpression(project, task.episodeNumber || project.currentEpisode)));
  if (!attachment?.ok) return attachment || { ok: false, reason: '未能读取 ChatGPT TXT 附件。' };
  const archive = await archiveChatGptReply(project, task, attachment.content);
  return { ok: true, replySource: 'attachment', attachmentName: attachment.name, ...archive };
}

async function archiveChatGptMessage(project, task, content) {
  const raw = String(content || '').trim();
  const fenced = raw.match(/^```(?:txt|text|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i);
  const normalized = String(fenced?.[1] || raw).trim();
  if (!normalized) return { ok: false, reason: 'ChatGPT 聊天正文为空，暂不能保存。' };
  const archive = await archiveChatGptReply(project, task, normalized);
  return { ok: true, replySource: 'message', content: normalized, ...archive };
}

async function captureChromeReplyByMode(project, task, snapshot) {
  const mode = chatGptReplyMode(project, task);
  if (mode !== 'attachment') {
    const message = await archiveChatGptMessage(project, task, snapshot?.content || '');
    if (message.ok || mode === 'message') return message;
  }
  let attachment;
  try {
    attachment = await captureChromeLatestAttachment(project, task);
  } catch (error) {
    attachment = { ok: false, reason: error?.message || String(error) };
  }
  return attachment;
}

async function executeChromeCurrentChatTask(project, task) {
  const backoff = chatGptBackoffMessage();
  if (backoff) return { ok: false, reason: backoff };
  await selectChromeChatTab(project);
  if (task.resume && task.chatUrl) {
    const current = await chromeMcpEvaluate('() => location.href');
    if (String(current) !== task.chatUrl) return {ok:false,reason:`请在Chrome打开原任务聊天后继续：${task.chatUrl}`};
  }
  const sourcePaths = await collectChromeUploadPaths(project, task);
  if (!sourcePaths.length) return { ok: false, reason: '本步骤没有找到要上传的真实文件。' };
  const stage = await stageChatGptUploadFiles(sourcePaths);
  try {
    if (!task.resume) {
      const upload = await withChromeReconnect(project, async () => uploadFilesToChromeMcp(stage.paths));
      if (!upload.ok) return upload;
      await delay(chatGptPacing.afterUploadMs);
    }
    if (task.control?.isPaused()) return {ok:false,paused:true,reason:'已暂停，尚未继续发送或读取。'};
    if (!task.resume) await task.control?.checkpoint('send-intent');
    const sent = task.resume ? {ok:true,previousReply:task.previousReply} : await withChromeReconnect(project, () => chromeMcpEvaluate(chromeSendPromptExpression(task.prompt)), { retry: false });
    if (isChatGptRateLimit(sent)) return { ok: false, reason: registerChatGptRateLimit() };
    if (!sent?.ok) return sent || { ok: false, reason: '未能发送到当前 ChatGPT 聊天。' };
    await task.control?.checkpoint('waiting', {previousReply:sent.previousReply||'',chatUrl:String(await chromeMcpEvaluate('() => location.href'))});
    const startedAt = Date.now();
    const waitMinutes = chatGptReplyWaitMinutes(project);
    let prior = sent.previousReply || '';
    let stableCount = 0;
    while (Date.now() - startedAt < waitMinutes * 60 * 1000) {
      if (task.control?.isPaused()) return {ok:false,paused:true,reason:'已停止等待；网页可能仍在生成。继续时只读取，不重复发送。'};
      await delay(chatGptPacing.pollMs);
      const snapshot = await withChromeReconnect(project, () => chromeMcpEvaluate(chromeReplySnapshotExpression));
      if (task.control) await task.control.checkpoint('waiting', {chatUrl:String(await chromeMcpEvaluate('() => location.href'))});
      if (!snapshot?.ok) return snapshot || { ok: false, reason: '无法读取 ChatGPT 回复状态。' };
      if (snapshot.rateLimited) return { ok: false, reason: registerChatGptRateLimit() };
      if (!snapshot.content || snapshot.content === sent.previousReply) continue;
      if (snapshot.content === prior && !snapshot.generating) stableCount += 1;
      else stableCount = 0;
      prior = snapshot.content;
      if (stableCount >= 2) return captureChromeReplyByMode(project, task, snapshot);
    }
    return { ok: false, reason: `等待回复超过 ${waitMinutes} 分钟。任务已保留；请在当前 ChatGPT 聊天确认结果后点“读取官网回复”。` };
  } finally {
    await stage.cleanup();
  }
}

function chromeStartNewChatExpression() {
  return `(async () => {
    const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
    if (/(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(String(document.body?.innerText || ''))) {
      return { ok: false, reason: 'ChatGPT 官网暂时限制了对话访问。请等待官网提示的时间后再继续。' };
    }
    const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.dataset?.testid, el.innerText, el.textContent]
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    const candidates = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')]
      .filter(visible)
      .map((element) => ({ element, text: label(element) }))
      .filter((item) => /(?:new chat|新聊天|开启新聊天|开始新聊天)/i.test(item.text) || /(?:new[-_ ]?chat|new[_-]?conversation)/i.test(item.text));
    const target = candidates.find((item) => /new[-_ ]?chat|新聊天/i.test(item.text))?.element || candidates[0]?.element;
    if (!target) return { ok: false, reason: '未找到 ChatGPT 的“新聊天”按钮。请先打开 ChatGPT 首页，再重新执行。' };
    target.scrollIntoView({ block: 'center' });
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const composer = [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')].find(visible);
    return composer ? { ok: true } : { ok: false, reason: '已点击“新聊天”，但没有读到输入框。请先完成 ChatGPT 的登录或验证。' };
  })()`;
}

async function startChromeNewChat(project) {
  const backoff = chatGptBackoffMessage();
  if (backoff) return { ok: false, reason: backoff };
  const remaining = Math.max(0, chatGptPacing.betweenNewChatsMs - (Date.now() - lastChatGptConversationStartedAt));
  if (remaining) await delay(remaining);
  await selectChromeChatTab(project);
  const result = await withChromeReconnect(project, () => chromeMcpEvaluate(chromeStartNewChatExpression()), { retry: false });
  if (isChatGptRateLimit(result)) return { ok: false, reason: registerChatGptRateLimit() };
  if (result?.ok) lastChatGptConversationStartedAt = Date.now();
  return result?.ok ? result : (result || { ok: false, reason: '无法创建 ChatGPT 新聊天。' });
}

async function startEmbeddedNewChat() {
  const backoff = chatGptBackoffMessage();
  if (backoff) return { ok: false, reason: backoff };
  const remaining = Math.max(0, chatGptPacing.betweenNewChatsMs - (Date.now() - lastChatGptConversationStartedAt));
  if (remaining) await delay(remaining);
  createChatWindow();
  // Do not reload chatgpt.com for every episode.  A full reload repeatedly
  // asks ChatGPT for the sidebar conversation history and is the main cause
  // of the account-level “请求过于频繁” dialog in compatibility mode.
  const alreadyLoaded = /^https:\/\/chatgpt\.com(?:\/|$)/i.test(chatGptWindow.webContents.getURL() || '');
  if (!alreadyLoaded) {
    try { await chatGptWindow.loadURL('https://chatgpt.com/'); } catch {
      return { ok: false, reason: '无法打开 ChatGPT 首页。请检查登录状态后重试。' };
    }
  }
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await delay(attempt ? 550 : 1100);
    try {
      const ready = await chatGptWindow.webContents.executeJavaScript(`(() => {
        const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
        const rateLimited = /(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(String(document.body?.innerText || ''));
        return { ready: [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')].some(visible), rateLimited };
      })()`);
      if (ready?.rateLimited) return { ok: false, reason: registerChatGptRateLimit() };
      if (ready?.ready) {
        if (alreadyLoaded) {
          const newChat = await chatGptWindow.webContents.executeJavaScript(chromeStartNewChatExpression());
          if (isChatGptRateLimit(newChat)) return { ok: false, reason: registerChatGptRateLimit() };
          if (!newChat?.ok) return newChat || { ok: false, reason: '未能在当前 ChatGPT 页面创建新聊天。' };
        }
        lastChatGptConversationStartedAt = Date.now();
        return { ok: true };
      }
    } catch { /* the website may still be redirecting */ }
  }
  return { ok: false, reason: '已打开 ChatGPT 首页，但未读到新聊天输入框。请先在任务窗口完成登录或验证。' };
}

async function uploadFilesToEmbeddedChat(filePaths) {
  if (!chatGptWindow || chatGptWindow.isDestroyed()) return { ok: false, reason: 'ChatGPT 任务窗口已关闭。' };
  if (!filePaths.length) return { ok: false, reason: '本步骤没有可上传的文件。' };
  const debuggerApi = chatGptWindow.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3');
      attachedHere = true;
    }
    // Wait for the new-chat composer in the current execution context.  A
    // freshly opened ChatGPT conversation often replaces its renderer once;
    // interacting during that replacement produced Electron's unhelpful
    // “Script failed to execute” error.
    let composerReady = false;
    for (let attempt = 0; attempt < 8 && !composerReady; attempt += 1) {
      const state = await evaluateEmbeddedChatGpt(debuggerApi, `(() => ({
        ready: document.readyState !== 'loading' && [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')]
          .some((element) => element && element.offsetParent !== null && !element.disabled),
        rateLimited: /(请求过于频繁|too many requests|限制你访问对话记录|temporarily limited)/i.test(String(document.body?.innerText || ''))
      }))()`, { attempts: 3 });
      if (state?.rateLimited) return { ok: false, reason: registerChatGptRateLimit() };
      composerReady = Boolean(state?.ready);
      if (!composerReady) await delay(650);
    }
    if (!composerReady) return { ok: false, reason: 'ChatGPT 新聊天尚未准备好上传文件。本步骤没有发送，请等待输入框出现后重试。' };
    // The visible composer menu must be opened first.  Picking an arbitrary
    // hidden file input can show attachment chips but leaves ChatGPT unable to
    // transfer the files, which is why earlier tasks were sent with red
    // “无法上传” chips.
    const selected = await uploadFilesThroughEmbeddedChooser(debuggerApi, filePaths);
    if (!selected.ok) return selected;
    const confirmed = await waitForEmbeddedUploads(filePaths, debuggerApi);
    return { ...confirmed, exactChooser: Boolean(selected.exactChooser), fileTypes: selected.fileTypes || [] };
  } catch (error) {
    return {
      ok: false,
      reason: `上传文件失败：${embeddedChatGptExceptionMessage(error)}。本步骤没有发送，请保持 ChatGPT 新聊天打开后重试。`
    };
  } finally {
    if (attachedHere && debuggerApi.isAttached()) {
      try { debuggerApi.detach(); } catch { /* detached by navigation */ }
    }
  }
}

async function runEmbeddedUploadSmokeCheck() {
  // Compile every page expression before opening the fixture.  This catches
  // template-string escaping mistakes (for example a regex whose escaped “+”
  // becomes a bare quantifier) before a release can be packaged.
  for (const expression of [
    chromeOpenUploadMenuExpression(),
    chromeActivateUploadActionExpression(),
    chatGptUploadStatusExpression(['upload-smoke.txt']),
    chromeSendPromptExpression('upload smoke'),
    chromeStartNewChatExpression()
  ]) {
    // eslint-disable-next-line no-new-func
    new Function(`return ${expression};`);
  }
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'manju-upload-smoke-'));
  const fixturePath = path.join(directory, 'upload-smoke.md');
  await fs.writeFile(fixturePath, 'upload smoke', 'utf8');
  chatGptWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  const fixture = `<!doctype html><meta charset="utf-8"><body>
    <button id="attach" aria-label="添加附件">+</button>
    <textarea id="prompt-textarea" aria-label="message"></textarea>
    <script>
      document.querySelector('#attach').addEventListener('click', () => {
        if (document.querySelector('#upload-action')) return;
        const documentInput = document.createElement('input');
        documentInput.id = 'document-input';
        documentInput.type = 'file';
        documentInput.accept = '.txt,.pdf,application/msword';
        documentInput.multiple = true;
        documentInput.style.display = 'none';
        documentInput.addEventListener('change', () => {
          const invalid = [...documentInput.files].some((file) => file.type !== 'text/plain');
          if (invalid) {
            const warning = document.createElement('div');
            warning.textContent = '不支持此文件类型。';
            document.body.appendChild(warning);
          } else {
            for (const file of documentInput.files) {
              const chip = document.createElement('div');
              chip.className = 'attachment-chip';
              chip.textContent = file.name;
              document.body.appendChild(chip);
            }
          }
        });
        document.body.appendChild(documentInput);
        const imageOnlyInput = document.createElement('input');
        imageOnlyInput.id = 'image-only-input';
        imageOnlyInput.type = 'file';
        imageOnlyInput.accept = 'image/*';
        imageOnlyInput.style.display = 'none';
        document.body.appendChild(imageOnlyInput);
        const action = document.createElement('div');
        action.id = 'upload-action';
        action.tabIndex = 0;
        action.innerHTML = '<span>添加照片和文件</span><span>从电脑上传</span>';
        action.addEventListener('click', () => documentInput.click());
        document.body.appendChild(action);
      });
    </script>`;
  try {
    await chatGptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`);
    const staged = await stageChatGptUploadFiles([fixturePath]);
    try {
      if (path.extname(staged.paths[0]).toLowerCase() !== '.txt') throw new Error('Markdown upload copy was not converted to TXT.');
      const result = await uploadFilesToEmbeddedChat(staged.paths);
      if (!result?.ok) throw new Error(result?.reason || 'embedded upload smoke failed');
      if (!result.exactChooser) throw new Error('Embedded upload did not use the intercepted document chooser.');
      if (!result.fileTypes?.length || result.fileTypes.some((type) => type !== 'text/plain')) throw new Error('TXT upload MIME type was not text/plain.');
      console.log(`Embedded upload smoke passed: ${result.uploaded} file selected through CDP.`);
    } finally {
      await staged.cleanup();
    }
  } finally {
    if (chatGptWindow && !chatGptWindow.isDestroyed()) chatGptWindow.destroy();
    chatGptWindow = null;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeEmbeddedCurrentChatTask(project, task) {
  const backoff = chatGptBackoffMessage();
  if (backoff) return { ok: false, reason: backoff };
  if (task.resume && task.chatUrl && chatGptWindow?.webContents.getURL() !== task.chatUrl) return {ok:false,reason:`请打开原任务聊天后继续：${task.chatUrl}`};
  const sourcePaths = await collectChromeUploadPaths(project, task);
  if (!sourcePaths.length) return { ok: false, reason: '本步骤没有找到要上传的真实文件。' };
  const stage = await stageChatGptUploadFiles(sourcePaths);
  try {
    if (!task.resume) {
      const upload = await uploadFilesToEmbeddedChat(stage.paths);
      if (!upload.ok) return upload;
      await delay(chatGptPacing.afterUploadMs);
    }
    if (task.control?.isPaused()) return {ok:false,paused:true,reason:'任务已暂停。'};
    if (!task.resume) await task.control?.checkpoint('send-intent');
    const sent = task.resume ? {ok:true,previousReply:task.previousReply} : await sendPromptToChatGpt(task.prompt);
    if (isChatGptRateLimit(sent)) return { ok: false, reason: registerChatGptRateLimit() };
    if (!sent.ok) return sent;
    await task.control?.checkpoint('waiting',{previousReply:sent.previousReply||'',chatUrl:chatGptWindow.webContents.getURL()});
    const startedAt = Date.now();
    const waitMinutes = chatGptReplyWaitMinutes(project);
    let prior = sent.previousReply || '';
    let stableCount = 0;
    while (Date.now() - startedAt < waitMinutes * 60 * 1000) {
      if (task.control?.isPaused()) return {ok:false,paused:true,reason:'已暂停等待；继续时只读取，不重复发送。'};
      await delay(chatGptPacing.pollMs);
      const snapshot = await getChatGptReplySnapshot();
      if (task.control) await task.control.checkpoint('waiting',{chatUrl:chatGptWindow.webContents.getURL()});
      if (!snapshot.ok) return snapshot;
      if (snapshot.rateLimited) return { ok: false, reason: registerChatGptRateLimit() };
      if (!snapshot.content || snapshot.content === sent.previousReply) continue;
      if (snapshot.content === prior && !snapshot.generating) stableCount += 1;
      else stableCount = 0;
      prior = snapshot.content;
      if (stableCount >= 2) {
        const mode = chatGptReplyMode(project, task);
        if (mode !== 'attachment') {
          const message = await archiveChatGptMessage(project, task, snapshot.content);
          if (message.ok || mode === 'message') return message;
        }
        const file = await downloadLatestChatGptAttachment(project, task);
        return file.ok ? { ...file, replySource: 'attachment' } : file;
      }
    }
    return { ok: false, reason: `等待回复超过${waitMinutes}分钟。请在当前 ChatGPT 新聊天确认结果后再重试。` };
  } finally {
    await stage.cleanup();
  }
}

async function executeEpisodeWorkflow(project, payload = {}) {
  const initialPlan = await prepareEpisodeWorkflow(project, payload);
  const episodeProject = { ...project, currentEpisode: initialPlan.episodeNumber };
  const completed = [];
  for (const selectedStep of initialPlan.steps) {
    // Re-read immediately before each send.  When an earlier step is selected,
    // its newly saved TXT becomes the next step's real upload file.
    const step = await prepareWorkflowStep(episodeProject, {
      episodeNumber: initialPlan.episodeNumber,
      step: selectedStep.step,
      selection: initialPlan.selection,
      promptMode: initialPlan.promptMode,
      promptOverride: payload.prompts?.[selectedStep.step] || ''
    });
    if (!step.inputPath) {
      return { ok: false, completed, failedStep: step.step, reason: `第${initialPlan.episodeNumber}集${step.label}的上一步文件尚未保存，无法继续上传。` };
    }
    const task = {
      id: uid(),
      kind: step.outputKind,
      episodeNumber: initialPlan.episodeNumber,
      targetSeconds: Number((episodeProject.episodes || []).find((item) => Number(item.number) === initialPlan.episodeNumber)?.targetSeconds) || Number(episodeProject.targetDuration) || 120,
      name: `第${initialPlan.episodeNumber}集 · ${step.label}`,
      prompt: step.prompt,
      replyMode: normalizeChatGptReplyMode(payload.replyMode || episodeProject.chatGptRunner?.replyMode),
      uploadPaths: step.files,
      syncDocx: step.outputKind !== 'shotlist'
    };
    const inputHash = crypto.createHash('sha256');
    for (const name of step.files) inputHash.update(await fs.readFile(name));
    inputHash.update(task.prompt);
    const key = `workflow:${initialPlan.episodeNumber}:${step.step}:${inputHash.digest('hex')}`;
    const result = await runRecordedWebTask(episodeProject, {key,name:task.name,prompt:task.prompt,files:step.files,kind:step.outputKind});
    if (result.phase !== 'completed') {
      return { ok: false, completed, failedStep: step.step, reason: result.reason || `${step.label}没有完成。` };
    }
    let archive;
    if (result.outputPath && fsSync.existsSync(result.outputPath)) {
      const existing = await readTextDocument(result.outputPath);
      if (crypto.createHash('sha256').update(existing).digest('hex') !== result.outputHash) return {ok:false,completed,failedStep:step.step,reason:'已完成文件被手动修改；请使用当前稿继续，不能自动覆盖：'+result.outputPath};
      archive={outputPath:result.outputPath};
    } else {
      const folder=outputFolderForTask(episodeProject,task);
      const old=await findEpisodeDocumentFile(episodeProject,step.outputKind,folder,initialPlan.episodeNumber);
      if(old) {const backup=path.join(episodeProject.projectPath,'.ai-director','workflow-backups',uid());await fs.mkdir(backup,{recursive:true});await fs.copyFile(old.path,path.join(backup,path.basename(old.path)));}
      archive=await archiveChatGptReply(episodeProject,task,result.content);
      result.outputPath=archive.outputPath;
      result.outputHash=crypto.createHash('sha256').update(await readTextDocument(archive.outputPath)).digest('hex');
      await executionJournal.save(episodeProject,key,result);
    }
    completed.push({ step: step.step, label: step.label, outputPath: archive.outputPath });
  }
  return { ok: true, episodeNumber: initialPlan.episodeNumber, completed };
}

async function runRecordedWebTask(project, request) {
  if (project.generationMode === 'api') {
    try {
      const content = await apiService.executePrompt(project, request.prompt, request.files, request.kind || '');
      return { phase: 'completed', ok: true, content, outputPath: '', reason: '' };
    } catch (error) {
      return { phase: 'needs-attention', ok: false, reason: `API 任务未完成：${error.message || String(error)}` };
    }
  }
  return executionJournal.run(project,request,async task=>{
    if(!task.resume) {
      const opened=chromeRunnerOptions(project).mode==='chrome'?await startChromeNewChat(project):await startEmbeddedNewChat();
      if(!opened.ok)return opened;
    }
    return chromeRunnerOptions(project).mode==='chrome'?executeChromeCurrentChatTask(project,task):executeEmbeddedCurrentChatTask(project,task);
  });
}

async function executeProductionTask(project, taskId) {
  const db=await productionService.load(project),ep=db.episodes[project.currentEpisode];
  const task=ep?.tasks.find(t=>t.id===taskId);
  if(!task?.prepared||ep.paused||!require('./production').ready(ep,task))throw Error('请先准备当前任务并验收上游。');
  const token=task.prepared.token;
  const folder=path.join(project.projectPath,'.ai-director','production-v2','tasks');await fs.mkdir(folder,{recursive:true});
  const file=path.join(folder,token+'.txt');await fs.writeFile(file,task.prepared.prompt,'utf8');
  const result=await runRecordedWebTask(project,{key:'production:'+token,name:`第${ep.number}集 · ${require('./production').roles.find(r=>r.id===taskId).name}`,prompt:'完整阅读附件任务单及其中全部资料，按职责完成本次任务。',files:[file]});
  if(result.phase!=='completed')return {db:await productionService.load(project),run:result};
  const current=await productionService.load(project),latest=current.episodes[ep.number].tasks.find(t=>t.id===taskId);
  if(latest.versions.some(v=>v.taskToken===token&&v.content===result.content))return {db:current,run:result};
  const saved=await productionService.act(project,{action:'result',episode:ep.number,revision:current.revision,task:taskId,taskToken:token,content:result.content});
  return {...saved,run:result};
}

async function finalizeEpisodeOutput(project, kind) {
  const task = { kind };
  const content = project[kind]?.content?.trim();
  if (!content) throw new Error('当前内容为空，无法定稿。');
  const directory = outputFolderForTask(project, task);
  await ensureDirectory(directory);
  await removeEpisodeArchiveFiles(project, task, { includeOriginal: false, includeLegacy: true, includeWord: false });
  const stem = episodeFileStem(project);
  const format = documentFormatForKind(project, kind);
  const outputPath = path.join(directory, `${stem}${extensionForDocumentFormat(format)}`);
  await writeEditableDocument(outputPath, content);
  const docxPath = format === 'docx' ? outputPath : '';
  return { outputPath, plainTextPath: format === 'docx' ? '' : outputPath, docxPath, stem, format };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startChatGptProjectConversation(projectName) {
  createChatWindow();
  const requestedName = String(projectName || '').trim();
  if (!requestedName) return { ok: true, skipped: true };
  let projectUrl = '';
  let projectListOpened = false;
  let projectClickStarted = false;

  // 每一项兼容模式任务都必须回到“项目首页”。项目首页的输入框会创建该项目
  // 内的新聊天；绝不能点击通用“新聊天”，也不能留在上一项任务的旧会话里。
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await delay(attempt ? 650 : 1100);
    try {
      const result = await chatGptWindow.webContents.executeJavaScript(`(() => {
        const requested = ${JSON.stringify(requestedName)};
        const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
        const label = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.dataset?.testid]
          .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
        const normalized = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const click = (element) => {
          const target = element.closest('a, button, [role="button"], [role="link"], [role="menuitem"], [role="treeitem"]') || element;
          target.scrollIntoView({ block: 'center' });
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          target.click();
        };
        const settings = [...document.querySelectorAll('[role="dialog"], dialog')]
          .find((el) => visible(el) && /项目设置|project settings/i.test(label(el)));
        if (settings) {
          const close = [...settings.querySelectorAll('button, [role="button"]')]
            .find((el) => /关闭|close|dismiss/i.test(label(el)));
          if (close) click(close);
          else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return { ok: false, action: 'settings-closed' };
        }

        const isProjectRoot = /\\/g\\/g-p-[^/]+\\/project\\/?$/i.test(location.pathname)
          || /^\\/projects\\/[^/]+\\/?$/i.test(location.pathname);
        const hasProjectHeading = [...document.querySelectorAll('h1, h2, [role="heading"]')]
          .some((el) => visible(el) && normalized(label(el)) === requested);
        if (isProjectRoot && hasProjectHeading) {
          return { ok: true, action: 'project-found', projectUrl: location.href };
        }

        // 只认可真实项目入口，避免点到分享、“…”或项目设置。某些 ChatGPT
        // 版本的项目入口没有 href，故允许只点击一次后读取实际项目根页地址。
        const projectItems = [...document.querySelectorAll('a[href], [role="link"], [role="treeitem"]')]
          .filter(visible)
          .map((el) => ({
            element: el.closest('a[href], [role="link"], [role="treeitem"]') || el,
            text: normalized(label(el)),
            href: el.closest('a[href]')?.href || el.getAttribute('href') || ''
          }))
          .filter((item) => item.text === requested || item.text.startsWith(requested + ' '));
        if (projectItems.length) {
          const project = projectItems[0];
          if (/\\/(?:projects?\\/[^/]+|g\\/g-p-[^/]+\\/project)/i.test(project.href)) {
            return { ok: true, action: 'project-found', projectUrl: new URL(project.href, location.href).href };
          }
          if (!${projectClickStarted}) {
            click(project.element);
            return { ok: false, action: 'project-clicked' };
          }
        }

        const selectable = [...document.querySelectorAll('a, button, [role="button"], [role="link"], [role="menuitem"], [role="treeitem"]')].filter(visible);
        const projectsNav = selectable.find((el) => /(^|\\s)(projects?|项目)(\\s|$)/i.test(label(el)));
        if (projectsNav && !${projectListOpened}) {
          click(projectsNav);
          return { ok: false, action: 'projects-opened' };
        }
        return { ok: false, action: 'waiting-for-project' };
      })()`);
      if (result?.ok && result.action === 'project-found' && result.projectUrl) {
        projectUrl = String(result.projectUrl);
        break;
      }
      if (result?.action === 'projects-opened') projectListOpened = true;
      if (result?.action === 'project-clicked') projectClickStarted = true;
    } catch {
      // 页面仍在重定向或登录校验时，下一轮继续寻找项目入口。
    }
  }

  if (!projectUrl) {
    return {
      ok: false,
      reason: `未能在 ChatGPT 官网找到项目“${requestedName}”。项目列表只会自动展开一次，不会反复跳转；请确认项目名称与 ChatGPT 中完全一致后重试。`
    };
  }

  try {
    // 强制导航到项目根页，清除上一项任务残留的聊天地址。随后由 sendPromptToChatGpt
    // 在这个根页输入，ChatGPT 才会为本项任务创建一个属于该项目的新会话。
    await chatGptWindow.loadURL(projectUrl);
  } catch {
    return { ok: false, reason: `无法打开 ChatGPT 项目“${requestedName}”的项目首页。请关闭登录验证后重试。` };
  }

  for (let attempt = 0; attempt < 14; attempt += 1) {
    await delay(attempt ? 500 : 900);
    try {
      const ready = await chatGptWindow.webContents.executeJavaScript(`(() => {
        const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);
        const text = (el) => [el.innerText, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.dataset?.testid]
          .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
        const pathIsProjectRoot = /\\/g\\/g-p-[^/]+\\/project\\/?$/i.test(location.pathname)
          || /^\\/projects\\/[^/]+\\/?$/i.test(location.pathname);
        const composer = [...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')]
          .filter(visible)
          .find((el) => /prompt-textarea|message|chat|新聊天|new chat/i.test(text(el)));
        // 已由项目名称匹配出的 URL 直接打开项目根页；无需依赖页面标题标签，
        // 因为不同 ChatGPT 版本的项目标题不一定使用 h1/h2。
        return !!(pathIsProjectRoot && composer);
      })()`);
      if (ready) return { ok: true, projectName: requestedName, newProjectChat: true };
    } catch {
      // 正在加载时继续等待。
    }
  }
  return {
    ok: false,
    reason: `已打开 ChatGPT 项目“${requestedName}”，但未能确认项目首页的新聊天输入框。请关闭登录验证或弹窗后重新执行。`
  };
}

async function executeChatGptTask(project, task) {
  if (chromeRunnerOptions(project).mode === 'chrome') {
    try { return await executeChromeCurrentChatTask(project, task); }
    catch (error) { return { ok: false, reason: error.message || chromeAuthorizationHelp() }; }
  }
  const projectName = task.kind === 'script'
    ? project.chatGptProjects?.script
    : (task.kind === 'shotlist' || task.kind === 'storyboard' ? project.chatGptProjects?.prompt : '');
  if (projectName) {
    const conversation = await startChatGptProjectConversation(projectName);
    if (!conversation.ok) return conversation;
  }
  const sent = await sendPromptToChatGpt(task.prompt);
  if (!sent.ok) return sent;
  const startedAt = Date.now();
  const waitMinutes = chatGptReplyWaitMinutes(project);
  let prior = sent.previousReply || '';
  let stableCount = 0;
  while (Date.now() - startedAt < waitMinutes * 60 * 1000) {
    await delay(chatGptPacing.pollMs);
    const snapshot = await getChatGptReplySnapshot();
    if (!snapshot.ok) return snapshot;
    if (snapshot.rateLimited) return { ok: false, reason: registerChatGptRateLimit() };
    if (!snapshot.content || snapshot.content === sent.previousReply) continue;
    if (snapshot.content === prior && !snapshot.generating) stableCount += 1;
    else stableCount = 0;
    prior = snapshot.content;
    if (stableCount >= 2) {
      const mode = chatGptReplyMode(project, task);
      if (mode !== 'attachment') {
        const message = await archiveChatGptMessage(project, task, snapshot.content);
        if (message.ok || mode === 'message') return message;
      }
      const file = await downloadLatestChatGptAttachment(project, task);
      return file.ok ? { ...file, replySource: 'attachment' } : file;
    }
  }
  return { ok: false, reason: `等待回复超过${waitMinutes}分钟。任务已保留；请确认 ChatGPT 已生成结果后再点“读取官网回复”。` };
}

async function chooseWorkflowTemplate(project, key) {
  const names = {
    script: '原文转剧本模板',
    shotlist: '剧本转分镜模板',
    prompt15: '分镜转提示词（15 秒）模板',
    prompt30: '分镜转提示词（30 秒）模板'
  };
  if (!names[key]) throw new Error('未识别的工作流模板。');
  const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
    title: `选择${names[key]}`,
    filters: [{ name: 'Markdown 与文本文件', extensions: ['md', 'markdown', 'txt'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const folders = makeFolderMap(project.projectPath);
  const destination = path.join(folders.promptTemplates, '工作流模板');
  await ensureDirectory(destination);
  const sourcePath = result.filePaths[0];
  const targetPath = await uniqueFileDestination(destination, sanitizeName(path.basename(sourcePath)));
  await fs.copyFile(sourcePath, targetPath);
  return { name: path.basename(sourcePath), path: targetPath, importedAt: now() };
}

function installIpc() {
  registerIpcHandle('workspace:snapshot', (_event, projectPath) => {
    const project = store.projects.find(p => normalizedPath(p.projectPath) === normalizedPath(projectPath));
    return project ? structuredClone(project) : null;
  });
  registerIpcHandle('workspace:accept', () => true);
  registerIpcHandle('workspace:bootstrap', event => {
    const entry = workspaceWindows.get(event.sender);
    return { ...entry?.bootstrap, ...(entry?.meta?.currentEpisode ? { episode: entry.meta.currentEpisode } : {}),
      ...(entry?.meta?.title ? { projectPath: entry.meta.projectPath, view: entry.meta.view } : {}),
      id: entry?.win.id, number: entry?.number || 1, windows: workspaceWindows.list(), displays: screen.getAllDisplays().length };
  });
  registerIpcHandle('workspace:open', async (event, input) => {
    const win = await workspaceWindows.create(input, event.sender);
    return win ? { id: win.id } : null;
  });
  registerIpcHandle('workspace:list', () => workspaceWindows.list());
  registerIpcHandle('workspace:focus', (_event, id) => {
    const win = workspaceWindows.live().find(entry => entry.win.id === Number(id))?.win;
    if (!win) return false;
    if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true;
  });
  registerIpcHandle('workspace:update', (event, value) => { workspaceWindows.update(event.sender, value); return true; });
  registerIpcHandle('workspace:move-screen', event => workspaceWindows.moveToNextScreen(event.sender));

  registerIpcHandle('performance:info', () => runtimeSupport.info());
  ipcMain.on('performance:episode-switch', (_event, timing) => {
    if (!runtimeSupport.diagnostics) return;
    const sample = {};
    for (const key of ['episode', 'readMs', 'displayMs', 'requestBytes']) if (Number.isFinite(Number(timing?.[key]))) sample[key] = Number(timing[key]);
    runtimeSupport.record('episode-switch', sample);
  });
  registerIpcHandle('assistant:ask',(_event,{project,input})=>{assertGenerationIdle();return keepComputerAwakeWhileWorking(()=>assistantService.ask(project,input));});
  registerIpcHandle('assistant:cancel',()=>assistantService.cancel());
  registerIpcHandle('director:snapshot',(_event,p)=>directorService.snapshot(p));
  registerIpcHandle('director:save',(_event,{project,input})=>directorService.save(project,input));
  registerIpcHandle('director:apply',(_event,{project,input})=>{assertGenerationIdle();return directorService.apply(project,input);});
  registerIpcHandle('director:restore',(_event,{project,input})=>{assertGenerationIdle();return directorService.restore(project,input);});
  registerIpcHandle('director:propose',(_event,{project,input})=>{assertGenerationIdle();return keepComputerAwakeWhileWorking(()=>directorService.propose(project,input));});
  registerIpcHandle('director:cancel',()=>directorService.cancel());
  registerIpcHandle('director:choose-image',async()=>{await membershipService.assertCanEdit();const choice=await dialog.showOpenDialog(activeWorkspaceWindow(),{title:'选择参考图片',properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg','webp','gif','bmp']}]});return choice.canceled?null:choice.filePaths[0];});
  registerIpcHandle('html:list', (_event,{project,options}) => htmlLibrary.list(project,options));
  registerIpcHandle('html:choose', async (_event,{project,category}) => {
    const result=await dialog.showOpenDialog(activeWorkspaceWindow(),{title:'选择 HTML 资料',defaultPath:path.join(project.projectPath,'06 资产'),properties:['openFile'],filters:[{name:'HTML 网页资料',extensions:['html','htm']}]});
    return result.canceled ? null : htmlLibrary.describe(result.filePaths[0],null,category);
  });
  registerIpcHandle('automation:load', (_event,project) => automationService.load(project));
  registerIpcHandle('automation:visuals', (_event,project) => htmlLibrary.list(project));
  registerIpcHandle('automation:preview', (_event,{project,input}) => automationService.preview(project,input));
  registerIpcHandle('automation:choose-source', async () => {
    const result = await dialog.showOpenDialog(activeWorkspaceWindow(),{title:'选择完整小说原文',properties:['openFile'],filters:[{name:'原文文件',extensions:['txt','md','docx']}]});
    return result.canceled ? null : result.filePaths[0];
  });
  registerIpcHandle('automation:run', async (_event,{project,input}) => {
    assertGenerationIdle();
    return keepComputerAwakeWhileWorking(() => automationService.run(project,input));
  });
  registerIpcHandle('automation:cancel', () => automationService.cancel());
  registerIpcHandle('automation:open', async (_event,{project,kind}) => {
    const relative = {relationships:'06 资产/人物关系网.html',assets:'06 资产/资产与图片提示词.html',reports:'检查报告',outputs:''}[kind];
    if (relative === undefined) throw Error('未知输出类型。');
    const destination = path.join(project.projectPath,relative);
    await fs.access(destination); const error = await shell.openPath(destination); if(error) throw Error(error); return true;
  });
  registerIpcHandle('quality:check', async (_event,{project,input}) => {
    assertGenerationIdle();
    const registry = await automationService.registry(project);
    let previous=input.previous || '';
    if(!previous){const keys=(project.episodes||[]).map(e=>Number(e.number)).filter(n=>n<Number(project.currentEpisode)).sort((a,b)=>a-b);
      const key=keys.at(-1);if(key){const files=await listTextFiles(documentFolderForKind(project,'script'),1600,{identifyEpisodes:true,extensions:editorExtensions});const file=chooseEpisodeFile(files,project,'script',key);if(file)previous=`【第${episodeSlots.label(project,key)}集】\n${await readTextDocument(file.path)}`;}}
    const currentAssets=registry.assets.filter(a=>a.firstEpisode<=Number(project.currentEpisode));
    const directorAssets=await directorService.assets(project);
    for(const a of directorAssets){const index=currentAssets.findIndex(x=>x.id===a.id);if(index>=0)currentAssets[index]={...currentAssets[index],...a};else currentAssets.push(a);}
    if(!currentAssets.length)currentAssets.push(...(project.assets||[]).map(a=>({id:a.id,name:a.standardName||a.name,aliases:[],type:a.category})));
    return qualityService.check(project,{...input,previous,assets:JSON.stringify({...registry,assets:currentAssets})});
  });
  registerIpcHandle('quality:propose', async (_event,{project,report,instruction,settings}) => {assertGenerationIdle();return qualityService.propose(project,report,instruction,settings);});
  registerIpcHandle('quality:apply', (_event,{project,id}) => {assertGenerationIdle();return qualityService.apply(project,id);});
  registerIpcHandle('quality:undo', (_event,{project,id}) => {assertGenerationIdle();return qualityService.undo(project,id);});
  registerIpcHandle('quality:cancel', () => qualityService.cancel());
  registerIpcHandle('review:load', (_event, project) => reviewService.load(project));
  registerIpcHandle('review:act', async (_event, { project, input }) => {
    if(input.action==='note'&&input.shotId){const db=await reviewService.load(project),video=db.videos.find(v=>v.id===input.videoId);if(video?.episode==null)throw Error('先为视频指定集数。');const snapshot=await directorService.snapshot({...project,currentEpisode:video.episode});const shot=snapshot.shots.find(s=>s.id===input.shotId);if(!shot)throw Error('对应镜头已变化，请重新选择，或取消镜头绑定。');input={...input,shotLabel:shot.label,shotFile:snapshot.files.shotlist.path};}
    return reviewService.act(project,input);
  });
  registerIpcHandle('review:choose-folder', async (_event, project) => {
    const choice = await dialog.showOpenDialog(activeWorkspaceWindow(), { title: '选择审片视频文件夹', properties: ['openDirectory'] });
    if (choice.canceled) return null;
    return reviewService.act(project, { action: 'scan', folder: choice.filePaths[0] });
  });
  registerIpcHandle('review:export', async (_event, project, options) => {
    const result = await reviewService.exportReport(project, options);
    if (result.directory) await shell.openPath(result.directory); return result;
  });
  registerIpcHandle('review:open-folder', async (_event, project) => {
    const directory = reviewService.rootOf(project); await fs.mkdir(directory, { recursive: true });
    return shell.openPath(directory);
  });
  registerIpcHandle('review:external', async (_event, { project, videoId }) => {
    const db = await reviewService.load(project), video = db.videos.find((v) => v.id === videoId);
    if (!video) throw Error('视频不存在。');
    return shell.openPath(video.path);
  });
  registerIpcHandle('membership:status', () => membershipService.status());
  registerIpcHandle('membership:activate', (_event, token) => membershipService.activateToken(token));
  registerIpcHandle('membership:import', () => membershipService.importLicense());
  registerIpcHandle('membership:remove-license', () => membershipService.removeLicense());
  registerIpcHandle('templates:list', async () => {
    await membershipService.assertCanUseBuiltinTemplates();
    return listBuiltinTemplates();
  });
  registerIpcHandle('templates:select', async (_event, id) => {
    await membershipService.assertCanUseBuiltinTemplates();
    const selected = builtinTemplateById(id);
    if (!selected) throw new Error('没有找到这份内置提示词。');
    return selected;
  });
  registerIpcHandle('templates:read', async (_event, id) => {
    await membershipService.assertCanUseBuiltinTemplates();
    return readBuiltinTemplate(id);
  });
  registerIpcHandle('production:execute', async (_event,{project,task})=>{
    assertGenerationIdle();
    return keepComputerAwakeWhileWorking(()=>executeProductionTask(project,task));
  });
  registerIpcHandle('production:jobs',(_event,project)=>executionJournal.list(project));
  registerIpcHandle('production:stop',(_event,project)=>executionJournal.pause(project));
  registerIpcHandle('workflow:batch-state',async(_event,{project,draft})=>{
    const target=path.join(project.projectPath,'.ai-director','batch-v21.json');
    if(draft===undefined){try{return JSON.parse(await fs.readFile(target,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
    await fs.mkdir(path.dirname(target),{recursive:true});await writeFileAtomically(target,JSON.stringify(draft,null,2),'utf8');return draft;
  });
  registerIpcHandle('production:load', (_event, project) => productionService.load(project));
  registerIpcHandle('production:copy', (_event, text) => { clipboard.writeText(String(text)); return true; });
  registerIpcHandle('production:act', async (_event, { project, input }) => {
    if(input.action==='media') {
      const selection=await dialog.showOpenDialog(activeWorkspaceWindow(),{title:'绑定本集真实视频',properties:['openFile'],filters:[{name:'视频',extensions:['mp4','mov','mkv','webm','avi','m4v']}]});
      if(selection.canceled)return {db:await productionService.load(project)};
      const binary = [
        path.join(process.resourcesPath, 'media-tools', 'ffprobe.exe'),
        path.join(__dirname, '..', 'media-tools', 'ffprobe.exe')
      ].find(candidate => fsSync.existsSync(candidate)) || 'ffprobe';
      input.probed = await mediaProbe.probe(selection.filePaths[0], binary);
    }
    if(input.action==='cue'||input.action==='export-rich') {
      const db=await productionService.load(project);
      const media=input.action==='cue'?db.media.filter(m=>m.id===input.mediaId):db.media.filter(m=>db.cues.some(c=>c.mediaId===m.id));
      for(const item of media)await mediaProbe.verify(item);
    }
    if (input.action === 'sync') {
      project.productionReferences = [];
      const docs = [...(project.ruleDocuments || []), ...(project.referenceDocuments || [])];
      const templates = normalizeWorkflowTemplates(project.workflowTemplates);
      for (const key of ['shotlist', templates.promptMode === '15' ? 'prompt15' : 'prompt30']) {
        if (templates[key]?.path && fsSync.existsSync(templates[key].path)) docs.push(templates[key]);
      }
      const seen = new Set();
      for (const doc of docs) {
        if (!doc.path || seen.has(doc.path)) continue;
        seen.add(doc.path);
        project.productionReferences.push({ path: doc.path, name: doc.name || path.basename(doc.path), content: await readTextDocument(doc.path) });
      }
    }
    return productionService.act(project, input);
  });
  registerIpcHandle('projects:list', listProjects);
  registerIpcHandle('projects:forget', (_event, ids) => forgetProjects(ids));
  registerIpcHandle('projects:store-status', () => projectStore.status());
  registerIpcHandle('projects:create', async (_event, input) => {
    const title = String(input?.title || '').trim();
    if (!title) throw new Error('请填写项目名称。');
    const seedFiles = Object.entries(input?.seedFiles || {}).filter(([, file]) => file);
    const allowedSeedKinds = new Set(['source', 'outline', 'script']);
    for (const [kind, filePath] of seedFiles) {
      if (!allowedSeedKinds.has(kind) || typeof filePath !== 'string' || !editorExtensions.has(path.extname(filePath).toLowerCase())) {
        throw new Error('初始资料只支持原文、大纲或剧本的 TXT、Markdown 与 Word 文件。');
      }
      if (!(await fs.stat(filePath)).isFile()) throw new Error('选择的初始资料不是文件。');
    }
    let projectPath = input?.projectPath;
    if (!projectPath) {
      const parentPath = input?.parentPath ? path.resolve(input.parentPath) : path.join(defaultRoot(), 'projects');
      if (input?.parentPath && !(await fs.stat(parentPath)).isDirectory()) throw new Error('请选择有效的项目存放文件夹。');
      const base = path.join(parentPath, sanitizeName(title));
      projectPath = base;
      let suffix = 2;
      while (fsSync.existsSync(projectPath)) projectPath = `${base} (${suffix++})`;
    }
    const project = createProject({ ...input, title, projectPath });
    await writeProject(project);
    for (const [kind, filePath] of seedFiles) {
      const destination = await uniqueFileDestination(documentFolderForKind(project, kind), path.basename(filePath));
      await fs.copyFile(filePath, destination);
      const extension = path.extname(filePath).toLowerCase();
      project.documentFormats[kind] = extension === '.docx' ? 'docx' : ['.md', '.markdown'].includes(extension) ? 'md' : 'txt';
    }
    if (seedFiles.length) {
      await scanProjectFolder(project);
      await writeProject(project);
    }
    store.projects.push(project);
    await persistStore();
    return project;
  });
  registerIpcHandle('projects:choose-parent', async () => {
    const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
      title: '选择新项目的存放位置',
      defaultPath: path.join(defaultRoot(), 'projects'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  registerIpcHandle('projects:choose-seed-file', async () => {
    const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
      title: '选择原文、大纲或剧本文件',
      filters: [{ name: 'TXT、Markdown 与 Word', extensions: ['txt', 'md', 'markdown', 'docx'] }],
      properties: ['openFile']
    });
    return result.canceled ? null : { path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
  });
  registerIpcHandle('projects:adopt-folder', async () => {
    const result = await dialog.showOpenDialog(activeWorkspaceWindow(), {
      title: '选择漫剧项目根文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return null;
    return openProjectFolder(result.filePaths[0]);
  });
  registerIpcHandle('projects:open', async (_event, projectPath) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('项目文件夹路径为空。');
    const stat = await fs.stat(path.resolve(projectPath));
    if (!stat.isDirectory()) throw new Error('所选项目路径不是文件夹。');
    return openProjectFolder(projectPath);
  });
  registerIpcHandle('projects:rescan', async (_event, project) => {
    await projectWrites.flush(project.projectPath);
    const scanned = await scanProjectFolder(project);
    await writeProject(scanned);
    const index = store.projects.findIndex((item) => item.id === scanned.id || normalizedPath(item.projectPath) === normalizedPath(scanned.projectPath));
    if (index >= 0) store.projects[index] = scanned;
    else store.projects.push(scanned);
    await persistStore();
    return scanned;
  });
  registerIpcHandle('projects:save', async (_event, project, options = {}) => {
    const index = store.projects.findIndex((item) => item.id === project.id);
    if (index === -1) throw new Error('找不到需要保存的项目');
    const next = { ...project, updatedAt: now() };
    const previous = store.projects[index];
    const writeKey = normalizedPath(next.projectPath);
    const previousPending = store.pendingProjectWrites?.[writeKey];
    store.projects[index] = next;
    store.pendingProjectWrites = { ...(store.pendingProjectWrites || {}), [writeKey]: next.updatedAt };
    try { await persistStore(); }
    catch (error) {
      store.projects[index] = previous;
      if (previousPending) store.pendingProjectWrites[writeKey] = previousPending;
      else delete store.pendingProjectWrites[writeKey];
      throw error;
    }
    projectSessions.invalidate(next.projectPath);
    projectWrites.enqueue(next);
    if (!options.deferRemote) await projectWrites.flush(next.projectPath);
    return next;
  });
  registerIpcHandle('projects:flush-writes', async (_event, projectPath) => {
    await projectWrites.flush(projectPath);
    await persistStore();
    return true;
  });
  registerIpcHandle('source:import', async (_event, project) => importSource(project));
  registerIpcHandle('source:open-file', async (_event, filePath) => {
    if (!editorExtensions.has(path.extname(filePath).toLowerCase())) throw new Error('阅读器仅打开 TXT、Markdown 与 Word 文件。');
    return { name: path.basename(filePath), content: await readTextDocument(filePath) };
  });
  registerIpcHandle('documents:open', async (_event, { project, kind, filePath }) => openProjectDocument(project, kind, filePath));
  registerIpcHandle('documents:save', async (_event, { project, kind, content, activePath }) => saveProjectDocument(project, kind, content, activePath));
  registerIpcHandle('documents:export-word', async (_event, { project, kind, content, activePath }) => exportDocumentWord(project, kind, content, activePath));
  registerIpcHandle('documents:replace-project-text', async (_event, { project, findText, replaceText, previewOnly, expectedRevision, options }) => replaceProjectTextFiles(project, findText, replaceText, Boolean(previewOnly), expectedRevision, options));
  registerIpcHandle('documents:choose-backup-directory', async () => {
    const result = await dialog.showOpenDialog(activeWorkspaceWindow(), { title: '选择替换备份的存放位置', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  });
  registerIpcHandle('documents:open-backup', async (_event, { project, directory }) => {
    await require('./replacement-backups').readManifest(project, directory);
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return true;
  });
  registerIpcHandle('documents:undo-replacement', async (_event, { project, directory }) => {
    await membershipService.assertCanEdit();
    if (activeGlobalTextSearch) throw new Error('请等待查找替换完成后再撤销。');
    const operation = { phase: 'undo' };
    activeGlobalTextSearch = operation;
    try { return await require('./replacement-backups').restore(project, directory, writeFileAtomically); }
    finally { if (activeGlobalTextSearch === operation) activeGlobalTextSearch = null; }
  });
  registerIpcHandle('documents:cancel-search', () => {
    if (activeGlobalTextSearch?.phase === 'scan') activeGlobalTextSearch.controller.abort();
    return true;
  });
  registerIpcHandle('assets:add', async (_event, { project, category }) => addAsset(project, category));
  registerIpcHandle('assets:refresh', async (_event, project) => scanAssetLibrary(project));
  registerIpcHandle('assets:prompt-library', async (_event, { project, episodeNumber }) => loadAssetPromptLibrary(project, episodeNumber));
  registerIpcHandle('assets:organize-role', async (_event, { project, assetId }) => organizeRoleAsset(project, assetId));
  ipcMain.on('assets:start-drag', (event, filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    if (!assetExtensions.has(path.extname(resolved).toLowerCase()) || !fsSync.existsSync(resolved)) return;
    // Do not use the dragged picture itself as the native drag icon. Some large or
    // uncommon image formats can make Windows' native drag path unstable.
    const icon = path.join(__dirname, 'assets', 'app-icon.png');
    if (!fsSync.existsSync(icon)) return;
    try {
      event.sender.startDrag({ file: resolved, icon });
    } catch (error) {
      console.warn('素材拖拽未启动：', error?.message || error);
    }
  });
  registerIpcHandle('rules:import', async (_event, { project, category }) => importRuleDocuments(project, category));
  registerIpcHandle('rules:save-prompt-template', async (_event, { project, kind, name, content }) => savePromptTemplateFile(project, kind, name, content));
  registerIpcHandle('rules:save-settings', async (_event, project) => saveRuleSettingsFile(project));
  registerIpcHandle('references:import', async (_event, { project, category }) => importReferenceDocuments(project, category));
  registerIpcHandle('script:check-dialogues', async (event, { script, source, options }) => backgroundDocumentChecks.run('script', [script, source, options || {}], event.sender.id));
  registerIpcHandle('storyboard:check', async (event, { content, script, shotlist, options }) => backgroundDocumentChecks.run('storyboard', [content, script, shotlist, options || {}], event.sender.id));
  registerIpcHandle('projects:export', async (_event, { project, type, target }) => exportProject(project, type, target));
  registerIpcHandle('episodes:finalize-output', async (_event, { project, kind }) => finalizeEpisodeOutput(project, kind));
  registerIpcHandle('episodes:discard-revisions', async (_event, { project, kind }) => removeEpisodeArchiveFiles(project, { kind }, { includeOriginal: false, includeLegacy: true }));
  registerIpcHandle('episodes:load-documents', async (_event, { project, episodeNumber }) => loadEpisodeDocuments(project, episodeNumber));
  registerIpcHandle('tasks:prepare', async (_event, { project, kind }) => composeTaskPrompt(project, kind));
  registerIpcHandle('batches:preview', async (_event, { project, kind, episodeNumber, templateOverride }) => composeTaskPrompt(project, kind, { episodeNumber, templateOverride }));
  registerIpcHandle('workflow:prepare', async (_event, { project, payload }) => {
    if (workflowUsesBuiltinTemplate(project, payload)) await membershipService.assertCanUseBuiltinTemplates();
    return prepareEpisodeWorkflow(project, payload);
  });
  registerIpcHandle('workflow:execute', async (_event, { project, payload }) => {
    if (workflowUsesBuiltinTemplate(project, payload)) await membershipService.assertCanUseBuiltinTemplates();
    assertGenerationIdle();
    return keepComputerAwakeWhileWorking(() => executeEpisodeWorkflow(project, payload));
  });
  registerIpcHandle('workflow:choose-template', async (_event, { project, key }) => chooseWorkflowTemplate(project, key));
  registerIpcHandle('chatgpt:open', async (_event, project) => {
    if (chromeRunnerOptions(project).mode === 'chrome') {
      await shell.openExternal('https://chatgpt.com/');
      return true;
    }
    createChatWindow();
    return true;
  });
  registerIpcHandle('chatgpt:send', async (_event, prompt) => sendPromptToChatGpt(prompt));
  registerIpcHandle('chatgpt:capture', captureChatGptReply);
  registerIpcHandle('chatgpt:archive', async (_event, { project, task, content }) => archiveChatGptReply(project, task, content));
  registerIpcHandle('chatgpt:download-latest', async (_event, { project, task }) => {
    const mode = chatGptReplyMode(project, task);
    if (chromeRunnerOptions(project).mode !== 'chrome') {
      if (mode !== 'attachment') {
        const snapshot = await getChatGptReplySnapshot();
        const message = snapshot.ok ? await archiveChatGptMessage(project, task, snapshot.content) : snapshot;
        if (message.ok || mode === 'message') return message;
      }
      const attachment = await downloadLatestChatGptAttachment(project, task);
      return attachment.ok ? { ...attachment, replySource: 'attachment' } : attachment;
    }
    try {
      await selectChromeChatTab(project);
      const snapshot = await withChromeReconnect(project, () => chromeMcpEvaluate(chromeReplySnapshotExpression));
      return captureChromeReplyByMode(project, task, snapshot);
    }
    catch (error) { return { ok: false, reason: error.message || chromeAuthorizationHelp() }; }
  });
  registerIpcHandle('chatgpt:execute', async (_event, { project, task }) => {assertGenerationIdle();return keepComputerAwakeWhileWorking(() => executeChatGptTask(project, task));});
  registerIpcHandle('chrome:status', async (_event, project) => chromeDebugStatus(project));
  registerIpcHandle('chrome:reset', async (_event, project) => {
    stopChromeMcpClient();
    return chromeDebugStatus(project);
  });
  registerIpcHandle('chrome:open-permission', async () => {
    stopChromeMcpClient();
    return openChromePermissionPage();
  });
  registerIpcHandle('ai:providers', () => Object.entries(aiCore.PROVIDERS).map(([id, preset]) => ({
    id, label: preset.label, baseUrl: preset.baseUrl, models: preset.models, modelNotes: preset.modelNotes || {}
  })));
  registerIpcHandle('ai:checks', () => aiCore.VALIDATION_CHECKS.map(({ id, label, scope, severity, desc }) => ({ id, label, scope, severity, desc })));
  registerIpcHandle('ai:config', (_event, project) => aiCore.normalizeRunnerConfig(project));
  registerIpcHandle('ai:save-config', (_event, { project, runner }) => aiCore.normalizeRunnerConfig({ aiRunner: { ...(project.aiRunner || {}), ...(runner || {}) } }));
  registerIpcHandle('ai:test', (_event, { project, runner }) => apiService.test(project, runner));
  registerIpcHandle('ai:batch', async (_event, { project, payload }) => {
    assertGenerationIdle();
    return keepComputerAwakeWhileWorking(() => apiService.runBatch(project, payload));
  });
  registerIpcHandle('ai:cancel', () => apiService.cancel());
  registerIpcHandle('ai:batch-state', (_event, { project, kind }) => apiService.batchState(project, kind));
  registerIpcHandle('ai:clear-batch-state', (_event, { project, kind }) => apiService.clearBatchState(project, kind));
  registerIpcHandle('ai:preview-messages', (_event, { project, kind, episodeNumber, templateOverride, strict }) =>
    apiService.preview(project, kind, episodeNumber, templateOverride, strict !== false));
  registerIpcHandle('ai:validate', (_event, { kind, content, checks }) =>
    aiCore.validateStructure(kind, String(content || ''), { checks }));
}

async function createMainWindow() {
  if (!workspaceWindows) workspaceWindows = require('./workspace-windows').createWorkspaceWindows({
    BrowserWindow, screen, dialog, smokeMode,
    beforeClose: async () => { await projectWrites.flush(); await persistStore(); },
    isBusy: () => Boolean(activeAiWork || apiService.isBusy() || automationService.isBusy() || qualityService.isBusy() || directorService.isBusy() || assistantService.isBusy()),
    isWindowBusy: win => Boolean(windowTaskCounts.get(win.webContents.id)),
    cancelWork: () => { apiService.cancel(); automationService.cancel(); qualityService.cancel(); directorService.cancel(); assistantService.cancel(); },
    onClosed: (win, senderId) => {
      workspaceSync.release(senderId);
      if (mainWindow === win) mainWindow = workspaceWindows.live()[0]?.win;
    }
  });
  mainWindow = await workspaceWindows.create();
}

app.on('will-quit', () => {
  projectSessions.clear();
  episodeFileIndex.clear(); episodeDocumentCache.clear(); backgroundDocumentChecks.close();
  automationService.cancel(); qualityService.cancel(); directorService.cancel(); assistantService.cancel();
  chromeMcpClient?.close();
  stopAiWakeBlocker();
  try {
    const tempRoot = path.resolve(app.getPath('temp'));
    const templateRoot = path.resolve(tempRoot, 'director-theater-templates');
    if (path.dirname(templateRoot) === tempRoot) fsSync.rmSync(templateRoot, { recursive: true, force: true });
  } catch {}
});

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  if (process.platform === 'win32') app.setAppUserModelId('com.director.theater');
  void runtimeSupport.start();
  await membershipService.init();
  await initStore();
  if (uploadSmokeMode) {
    await runEmbeddedUploadSmokeCheck();
    app.quit();
    return;
  }
  if (smokeMode && process.env.AI_DIRECTOR_SMOKE_ROOT) {
    const scanned = await adoptProjectFolder(process.env.AI_DIRECTOR_SMOKE_ROOT);
    if (!scanned.source.files?.length || !scanned.folders?.script || !scanned.folders?.seedance) {
      throw new Error('Project-folder scan did not discover the expected 00–05 structure.');
    }
    await runProjectSmokeChecks(scanned);
    if (process.env.AI_DIRECTOR_FORMAT_SMOKE === '1') await runDocumentFormatSmokeChecks(scanned);
  }
  installIpc();
  await createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
}).catch((error) => {
  console.error(`Application startup failed: ${error?.stack || error?.message || String(error)}`);
  app.exit(1);
});

module.exports = { replaceProjectTextFiles, normalizeWorkflowTemplates, makeFolderMap, missingProjectFolders };

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

