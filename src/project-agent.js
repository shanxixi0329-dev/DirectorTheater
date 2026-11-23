'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const aiCore = require('./ai-core');
const episodeSlots = require('./episode-slots');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.docx']);

const MATERIAL_FOLDERS = [
  ['source', '00 小说原文'],
  ['outline', '02 大纲'],
  ['script', '03 剧本'],
  ['shotlist', '04 分镜'],
  ['storyboard', '05 seedance提示词']
];

const tools = [
  {
    type: 'function',
    function: {
      name: 'list_project_directory',
      description: '列出当前项目内某个目录的直接内容。只能查看，不能修改。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根目录的路径；项目根目录使用空字符串。' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_episode_materials',
      description: '查找当前集及相邻集的原文、大纲、剧本、分镜和提示词候选文件，并标出已选文件与疑似备份稿。',
      parameters: {
        type: 'object',
        properties: {
          episode: { type: 'number', description: '要查找的集数。不填则使用当前任务集。' },
          include_neighbors: { type: 'boolean', description: '是否同时查找前后相邻集，默认 true。' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: '读取当前项目内的 TXT、Markdown 或 Word 文本。必须使用相对路径；不能读取程序状态目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'find_episode_materials 或目录列表返回的相对路径。' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_project_memory',
      description: '读取项目记忆，包括项目内导演台记忆文件和已保存的人物、连续性记忆。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_configured_document',
      description: '读取用户在导演台中启用的要求或参照文件。先用 document_id 选择，不可读取其他外部文件。',
      parameters: {
        type: 'object',
        properties: {
          document_id: { type: 'string', description: '可选值会在工具结果或错误信息中列出。' }
        },
        required: ['document_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish_reading',
      description: '确认完成必要资料核对并结束读取阶段。资料已经足够生成唯一成品时立即调用；调用后程序会关闭读取工具并进入最终生成。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '用简短文字概括已经确认的事实边界、连续性和必须遵守的要求，不要在这里写成品。' }
        },
        required: ['summary']
      }
    }
  }
];

function relativeLabel(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, '/')
    : path.basename(filePath);
}

function backupLike(name) {
  return /(备份|backup|副本|copy|旧稿|旧版|历史|history|archive|归档|~|\.bak(?:\.|$))/i.test(String(name || ''));
}

function selectedPathFor(project, episodeNumber, kind) {
  const episode = episodeSlots.episodeByKey(project, episodeNumber);
  return episode?.activeFiles?.[kind]
    || (Number(project.currentEpisode) === Number(episodeNumber) ? project.activeFiles?.[kind] : '')
    || '';
}

function createReadOnlyProjectAgent({ project, episodeNumber, kind, readTextDocument, signal: agentSignal }) {
  if (!project?.projectPath) throw new Error('智能读取缺少项目目录。');
  if (typeof readTextDocument !== 'function') throw new Error('智能读取缺少文档读取器。');
  const root = path.resolve(project.projectPath);
  const state = { calls: 0, totalChars: 0 };
  const completedCalls = new Map();
  const textFilesByDirectory = new Map();
  const preparedFiles = new Map();
  let activePreparationSignal = agentSignal;
  function assertActive(signal = activePreparationSignal) {
    if (signal?.aborted) throw new aiCore.ApiError('本次任务已取消。');
  }

  function countCall() {
    state.calls += 1;
  }

  function safeProjectPath(relativePath = '') {
    const raw = String(relativePath || '').trim().replace(/^[.][\\/]/, '');
    if (path.isAbsolute(raw)) throw new Error('请使用项目内相对路径。');
    const resolved = path.resolve(root, raw || '.');
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('不能读取项目目录以外的文件。');
    const first = relative.split(path.sep)[0].toLowerCase();
    if (first === '.ai-director') throw new Error('程序状态目录不可读取。');
    return resolved;
  }

  function consumeText(text) {
    const value = String(text || '');
    state.totalChars += value.length;
    return value;
  }

  async function readAllowedFile(filePath, label) {
    assertActive();
    const extension = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) throw new Error('只能读取 TXT、Markdown 和 Word 文本。');
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('目标不是文件。');
    const text = consumeText(await readTextDocument(filePath));
    assertActive();
    return { content: `【只读文件：${label}】\n${text}`, meta: { path: label, chars: text.length } };
  }

  async function listDirectory(args) {
    const directory = safeProjectPath(args.path || '');
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error('目标不是目录。');
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name.toLowerCase() !== '.ai-director')
      .map((entry) => `${entry.isDirectory() ? '[目录]' : '[文件]'} ${relativeLabel(root, path.join(directory, entry.name))}`);
    const label = relativeLabel(root, directory) || '项目根目录';
    return { content: `【${label}】\n${entries.join('\n') || '（空目录）'}`, meta: { path: label, entries: entries.length } };
  }

  async function collectTextFiles(directory) {
    assertActive();
    if (textFilesByDirectory.has(directory)) return textFilesByDirectory.get(directory);
    const found = [];
    async function visit(current) {
      assertActive();
      let entries = [];
      try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
      assertActive();
      for (const entry of entries) {
        assertActive();
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push({ name: entry.name, path: fullPath });
      }
    }
    await visit(directory);
    textFilesByDirectory.set(directory, found);
    return found;
  }

  async function episodeMatches(number) {
    const base = episodeSlots.baseNumber(number);
    const output = {};
    for (const [materialKind, folder] of MATERIAL_FOLDERS) {
      const directory = path.join(root, folder);
      const selected = selectedPathFor(project, number, materialKind);
      const allFiles = (await collectTextFiles(directory))
        .map((file) => ({ ...file, match: aiCore.checkEpisodeFileName(file.name, base) }));
      let matchedFiles = allFiles
        .filter((file) => file.match.ok && episodeSlots.matchingPart(project, number, file.name, materialKind === 'source'));
      if (materialKind === 'outline') {
        const shared = allFiles.filter((file) => !matchedFiles.some((matched) => matched.path === file.path))
          .filter((file) => (selected && path.resolve(selected).toLowerCase() === path.resolve(file.path).toLowerCase()) || allFiles.length === 1)
          .map((file) => ({ ...file, shared: true }));
        matchedFiles = [...matchedFiles, ...shared];
      }
      const files = matchedFiles
        .map((file) => ({
          name: file.name,
          path: relativeLabel(root, file.path),
          selected: Boolean(selected) && path.resolve(selected).toLowerCase() === path.resolve(file.path).toLowerCase(),
          possibleBackup: backupLike(file.name),
          part: file.match.part || '',
          sharedOutline: Boolean(file.shared)
        }));
      output[materialKind] = files;
    }
    return output;
  }

  async function findEpisodeMaterials(args) {
    const requested = Number(args.episode ?? episodeNumber);
    const current = (project.episodes || []).find((item) => Number(item.number) === requested)?.number ?? requested;
    const all = (project.episodes || []).map((item) => Number(item.number));
    const index = all.findIndex((number) => number === Number(current));
    const numbers = args.include_neighbors === false || index < 0
      ? [Number(current)]
      : [all[index - 1], all[index], all[index + 1]].filter((value) => Number.isFinite(value));
    const result = {};
    for (const number of numbers) result[`第${episodeSlots.label(project, number)}集`] = await episodeMatches(number);
    return {
      content: JSON.stringify({ task: kind, currentEpisode: episodeSlots.label(project, current), materials: result }, null, 2),
      meta: { episodes: numbers.map((number) => episodeSlots.label(project, number)) }
    };
  }

  function configuredDocuments() {
    const result = new Map();
    const rules = (project.ruleDocuments || []).filter((doc) => doc.enabled !== false);
    const references = (project.referenceDocuments || []).filter((doc) => doc.enabled !== false);
    const put = (id, doc, label) => { if (doc?.path) result.set(id, { ...doc, label }); };
    put('script_rule', rules.filter((doc) => doc.category === 'script').at(-1), '剧本要求文件');
    put('storyboard_rule', rules.filter((doc) => doc.category === 'storyboard').at(-1), '分镜要求文件');
    put('prompt_rule', rules.filter((doc) => doc.category === 'shared').at(-1), '提示词要求文件');
    put('outline_reference', references.filter((doc) => doc.category === 'script').at(-1), '兼容大纲参照文件');
    return result;
  }

  async function readConfigured(args) {
    const documents = configuredDocuments();
    const id = String(args.document_id || '');
    const doc = documents.get(id);
    if (!doc) throw new Error(`不可用的文档编号。当前可用：${[...documents.keys()].join('、') || '无'}。`);
    const label = `${doc.label}：${doc.name || path.basename(doc.path)}`;
    return readAllowedFile(path.resolve(doc.path), label);
  }

  async function readMemory() {
    const parts = [];
    const paths = [];
    const saved = project.memory || {};
    for (const [label, value] of [['项目记忆', saved.project], ['人物记忆', saved.characters], ['连续性记忆', saved.continuity]]) {
      if (String(value || '').trim()) parts.push(`【${label}】\n${String(value).trim()}`);
    }
    const memoryRoot = path.join(root, '07 AI规则与记忆');
    for (const file of await collectTextFiles(memoryRoot)) {
      if (file.name !== '导演台-项目记忆.txt') continue;
      const label = relativeLabel(root, file.path);
      const text = consumeText(await readTextDocument(file.path));
      if (text.trim()) parts.push(`【${label}】\n${text}`);
      paths.push(label);
    }
    return { content: parts.join('\n\n') || '（项目记忆为空）', meta: { paths, chars: parts.join('\n\n').length } };
  }

  async function prepareContext({ alreadyReadFiles = [], onEvent = () => {}, signal = agentSignal } = {}) {
    activePreparationSignal = signal;
    assertActive(signal);
    const filesRead = [];
    const missing = [];
    const warnings = [];
    const sections = [];
    let chars = 0;
    const keyOf = (file) => path.resolve(file).toLowerCase();
    const announce = (payload) => onEvent({ ...payload, episodeNumber });
    const remember = (file, label, content, reused = false) => {
      const key = keyOf(file);
      if (preparedFiles.has(key)) return;
      const display = relativeLabel(root, file);
      preparedFiles.set(key, { file, label, content, provided: reused });
      filesRead.push(display);
      chars += String(content || '').length;
      if (!reused) state.totalChars += String(content || '').length;
    };
    async function read(file, label) {
      assertActive(signal);
      const key = keyOf(file);
      if (preparedFiles.has(key)) return preparedFiles.get(key).content || '';
      const display = relativeLabel(root, file);
      announce({ type: 'tool-start', name: 'read_project_file', args: { path: display }, stage: 'preparing', label });
      try {
        const content = String(await readTextDocument(file) || '');
        assertActive(signal);
        remember(file, label, content);
        announce({ type: 'tool-done', name: 'read_project_file', args: { path: display }, path: display,
          chars: content.length, stage: 'preparing', label });
        return content;
      } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push(`${label}读取失败：${error.message || String(error)}`);
        announce({ type: 'tool-done', name: 'read_project_file', args: { path: display }, path: display,
          failed: true, reason: error.message || String(error), stage: 'preparing', label });
        return '';
      }
    }
    // 固定输入已经由 API 预览或旧入口实际读取并加入消息，只记入覆盖清单，避免重复发送。
    for (const item of alreadyReadFiles) {
      assertActive(signal);
      if (!item?.path || preparedFiles.has(keyOf(item.path))) continue;
      const display = relativeLabel(root, item.path);
      announce({ type: 'tool-start', name: 'read_project_file', args: { path: display }, stage: 'preparing', reused: true, label: item.label });
      remember(item.path, item.label || '已读固定输入', item.content || '', true);
      const suppliedChars = Number(item.chars) || String(item.content || '').length;
      if (!item.content) chars += suppliedChars;
      announce({ type: 'tool-done', name: 'read_project_file', args: { path: display }, path: display,
        chars: suppliedChars, stage: 'preparing', reused: true, label: item.label });
    }

    const materialLabels = { source: '小说原文', outline: '大纲', script: '剧本', shotlist: '分镜', storyboard: '提示词' };
    async function choose(number, materialKind, matches, label) {
      const candidates = (matches[materialKind] || []).filter((file) => !file.possibleBackup);
      const selected = (matches[materialKind] || []).filter((file) => file.selected);
      // 已选文件优先，包括用户明确选定的旧稿；没有选定则不得混用多个正文不同的候选。
      const list = selected.length ? selected : candidates;
      if (!list.length) return null;
      const groups = new Map();
      for (const candidate of list) {
        const part = candidate.part || '';
        if (!groups.has(part)) groups.set(part, []);
        groups.get(part).push(candidate);
      }
      const chosen = [];
      for (const [part, group] of groups) {
        if (group.length === 1) chosen.push(group[0]);
        else {
          const bodies = [];
          for (const file of group) bodies.push({ file, content: await read(safeProjectPath(file.path), `${label}候选核对`) });
          if (bodies.some((item) => !item.content.trim()) || new Set(bodies.map((item) => item.content.replace(/\s+/g, ''))).size !== 1) {
            for (const item of bodies) {
              const record = preparedFiles.get(keyOf(safeProjectPath(item.file.path)));
              if (record) record.excluded = true;
            }
            warnings.push(`${label}有正文不同或不可读取的候选（${group.map((file) => file.name).join('、')}），未自行选稿，请在编辑页选定当前文件。`);
            return null;
          }
          const preferred = String(project.documentFormats?.[materialKind] || '').toLowerCase();
          chosen.push([...group].sort((a, b) =>
            Number(path.extname(b.name).slice(1).toLowerCase() === preferred) - Number(path.extname(a.name).slice(1).toLowerCase() === preferred)
            || Number(!/\.txt$/i.test(a.name)) - Number(!/\.txt$/i.test(b.name))
            || a.name.localeCompare(b.name, 'zh-CN'))[0]);
        }
      }
      if (chosen.some((file) => !file.part) && chosen.some((file) => file.part)) {
        warnings.push(`${label}同时存在整集和分段稿，未自行混用，请在编辑页选定当前文件。`);
        return null;
      }
      const order = { '': 0, 上: 1, 中: 2, 下: 3 };
      return chosen.sort((a, b) => order[a.part || ''] - order[b.part || '']);
    }
    async function material(number, materialKind, matches, label, required = false) {
      const chosen = await choose(number, materialKind, matches, label);
      if (!chosen?.length) { if (required) missing.push(label); return ''; }
      const bodies = [];
      for (const file of chosen) {
        const actual = safeProjectPath(file.path);
        if (preparedFiles.get(keyOf(actual))?.provided) continue;
        const content = await read(actual, label);
        if (content.trim()) {
          bodies.push(`【${file.name}】\n${content}`);
          preparedFiles.get(keyOf(actual)).provided = true;
        }
      }
      return bodies.join('\n\n');
    }

    const current = Number(episodeNumber);
    const currentMatches = await episodeMatches(current);
    assertActive(signal);
    const mainKind = kind === 'script' ? 'source' : kind === 'storyboard'
      && !episodeSlots.episodeByKey(project, current)?.shotlistSkipped ? 'shotlist' : 'script';
    const alreadyHasMaterial = (materialKind) => (currentMatches[materialKind] || [])
      .some((file) => preparedFiles.has(keyOf(safeProjectPath(file.path))));
    const currentInput = alreadyHasMaterial(mainKind) ? '' : await material(current, mainKind, currentMatches,
      `第${episodeSlots.label(project, current)}集${materialLabels[mainKind]}`, true);
    if (currentInput) sections.push(`【本集事实材料：只以本集内容生产，不把相邻集事件编入本集】\n${currentInput}`);
    if (kind === 'script') {
      const outline = alreadyHasMaterial('outline') ? '' : await material(current, 'outline', currentMatches, '本集大纲');
      if (outline) sections.push(`【本集大纲：作为本集范围和结构参照，不能越过本集小说原文事实】\n${outline}`);
    } else if (mainKind === 'shotlist') {
      const script = await material(current, 'script', currentMatches, '本集剧本');
      if (script) sections.push(`【本集剧本：核对本集镜头事实和对白】\n${script}`);
    }
    const all = [...new Set((project.episodes || []).map((item) => Number(item.number)).filter(Number.isFinite))].sort((a, b) => a - b);
    const index = all.findIndex((number) => number === current);
    const neighbors = index < 0 ? [] : [all[index - 1], all[index + 1]].filter(Number.isFinite);
    for (const neighbor of neighbors) {
      assertActive(signal);
      const matches = await episodeMatches(neighbor);
      const label = `第${episodeSlots.label(project, neighbor)}集连续性参照`;
      let found = false;
      for (const materialKind of ['script', 'outline', 'source']) {
        if (!(matches[materialKind] || []).length) continue;
        const body = await material(neighbor, materialKind, matches, `${label}${materialLabels[materialKind]}`);
        if (body) {
          sections.push(`【相邻集参考：第${episodeSlots.label(project, neighbor)}集${materialLabels[materialKind]}；仅核对人物、时间、地点和衔接，不提前、不补写本集事件或对白】\n${body}`);
          found = true;
        }
        // 候选存在但有歧义时也不改用其他材料绕过用户选稿。
        break;
      }
      if (!found) missing.push(`${label}（暂无已确定当前稿）`);
    }

    announce({ type: 'tool-start', name: 'read_project_memory', args: {}, stage: 'preparing' });
    const memoryParts = [];
    for (const [label, value] of [['项目记忆', project.memory?.project], ['人物记忆', project.memory?.characters], ['连续性记忆', project.memory?.continuity]]) {
      if (String(value || '').trim()) {
        memoryParts.push(`【${label}】\n${String(value).trim()}`);
        chars += String(value).trim().length;
      }
    }
    const memoryPaths = [];
    for (const file of await collectTextFiles(path.join(root, '07 AI规则与记忆'))) {
      assertActive(signal);
      if (file.name !== '导演台-项目记忆.txt') continue;
      const content = await read(file.path, '项目记忆文件');
      if (content.trim()) memoryParts.push(`【${relativeLabel(root, file.path)}】\n${content}`);
      if (preparedFiles.has(keyOf(file.path))) memoryPaths.push(relativeLabel(root, file.path));
    }
    const memory = { content: memoryParts.join('\n\n'), meta: { paths: memoryPaths, chars: memoryParts.join('\n\n').length } };
    if (memory.content.trim()) {
      sections.push(`【项目、人物和连续性记忆：仅作核对，若与本集原文或用户当前稿冲突则指出，不能改写事实】\n${memory.content}`);
    } else missing.push('项目、人物和连续性记忆（尚未填写）');
    announce({ type: 'tool-done', name: 'read_project_memory', args: {}, ...memory.meta, stage: 'preparing' });
    completedCalls.set('read_project_memory:{}', { label: '项目、人物和连续性记忆', meta: memory.meta });

    const relatedCategories = kind === 'script' ? ['script', 'shared'] : ['storyboard', 'shared'];
    for (const doc of (project.referenceDocuments || []).filter((item) => item.enabled !== false
      && item.path && relatedCategories.includes(item.category))) {
      assertActive(signal);
      if (preparedFiles.get(keyOf(doc.path))?.provided) continue;
      const content = await read(path.resolve(doc.path), `已启用参照文件：${doc.name || path.basename(doc.path)}`);
      if (content.trim()) {
        sections.push(`【用户明确启用的相关参照：${doc.name || path.basename(doc.path)}；服从本集事实和本轮要求】\n${content}`);
        preparedFiles.get(keyOf(doc.path)).provided = true;
      }
    }
    for (const value of preparedFiles.values()) {
      if (!value.provided) continue;
      const display = relativeLabel(root, value.file);
      const args = { path: display };
      completedCalls.set(`read_project_file:${JSON.stringify(args)}`, { label: display, meta: { path: display, chars: String(value.content || '').length } });
    }
    const result = { content: sections.join('\n\n'), filesRead: [...new Set(filesRead)], missing, warnings, chars };
    assertActive(signal);
    announce({ type: 'context-ready', ...result, content: undefined });
    return result;
  }

  async function executeTool({ name, args = {} }) {
    countCall();
    if (name === 'finish_reading') {
      const summary = String(args.summary || '').trim();
      return {
        content: `资料读取阶段结束。已确认内容：${summary || '以已经读取的资料为准。'}`,
        meta: { finishReading: true, summary }
      };
    }
    const cacheKey = `${name}:${JSON.stringify(args, Object.keys(args || {}).sort())}`;
    if (completedCalls.has(cacheKey)) {
      const previous = completedCalls.get(cacheKey);
      return {
        content: `【已读取过，不再重复】${previous.label || name}。请使用此前结果；若资料已经足够，请立即调用 finish_reading。`,
        meta: { ...(previous.meta || {}), duplicate: true, cached: true }
      };
    }
    let result;
    if (name === 'list_project_directory') result = await listDirectory(args);
    else if (name === 'find_episode_materials') result = await findEpisodeMaterials(args);
    if (name === 'read_project_file') {
      const filePath = safeProjectPath(args.path);
      const prepared = preparedFiles.get(path.resolve(filePath).toLowerCase());
      result = prepared?.excluded
        ? { content: `这个文件属于正文不同的候选，尚未由用户选定：${relativeLabel(root, filePath)}。不可自行混用，请提示用户选定当前稿。`, meta: { path: relativeLabel(root, filePath), failed: true, ambiguous: true } }
        : prepared?.provided
        ? { content: `【已实际读取并提供，不再重复】${relativeLabel(root, filePath)}。请使用已提供正文。`,
          meta: { path: relativeLabel(root, filePath), duplicate: true, cached: true } }
        : await readAllowedFile(filePath, relativeLabel(root, filePath));
    }
    else if (name === 'read_project_memory') result = await readMemory();
    else if (name === 'read_configured_document') result = await readConfigured(args);
    else if (!result) throw new Error(`未知只读工具：${name}`);
    completedCalls.set(cacheKey, {
      label: result?.meta?.path || result?.meta?.paths?.join('、') || name,
      meta: result?.meta || {}
    });
    return result;
  }

  return { tools, executeTool, prepareContext, state };
}

module.exports = { createReadOnlyProjectAgent, tools };
