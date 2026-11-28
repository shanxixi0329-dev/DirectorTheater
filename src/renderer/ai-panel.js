'use strict';

/* ==================================================================
 * 导演台剧场 · AI 直连面板（V0.0.2）
 *
 * 这个文件独立承载三件事，尽量不改动原有 app.js：
 *   1. 「AI 直连」设置页：服务商 / 地址 / 模型 / Key / 参数 / 每对话集数 / 连通测试
 *   2. API 批量任务弹窗：范围、轮换节奏、模板、实时进度、停止、断点
 *   3. 批量入口分流：API 模式走这里，网页模式仍走旧弹窗
 * ================================================================== */

const AI_PROVIDER_FALLBACK = [
  { id: 'magpie', label: 'Magpie 本机网关（直连 Codex / 路由组）', baseUrl: 'http://127.0.0.1:3425/v1', models: ['group/smart-split', 'codex/gpt-6.2-sol', 'codex/gpt-6.2-astra', 'auto/deepseek-v4.1-flash'], localGateway: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.2', 'gpt-5.1', 'gpt-4.1', 'gpt-4o'] },
  { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview', 'moonshot-v1-128k'] },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4-plus'] },
  { id: 'dashscope', label: '阿里云百炼（通义）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-max', 'qwen-plus'] },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.2-Exp'] },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', models: [] }
];

const AI_BATCH_KIND_LABEL = { script: '剧本', pair: '分镜 → 提示词', shotlist: '分镜', storyboard: 'Seedance 提示词' };
const AI_BATCH_KIND_OUTPUT = { script: '03 剧本', pair: '04 分镜、05 seedance提示词', shotlist: '04 分镜', storyboard: '05 seedance提示词' };

let aiProviders = AI_PROVIDER_FALLBACK;
let aiProvidersLoaded = false;
let aiValidationChecks = [
  { id: 'balancedMarkers', label: '标记闭合', scope: 'all', severity: 'error', desc: '检查 ** 、【】、``` 是否成对。流式输出被掐断时最典型的特征。' },
  { id: 'tailComplete', label: '结尾完整性', scope: 'all', severity: 'error', desc: '结尾不能停在断句符号上，也不能整段没有句末标点。' },
  { id: 'sceneHeaders', label: '剧本场景题头', scope: 'script', severity: 'warn', desc: '至少要有「场号 场景名 [内/外] [时段]」形式的题头。' },
  { id: 'dialogueLines', label: '剧本台词行', scope: 'script', severity: 'error', desc: '至少要有可识别的台词行。' },
  { id: 'tableHeader', label: '分镜表 12 列', scope: 'shotlist', severity: 'error', desc: '逐行核对列数；某行列数不对视为表格被截断。' },
  { id: 'shotNumbering', label: '分镜镜号连续', scope: 'shotlist', severity: 'warn', desc: '镜号应从 1 起连续递增。' },
  { id: 'groupHeaders', label: '提示词分组标题', scope: 'storyboard', severity: 'error', desc: '识别「第X组（镜头A-B，总时长XX秒）」。' },
  { id: 'groupShotRange', label: '分组镜头范围', scope: 'storyboard', severity: 'error', desc: '写出的镜头不能少于组标题声明的数量。' },
  { id: 'groupDuration', label: '分组时长自洽', scope: 'storyboard', severity: 'warn', desc: '组内镜头秒数合计要与组标题的总时长一致。' },
  { id: 'styleBlock', label: '统一风格段', scope: 'storyboard', severity: 'warn', desc: '整集通常只出现一次【统一风格与约束】。' }
];
let aiUnregisterBatchEvents = null;

function aiDefaultChecks() {
  return aiValidationChecks.reduce((acc, item) => { acc[item.id] = true; return acc; }, {});
}

function aiChecksOf(project) {
  const stored = project?.validationChecks;
  return { ...aiDefaultChecks(), ...(stored && typeof stored === 'object' ? stored : {}) };
}

function aiReadCheckInputs() {
  const values = aiDefaultChecks();
  for (const item of aiValidationChecks) {
    const box = document.querySelector(`input[data-ai-check="${item.id}"]`);
    if (box) values[item.id] = box.checked;
  }
  return values;
}

async function aiSaveChecks(forced) {
  const values = forced || aiReadCheckInputs();
  state.project.validationChecks = values;
  markDirty();
  await saveProject({ preserveViewport: true });
  const off = Object.values(values).filter((value) => value === false).length;
  showToast(off ? `校验开关已保存，关闭了 ${off} 项` : '校验开关已保存：全部开启');
}

function aiRunnerOf(project) {
  const raw = project?.aiRunner || {};
  return {
    provider: aiProviders.some((item) => item.id === raw.provider) ? raw.provider : 'deepseek',
    baseUrl: String(raw.baseUrl || ''),
    model: String(raw.model || ''),
    apiKey: String(raw.apiKey || ''),
    temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.7,
    maxTokens: Number(raw.maxTokens) || 65536,
    timeoutMs: Number(raw.timeoutMs) || 180000,
    maxAttempts: Number(raw.maxAttempts) || 3,
    conversationCap: Number(raw.conversationCap) || 3,
    maxContextChars: Number(raw.maxContextChars) || 900000,
    smartRead: raw.smartRead !== false
  };
}

async function aiEnsureProviders() {
  if (aiProvidersLoaded) return aiProviders;
  try {
    const list = await window.directorApi.aiProviders();
    if (Array.isArray(list) && list.length) aiProviders = list;
    const checks = await window.directorApi.aiChecks?.();
    if (Array.isArray(checks) && checks.length) aiValidationChecks = checks;
  } catch { /* 拿不到就用内置兜底 */ }
  aiProvidersLoaded = true;
  return aiProviders;
}

function aiPresetOf(providerId) {
  return aiProviders.find((item) => item.id === providerId) || AI_PROVIDER_FALLBACK[0];
}

function aiModelLabel(model) {
  if (model === 'deepseek-flash') return 'V4.1 Flash';
  if (model === 'deepseek-v4-pro') return 'V4 Pro';
  return model;
}

function aiChosenDocument(collection, category) {
  return (state.project?.[collection] || []).filter((doc) => doc.enabled !== false && doc.category === category).at(-1) || null;
}

/* ------------------------------------------------------------------ *
 * 「AI 直连」设置页
 * ------------------------------------------------------------------ */

function renderAiPanel(embedded = false) {
  const runner = state.aiConfigDraft || aiRunnerOf(state.project);
  const preset = aiPresetOf(runner.provider);
  const modelOptions = preset.models.map((name) => `<option value="${escapeHTML(name)}" ${runner.model === name ? 'selected' : ''}>${escapeHTML(aiModelLabel(name))}</option>`).join('');
  const modelControl = preset.models.length
    ? `<select id="ai-model">${modelOptions}${runner.model && !preset.models.includes(runner.model) ? `<option value="${escapeHTML(runner.model)}" selected>${escapeHTML(runner.model)}</option>` : ''}</select>`
    : `<input id="ai-model" value="${escapeHTML(runner.model || '')}" placeholder="填写服务商的模型 ID" />`;
  const testResult = state.aiTestResult
    ? `<div class="notice ${state.aiTestResult.ok ? '' : 'danger-note'}" style="margin-top:12px">${state.aiTestResult.ok
      ? `连通成功：接口实际返回 <strong>${escapeHTML(state.aiTestResult.modelLabel || aiModelLabel(state.aiTestResult.responseModel || state.aiTestResult.model || ''))}</strong> · ${state.aiTestResult.ms} ms`
      : `连通失败：${escapeHTML(state.aiTestResult.reason || '')}`}</div>`
    : '';
  const templates = normalizeWorkflowTemplates(state.project?.workflowTemplates);
  const builtinAllowed = membershipCanUseBuiltinTemplates();
  const usable = (doc) => doc?.builtin && !builtinAllowed ? null : doc;
  const scriptRule = aiChosenDocument('ruleDocuments', 'script') || usable(templates.script);
  const shotRule = aiChosenDocument('ruleDocuments', 'storyboard') || usable(templates.shotlist);
  const promptRule = aiChosenDocument('ruleDocuments', 'shared') || usable(templates.promptMode === '15' ? templates.prompt15 : templates.prompt30);
  const outlineName = state.project?.activeFiles?.outline?.split(/[\\/]/).at(-1)
    || (state.project?.outline?.content?.trim() ? `第${directorEpisodeSlots.label(state.project, state.project.currentEpisode)}集大纲（未保存）` : '本集尚未填写');
  const fileRow = (label, doc, action, category, optional = false) => `<div class="api-input-file"><div><strong>${label}</strong><span>${doc ? escapeHTML(doc.name) : optional ? '未选择（可不选）' : '尚未选择'}</span></div><div class="form-actions"><button class="button quiet small" data-action="${action}" ${category ? `data-rule-category="${category}"` : ''}>${doc ? '更换' : '选择'}</button>${optional && doc ? '<button class="button quiet small" data-action="ai-clear-outline">清除</button>' : ''}</div></div>`;

  return `<div class="api-panel ${embedded ? 'embedded' : ''}">
    ${embedded ? '' : '<div class="page-head"><div><div class="eyebrow">LLM API · DIRECT</div><h1>API 生成</h1><p>选择服务商和模型，再按下面两套固定输入生成。</p></div></div>'}
    <article class="card">
      <div class="card-title"><h2>接口配置</h2><span class="badge">实际模型会写入成品</span></div>
      <div class="grid two">
        <div class="field"><label>服务商</label><select id="ai-provider">${aiProviders.map((item) => `<option value="${item.id}" ${runner.provider === item.id ? 'selected' : ''}>${escapeHTML(item.label)}</option>`).join('')}</select></div>
        <div class="field"><label>模型</label>${modelControl}<p class="hint">DeepSeek 模型请求开启高强度思考（high），自定义兼容接口也适用；是否返回可见思考以执行记录为准。Flash 与 Pro 使用不同模型 ID，按接口返回值核对。</p></div>
        <div class="field wide"><label>API 地址</label><input id="ai-base-url" value="${escapeHTML(runner.baseUrl || preset.baseUrl)}" placeholder="${escapeHTML(preset.baseUrl)}" /></div>
        <div class="field wide"><label>API Key${preset.localGateway ? '（本机 Magpie 网关可留空）' : ''}</label><div class="ui-password-wrap"><input id="ai-api-key" type="password" value="${escapeHTML(runner.apiKey)}" placeholder="${preset.localGateway ? '本机网关无需 API Key，留空即可' : 'sk-...'}" autocomplete="off" />${window.DirectorUIMotion?.passwordEyeButtonHtml?.() || ''}</div></div>
        <div class="field wide"><label>每个对话处理几集</label><input id="ai-cap" type="number" min="1" max="50" step="1" value="${runner.conversationCap}" /><p class="hint">填 1：每生成一集都开启新对话；填 2、3、5 等：处理相应集数后再换新对话。可填写 1–50。</p></div>
      </div>
      <input id="ai-temperature" type="hidden" value="${runner.temperature}" />
      <input id="ai-max-tokens" type="hidden" value="${runner.maxTokens}" />
      <input id="ai-timeout" type="hidden" value="${Math.round(runner.timeoutMs / 1000)}" />
      <input id="ai-max-attempts" type="hidden" value="${runner.maxAttempts}" />
      <input id="ai-max-context" type="hidden" value="${runner.maxContextChars}" />
      <label class="api-smart-read"><input id="ai-smart-read" type="checkbox" ${runner.smartRead !== false ? 'checked' : ''} /> <strong>逐集智能读取</strong>：剧本、分镜、提示词及合并任务，单集和批量都逐集核对资料。本集原文或剧本是事实依据，前后集用于连续性，项目记忆和配置仅作参照；保留你选择的要求文件和手输要求。接口不支持读取工具时，使用已准备的关联资料继续生成。</label>
      ${testResult}
      <div class="form-actions" style="margin-top:14px"><button class="button" data-action="ai-save-config">保存配置</button><button class="button secondary" data-action="ai-test">测试连接</button></div>
    </article>
    <article class="card" style="margin-top:16px">
      <div class="card-title"><h2>API 输入文件</h2><span class="badge">实际读取资料可在执行记录查看</span></div>
      <div class="api-input-workflows">
        <section><h3>剧本生成</h3><p class="hint">1 份要求文件＋本集大纲＋本集小说原文＋你在生成窗口手输的要求。</p>${fileRow('剧本要求文件', scriptRule, 'ai-replace-rule', 'script')}<div class="api-input-file"><div><strong>本集大纲</strong><span>${escapeHTML(outlineName)}</span></div><button class="button quiet small" data-view="outline">查看与编辑</button></div></section>
        <section><h3>分镜＋提示词</h3><p class="hint">逐集分两步：先用分镜要求生成并保存分镜，再用提示词要求和本轮分镜生成提示词。</p>${fileRow('分镜要求文件', shotRule, 'ai-replace-rule', 'storyboard')}${fileRow('提示词要求文件', promptRule, 'ai-replace-rule', 'shared')}</section>
      </div>
    </article>
  </div>`;
}
function aiReadConfigInputs() {
  const provider = document.querySelector('#ai-provider')?.value || 'deepseek';
  const preset = aiPresetOf(provider);
  return {
    provider,
    baseUrl: document.querySelector('#ai-base-url')?.value?.trim() || preset.baseUrl,
    model: document.querySelector('#ai-model')?.value?.trim() || preset.models[0] || '',
    apiKey: document.querySelector('#ai-api-key')?.value?.trim() || '',
    temperature: Number(document.querySelector('#ai-temperature')?.value),
    maxTokens: Number(document.querySelector('#ai-max-tokens')?.value),
    timeoutMs: Number(document.querySelector('#ai-timeout')?.value) * 1000,
    maxAttempts: Number(document.querySelector('#ai-max-attempts')?.value),
    conversationCap: Number(document.querySelector('#ai-cap')?.value),
    maxContextChars: Number(document.querySelector('#ai-max-context')?.value),
    smartRead: document.querySelector('#ai-smart-read')?.checked !== false
  };
}

function aiProviderChanged() {
  const next = document.querySelector('#ai-provider')?.value || 'deepseek';
  const previous = state.aiConfigDraft?.provider || state.project.aiRunner?.provider || 'deepseek';
  state.aiConfigDrafts = state.aiConfigDrafts || {};
  state.aiConfigDrafts[previous] = { ...aiReadConfigInputs(), provider: previous };
  const preset = aiPresetOf(next);
  state.aiConfigDraft = state.aiConfigDrafts[next]
    || state.project.aiProfiles?.[next]
    || { ...aiRunnerOf(state.project), provider: next, baseUrl: preset.baseUrl, model: preset.models[0] || '', apiKey: '' };
  state.aiTestResult = null;
  render();
}

async function aiSaveConfig() {
  const runner = aiReadConfigInputs();
  const saved = await window.directorApi.aiSaveConfig(state.project, runner);
  state.project.aiRunner = saved;
  state.project.aiProfiles = { ...(state.project.aiProfiles || {}), [saved.provider]: saved };
  state.aiConfigDraft = null;
  markDirty();
  await saveProject({ preserveViewport: true });
  showToast(`配置已保存：${aiPresetOf(saved.provider).label} · ${aiModelLabel(saved.model)}`);
}

async function aiTestConnection() {
  const runner = aiReadConfigInputs();
  state.aiConfigDraft = runner;
  state.aiTestResult = null;
  state.workLocked = true;
  state.workLabel = '正在测试 API 连通性…';
  render();
  try {
    state.aiTestResult = await window.directorApi.aiTest(state.project, runner);
  } catch (error) {
    state.aiTestResult = { ok: false, reason: error?.message || String(error) };
  } finally {
    state.workLocked = false;
    state.workLabel = '';
    render();
  }
}

/* ------------------------------------------------------------------ *
 * API 批量任务
 * ------------------------------------------------------------------ */

function aiEpisodeRange(project) {
  const numbers = (project.episodes || []).map((item) => Number(item.number)).filter(Number.isFinite);
  if (!numbers.length) return [];
  return numbers.sort((a, b) => a - b);
}

function aiEpisodeLabel(number) {
  return window.episodeSlots.label(state.project, number);
}

function aiBatchOutputBudget(kind, runner) {
  return kind === 'pair' && runner.provider === 'deepseek'
    ? Math.max(32768, runner.maxTokens) : runner.maxTokens;
}

async function aiOpenBatch(kind, currentOnly = false) {
  const numbers = aiEpisodeRange(state.project);
  if (!numbers.length) return showToast('当前项目还没有任何集。');
  const runner = aiRunnerOf(state.project);
  state.apiBatch = {
    kind,
    start: currentOnly ? Number(state.project.currentEpisode) : numbers[0],
    end: currentOnly ? Number(state.project.currentEpisode) : numbers.at(-1),
    previewEpisode: Number(state.project.currentEpisode) || numbers[0],
    template: '',
    manualInstruction: '',
    conversationCap: runner.conversationCap,
    maxTokens: aiBatchOutputBudget(kind, runner),
    status: 'review',
    log: [],
    completed: [],
    rotations: 0,
    failure: null,
    preview: '',
    currentOnly
  };
  state.apiBatchMinimized = false;
  if (!currentOnly) {
    try {
      const saved = await window.directorApi.aiBatchState(state.project, kind);
      const completed = Array.isArray(saved?.completed)
        ? saved.completed.map(Number).filter((number) => numbers.includes(number)) : [];
      if (saved?.kind === kind && (completed.length || Object.keys(saved.stages || {}).length)) {
        const draft = state.apiBatch;
        draft.fresh = false;
        draft.checkpointCompleted = completed;
        draft.completed = completed;
        if (Number.isFinite(Number(saved.range?.start)) && Number.isFinite(Number(saved.range?.end))) {
          draft.start = Number(saved.range.start);
          draft.end = Number(saved.range.end);
        } else {
          const next = numbers.find((number) => number > Math.max(...completed));
          draft.start = next || Math.max(...completed);
          draft.end = draft.start;
        }
        draft.previewEpisode = numbers.find((number) => number >= draft.start && number <= draft.end && !completed.includes(number)) || draft.start;
      }
    } catch { /* 断点读取失败时仍可新建任务 */ }
  }
  await aiRefreshPreview();
}

async function aiRefreshPreview() {
  const draft = state.apiBatch;
  if (!draft) return;
  const runner = aiRunnerOf(state.project);
  draft.start = Number(document.querySelector('#api-batch-start')?.value) || draft.start;
  draft.end = Number(document.querySelector('#api-batch-end')?.value) || draft.end;
  draft.previewEpisode = Number(document.querySelector('#api-batch-preview')?.value) || draft.previewEpisode;
  draft.manualInstruction = document.querySelector('#api-batch-manual')?.value ?? draft.manualInstruction;

  const numbers = aiEpisodeRange(state.project).filter((n) => n >= Math.min(draft.start, draft.end) && n <= Math.max(draft.start, draft.end));
  if (!numbers.includes(draft.previewEpisode)) draft.previewEpisode = numbers[0];
  if (!numbers.length) {
    draft.preview = '当前范围内没有可处理的集。';
    return renderApiBatchModal();
  }
  const episodeProject = deepCopy(state.project);
  episodeProject.currentEpisode = draft.previewEpisode;
  try {
    const parts = await window.directorApi.aiPreviewMessages(episodeProject, draft.kind, draft.previewEpisode, draft.template, true);
    const inputLabel = ['pair', 'shotlist'].includes(draft.kind) ? '剧本' : draft.kind === 'storyboard' ? '分镜' : '原文';
    const manifest = [
      `【本集主要输入】${inputLabel}：${parts.inputNames.join('、') || '无'}`,
      `要求文件 ${parts.ruleNames.length} 份：${parts.ruleNames.join('、') || '无'}`,
      draft.kind === 'pair' ? '分两步独立生成：① 剧本＋分镜要求 → 04 分镜；② 本轮分镜＋提示词要求 → 05 seedance提示词。两份都完成才计为一集完成；失败步骤单独续做。' : '',
      draft.kind === 'script' ? `本集大纲：${parts.referenceNames.join('、') || '未填写（本次不会引用大纲）'}` : '',
      runner.smartRead !== false
        ? '逐集智能读取：开启（单集与批量均逐集准备资料；本集事实为依据，前后集作连续性参照，记忆与配置仅作参照；实际读取清单在执行记录查看）'
        : '逐集智能读取：关闭（不调用智能读取工具；实际准备的输入资料在执行记录查看）',
      `对话轮换：${draft.conversationCap === 1 ? '每集都开启新对话' : `每 ${draft.conversationCap} 集开启新对话`}`,
      `你手输的要求：${draft.manualInstruction.trim() || '未填写'}`,
      parts.ignoredInputNames.length ? `同一集未重复发送：${parts.ignoredInputNames.join('、')}` : ''
    ].filter(Boolean).join('\n');
    draft.preview = `${manifest}\n\n${parts.user}${draft.manualInstruction.trim() ? `\n\n【本轮人工要求】\n${draft.manualInstruction.trim()}` : ''}\n\n────────── 要求文件正文 ──────────\n${parts.system}`;
    draft.previewError = '';
  } catch (error) {
    draft.preview = '';
    draft.previewError = error?.message || String(error);
  }
  renderApiBatchModal();
}

function aiBatchFailureDetails(failure) {
  const reason = String(failure?.reason || '').trim();
  const problems = [...new Set((failure?.problems || []).map((problem) => String(problem).trim()).filter(Boolean))];
  const compact = (text) => text.replace(/\s+/g, '');
  const extra = problems.filter((problem) => !compact(reason).includes(compact(problem)));
  return `${reason ? escapeHTML(reason) : ''}${extra.length ? `${reason ? '<br>' : ''}校验问题：${escapeHTML(extra.join('；'))}` : ''}`;
}

function aiFailedDraftAvailable(draft) {
  return Boolean(draft?.failure && String(draft.contentText || '').trim()
    && Number(draft.contentEpisodeNumber ?? draft.currentEpisode) === Number(draft.failure.episodeNumber));
}

function aiEpisodeExecution(draft, episodeNumber) {
  const number = Number(episodeNumber ?? draft.currentEpisode);
  if (!Number.isFinite(number)) return null;
  draft.executionRecords ||= [];
  let record = draft.executionRecords.find((item) => item.episodeNumber === number);
  if (!record) {
    record = { episodeNumber: number, status: 'running', filesRead: [], missing: [], warnings: [], requests: [], toolCalls: 0, thinkingLength: 0, readingLength: 0, contentLength: 0 };
    draft.executionRecords.push(record);
  }
  return record;
}

function aiThinkingRequestLabel(request) {
  if (!request) return '思考请求参数：等待发送';
  return request.enabled
    ? `思考请求参数：${request.effort || '已开启'}（已发送）`
    : '本次请求未设置专用思考参数';
}

function aiContextLabel(record) {
  if (!record?.contextPrepared) return '本集资料：等待实际读取记录';
  return `本集资料：已实际读取 ${record.filesRead.length} 份${record.missing.length ? `；缺少：${record.missing.join('、')}` : ''}。具体清单见事件日志和本次执行记录。`;
}

function aiExecutionRecordText(draft) {
  const lines = ['本次执行记录（只在当前窗口内存保留；重新生成或关闭窗口后不再保留）'];
  const statuses = { running: '处理中', completed: '已保存', rejected: '校验未通过', failed: '生成或保存失败' };
  for (const record of draft.executionRecords || []) {
    lines.push('', `第 ${aiEpisodeLabel(record.episodeNumber)} 集 · ${statuses[record.status] || record.status}`,
      `实际读取 ${record.filesRead.length} 份文件：`, ...(record.filesRead.length ? record.filesRead.map((file) => `  ${file}`) : ['  尚无可核实的文件读取记录']),
      `缺少资料：${record.missing.join('、') || '未报告缺项'}`,
      aiThinkingRequestLabel(record.requests.at(-1)),
      record.thinkingLength > 0 ? `接口返回的可见思考：${record.thinkingLength} 字` : '接口未返回可见思考文本；不代表没有进行思考。',
      `普通读取核对文字：${record.readingLength || 0} 字（不计作接口思考）`,
      `正文：${record.contentLength} 字`);
    for (const warning of record.warnings) lines.push(`提示：${warning}`);
  }
  lines.push('', '────────── 事件日志 ──────────', ...(draft.log || []));
  return lines.join('\n');
}

function aiBindLazyText(selector, inputSelector, value) {
  const details = modalRoot.querySelector(selector);
  details?.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded === 'true') return;
    const box = details.querySelector(inputSelector);
    if (box) box.value = value();
    details.dataset.loaded = 'true';
  });
}

function renderApiBatchModal() {
  const draft = state.apiBatch;
  if (!draft) return closeModal();
  const numbers = aiEpisodeRange(state.project).filter((n) => n >= Math.min(draft.start, draft.end) && n <= Math.max(draft.start, draft.end));
  const runner = aiRunnerOf(state.project);
  const running = draft.status === 'running';
  const label = AI_BATCH_KIND_LABEL[draft.kind] || draft.kind;

  if (running) {
    const tail = draft.log.slice(-40).map((line) => `<div class="ai-batch-log-line">${escapeHTML(line)}</div>`).join('');
    const thinking = draft.thinkingText || '';
    const content = draft.contentText || '';
    const execution = (draft.executionRecords || []).find((item) => item.episodeNumber === Number(draft.currentEpisode));
    const elapsed = draft.startedAt ? Math.round((Date.now() - draft.startedAt) / 1000) : 0;
    const statusRow = numbers.map((number) => {
      const phase = draft.completed.includes(number) ? 'done'
        : (draft.currentEpisode === number ? 'active' : ((draft.failures || []).some(item => item.episodeNumber === number) || draft.failure?.episodeNumber === number ? 'failed' : 'wait'));
      const mark = phase === 'done' ? '✔' : phase === 'active' ? '▶' : phase === 'failed' ? '✘' : '·';
      return `<span class="ai-ep ${phase}">${mark} ${aiEpisodeLabel(number)}</span>`;
    }).join('');
    modalRoot.innerHTML = `<div class="modal-overlay batch-overlay"><div class="modal batch-modal batch-modal-wide">
      <div class="modal-head"><div><div class="eyebrow">AI DIRECT BATCH</div><h2>正在批量生成${label} · 第 ${draft.currentEpisode ? aiEpisodeLabel(draft.currentEpisode) : '—'} 集</h2></div><button class="button secondary small" data-action="ai-batch-minimize">转到后台</button></div>
      <div class="batch-progress"><strong>${draft.completed.length} / ${numbers.length} 集已完成</strong><span>对话 ${draft.currentConversation || 1} · ${draft.conversationCap === 1 ? '每集新对话' : `每 ${draft.conversationCap} 集换对话`} · 已换 ${draft.rotations} 次 · 用时 ${elapsed} 秒</span></div>
      <div class="ai-ep-strip">${statusRow}</div>
      <div class="ai-stream-stats">
        <span class="chip">接口返回思考 <b id="ai-think-chars">${draft.reasoningChars || 0}</b> 字</span>
        <span class="chip">普通读取核对 <b id="ai-reading-text-chars">${draft.readingChars || 0}</b> 字</span>
        <span class="chip">正文 <b id="ai-content-chars">${content.length}</b> 字</span>
        <span class="chip">只读核对 <b id="ai-read-tool-count">${draft.agentToolCalls || 0}</b> 次</span>
        <span class="chip">本集实际读取 <b id="ai-read-file-count">${draft.agentFilesRead?.length || 0}</b> 份</span>
        <span class="chip" id="ai-thinking-request">${escapeHTML(aiThinkingRequestLabel(execution?.requests.at(-1)))}</span>
        <span class="chip">模型 ${escapeHTML(aiModelLabel(runner.model))}</span>
      </div>
      <p class="hint" id="ai-context-status">${escapeHTML(aiContextLabel(execution))}</p>
      <div class="ai-stream-grid">
        <div class="ai-stream-pane">
          <div class="ai-stream-head"><strong>思考与读取核对</strong><span class="hint">两类文字在这里显示；计数分别统计，普通核对文字不计作接口思考</span></div>
          <pre class="ai-stream" id="ai-stream-reasoning" data-placeholder="${thinking ? '0' : '1'}">${escapeHTML(thinking) || '等待思考或读取核对内容；接口未返回可见思考不代表没有进行思考。'}</pre>
        </div>
        <div class="ai-stream-pane">
          <div class="ai-stream-head"><strong>正文</strong><span class="hint">最终会写进文件的内容</span></div>
          <pre class="ai-stream" id="ai-stream-content" data-placeholder="${content ? '0' : '1'}">${escapeHTML(content) || '等待正文…'}</pre>
        </div>
      </div>
      <details class="ai-log-details" open><summary>事件日志</summary><div class="ai-batch-log">${tail}</div></details>
      <div class="form-actions"><button class="button danger" data-action="ai-batch-stop" ${draft.stopRequested ? 'disabled' : ''}>${draft.stopRequested ? '正在立即停止…' : '立即停止批量任务'}</button></div>
    </div></div>`;
    const logBox = modalRoot.querySelector('.ai-batch-log');
    if (logBox) logBox.scrollTop = logBox.scrollHeight;
    const reasonBox = modalRoot.querySelector('#ai-stream-reasoning');
    if (reasonBox) reasonBox.scrollTop = reasonBox.scrollHeight;
    const contentBox = modalRoot.querySelector('#ai-stream-content');
    if (contentBox) contentBox.scrollTop = contentBox.scrollHeight;
    return;
  }

  const failure = draft.failure
    ? `<div class="notice danger-note" style="margin-top:12px"><strong>${draft.kind === 'pair' ? `有 ${(draft.failures || []).length || 1} 集待处理` : `停在第 ${aiEpisodeLabel(draft.failure.episodeNumber)} 集`}</strong><br>${aiBatchFailureDetails(draft.failure)}${draft.kind === 'pair' ? `<br>待处理集：${(draft.failures || [draft.failure]).map(item => aiEpisodeLabel(item.episodeNumber)).join('、')}。已完成步骤保留，点击继续只补未完成步骤。` : ''}</div>`
    : '';
  const previewError = draft.previewError
    ? `<div class="notice danger-note" style="margin-top:12px">${escapeHTML(draft.previewError)}</div>` : '';
  const failedDraft = aiFailedDraftAvailable(draft)
    ? `<details class="ai-log-details" data-ai-failed-draft><summary>查看第 ${aiEpisodeLabel(draft.failure.episodeNumber)} 集未保存的正文（${draft.contentText.length} 字）</summary><p class="hint" id="ai-failed-draft-hint">这是本轮留在内存中的临时内容，可能未完成或未通过校验，尚未写入正式文件。关闭窗口或重新生成后不再保留，复制后请先核对。</p><div class="field"><textarea class="batch-preview" id="ai-failed-draft-content" aria-label="本轮未保存的正文，只读" aria-describedby="ai-failed-draft-hint" readonly spellcheck="false"></textarea></div><div class="form-actions"><button class="button secondary small" data-action="ai-batch-copy-draft">复制未保存的正文</button></div></details>`
    : '';
  const done = draft.status === 'completed'
    ? `<div class="notice" style="margin-top:12px">全部 ${draft.completed.length} 集已完成并写入「${AI_BATCH_KIND_OUTPUT[draft.kind]}」。</div>`
    : '';
  const executionHistory = draft.executionRecords?.length || draft.log?.length
    ? `<details class="ai-log-details" data-ai-execution-record><summary>查看本次执行记录（${draft.executionRecords?.length || 0} 集，含实际读取清单）</summary><p class="hint">每集独立记录已读取文件、缺少资料和实际发送的思考参数，只在本次窗口保留。发送参数不代表服务商已执行思考。</p><div class="field"><textarea class="batch-preview" id="ai-execution-record-content" aria-label="本次执行记录，只读" readonly spellcheck="false"></textarea></div></details>`
    : '';
  const lastThinking = draft.thinkingText
    ? `<details class="ai-log-details" data-ai-last-thinking><summary>查看第 ${aiEpisodeLabel(draft.thinkingEpisodeNumber ?? draft.currentEpisode)} 集思考与读取核对文本（${draft.thinkingText.length} 字）</summary><p class="hint">这里是本轮最后处理集的显示文本：接口思考 ${draft.reasoningChars || 0} 字，普通读取核对 ${draft.readingChars || 0} 字；普通核对不计作思考。其他集的字数和读取清单见执行记录。</p><div class="field"><textarea class="batch-preview" id="ai-last-thinking-content" aria-label="本轮最后集的思考与读取核对文本，只读" readonly spellcheck="false"></textarea></div></details>`
    : (executionHistory ? '<p class="hint">接口未返回可见思考文本，不代表没有进行思考；实际发送的参数可在执行记录查看。</p>' : '');
  const checkpointCompleted = (draft.checkpointCompleted || draft.completed || []).filter((number) => numbers.includes(number));
  const pendingCount = numbers.filter((number) => !checkpointCompleted.includes(number)).length;
  const resumed = draft.fresh === false
    ? `<div class="notice" style="margin-top:12px">已读取断点：原任务完成 ${draft.checkpointCompleted?.length || 0} 集，本次范围内已完成 ${checkpointCompleted.length} 集、剩余 ${pendingCount} 集。可继续未完成部分，也可重新生成当前所选范围；重新生成前会自动备份已有成品。</div>`
    : '';
  modalRoot.innerHTML = `<div class="modal-overlay batch-overlay"><div class="modal batch-modal">
    <div class="modal-head"><div><div class="eyebrow">AI DIRECT BATCH</div><h2>批量生成${label}</h2></div>${running ? '' : '<button class="modal-close" data-action="ai-batch-close">×</button>'}</div>
    <p class="hint">输出目录：${AI_BATCH_KIND_OUTPUT[draft.kind]} · 模型：${escapeHTML(aiModelLabel(runner.model))}</p>
    <div class="form-grid">
      <div class="field"><label>开始集</label><select id="api-batch-start">${aiEpisodeRange(state.project).map((n) => `<option value="${n}" ${Number(draft.start) === n ? 'selected' : ''}>第 ${aiEpisodeLabel(n)} 集</option>`).join('')}</select></div>
      <div class="field"><label>结束集</label><select id="api-batch-end">${aiEpisodeRange(state.project).map((n) => `<option value="${n}" ${Number(draft.end) === n ? 'selected' : ''}>第 ${aiEpisodeLabel(n)} 集</option>`).join('')}</select></div>
      <div class="field"><label>预览集</label><select id="api-batch-preview">${numbers.map((n) => `<option value="${n}" ${Number(draft.previewEpisode) === n ? 'selected' : ''}>第 ${aiEpisodeLabel(n)} 集</option>`).join('')}</select></div>
    </div>
    <div class="field" style="margin-top:14px"><label>我的要求（会追加到每一集，可留空）</label><textarea id="api-batch-manual" placeholder="输入这次要额外强调的内容。">${escapeHTML(draft.manualInstruction || '')}</textarea></div>
    <div class="field" style="margin-top:14px"><label>第 ${aiEpisodeLabel(draft.previewEpisode)} 集实际发送内容（可改范围后点「更新预览」）</label><textarea class="batch-preview" readonly>${escapeHTML(draft.preview || '正在生成预览…')}</textarea></div>
    ${failure}${previewError}${failedDraft}${resumed}${done}${executionHistory}${lastThinking}
    <div class="form-actions">
      <button class="button secondary" data-action="ai-batch-refresh">更新范围与预览</button>
      ${draft.fresh === false
        ? `<button class="button" data-action="ai-batch-start" ${pendingCount ? '' : 'disabled'}>继续未完成（${pendingCount} 集）</button><button class="button secondary" data-action="ai-batch-restart">重新生成所选范围（${numbers.length} 集）</button>`
        : `<button class="button" data-action="ai-batch-start">开始批量生成（${numbers.length} 集）</button>`}
    </div>
  </div></div>`;
  // 长正文在用户展开时才填入，只读查看，不把候选内容写入项目或正式文件。
  aiBindLazyText('[data-ai-failed-draft]', '#ai-failed-draft-content', () => draft.contentText || '');
  aiBindLazyText('[data-ai-execution-record]', '#ai-execution-record-content', () => aiExecutionRecordText(draft));
  aiBindLazyText('[data-ai-last-thinking]', '#ai-last-thinking-content', () => draft.thinkingText || '');
}

function aiLog(line) {
  if (!state.apiBatch) return;
  state.apiBatch.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  state.apiBatch.logSequence = (state.apiBatch.logSequence || 0) + 1;
  if (state.apiBatch.log.length > 800) state.apiBatch.log.splice(0, state.apiBatch.log.length - 800);
}

function aiNewLogLines(draft, before) {
  const count = Math.max(0, (draft.logSequence || 0) - before);
  return count ? draft.log.slice(-count) : [];
}

/**
 * 把流式片段直接追加进两个 <pre>。
 * 每个字符都重绘整个弹窗会把界面拖死，所以这里只动 DOM 节点。
 */
function aiAppendStream(event) {
  const draft = state.apiBatch;
  if (!draft) return;
  const isThinking = event.stream === 'reasoning';
  if (isThinking) {
    draft.thinkingText = (draft.thinkingText || '') + (event.text || '');
    const readingText = (event.meta?.sourceType || event.sourceType) === 'content';
    if (readingText) draft.readingChars = (draft.readingChars || 0) + (event.text || '').length;
    else draft.reasoningChars = (draft.reasoningChars || 0) + (event.text || '').length;
  }
  else draft.contentText = (draft.contentText || '') + (event.text || '');
  const execution = aiEpisodeExecution(draft, event.episodeNumber);
  if (execution) {
    if (isThinking) {
      execution.hasThinkingStream = true;
      execution.thinkingLength = draft.reasoningChars || 0;
      execution.readingLength = draft.readingChars || 0;
    }
    else execution.contentLength = draft.contentText.length;
  }
  if (!modalRoot.querySelector('.ai-stream-grid')) return;
  const box = modalRoot.querySelector(isThinking ? '#ai-stream-reasoning' : '#ai-stream-content');
  if (box) {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (box.dataset.placeholder === '1') { box.textContent = ''; box.dataset.placeholder = '0'; }
    box.appendChild(document.createTextNode(event.text || ''));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  const counter = modalRoot.querySelector(isThinking ? '#ai-think-chars' : '#ai-content-chars');
  if (counter) counter.textContent = String(isThinking ? draft.reasoningChars || 0 : draft.contentText.length);
  const readingCounter = modalRoot.querySelector('#ai-reading-text-chars');
  if (readingCounter && isThinking) readingCounter.textContent = String(draft.readingChars || 0);
}

function aiAppendVisibleLogs(lines) {
  const logBox = modalRoot.querySelector('.ai-batch-log');
  if (!logBox || !lines.length) return;
  const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 80;
  for (const text of lines) {
    const line = document.createElement('div');
    line.className = 'ai-batch-log-line';
    line.textContent = text;
    logBox.appendChild(line);
  }
  while (logBox.children.length > 40) logBox.firstElementChild.remove();
  if (atBottom) logBox.scrollTop = logBox.scrollHeight;
}

function aiSyncExecutionStats(draft) {
  const execution = (draft.executionRecords || []).find((item) => item.episodeNumber === Number(draft.currentEpisode));
  const values = {
    '#ai-thinking-request': aiThinkingRequestLabel(execution?.requests.at(-1)),
    '#ai-context-status': aiContextLabel(execution),
    '#ai-read-tool-count': String(draft.agentToolCalls || 0),
    '#ai-read-file-count': String(draft.agentFilesRead?.length || 0)
  };
  for (const [selector, value] of Object.entries(values)) {
    const element = modalRoot.querySelector(selector);
    if (element) element.textContent = value;
  }
}

function aiHandleExecutionEvidence(event) {
  const draft = state.apiBatch;
  const execution = aiEpisodeExecution(draft, event.episodeNumber);
  if (!execution) return;
  const before = draft.logSequence || 0;
  if (event.type === 'thinking-request') {
    const request = { enabled: event.enabled === true, effort: String(event.effort || ''), model: String(event.model || '') };
    execution.requests.push(request);
    aiLog(`   第 ${aiEpisodeLabel(execution.episodeNumber)} 集${aiThinkingRequestLabel(request)}${request.model ? ` · 模型 ${aiModelLabel(request.model)}` : ''}；服务商是否返回可见思考，以返回文本为准。`);
  } else {
    const newWarnings = [...new Set((event.warnings || []).map(String).filter(Boolean))].filter((warning) => !execution.warnings.includes(warning));
    execution.contextPrepared = true;
    execution.filesRead = [...new Set([...execution.filesRead, ...(event.filesRead || []).map(String).filter(Boolean)])];
    execution.missing = [...new Set((event.missing || []).map(String).filter(Boolean))];
    execution.warnings = [...execution.warnings, ...newWarnings];
    execution.contextChars = Number(event.chars) || 0;
    if (Number(draft.currentEpisode) === execution.episodeNumber) draft.agentFilesRead = [...execution.filesRead];
    aiLog(`   第 ${aiEpisodeLabel(execution.episodeNumber)} 集资料准备完成：已实际读取 ${execution.filesRead.length} 份文件 · ${execution.contextChars} 字。`);
    for (const file of event.filesRead || []) aiLog(`   已读取：${file}`);
    if (execution.missing.length) aiLog(`   缺少资料：${execution.missing.join('、')}（未读取，不冒充已有）`);
    for (const warning of newWarnings) aiLog(`   ⚠ ${warning}`);
  }
  aiSyncExecutionStats(draft);
  aiAppendVisibleLogs(aiNewLogLines(draft, before));
}

function aiApplyFormatRepair(event) {
  const draft = state.apiBatch;
  if (!draft) return;
  if (typeof event.content === 'string') {
    draft.contentText = event.content;
    draft.contentEpisodeNumber = event.episodeNumber;
    const execution = aiEpisodeExecution(draft, event.episodeNumber);
    if (execution) execution.contentLength = event.content.length;
    const contentBox = modalRoot.querySelector('#ai-stream-content');
    if (contentBox) {
      const atBottom = contentBox.scrollHeight - contentBox.scrollTop - contentBox.clientHeight < 80;
      const scrollTop = contentBox.scrollTop;
      contentBox.textContent = event.content;
      contentBox.dataset.placeholder = event.content ? '0' : '1';
      contentBox.scrollTop = atBottom ? contentBox.scrollHeight : scrollTop;
    }
    const counter = modalRoot.querySelector('#ai-content-chars');
    if (counter) counter.textContent = String(event.content.length);
  }
  const repairs = [...new Set((event.repairs || []).map(String).filter(Boolean))];
  aiLog(`   已在本地修正第 ${aiEpisodeLabel(event.episodeNumber)} 集排版，正文与对白未改${repairs.length ? `：${repairs.join('；')}` : '。'}`);
  aiAppendVisibleLogs([draft.log.at(-1)]);
}

function aiHandleBatchEvent(event) {
  const draft = state.apiBatch;
  if (!draft || !event) return;
  if (event.kind && event.kind !== draft.kind) return;
  if (event.type === 'stage-stream-reset' || event.type === 'stage-content') {
    draft.currentStage = event.stage;
    draft.contentText = event.type === 'stage-content' ? event.content : '';
    draft.contentEpisodeNumber = event.episodeNumber;
    const box = modalRoot.querySelector('#ai-stream-content');
    if (box) { box.textContent = draft.contentText || '等待本步骤正文…'; box.dataset.placeholder = draft.contentText ? '0' : '1'; }
    const counter = modalRoot.querySelector('#ai-content-chars');
    if (counter) counter.textContent = String(draft.contentText.length);
    return;
  }
  const label = AI_BATCH_KIND_LABEL[draft.kind] || draft.kind;
  // 流式增量直接追加，不做整屏重绘
  if (event.type === 'delta') { aiAppendStream(event); return; }
  if (event.type === 'format-repaired') { aiApplyFormatRepair(event); return; }
  if (['thinking-request', 'context-ready'].includes(event.type)) { aiHandleExecutionEvidence(event); return; }
  const logCountBefore = draft.logSequence || 0;
  switch (event.type) {
    case 'stage-start':
      draft.currentStage = event.stage;
      aiLog(`▶ 第 ${aiEpisodeLabel(event.episodeNumber)} 集 · ${event.stage === 'shotlist' ? '步骤 1/2：独立生成分镜' : '步骤 2/2：依据本轮分镜独立生成提示词'}`);
      break;
    case 'stage-done':
    case 'stage-reused':
      aiLog(`✔ 第 ${aiEpisodeLabel(event.episodeNumber)} 集${event.stage === 'shotlist' ? '分镜' : '提示词'}${event.type === 'stage-reused' ? '已核对并复用' : '已单独保存'}：${event.outputPath}`);
      break;
    case 'stage-repair':
      aiLog(`正在修正本步骤：${event.problems.join('；')}。修订稿替换草稿，不拼接第二份成品。`);
      break;
    case 'stage-failed':
      draft.failures ||= [];
      draft.failures.push(event);
      aiLog(`第 ${aiEpisodeLabel(event.episodeNumber)} 集${event.stage === 'shotlist' ? '分镜' : '提示词'}待处理：${event.reason}${event.savedShotlist ? '；已保存分镜保留。' : ''}${event.cancelled ? '' : ' 继续处理后续集。'}${event.draftPath ? ` 草稿：${event.draftPath}` : ''}`);
      break;
    case 'batch-start':
      aiLog(`开始批量${label}：第 ${aiEpisodeLabel(event.episodes[0])}–${aiEpisodeLabel(event.episodes.at(-1))} 集，模型 ${aiModelLabel(event.model)}`);
      if (event.smartReadEnabled) aiLog('逐集智能核对已开启：每集先准备本集与关联资料，再按需要只读核对。');
      break;
    case 'new-conversation':
      draft.rotations += 1;
      aiLog(`★ 第 ${aiEpisodeLabel(event.episodeNumber)} 集前开启第 ${event.conversationId} 个新对话（已完成 ${draft.conversationCap} 集）`);
      break;
    case 'episode-start': {
      const execution = aiEpisodeExecution(draft, event.episodeNumber);
      draft.currentEpisode = event.episodeNumber;
      draft.currentConversation = event.conversationId;
      draft.startedAt = Date.now();
      draft.thinkingText = '';
      draft.reasoningChars = 0;
      draft.readingChars = 0;
      draft.thinkingEpisodeNumber = event.episodeNumber;
      draft.contentText = '';
      draft.contentEpisodeNumber = event.episodeNumber;
      draft.agentToolCalls = execution?.toolCalls || 0;
      draft.agentFilesRead = [...(execution?.filesRead || [])];
      aiLog(`▶ 第 ${aiEpisodeLabel(event.episodeNumber)} 集：请求中（对话 ${event.conversationId}，本轮第 ${event.filled + 1} 集）`);
      break;
    }
    case 'agent-turn':
      aiLog(`   资料核对第 ${event.turn} 轮`);
      break;
    case 'agent-reading-done':
      aiLog(`   资料核对完成${event.forced ? '（检测到重复读取，自动收敛）' : ''}，停止调用读取工具`);
      break;
    case 'smart-read-fallback':
      aiLog(`   ⚠ 当前接口不支持智能读取工具${event.contextPrepared ? '；本集与关联资料已准备，继续引用这些资料生成' : '，继续使用已准备的输入资料生成'}：${event.reason || '工具调用不可用'}`);
      break;
    case 'agent-final-start':
      aiLog('   正在生成唯一成品；完成后只检验一次');
      break;
    case 'agent-final-done':
      aiLog('   唯一成品生成完成，进入本地完整性检验');
      break;
    case 'completion-marker':
      aiLog('   已收到成品完成标记，停止继续思考和续写');
      break;
    case 'output-continuation':
      aiLog(`   单次输出已到服务商长度上限，正在自动续写第 ${event.continuation} 段`);
      break;
    case 'tool-start':
      aiLog(`   正在只读核对：${event.name}`);
      break;
    case 'tool-done': {
      const execution = aiEpisodeExecution(draft, event.episodeNumber);
      const paths = [event.path || event.args?.path, ...(event.paths || [])].filter(Boolean);
      const failed = event.failed === true;
      const actualFiles = failed ? [] : /^read(?:_project)?_files?$/.test(String(event.name || '')) ? paths : (event.filesRead || []);
      if (execution) {
        execution.toolCalls += 1;
        execution.filesRead = [...new Set([...execution.filesRead, ...actualFiles.map(String)])];
        if (Number(draft.currentEpisode) === execution.episodeNumber) {
          draft.agentToolCalls = execution.toolCalls;
          draft.agentFilesRead = [...execution.filesRead];
        }
      }
      const line = `${failed ? '读取失败' : event.reused ? '复用已读取资料' : '已完成只读核对'}：${event.name}${paths.length ? ` · ${paths.join('、')}` : ''}${failed && event.reason ? `：${event.reason}` : ''}`;
      if (failed && execution) {
        const summary = `${event.label || paths.join('、') || event.name}读取失败：${event.reason || '未提供原因'}`;
        execution.warnings = [...new Set([...execution.warnings, summary])];
      }
      aiLog(`   ${line}`);
      break;
    }
    case 'retry':
      aiLog(`↻ 第 ${aiEpisodeLabel(event.episodeNumber)} 集重试（第 ${event.attempt} 次，等待 ${Math.round(event.waitMs / 1000)} 秒${event.nextReasoningEffort ? `，思考请求参数 ${event.nextReasoningEffort}` : ''}）：${event.reason}`);
      break;
    case 'episode-done': {
      const execution = aiEpisodeExecution(draft, event.episodeNumber);
      if (execution) {
        execution.status = 'completed';
        // 读取阶段普通 content 也会显示在核对区，不能把其合计字数重新当成思考。
        if (!execution.hasThinkingStream) execution.thinkingLength = Math.max(execution.thinkingLength, Number(event.thinkingLength) || 0);
        execution.contentLength = Number(event.contentLength) || draft.contentText?.length || 0;
        execution.filesRead = [...new Set([...execution.filesRead, ...(event.agent?.filesRead || [])])];
      }
      if (!draft.completed.includes(event.episodeNumber)) draft.completed.push(event.episodeNumber);
      draft.currentEpisode = event.episodeNumber;
      aiLog(`✔ 第 ${aiEpisodeLabel(event.episodeNumber)} 集已保存 · 实际模型 ${aiModelLabel(event.responseModel || '')}`);
      aiLog(`   ${execution?.thinkingLength ? `接口返回思考 ${execution.thinkingLength} 字` : '接口未返回可见思考文本，不代表没有进行思考'} · 普通读取核对 ${execution?.readingLength || 0} 字 · 正文 ${event.contentLength ?? 0} 字${event.usage ? ` · tokens ${event.usage.total_tokens ?? '—'}` : ''}${event.finishReason === 'length' ? ' · ⚠ 被长度截断' : ''}`);
      if (event.agent) aiLog(`   本集智能核对 ${event.agent.turns ?? '—'} 轮 / ${event.agent.toolCalls ?? '—'} 次；本集实际读取累计记录 ${execution?.filesRead.length || 0} 份文件`);
      for (const warning of event.warnings || []) aiLog(`   ⚠ ${warning}`);
      break;
    }
    case 'repair-request':
      aiLog(`↻ 第 ${aiEpisodeLabel(event.episodeNumber)} 集：${event.reason}`);
      break;
    case 'repair-start':
      aiLog(`↻ 第 ${aiEpisodeLabel(event.episodeNumber)} 集正在检查并自动补齐第二份成品。`);
      break;
    case 'repair-done':
      aiLog(`✔ 第 ${aiEpisodeLabel(event.episodeNumber)} 集已自动补齐提示词。`);
      break;
    case 'repair-failed':
      aiLog(`✘ 第 ${aiEpisodeLabel(event.episodeNumber)} 集自动补齐失败：${(event.problems || []).join('；')}`);
      break;
    case 'episode-rejected': {
      const execution = aiEpisodeExecution(draft, event.episodeNumber);
      if (execution) execution.status = 'rejected';
      aiLog(`✘ 第 ${aiEpisodeLabel(event.episodeNumber)} 集结构校验不通过，未写文件：${event.problems.join('；')}`);
      break;
    }
    case 'episode-failed': {
      const execution = aiEpisodeExecution(draft, event.episodeNumber);
      if (execution) execution.status = 'failed';
      aiLog(`✘ 第 ${aiEpisodeLabel(event.episodeNumber)} 集失败：${event.reason}`);
      draft.failure = { episodeNumber: event.episodeNumber, reason: event.reason };
      break;
    }
    case 'saved':
      aiLog(`   → 已写入 ${event.outputPath}`);
      break;
    default:
      break;
  }
  if (draft.status === 'running' && !state.apiBatchMinimized) {
    if (['episode-start', 'episode-done'].includes(event.type)) renderApiBatchModal();
    else {
      aiSyncExecutionStats(draft);
      aiAppendVisibleLogs(aiNewLogLines(draft, logCountBefore));
    }
  } else if (draft.status === 'running') {
    const dockTitle = document.querySelector('[data-api-batch-dock-title]');
    const dockStatus = document.querySelector('[data-api-batch-dock-status]');
    if (dockTitle) dockTitle.textContent = draft.stopRequested ? '正在停止 API 批量任务…' : 'API 批量任务在后台运行';
    if (dockStatus) dockStatus.textContent = `第 ${draft.currentEpisode ? aiEpisodeLabel(draft.currentEpisode) : '—'} 集 · ${draft.completed.length} 集已完成`;
  }
}

async function aiStartBatch(forceFresh = false) {
  const draft = state.apiBatch;
  if (!draft) return;
  draft.start = Number(document.querySelector('#api-batch-start')?.value) || draft.start;
  draft.end = Number(document.querySelector('#api-batch-end')?.value) || draft.end;
  draft.manualInstruction = document.querySelector('#api-batch-manual')?.value ?? draft.manualInstruction;

  const numbers = aiEpisodeRange(state.project).filter((n) => n >= Math.min(draft.start, draft.end) && n <= Math.max(draft.start, draft.end));
  if (!numbers.length) return showToast('选定的范围里没有可处理的集。');
  const runFresh = forceFresh || draft.fresh !== false;
  const checkpointCompleted = (draft.checkpointCompleted || []).filter((number) => numbers.includes(number));
  const toProcess = runFresh ? numbers : numbers.filter((number) => !checkpointCompleted.includes(number));
  if (!toProcess.length) return showToast('所选范围已经全部完成；如需重做，请点击“重新生成所选范围”。');

  // 先检查首个待处理集的输入能否读取；要求文件仍由用户自行选择。
  if (draft.preflighting) return;
  draft.preflighting = true;
  try {
    const preflightProject = deepCopy(state.project);
    preflightProject.currentEpisode = toProcess[0];
    await window.directorApi.aiPreviewMessages(preflightProject, draft.kind, toProcess[0], draft.template, true);
    draft.previewError = '';
  } catch (error) {
    draft.previewError = error?.message || String(error);
    showToast(draft.previewError);
    renderApiBatchModal();
    return;
  } finally {
    draft.preflighting = false;
  }
  if (state.apiBatch !== draft) return;

  draft.fresh = runFresh;
  if (runFresh) draft.checkpointCompleted = [];
  draft.status = 'running';
  draft.log = [];
  draft.logSequence = 0;
  draft.executionRecords = [];
  draft.completed = runFresh ? [] : checkpointCompleted;
  draft.rotations = 0;
  draft.failure = null;
  draft.failures = [];
  draft.thinkingText = '';
  draft.reasoningChars = 0;
  draft.readingChars = 0;
  draft.thinkingEpisodeNumber = null;
  draft.contentText = '';
  draft.contentEpisodeNumber = null;
  draft.stopRequested = false;
  state.apiBatchMinimized = false;
  state.apiBatchLock = true;
  state.workLocked = true;
  const startedProjectPath = state.project?.projectPath || '';
  state.workLabel = `${runFresh ? '正在重新生成' : '正在继续生成'}${AI_BATCH_KIND_LABEL[draft.kind]}，本次处理 ${toProcess.length} 集。`;
  render();

  try {
    const result = await window.directorApi.aiRunBatch(deepCopy(state.project), {
      kind: draft.kind,
      start: Math.min(draft.start, draft.end),
      end: Math.max(draft.start, draft.end),
      template: draft.template,
      conversationCap: draft.conversationCap,
      maxTokens: draft.maxTokens,
      manualInstruction: draft.manualInstruction,
      fresh: runFresh
    });
    draft.failure = result.failure || null;
    draft.failures = result.failures || [];
    draft.rotations = result.rotations ?? draft.rotations;
    draft.completed = (result.completed || draft.completed).filter((number) => numbers.includes(number));
    draft.status = result.ok ? 'completed' : 'paused';
    if (!result.ok && (draft.completed.length || draft.kind === 'pair')) {
      try {
        const saved = await window.directorApi.aiBatchState(state.project, draft.kind);
        if (saved?.kind === draft.kind && Array.isArray(saved.completed)) {
          draft.fresh = false;
          draft.checkpointCompleted = saved.completed.map(Number);
        }
      } catch { /* 保留当前失败状态，允许用户自行选择范围重试 */ }
    }
    if (result.ok) aiLog(`全部完成：${draft.completed.length} 集，共换对话 ${draft.rotations} 次`);
  } catch (error) {
    draft.status = 'paused';
    draft.failure = { episodeNumber: draft.previewEpisode, reason: error?.message || String(error) };
    aiLog(`批量任务中断：${draft.failure.reason}`);
  } finally {
    state.apiBatchLock = false;
    state.workLocked = false;
    state.workLabel = '';
    state.apiBatchMinimized = false;
    if (state.project && projectPathKey(state.project.projectPath) === projectPathKey(startedProjectPath)) {
      try {
        const dirtyKinds = dirtyDocumentKinds();
        const preservedDrafts = Object.fromEntries(dirtyKinds.map(kind => [kind, state.project[kind]?.content]));
        const preservedDirty = { ...state.documentDirty };
        const currentEpisode = Number(state.project.currentEpisode);
        state.project = ensureClientProjectShape(await window.directorApi.rescanProject(state.project));
        state.projects = state.projects.map((item) => item.id === state.project.id ? state.project : item);
        if (!dirtyKinds.length) {
          await activateEpisode(currentEpisode);
          markDirty();
          await saveProject({ renderAfter: false, preserveViewport: true });
        } else {
          for (const kind of dirtyKinds) {
            if (state.project[kind]) state.project[kind].content = preservedDrafts[kind];
          }
          state.documentDirty = preservedDirty;
          showToast('批量生成已结束；你正在编辑的未保存草稿已保留。');
        }
      } catch { /* 重扫失败不影响已落盘的成品 */ }
    }
    render();
  }
}

async function aiStopBatch() {
  const draft = state.apiBatch;
  if (!draft || draft.status !== 'running') return showToast('当前没有正在运行的批量任务。');
  if (draft.stopRequested) return;
  draft.stopRequested = true;
  state.workLocked = false;
  state.apiBatchMinimized = false;
  aiLog('正在立即中断当前 API 请求；不会等待本集生成完成。');
  render();
  try {
    const result = await window.directorApi.aiCancelBatch();
    if (result?.ok) showToast('停止请求已发送，正在结束当前连接…');
    else {
      draft.stopRequested = false;
      showToast(result?.reason || '当前没有正在运行的批量任务。');
      render();
    }
  } catch (error) {
    draft.stopRequested = false;
    showToast(error?.message || String(error));
    render();
  }
}

async function aiLoadCheckpoint(kind) {
  try {
    const saved = await window.directorApi.aiBatchState(state.project, kind || state.apiBatch?.kind || 'script');
    state.aiCheckpoint = saved || null;
    if (saved) showToast(`断点：已完成 ${(saved.completed || []).length} 集。打开对应批量窗口点「开始」会从断点接着跑。`);
    else showToast('没有找到断点记录。');
  } catch (error) {
    showToast(error?.message || String(error));
  }
  render();
}

async function aiClearCheckpoint(kind) {
  try {
    await window.directorApi.aiClearBatchState(state.project, kind || state.apiBatch?.kind || 'script');
    state.aiCheckpoint = null;
    showToast('断点已清除，下次会从头开始。');
  } catch (error) {
    showToast(error?.message || String(error));
  }
  render();
}

/* ------------------------------------------------------------------ *
 * 批量入口分流 + 事件注册
 * ------------------------------------------------------------------ */

function openBatchEntry(kind) {
  return aiOpenBatch(kind);
}

async function aiReplaceRequirement(category) {
  const imported = await window.directorApi.importRules(state.project, category);
  if (!imported.length) return;
  const chosen = imported.at(-1);
  state.project.ruleDocuments = (state.project.ruleDocuments || []).map((doc) =>
    doc.category === category ? { ...doc, enabled: false } : doc);
  state.project.ruleDocuments.push(...imported.map((doc) => ({ ...doc, enabled: doc.id === chosen.id })));
  markDirty();
  await saveProject({ preserveViewport: true });
  showToast(`已选择：${chosen.name}`);
}

async function aiReplaceOutline() {
  const imported = await window.directorApi.importReferences(state.project, 'script');
  if (!imported.length) return;
  const chosen = imported.at(-1);
  state.project.referenceDocuments = (state.project.referenceDocuments || []).map((doc) =>
    doc.category === 'script' ? { ...doc, enabled: false } : doc);
  state.project.referenceDocuments.push(...imported.map((doc) => ({ ...doc, enabled: doc.id === chosen.id })));
  markDirty();
  await saveProject({ preserveViewport: true });
  showToast(`已选择大纲：${chosen.name}`);
}

async function aiClearOutline() {
  state.project.referenceDocuments = (state.project.referenceDocuments || []).map((doc) =>
    doc.category === 'script' ? { ...doc, enabled: false } : doc);
  markDirty();
  await saveProject({ preserveViewport: true });
  showToast('已清除可选大纲。');
}

/** 返回 true 表示这个动作已被 AI 面板处理 */
async function handleAiAction(action, button) {
  switch (action) {
    case 'ai-save-config': await aiSaveConfig(); return true;
    case 'ai-test': await aiTestConnection(); return true;
    case 'ai-replace-rule': await aiReplaceRequirement(button.dataset.ruleCategory); return true;
    case 'ai-replace-outline': await aiReplaceOutline(); return true;
    case 'ai-clear-outline': await aiClearOutline(); return true;
    case 'ai-save-checks': await aiSaveChecks(); return true;
    case 'ai-reset-checks': await aiSaveChecks(aiDefaultChecks()); render(); return true;
    case 'ai-open-batch': await aiOpenBatch(button.dataset.kind || 'script', button.dataset.current === 'true'); return true;
    case 'ai-batch-refresh': await aiRefreshPreview(); return true;
    case 'ai-batch-start': await aiStartBatch(); return true;
    case 'ai-batch-restart': await aiStartBatch(true); return true;
    case 'ai-batch-stop': await aiStopBatch(); return true;
    case 'ai-batch-copy-draft':
      if (!aiFailedDraftAvailable(state.apiBatch)) {
        showToast('本轮没有可复制的未保存正文。');
        return true;
      }
      try {
        await window.directorApi.productionCopy(state.apiBatch.contentText);
        showToast('临时正文已复制；未作为成品保存，请先核对完整性与校验问题。');
      } catch (error) {
        showToast(error?.message || '复制失败，请选中正文后重试。');
      }
      return true;
    case 'ai-batch-show':
      state.apiBatchMinimized = false;
      render();
      return true;
    case 'ai-batch-minimize':
      state.apiBatchMinimized = true;
      render();
      return true;
    case 'ai-batch-close':
      if (state.apiBatch?.status !== 'running') { state.apiBatch = null; closeModal(); render(); }
      return true;
    case 'ai-load-checkpoint': await aiLoadCheckpoint(button.dataset.kind); return true;
    case 'ai-clear-checkpoint': await aiClearCheckpoint(button.dataset.kind); return true;
    default: return false;
  }
}

function aiInitBatchEvents() {
  if (aiUnregisterBatchEvents) return;
  try {
    aiUnregisterBatchEvents = window.directorApi.onAiBatchEvent(aiHandleBatchEvent);
  } catch { /* 旧版 preload 没有这个接口时静默跳过 */ }
}

