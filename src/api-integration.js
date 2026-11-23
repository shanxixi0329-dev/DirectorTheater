'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const aiCore = require('./ai-core');
const episodeSlots = require('./episode-slots');
const { createReadOnlyProjectAgent } = require('./project-agent');
const { builtinTemplateById } = require('./template-library');
const { runPairPipeline } = require('./pair-pipeline');

const INPUT_FOLDER = { script: '00 小说原文', shotlist: '03 剧本', pair: '03 剧本', storyboard: '04 分镜' };
const OUTPUT_FOLDER = { script: '03 剧本', shotlist: '04 分镜', storyboard: '05 seedance提示词' };
const PART_ORDER = { '': 0, 上: 1, 中: 2, 下: 3 };
const EXTENSION_ORDER = { '.txt': 0, '.md': 1, '.markdown': 2, '.docx': 3 };

function comparableText(content) {
  return String(content || '').replace(/\s+/g, '');
}

function selectedEpisodeFile(project, episodeNumber, inputKind, candidates) {
  const episode = project.episodes?.find((item) => Number(item.number) === episodeNumber);
  const paths = [episode?.activeFiles?.[inputKind]];
  if (Number(project.currentEpisode) === episodeNumber) paths.push(project.activeFiles?.[inputKind]);
  for (const selected of paths.filter(Boolean)) {
    const exact = candidates.find((file) => path.resolve(file.path).toLowerCase() === path.resolve(selected).toLowerCase());
    if (exact) return exact;
    const name = path.basename(selected).toLowerCase();
    const sameName = candidates.filter((file) => file.name.toLowerCase() === name);
    if (sameName.length === 1) return sameName[0];
  }
  return null;
}

function chooseEquivalentFile(project, episodeNumber, inputKind, folder, candidates) {
  if (candidates.length === 1) return candidates[0];
  const selected = selectedEpisodeFile(project, episodeNumber, inputKind, candidates);
  if (selected) return selected;
  const uniqueBodies = new Set(candidates.map((file) => comparableText(file.content)));
  if (uniqueBodies.size !== 1) {
    throw new Error(`第 ${episodeSlots.label(project, episodeNumber)} 集在「${folder}」有正文不同的候选文件：${candidates.map((file) => file.name).join('、')}。请在「编辑与检查」中选定本集${inputKind === 'script' ? '剧本' : '输入'}文件；程序不会自行删除旧稿。`);
  }
  const format = String(project.documentFormats?.[inputKind] || '').toLowerCase();
  const wantedExtension = format ? `.${format}` : '';
  return [...candidates].sort((a, b) =>
    Number(path.extname(b.name).toLowerCase() === wantedExtension) - Number(path.extname(a.name).toLowerCase() === wantedExtension)
    || (EXTENSION_ORDER[path.extname(a.name).toLowerCase()] ?? 99) - (EXTENSION_ORDER[path.extname(b.name).toLowerCase()] ?? 99)
    || a.name.localeCompare(b.name, 'zh-CN'))[0];
}

function createApiService({ readTextDocument, archiveReply, onEvent, assertBuiltinTemplates = async () => {} }) {
  let controller = null;

  function configOf(project, override = {}) {
    const config = aiCore.normalizeRunnerConfig({ aiRunner: { ...(project.aiRunner || {}), ...override } });
    const problems = aiCore.configProblems(config);
    if (problems.length) throw new Error(problems.join(' '));
    return config;
  }

  function enabledDocument(project, collection, category) {
    const items = (project[collection] || []).filter((doc) => doc.enabled !== false && doc.category === category);
    return items.at(-1) || null;
  }

  async function requirementBlock(project, category, label, required = true) {
    let doc = enabledDocument(project, 'ruleDocuments', category);
    if (!doc) {
      const templates = project.workflowTemplates || {};
      doc = category === 'script'
        ? templates.script
        : category === 'storyboard'
          ? templates.shotlist
          : category === 'shared'
            ? (String(templates.promptMode) === '15' ? templates.prompt15 : templates.prompt30)
            : null;
    }
    if (!doc?.path && !doc?.builtin) {
      if (!required) return null;
      throw new Error(`还没有选择“${label}”。请到「API 输入文件」中选择 1 份要求文件。`);
    }
    if (doc.builtin) {
      await assertBuiltinTemplates();
      doc = builtinTemplateById(doc.id);
      if (!doc) throw Error('内置提示词版本不存在，请重新选择。');
    }
    const content = await readTextDocument(doc.path);
    return { name: doc.name, path: doc.path, chars: String(content || '').length,
      text: `【${label}：${doc.name}】\n${content}` };
  }

  async function taskRequirements(project, kind) {
    if (kind === 'script') return [await requirementBlock(project, 'script', '剧本要求文件')];
    if (kind === 'shotlist') return [await requirementBlock(project, 'storyboard', '分镜要求文件')];
    if (kind === 'storyboard') return [await requirementBlock(project, 'shared', '提示词要求文件')];
    if (kind === 'pair') return [
      await requirementBlock(project, 'storyboard', '分镜要求文件'),
      await requirementBlock(project, 'shared', '提示词要求文件')
    ];
    throw new Error(`不支持的 API 任务类型：${kind}`);
  }

  async function outlineBlock(project, episodeNumber) {
    const folder = '02 大纲';
    const directory = path.join(project.projectPath, folder);
    const baseNumber = episodeSlots.baseNumber(episodeNumber);
    const outlineFiles = [];
    async function visitOutlineFolder(current) {
      if (outlineFiles.length >= 1600) return;
      let entries = [];
      try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (outlineFiles.length >= 1600) break;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) await visitOutlineFolder(fullPath);
        else if (/\.(txt|md|markdown|docx)$/i.test(entry.name)) outlineFiles.push({ name: entry.name, path: fullPath });
      }
    }
    await visitOutlineFolder(directory);
    const allFiles = outlineFiles
      .map((file) => ({ ...file, ...aiCore.checkEpisodeFileName(file.name, baseNumber) }));
    const files = allFiles
      .filter((entry) => entry.ok && episodeSlots.matchingPart(project, episodeNumber, entry.name))
      .sort((a, b) => PART_ORDER[a.part || ''] - PART_ORDER[b.part || ''] || a.name.localeCompare(b.name, 'zh-CN'));
    for (const file of files) file.content = await readTextDocument(file.path);
    const nonEmpty = files.filter((file) => String(file.content || '').trim());
    if (nonEmpty.length) {
      const groups = new Map();
      for (const file of nonEmpty) {
        const part = file.part || '';
        if (!groups.has(part)) groups.set(part, []);
        groups.get(part).push(file);
      }
      const chosen = [...groups].map(([part, candidates]) => ({ part,
        file: chooseEquivalentFile(project, episodeNumber, 'outline', folder, candidates) }));
      const full = chosen.find((item) => !item.part)?.file;
      const parts = chosen.filter((item) => item.part).sort((a, b) => PART_ORDER[a.part] - PART_ORDER[b.part]).map((item) => item.file);
      let selectedFiles = full ? [full] : parts;
      if (full && parts.length) {
        const selected = selectedEpisodeFile(project, episodeNumber, 'outline', [full, ...parts]);
        if (selected && parts.includes(selected)) selectedFiles = parts;
        else if (!selected && comparableText(full.content) !== comparableText(parts.map((file) => file.content).join(''))) {
          throw new Error(`第 ${episodeSlots.label(project, episodeNumber)} 集在「${folder}」同时有整集稿和上／中／下分段稿，内容不同。请在「编辑与检查」的大纲页选定本集使用的版本。`);
        }
      }
      return {
        name: selectedFiles.map((file) => file.name).join('、'),
        names: selectedFiles.map((file) => file.name),
        path: selectedFiles[0].path,
        readDocuments: selectedFiles.map((file) => ({ path: file.path, label: '本集大纲', chars: String(file.content || '').length })),
        text: `【本集大纲】\n${selectedFiles.map((file) => `【${file.name}】\n${file.content}`).join('\n\n')}`
      };
    }
    // 大纲也允许使用一份整季总纲。若没有严格的单集文件，只读取用户在大纲页
    // 选中的文件；目录内只有一份时也可直接使用，避免强迫用户拆成几十份。
    const selectedOutline = selectedPathForOutline(project, episodeNumber);
    const shared = allFiles.find((file) => selectedOutline
      && path.resolve(file.path).toLowerCase() === path.resolve(selectedOutline).toLowerCase())
      || (allFiles.length === 1 ? allFiles[0] : null);
    if (shared) {
      const content = await readTextDocument(shared.path);
      if (String(content || '').trim()) return {
        name: shared.name,
        names: [shared.name],
        path: shared.path,
        readDocuments: [{ path: shared.path, label: '本集使用的大纲', chars: String(content || '').length }],
        text: `【本集使用的大纲】\n【${shared.name}】\n${content}`
      };
    }
    // 兼容旧项目：还没有本集大纲文件时，继续使用原来已启用的剧本参照文档。
    const doc = enabledDocument(project, 'referenceDocuments', 'script');
    if (!doc) return null;
    const content = await readTextDocument(doc.path);
    return { name: doc.name, names: [doc.name], path: doc.path,
      readDocuments: [{ path: doc.path, label: '用户启用的大纲参照', chars: String(content || '').length }],
      text: `【大纲参照：${doc.name}】\n${content}` };
  }

  async function episodeInput(project, kind, episodeNumber) {
    const skipped = kind === 'storyboard' && project.episodes?.find((item) => Number(item.number) === episodeNumber)?.shotlistSkipped;
    const folder = skipped ? '03 剧本' : INPUT_FOLDER[kind];
    const inputKind = folder === '03 剧本' ? 'script' : folder === '04 分镜' ? 'shotlist' : 'source';
    const baseNumber = episodeSlots.baseNumber(episodeNumber);
    if (!folder) throw new Error(`不支持的 API 任务类型：${kind}`);
    const directory = path.join(project.projectPath, folder);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { throw new Error(`找不到输入目录：${folder}`); }
    const files = entries.filter((entry) => entry.isFile() && /\.(txt|md|markdown|docx)$/i.test(entry.name))
      .map((entry) => ({ ...aiCore.checkEpisodeFileName(entry.name, baseNumber), name: entry.name, path: path.join(directory, entry.name) }))
      .filter((entry) => entry.ok && episodeSlots.matchingPart(project, episodeNumber, entry.name, inputKind === 'source'))
      .sort((a, b) => PART_ORDER[a.part || ''] - PART_ORDER[b.part || ''] || a.name.localeCompare(b.name, 'zh-CN'));
    if (!files.length) throw new Error(`第 ${episodeSlots.label(project, episodeNumber)} 集在「${folder}」没有严格匹配的输入文件。请先保存本分段文件；下集可使用“${baseNumber}集下.txt”命名。`);
    for (const file of files) file.content = await readTextDocument(file.path);
    const groups = new Map();
    for (const file of files) {
      const part = file.part || '';
      if (!groups.has(part)) groups.set(part, []);
      groups.get(part).push(file);
    }
    const chosen = [...groups].map(([part, candidates]) => ({ part,
      file: chooseEquivalentFile(project, episodeNumber, inputKind, folder, candidates.filter((file) => String(file.content).trim())) }));
    if (chosen.some((item) => !item.file)) throw new Error(`第 ${episodeSlots.label(project, episodeNumber)} 集在「${folder}」的输入文件为空。`);
    const full = chosen.find((item) => !item.part)?.file;
    const parts = chosen.filter((item) => item.part).sort((a, b) => PART_ORDER[a.part] - PART_ORDER[b.part]).map((item) => item.file);
    let selectedFiles = full ? [full] : parts;
    if (full && parts.length) {
      const selected = selectedEpisodeFile(project, episodeNumber, inputKind, [full, ...parts]);
      if (selected && parts.includes(selected)) selectedFiles = parts;
      else if (!selected && comparableText(full.content) !== comparableText(parts.map((file) => file.content).join(''))) {
        throw new Error(`第 ${episodeSlots.label(project, episodeNumber)} 集在「${folder}」同时有整集稿和上／中／下分段稿，内容不同。请在「编辑与检查」中选定本集使用的版本。`);
      }
    }
    const selectedNames = new Set(selectedFiles.map((file) => file.name));
    return {
      folder,
      names: selectedFiles.map((file) => file.name),
      ignoredNames: files.filter((file) => !selectedNames.has(file.name)).map((file) => file.name),
      readDocuments: selectedFiles.map((file) => ({ path: file.path,
        label: `本集${inputKind === 'source' ? '小说原文' : inputKind === 'shotlist' ? '分镜' : '剧本'}`, chars: String(file.content || '').length })),
      content: selectedFiles.map((file) => `【${file.name}】\n${file.content}`).join('\n\n')
    };
  }

  function selectedPathForOutline(project, episodeNumber) {
    const episode = project.episodes?.find((item) => Number(item.number) === Number(episodeNumber));
    return episode?.activeFiles?.outline
      || (Number(project.currentEpisode) === Number(episodeNumber) ? project.activeFiles?.outline : '')
      || project.activeFiles?.outline
      || '';
  }

  async function preview(project, kind, episodeNumber, _templateOverride = '', strict = true) {
    const number = Number(episodeNumber || project.currentEpisode);
    const requirements = await taskRequirements(project, kind);
    let outline = null;
    if (kind === 'script') {
      outline = await outlineBlock(project, number);
    }
    const system = requirements.map((item) => item.text).filter(Boolean).join('\n\n');
    let input;
    try { input = await episodeInput(project, kind, number); }
    catch (error) { if (strict) throw error; input = { folder: INPUT_FOLDER[kind], names: [], content: `（${error.message}）` }; }
    const user = [`【项目】${project.title}`, `【当前集数】第${episodeSlots.label(project, number)}集`,
      outline?.text,
      `【本集${kind === 'script' ? '小说原文' : kind === 'storyboard' ? '分镜' : '剧本'}】\n${input.content}`,
      ].filter(Boolean).join('\n\n');
    return { system, user, full: `${system}\n\n${user}`, template: '',
      inputNames: input.names, ignoredInputNames: input.ignoredNames || [],
      ruleNames: requirements.map((item) => item.name), referenceNames: outline?.names || [],
      requirements: requirements.map((item) => ({ name: item.name, path: item.path })),
      readDocuments: [
        ...requirements.map((item) => ({ path: item.path, label: '已选要求文件', chars: item.chars })),
        ...(input.readDocuments || []), ...(outline?.readDocuments || [])
      ],
      outline: outline ? { name: outline.name, path: outline.path } : null };
  }

  async function test(project, override = {}) {
    const started = Date.now();
    try {
      const config = configOf(project, override);
      const result = await aiCore.chatCompletion({ ...config, maxTokens: 256, maxAttempts: 1, timeoutMs: Math.min(config.timeoutMs, 60000) },
        [{ role: 'user', content: '只回复两个字：连通' }]);
      return { ok: true, provider: config.provider, model: config.model,
        responseModel: result.responseModel || config.model,
        modelLabel: aiCore.modelDisplayName(result.responseModel || config.model),
        ms: Date.now() - started, reply: result.content.slice(0, 60) };
    } catch (error) { return { ok: false, ms: Date.now() - started, reason: error.message || String(error) }; }
  }

  async function completeWithContext(project, { kind, episodeNumber, config, messages,
    alreadyReadFiles = [], signal, onDelta = () => {}, onEvent: completionEvent = () => {} }) {
    const agent = createReadOnlyProjectAgent({ project, episodeNumber, kind, readTextDocument, signal });
    const context = await agent.prepareContext({ alreadyReadFiles, onEvent: completionEvent, signal });
    if (signal?.aborted) throw new aiCore.ApiError('本次任务已取消。');
    const preparedMessages = messages.map((message) => ({ ...message }));
    const lastUser = preparedMessages.findLast((message) => message.role === 'user');
    const boundary = `【只读核对资料范围】\n当前只生产第${episodeSlots.label(project, episodeNumber)}集。本集固定输入是事实边界；相邻集只核对人物、时间、地点和衔接，不把相邻集事件或对白写进本集。程序已实际读取：${context.filesRead.join('、') || '暂无文件'}。`;
    const contextText = [boundary, context.content,
      context.missing.length ? `【暂无资料】${context.missing.join('；')}。不要编造缺失材料。` : '',
      context.warnings.length ? `【读取提示】${context.warnings.join('；')}` : ''].filter(Boolean).join('\n\n');
    if (lastUser) lastUser.content = `${lastUser.content || ''}\n\n${contextText}`;
    else preparedMessages.push({ role: 'user', content: contextText });
    const readingInstruction = `【只读智能核对】
程序已按本集范围实际读取必要输入、可确定的前后集当前稿、项目记忆和用户启用的相关参照。先充分理解这些已提供资料；不要为了重复读取而重发同一文件。
如有明确且尚未读取的相关文件，可用只读工具继续核对。已标出歧义的候选不得自行混用，用户选择的要求文件保持原样。本集小说原文或剧本是事实边界，相邻集只能用作连续性参考。
资料足够后调用 finish_reading 结束读取；随后仍需充分思考、生成唯一成品并检查内容和逻辑，不要反复重做完整正文。`;
    const system = preparedMessages.find((message) => message.role === 'system');
    if (system) system.content = `${system.content || ''}\n\n${readingInstruction}`;
    else preparedMessages.unshift({ role: 'system', content: readingInstruction });
    let result;
    try {
      result = await aiCore.runToolAgent({
        config, messages: preparedMessages, tools: agent.tools, executeTool: agent.executeTool,
        finishToolName: 'finish_reading',
        finalInstruction: `资料读取已经结束。关闭读取工具，根据原始用户要求和已经读取的材料完成本集任务：
1. 充分思考本集内容、逻辑和前后衔接，在内部确定唯一方案，只生成一份最终成品。
2. 本集固定输入是事实边界；相邻集只用作连续性参考，不提前或补写其他集内容。严格保留用户选用的要求文件和手输要求。
3. 生成后检验内容和逻辑；若发现明确错误，只修正错误位置，不重复已完成全文。完成后立即结束。
4. 最终回复只包含本轮所需的成品正文，不输出候选稿、核对记录、修改说明或第二版成品。
5. 成品完整结束后，最后单独输出标记 <<<AIGC_FINAL_DONE>>>。该标记只供程序确认完成，不属于成品。`,
        stopMarker: '<<<AIGC_FINAL_DONE>>>', signal, onDelta, onEvent: completionEvent
      });
    } catch (error) {
      const reason = error?.message || String(error);
      const toolUnsupported = config.provider !== 'deepseek'
        && /(?:tools?|tool_calls?|function[ _-]?call|不支持.{0,8}(?:工具|函数)|未知.{0,8}(?:tools?|函数))/i.test(reason);
      if (!toolUnsupported || signal?.aborted) throw error;
      completionEvent({ type: 'smart-read-fallback', reason, contextPrepared: true,
        filesRead: context.filesRead, missing: context.missing, warnings: context.warnings });
      // 工具调用不兼容也必须保留已经实际读取的关联资料，不能退回只有本集固定输入。
      const fallbackMessages = preparedMessages.map((message) => ({ ...message }));
      const fallbackUser = fallbackMessages.findLast((message) => message.role === 'user');
      fallbackUser.content += '\n\n【读取已完成，直接生成】本接口不支持工具调用，但程序已经实际读取并提供上述关联材料。现在根据原始用户要求充分思考，完成本集唯一成品并检验内容和逻辑，最后直接输出成品正文。不要输出读取摘要，不要请求工具，也不要补写相邻集事件。';
      result = await aiCore.chatCompletion(config, fallbackMessages, {
        signal, onDelta, onEvent: completionEvent, stopMarker: '<<<AIGC_FINAL_DONE>>>'
      });
      result.agent = { enabled: true, prepared: true, staged: false, toolUnsupported: true, filesRead: context.filesRead, toolCalls: 0 };
    }
    result.agent = { ...(result.agent || {}), prepared: true, preparedChars: context.chars,
      filesRead: [...new Set([...context.filesRead, ...(result.agent?.filesRead || [])])],
      missing: context.missing, warnings: context.warnings };
    return result;
  }

  async function executePrompt(project, prompt, files = [], kind = '') {
    if (controller) throw new Error('已有 API 任务在运行。');
    const config = configOf(project);
    const attachments = [];
    const alreadyReadFiles = [];
    for (const file of files) {
      const content = await readTextDocument(file);
      attachments.push(`【附件：${path.basename(file)}】\n${content}`);
      alreadyReadFiles.push({ path: file, label: '本轮用户附件', chars: String(content || '').length });
    }
    if (controller) throw new Error('已有 API 任务在运行。');
    controller = new AbortController();
    try {
      const messages = [
        { role: 'system', content: String(prompt || '') },
        { role: 'user', content: attachments.join('\n\n') || '请按系统消息完成本次任务。' }
      ];
      const smartReadEnabled = config.smartRead !== false && ['script', 'shotlist', 'storyboard', 'pair'].includes(kind);
      const result = smartReadEnabled
        ? await completeWithContext(project, { kind, episodeNumber: Number(project.currentEpisode), config, messages, alreadyReadFiles,
          signal: controller.signal, onEvent: (event) => onEvent({ ...event, kind, episodeNumber: Number(project.currentEpisode) }) })
        : await aiCore.chatCompletion(config, messages, { signal: controller.signal });
      let content = aiCore.normalizeReply(result.content);
      if (kind) {
        const verdict = aiCore.validateStructure(kind, content, {
          checks: project.validationChecks,
          groupMaxSeconds: String(project.workflowTemplates?.promptMode) === '15' ? 15 : 30
        });
        if (!verdict.ok) throw new Error(`输出未通过结构校验，没有写入文件：${verdict.problems.join(' ')}`);
        content = verdict.normalizedContent ?? content;
      }
      return content;
    } finally { controller = null; }
  }

  async function archive(project, kind, episodeNumber, content) {
    const target = { ...project, currentEpisode: episodeNumber };
    const kinds = kind === 'pair' ? ['shotlist', 'storyboard'] : [kind];
    const backupRoot = path.join(project.projectPath, '.ai-director', 'api-backups',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-EP${episodeNumber}-${kind}`);
    const originals = [];
    for (const outputKind of kinds) {
      const folder = OUTPUT_FOLDER[outputKind];
      if (!folder) throw new Error(`不支持的输出类型：${outputKind}`);
      const directory = path.join(project.projectPath, folder);
      let entries = [];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isFile() || !aiCore.checkEpisodeFileName(entry.name, episodeSlots.baseNumber(episodeNumber)).ok ||
            !episodeSlots.matchingPart(project, episodeNumber, entry.name)) continue;
        const original = path.join(directory, entry.name);
        const backup = path.join(backupRoot, folder, entry.name);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(original, backup);
        originals.push({ original, backup });
      }
    }
    try {
      if (kind !== 'pair') {
        // Match the established workflow contract: a shotlist is the
        // intermediate planning document and stays in its selected format;
        // only script/storyboard TXT outputs get the optional synced Word copy.
        const result = await archiveReply(target, {
          kind,
          episodeNumber,
          syncDocx: kind !== 'shotlist'
        }, content);
        return result;
      }
      const split = aiCore.splitBundle(content);
      if (!split.ok) throw new Error(split.reason);
      const shotlist = await archiveReply(target, { kind: 'shotlist', episodeNumber, syncDocx: false }, split.shotlist);
      const storyboard = await archiveReply(target, { kind: 'storyboard', episodeNumber }, split.storyboard);
      return { outputPath: shotlist.outputPath, outputPathSecond: storyboard.outputPath, outputPaths: [shotlist.outputPath, storyboard.outputPath] };
    } catch (error) {
      const protectedPaths = new Set(originals.map((item) => item.original));
      for (const outputKind of kinds) {
        const directory = path.join(project.projectPath, OUTPUT_FOLDER[outputKind]);
        let entries = [];
        try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch {}
        for (const entry of entries) {
          const outputPath = path.join(directory, entry.name);
          if (entry.isFile() && aiCore.checkEpisodeFileName(entry.name, episodeSlots.baseNumber(episodeNumber)).ok &&
              episodeSlots.matchingPart(project, episodeNumber, entry.name) && !protectedPaths.has(outputPath)) {
            await fs.rm(outputPath, { force: true });
          }
        }
      }
      for (const item of originals) await fs.copyFile(item.backup, item.original);
      throw error;
    }
  }

  async function runBatch(project, payload = {}) {
    if (controller) throw new Error('已有 API 批量任务在运行。');
    const kind = ['script', 'shotlist', 'storyboard', 'pair'].includes(payload.kind) ? payload.kind : 'script';
    const requestedMaxTokens = Number(payload.maxTokens);
    const config = configOf(project, Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
      ? { maxTokens: requestedMaxTokens } : {});
    config.conversationCap = Math.max(1, Math.min(50, Number(payload.conversationCap) || config.conversationCap));
    const start = Math.min(Number(payload.start), Number(payload.end));
    const end = Math.max(Number(payload.start), Number(payload.end));
    const episodes = (project.episodes || []).map((episode) => Number(episode.number)).filter((number) => number >= start && number <= end).sort((a, b) => a - b);
    if (!episodes.length) throw new Error('选定范围内没有可处理的集。');
    const smartReadEnabled = config.smartRead !== false;
    const previewByEpisode = new Map();
    // 保留用户已选要求文件；缺失或无会员权限时不发请求、不清已有断点。
    await taskRequirements(project, kind);
    if (controller) throw new Error('已有 API 批量任务在运行。');
    const checkpointPath = path.join(project.projectPath, '.ai-director', `api-batch-${kind}.json`);
    controller = new AbortController();
    const emit = (event) => { apiBatchEvents.push(event); if (apiBatchEvents.length > 600) apiBatchEvents.shift(); onEvent(event); };
    apiBatchEvents.length = 0;
    try {
      if (payload.fresh) await fs.rm(checkpointPath, { force: true });
      emit({ type: 'batch-start', kind, episodes, model: config.model,
        maxTokens: config.maxTokens, conversationCap: config.conversationCap, smartReadEnabled });
      if (kind === 'pair') {
        const result = await runPairPipeline({ project, episodes, config, signal: controller.signal,
          fresh: payload.fresh, range: { start, end }, checkpointPath, emit,
          readTextDocument,
          options: { checks: project.validationChecks, groupMaxSeconds: String(project.workflowTemplates?.promptMode) === '15' ? 15 : 30 },
          buildStage: async (episodeNumber, stage, shotlist) => {
            const script = await episodeInput(project, 'shotlist', episodeNumber);
            const requirements = await taskRequirements(project, stage);
            const manual = String(payload.manualInstruction || '').trim();
            const boundary = stage === 'shotlist'
              ? '【单独生成：分镜】\n当前只完成剧本到分镜这一步。按分镜要求输出一份完整分镜表，不同时输出视频提示词。用户合并要求中属于提示词的要求交由下一步骤处理。充分思考和自检后只交付一份成品，完成后输出 <<<AIGC_FINAL_DONE>>> 并结束。'
              : '【单独生成：提示词】\n当前只完成分镜到提示词这一步。只使用下面本轮已完成并保存的分镜表逐镜生成提示词，覆盖全部镜头，保持镜号对应。剧本用于核对台词和事实，不重新创作分镜，不重复分镜表。充分思考和自检后只交付一份完整提示词，完成后输出 <<<AIGC_FINAL_DONE>>> 并结束。';
            const system = `${requirements.map(item => item.text).join('\n\n')}\n\n${boundary}`;
            const user = [`【项目】${project.title}`, `【当前集数】第${episodeSlots.label(project, episodeNumber)}集`,
              `【本集剧本】\n${script.content}`,
              stage === 'storyboard' ? `【本轮已经完成并保存的分镜表】\n${shotlist.content}` : '',
              manual ? `【本轮人工要求】\n${manual}` : '', boundary].filter(Boolean).join('\n\n');
            const target = { ...project, currentEpisode: episodeNumber,
              activeFiles: { ...project.activeFiles, ...(shotlist ? { shotlist: shotlist.outputPath } : {}) },
              episodes: (project.episodes || []).map(item => Number(item.number) === episodeNumber && shotlist
                ? { ...item, activeFiles: { ...item.activeFiles, shotlist: shotlist.outputPath } } : item) };
            return { system, user, project: target,
              readDocuments: [...(script.readDocuments || []),
                ...requirements.map(item => ({ path: item.path, label: '本步骤要求文件', chars: item.chars })),
                ...(shotlist ? [{
                  path: shotlist.outputPath,
                  label: '本轮已完成分镜',
                  // The storyboard step receives the saved shotlist in its user
                  // message. Keep the same body in the smart-read manifest too:
                  // prepareContext treats alreadyReadFiles as supplied material
                  // and otherwise marks a path as provided with an empty body,
                  // which can make a tool-capable provider think the shotlist
                  // was read while its context is actually blank.
                  chars: shotlist.content.length,
                  content: shotlist.content
                }] : [])] };
          },
          complete: ({ stage, episodeNumber, messages, input, signal, onDelta, onEvent: completionEvent }) => smartReadEnabled
            ? completeWithContext(input.project, { kind: stage, episodeNumber, config, messages,
              alreadyReadFiles: input.readDocuments, signal, onDelta, onEvent: completionEvent })
            : aiCore.chatCompletion(config, messages, { signal, onDelta, onEvent: completionEvent, stopMarker: '<<<AIGC_FINAL_DONE>>>' }),
          archive: (stage, episodeNumber, content) => archive(project, stage, episodeNumber, content)
        });
        emit({ type: 'batch-end', kind, ...result });
        return { ...result, kind, model: config.model, conversationCap: config.conversationCap };
      }
      const result = await aiCore.runBatch({
        episodes, kind, config, signal: controller.signal,
        groupOptions: { checks: project.validationChecks, groupMaxSeconds: String(project.workflowTemplates?.promptMode) === '15' ? 15 : 30 },
        buildSystem: async () => (await preview(project, kind, episodes[0], payload.template, false)).system,
        buildUser: async (episodeNumber) => {
          const parts = await preview(project, kind, episodeNumber, payload.template, true);
          previewByEpisode.set(episodeNumber, parts);
          const manual = String(payload.manualInstruction || '').trim();
          return { text: `${parts.user}${manual ? `\n\n【本轮人工要求】\n${manual}` : ''}` };
        },
        prepareContent: async (content, meta) => aiCore.stampGenerationModel(
          content, meta.result?.responseModel || config.model, kind),
        complete: smartReadEnabled ? async ({ config: turnConfig, messages, episodeNumber, signal, onDelta, onEvent: completionEvent }) =>
          completeWithContext(project, { kind, episodeNumber, config: turnConfig, messages,
            alreadyReadFiles: previewByEpisode.get(episodeNumber)?.readDocuments || [],
            signal, onDelta, onEvent: completionEvent }) : null,
        save: async (episodeNumber, content) => {
          const result = await archive(project, kind, episodeNumber, content);
          emit({ type: 'saved', kind, episodeNumber, outputPath: result.outputPath });
        },
        checkpoint: {
          load: async () => { try { return JSON.parse(await fs.readFile(checkpointPath, 'utf8')); } catch { return null; } },
          save: async (state) => {
            await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
            const temp = `${checkpointPath}.${process.pid}.tmp`;
            await fs.writeFile(temp, JSON.stringify({ ...state, range: { start, end }, at: new Date().toISOString() }, null, 2), 'utf8');
            await fs.rename(temp, checkpointPath);
          }
        },
        onEvent: (event) => emit({ ...event, kind })
      });
      emit({ type: 'batch-end', kind, ...result });
      return { ...result, kind, model: config.model, conversationCap: config.conversationCap };
    } finally { controller = null; }
  }

  const apiBatchEvents = [];
  return {
    preview, test, executePrompt, runBatch,
    configOf,
    isBusy: () => Boolean(controller),
    cancel: () => {
      if (!controller) return { ok: false, reason: '当前没有运行中的 API 批量任务。' };
      if (!controller.signal.aborted) controller.abort();
      return { ok: true, stopping: true };
    },
    events: () => apiBatchEvents,
    batchState: async (project, kind) => {
      try { return JSON.parse(await fs.readFile(path.join(project.projectPath, '.ai-director', `api-batch-${kind}.json`), 'utf8')); }
      catch { return null; }
    },
    clearBatchState: async (project, kind) => {
      await fs.rm(path.join(project.projectPath, '.ai-director', `api-batch-${kind}.json`), { force: true });
      return { ok: true };
    }
  };
}

module.exports = { createApiService };
