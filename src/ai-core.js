'use strict';

/**
 * 导演台剧场 · AI 执行核心
 *
 * 取代旧版"用 CDP 驱动 chatgpt.com 网页"的脆弱链路。三条硬要求：
 *   1. 直连 LLM API（OpenAI 兼容 /chat/completions），流式，可重试，错误可定位
 *   2. 上下文按对话轮换：同一对话最多容纳 N 集答案，满了就开新对话
 *   3. 落盘前必须通过结构完整性校验，绝不保存半截产物
 *
 * 零依赖（Node 原生 http/https）。可脱离 Electron 单独跑：node src/ai-core.test.js
 */

const http = require('node:http');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_ATTEMPTS = 3;
// 推理模型（如 deepseek-flash / deepseek-v4-pro）会先输出 reasoning_content 再输出正文，
// 两者共用这个额度，而且思考经常占到三分之二：
//   实测「40 行对照表」→ 思考 2872 tokens / 正文 1451 tokens。
// 合并链路（分镜+提示词）单集产物约 2 万字符 ≈ 8000~10000 tokens，再叠加思考就是 2 万+。
// max_tokens 只是上限、不会被额外计费，所以直接给足余量，避免"思考写完了正文还没开始"。
const DEFAULT_MAX_TOKENS = 65536;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

/* ------------------------------------------------------------------ *
 * 服务商预设
 *
 * 预设只负责填写地址和推荐模型；模型名始终允许手动输入。
 * ------------------------------------------------------------------ */

const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    // /models 当前返回这两个正式标识。界面使用友好名称，发送时始终使用这里的精确 ID。
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelNotes: {
      'deepseek-flash': 'V4.1 Flash（当前使用，速度快）',
      'deepseek-v4-pro': 'V4 Pro（复杂任务）'
    },
    supportsJsonMode: true
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4o'],
    modelNotes: {},
    supportsJsonMode: true
  },
  dashscope: {
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max'],
    modelNotes: {},
    supportsJsonMode: true
  },
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V4-Flash'],
    modelNotes: {},
    supportsJsonMode: true
  },
  custom: {
    label: '自定义兼容接口',
    baseUrl: '',
    models: [],
    modelNotes: {},
    supportsJsonMode: false
  }
};

function defaultProviderId() {
  return Object.keys(PROVIDERS)[0];
}

/**
 * 地址纠错。实测踩过的坑：把 api.deepseek.com/v4 当成有效地址，
 * 结果 404 且响应体为空，界面上只显示"连不上"，根本看不出问题在哪。
 * 这里对已知服务商做"主机名相同但路径不对"的自动纠正。
 */
function repairBaseUrl(provider, raw) {
  const preset = PROVIDERS[provider] || PROVIDERS[defaultProviderId()];
  let url = String(raw || '').trim();
  if (!url) return { baseUrl: preset.baseUrl, changed: false, notes: [] };
  const notes = [];

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
    notes.push('地址缺少 https:// 前缀，已自动补上。');
  }
  url = url.replace(/\/+$/, '');
  // 有人会把完整的 chat/completions 地址粘进来
  const stripped = url.replace(/\/chat\/completions$/i, '');
  if (stripped !== url) {
    url = stripped;
    notes.push('地址里含 /chat/completions，已去掉（只填到 /v1 就行）。');
  }

  try {
    const target = new URL(url);
    const want = preset.baseUrl ? new URL(preset.baseUrl) : null;
    if (want && target.host === want.host) {
      const path = target.pathname.replace(/\/+$/, '');
      if (path !== want.pathname.replace(/\/+$/, '')) {
        notes.push(`地址路径 ${path} 不是 ${preset.label} 的有效路径，已自动纠正为 ${preset.baseUrl}。`);
        url = preset.baseUrl;
      }
    }
  } catch {
    notes.push(`地址「${raw}」不是合法网址，已回退为 ${preset.baseUrl}。`);
    url = preset.baseUrl;
  }
  return { baseUrl: url, changed: notes.length > 0, notes };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRunnerConfig(project) {
  const raw = project?.aiRunner || {};
  const provider = PROVIDERS[raw.provider] ? raw.provider : defaultProviderId();
  const preset = PROVIDERS[provider];
  const repaired = repairBaseUrl(provider, raw.baseUrl);
  const requestedMaxTokens = Number(raw.maxTokens);
  const requestedAttempts = Number(raw.maxAttempts);
  return {
    provider,
    baseUrl: repaired.baseUrl,
    model: String(raw.model || preset.models[0] || ''),
    apiKey: String(raw.apiKey || ''),
    temperature: clampNumber(raw.temperature, 0, 2, 0.7),
    // 这是单次请求给服务商的窗口大小。总生成量不设上限；被截断会自动续写。
    maxTokens: Number.isFinite(requestedMaxTokens) && requestedMaxTokens >= 256
      ? Math.floor(requestedMaxTokens) : DEFAULT_MAX_TOKENS,
    timeoutMs: clampNumber(raw.timeoutMs, 10000, 900000, DEFAULT_TIMEOUT_MS),
    maxAttempts: Number.isFinite(requestedAttempts) && requestedAttempts >= 1
      ? Math.floor(requestedAttempts) : DEFAULT_MAX_ATTEMPTS,
    conversationCap: clampNumber(raw.conversationCap, 1, 50, 3),
    maxContextChars: clampNumber(raw.maxContextChars, 20000, 6000000, 900000),
    smartRead: raw.smartRead !== false
  };
}

function configProblems(config) {
  const problems = [];
  if (!config.baseUrl) problems.push('未填写 API 地址（Base URL）。');
  else if (!/^https?:\/\/.+/i.test(config.baseUrl)) problems.push(`API 地址「${config.baseUrl}」不是合法的网址（应以 https:// 开头）。`);
  if (!config.model) problems.push('未填写模型名。');
  if (!config.apiKey) problems.push('未填写 API Key。');
  return problems;
}

/* ------------------------------------------------------------------ *
 * 底层调用：OpenAI 兼容 /chat/completions
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    const { status = 0, retryable = false, retryAfterMs = 0, body = '', ...rest } = options;
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
    // 把诊断信息一起挂上（思考长度、结束原因、用量），上层报错时能说清楚到底哪一步出问题
    Object.assign(this, rest);
  }
}

function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function trimBody(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function classifyStatus(status, body, endpoint) {
  const where = endpoint ? `（请求地址：${endpoint}）` : '';
  if (status === 429) return { retryable: true, message: 'API 触发限流（429）。稍等片刻会自动重试。' };
  if (status === 408 || status === 409) return { retryable: true, message: `API 临时冲突（${status}）。` };
  if (status >= 500) return { retryable: true, message: `API 服务端错误（${status}）。` };
  if (status === 401 || status === 403) return { retryable: false, message: `API 鉴权失败（${status}），请检查 API Key 是否正确、是否有余额。` };
  if (status === 404) {
    return {
      retryable: false,
      message: `API 地址不存在（404）${where}。地址要填到 /v1 为止（例如 https://api.deepseek.com/v1），不要带 /chat/completions，也不要自己改版本号；模型名也要在可用列表里。${trimBody(body) ? `服务端返回：${trimBody(body)}` : '服务端没有返回内容。'}`
    };
  }
  if (status === 400) return { retryable: false, message: `API 拒绝了本次请求（400）${where}：${trimBody(body)}` };
  if (status === 413) return { retryable: false, message: '本次请求体超出模型上下文上限（413）。请调低「每对话集数」或精简规则文档。' };
  return { retryable: false, message: `API 返回异常状态 ${status}${where}：${trimBody(body)}` };
}

function parseRetryAfter(headers) {
  const raw = headers?.['retry-after'] ?? headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/**
 * 单次请求（不重试）。传 onDelta 时走流式。
 *
 * 刻意使用 node:http / node:https，而不是 fetch：
 * Electron 主进程的 fetch 走 Chromium 网络栈，会受系统代理设置影响，
 * 在开了代理的机器上连本地回环地址都可能直接失败。原生 http 模块行为确定。
 */
function requestOnce(config, messages, options = {}) {
  const { onDelta, signal, temperature, maxTokens, tools, toolChoice, reasoningEffort } = options;
  const streaming = typeof onDelta === 'function';
  const endpoint = chatEndpoint(config.baseUrl);

  let target;
  try {
    target = new URL(endpoint);
  } catch {
    return Promise.reject(new ApiError(`API 地址无法解析：「${config.baseUrl}」。请填写形如 https://api.deepseek.com/v1 的完整地址。`));
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return Promise.reject(new ApiError(`API 地址协议不支持：${target.protocol}。只支持 http 与 https。`));
  }

  const payload = {
    model: config.model,
    messages,
    max_tokens: maxTokens ?? config.maxTokens,
    stream: streaming
  };
  if (config.provider === 'deepseek' || /deepseek/i.test(String(config.model || ''))) {
    // DeepSeek 同一模型同时支持思考与非思考。这里显式开启并固定为最高强度，
    // 避免服务端默认值变化后出现“直接写正文、没有充分分析”的情况。
    payload.thinking = { type: 'enabled' };
    payload.reasoning_effort = reasoningEffort || 'high';
  } else {
    payload.temperature = temperature ?? config.temperature;
  }
  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools;
    payload.tool_choice = toolChoice || 'auto';
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let content = '';
    let reasoning = '';
    let finishReason = '';
    let usage = null;
    let responseModel = '';
    const stopMarker = String(options.stopMarker || '').trim();
    let emittedContent = 0;
    const toolCallParts = new Map();
    let buffer = '';
    let onAbort = null;
    let timer = null;
    let request = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };

    const armIdleTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        request?.destroy();
        finish(new ApiError(`连续 ${Math.round(config.timeoutMs / 1000)} 秒没有收到任何新内容。`, { retryable: true }));
      }, config.timeoutMs);
    };

    request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        Authorization: `Bearer ${config.apiKey}`,
        Accept: streaming ? 'text/event-stream' : 'application/json',
        'User-Agent': 'AIGC-Director-Desk/3.0'
      }
    }, (response) => {
      armIdleTimeout();
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        let errorBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { armIdleTimeout(); errorBody += chunk; });
        response.on('end', () => {
          const verdict = classifyStatus(status, errorBody, endpoint);
          finish(new ApiError(verdict.message, {
            status,
            retryable: verdict.retryable,
            retryAfterMs: parseRetryAfter(response.headers),
            body: errorBody
          }));
        });
        response.on('error', (error) => finish(new ApiError(`读取错误响应失败：${error.message}`, { retryable: true })));
        return;
      }

      const handleLine = (rawLine) => {
        if (settled) return;
        const line = rawLine.replace(/\r$/, '');
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let chunk;
        try { chunk = JSON.parse(data); } catch { return; }
        if (chunk?.model) responseModel = String(chunk.model);
        if (chunk?.usage) usage = chunk.usage;
        const choice = chunk?.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        // DeepSeek 的推理模型会先吐 reasoning_content（思考过程），再吐 content（正文）。
        // 两者共用 max_tokens —— 所以额度不够时会出现"思考写完了、正文一个字没有"。
        // 这里分开累计，并且都把流推给界面，用户才看得见"它到底在干什么"。
        const reasoningDelta = choice.delta?.reasoning_content;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onDelta(reasoningDelta, { type: 'reasoning' });
        }
        const delta = choice.delta?.content;
        if (delta) {
          content += delta;
          const markerIndex = stopMarker ? content.indexOf(stopMarker) : -1;
          let safeEnd = markerIndex >= 0 ? markerIndex : content.length;
          if (markerIndex < 0 && stopMarker) {
            // 标记可能分散在多个流式数据包中，暂存与其前缀重合的尾巴。
            for (let n = Math.min(stopMarker.length - 1, content.length); n > 0; n -= 1) {
              if (content.endsWith(stopMarker.slice(0, n))) { safeEnd -= n; break; }
            }
          }
          if (safeEnd > emittedContent) onDelta(content.slice(emittedContent, safeEnd), { type: 'content' });
          emittedContent = safeEnd;
          if (markerIndex >= 0) {
            content = content.slice(0, markerIndex).trimEnd();
            finish(null, { content, reasoning, toolCalls: [], finishReason: 'completed_marker',
              usage, responseModel, truncated: false,
              assistantMessage: { role: 'assistant', content, reasoning_content: reasoning } });
            response.destroy();
            request.destroy();
            return;
          }
        }
        for (const call of choice.delta?.tool_calls || []) {
          const index = Number(call.index) || 0;
          const current = toolCallParts.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) current.id = call.id;
          if (call.type) current.type = call.type;
          if (call.function?.name) current.function.name += call.function.name;
          if (call.function?.arguments) current.function.arguments += call.function.arguments;
          toolCallParts.set(index, current);
        }
      };

      response.setEncoding('utf8');
      if (streaming) {
        response.on('data', (chunk) => {
          if (settled) return;
          armIdleTimeout();
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
          }
        });
        response.on('end', () => {
          if (settled) return;
          if (buffer.trim()) handleLine(buffer);
          if (settled) return;
          if (content.length > emittedContent) onDelta(content.slice(emittedContent), { type: 'content' });
          const toolCalls = [...toolCallParts.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
          const stats = { contentLength: content.length, reasoningLength: reasoning.length, finishReason, usage, toolCallCount: toolCalls.length };
          const result = {
            content,
            reasoning,
            toolCalls,
            assistantMessage: {
              role: 'assistant',
              content,
              reasoning_content: reasoning,
              ...(toolCalls.length ? { tool_calls: toolCalls } : {})
            },
            finishReason,
            usage,
            responseModel,
            truncated: finishReason === 'length'
          };
          if (!content.trim() && !toolCalls.length) {
            // 长度截断交给上层自动续写；思考过程不会再被当成整集失败。
            if (finishReason === 'length') {
              finish(null, result);
              return;
            }
            if (reasoning.trim()) {
              finish(new ApiError(
                `模型只返回了思考过程（${reasoning.length} 字），没有返回正文。finish_reason=${finishReason || '未知'}。通常是输出额度不足或服务端异常，请调大「单次最大输出 tokens」后重试。`,
                { retryable: true, ...stats }
              ));
              return;
            }
            finish(new ApiError('模型没有返回任何流式内容。', { retryable: true, ...stats }));
            return;
          }
          finish(null, result);
        });
      } else {
        response.on('data', (chunk) => { armIdleTimeout(); buffer += chunk; });
        response.on('end', () => {
          let payload;
          try { payload = JSON.parse(buffer); }
          catch {
            finish(new ApiError(`模型返回的不是合法 JSON：${trimBody(buffer)}`, { retryable: true }));
            return;
          }
          const choice = payload?.choices?.[0];
          const message = choice?.message || {};
          const text = String(message.content ?? '');
          const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          const reasoningText = String(message.reasoning_content ?? '');
          finish(null, {
            content: text,
            reasoning: reasoningText,
            toolCalls,
            assistantMessage: {
              role: 'assistant',
              content: message.content ?? '',
              ...(reasoningText ? { reasoning_content: reasoningText } : {}),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {})
            },
            finishReason: choice?.finish_reason || '',
            usage: payload?.usage || null,
            responseModel: String(payload?.model || ''),
            truncated: choice?.finish_reason === 'length'
          });
        });
      }
      response.on('error', (error) => finish(new ApiError(`读取响应失败：${error.message}`, { retryable: true })));
    });

    armIdleTimeout();

    if (signal) {
      onAbort = () => {
        request.destroy();
        finish(new ApiError('本次请求已取消。'));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    request.on('error', (error) => {
      const code = error?.code || '';
      const hint = code === 'ECONNREFUSED' ? '（连接被拒绝，请确认 API 地址与端口）'
        : code === 'ENOTFOUND' ? '（域名解析失败，请检查 API 地址拼写与网络）'
          : code === 'ETIMEDOUT' ? '（连接超时）'
            : code === 'CERT_HAS_EXPIRED' || /certificate/i.test(String(error?.message)) ? '（证书校验失败）'
              : '';
      finish(new ApiError(`网络请求失败：${error?.message || String(error)}${hint}`, { retryable: true }));
    });

    // 仅报告实际发送的参数；不能据此断言服务商已执行深度思考。
    options.onEvent?.({ type: 'thinking-request', enabled: payload.thinking?.type === 'enabled',
      effort: payload.reasoning_effort || 'provider-default', model: config.model });
    request.end(body);
  });
}

/**
 * 合并自动续写片段，尽量去掉模型在续写开头重复的少量尾文。
 */
function appendGeneratedChunk(previous, next) {
  const left = String(previous || '');
  const right = String(next || '');
  if (!left) return right;
  if (!right) return left;
  const maxOverlap = Math.min(4000, left.length, right.length);
  for (let size = maxOverlap; size >= 24; size -= 1) {
    if (left.endsWith(right.slice(0, size))) return left + right.slice(size);
  }
  return `${left}${left.endsWith('\n') || right.startsWith('\n') ? '' : '\n'}${right}`;
}

/**
 * 每次请求遇到临时错误会持续重试；遇到服务商的单次长度上限会自动续写。
 * 整个任务没有程序侧的轮数或总 token 上限，用户仍可随时取消。
 */
async function chatCompletion(config, messages, options = {}) {
  const problems = configProblems(config);
  if (problems.length) throw new ApiError(problems.join(' '));
  const history = messages.map((message) => ({ ...message }));
  let combinedContent = '';
  let combinedReasoning = '';
  let combinedUsage = null;
  let responseModel = options.modelFromResponseOnly ? '' : config.model;
  let continuationCount = 0;
  let totalAttempts = 0;
  const stopMarker = String(options.stopMarker || '').trim();
  const requestedEffort = options.reasoningEffort || 'high';

  while (true) {
    let result = null;
    let retryAttempt = 0;
    while (!result) {
      if (options.signal?.aborted) throw new ApiError('本次任务已取消。');
      retryAttempt += 1;
      totalAttempts += 1;
      try {
        result = await requestOnce(config, history, { ...options, reasoningEffort: requestedEffort });
        assertResponseModel(config.model, result.responseModel);
      } catch (error) {
        if (!(error instanceof ApiError) || !error.retryable) throw error;
        const wait = Math.min(RETRY_MAX_MS, error.retryAfterMs || RETRY_BASE_MS * 2 ** Math.min(retryAttempt - 1, 8));
        options.onEvent?.({
          type: 'retry', attempt: retryAttempt, waitMs: wait, reason: error.message,
          nextReasoningEffort: requestedEffort
        });
        await sleep(wait, options.signal);
      }
    }

    combinedContent = appendGeneratedChunk(combinedContent, result.content);
    combinedReasoning = appendGeneratedChunk(combinedReasoning, result.reasoning);
    combinedUsage = addUsage(combinedUsage, result.usage);
    responseModel = result.responseModel || responseModel;
    const markerIndex = stopMarker ? combinedContent.indexOf(stopMarker) : -1;
    if (markerIndex >= 0) {
      combinedContent = combinedContent.slice(0, markerIndex).trimEnd();
      result = { ...result, truncated: false, finishReason: 'completed_marker', toolCalls: [] };
      options.onEvent?.({ type: 'completion-marker', contentLength: combinedContent.length });
    }

    if (!result.truncated) {
      const trimmed = combinedContent.trim();
      if (!trimmed && !result.toolCalls?.length) throw new ApiError('模型返回空内容。', { retryable: true });
      return {
        ...result,
        content: trimmed,
        reasoning: combinedReasoning,
        usage: combinedUsage || result.usage,
        responseModel,
        assistantMessage: {
          role: 'assistant',
          content: trimmed,
          ...(combinedReasoning ? { reasoning_content: combinedReasoning } : {}),
          ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {})
        },
        attempts: totalAttempts,
        continuations: continuationCount
      };
    }

    continuationCount += 1;
    options.onEvent?.({
      type: 'output-continuation',
      continuation: continuationCount,
      contentLength: combinedContent.length,
      reasoningLength: combinedReasoning.length
    });
    const assistant = result.assistantMessage || {
      role: 'assistant', content: result.content || '', reasoning_content: result.reasoning || ''
    };
    history.push(assistant);
    for (const call of result.toolCalls || []) {
      if (!call?.id) continue;
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: '本次工具调用被服务商的单次输出长度截断，未执行。请在下一轮重新发出完整调用。'
      });
    }
    history.push({
      role: 'user',
      content: result.content?.trim()
        ? '上一段因服务商的单次输出长度到达上限。请从中断处紧接着继续，只输出后续内容，不要重写已经输出的部分；完成后正常结束。'
        : '上一轮思考过程到达了服务商的单次输出长度上限，还没有正文。请继续完成思考并输出最终正文；不要解释中断原因。'
    });
  }
}

function addUsage(total, next) {
  if (!next || typeof next !== 'object') return total;
  const merged = { ...(total || {}) };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number') merged[key] = Number(merged[key] || 0) + value;
  }
  return merged;
}

/**
 * 只负责“模型提出工具调用 → 本地执行 → 把结果送回模型”的通用循环。
 * 不限制轮数，直到模型交付正文或用户主动取消。
 */
async function runToolAgent(options = {}) {
  const {
    config, messages = [], tools = [], executeTool,
    signal, onDelta = () => {}, onEvent = () => {},
    finishToolName = '', finalInstruction = '', stopMarker = ''
  } = options;
  if (!Array.isArray(tools) || !tools.length) throw new ApiError('智能读取没有可用工具。');
  if (typeof executeTool !== 'function') throw new ApiError('智能读取缺少工具执行器。');
  const history = messages.map((message) => ({ ...message }));
  const filesRead = [];
  const toolHistory = [];
  let totalUsage = null;
  let totalReasoning = '';
  let responseModel = config.model;
  let noProgressTurns = 0;

  const finishWithOneProduct = async ({ turn, summary = '', forced = false }) => {
    onEvent({ type: 'agent-reading-done', turn, forced, summary });
    history.push({
      role: 'user',
      content: `${String(finalInstruction || '').trim()}${summary ? `\n\n【读取阶段确认摘要】\n${summary}` : ''}`.trim()
    });
    onEvent({ type: 'agent-final-start', turn });
    const finalResult = await chatCompletion(config, history, {
      signal,
      reasoningEffort: 'high',
      stopMarker,
      onDelta: (delta, meta = {}) => {
        if (meta.type === 'reasoning') totalReasoning += delta;
        onDelta(delta, { ...meta, agentTurn: turn, agentStage: 'final' });
      },
      onEvent
    });
    totalUsage = addUsage(totalUsage, finalResult.usage);
    responseModel = finalResult.responseModel || responseModel;
    onEvent({ type: 'agent-final-done', turn, contentLength: finalResult.content.length });
    return {
      ...finalResult,
      reasoning: totalReasoning,
      usage: totalUsage || finalResult.usage,
      responseModel,
      agent: {
        enabled: true,
        staged: true,
        turns: turn,
        toolCalls: toolHistory.length,
        filesRead: [...new Set(filesRead)],
        tools: toolHistory
      }
    };
  };

  for (let turn = 1; ; turn += 1) {
    onEvent({ type: 'agent-turn', turn, unlimited: true });
    const result = await chatCompletion(config, history, {
      signal,
      tools,
      toolChoice: 'auto',
      reasoningEffort: 'high',
      onDelta: (delta, meta = {}) => {
        if (meta.type === 'reasoning') totalReasoning += delta;
        // 读取阶段的普通文本也归入“思考/核对”区，避免模型误写草稿时被用户看成第一份成品。
        onDelta(delta, { ...meta, type: 'reasoning', sourceType: meta.type, agentTurn: turn, agentStage: 'reading' });
      },
      onEvent
    });
    totalUsage = addUsage(totalUsage, result.usage);
    responseModel = result.responseModel || responseModel;
    const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    history.push(result.assistantMessage || {
      role: 'assistant',
      content: result.content || '',
      reasoning_content: result.reasoning || '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });

    if (!toolCalls.length) {
      if (finishToolName && finalInstruction) {
        return finishWithOneProduct({
          turn,
          summary: String(result.content || '').trim() || '模型已确认资料足够。',
          forced: true
        });
      }
      return {
        ...result,
        reasoning: totalReasoning,
        usage: totalUsage || result.usage,
        responseModel,
        agent: {
          enabled: true,
          turns: turn,
          toolCalls: toolHistory.length,
          filesRead: [...new Set(filesRead)],
          tools: toolHistory
        }
      };
    }

    let finishRequested = null;
    let newInformation = false;
    for (const call of toolCalls) {
      if (signal?.aborted) throw new ApiError('本次任务已取消。');
      const name = String(call.function?.name || 'unknown');
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); }
      catch { args = {}; }
      onEvent({ type: 'tool-start', turn, name, args });
      let outcome;
      try {
        outcome = await executeTool({ name, args, call, turn });
      } catch (error) {
        outcome = { content: `工具执行失败：${error?.message || String(error)}`, meta: { failed: true } };
      }
      if (typeof outcome === 'string') outcome = { content: outcome, meta: {} };
      const content = String(outcome?.content || '（工具没有返回内容）');
      const meta = outcome?.meta || {};
      if (name === finishToolName || meta.finishReading) {
        finishRequested = { summary: String(meta.summary || args.summary || '').trim() };
      } else if (!meta.duplicate && !meta.failed) {
        newInformation = true;
      }
      if (meta.path) filesRead.push(String(meta.path));
      if (Array.isArray(meta.paths)) filesRead.push(...meta.paths.map(String));
      toolHistory.push({ turn, name, args, ...meta, contentChars: content.length });
      onEvent({ type: 'tool-done', turn, name, args, ...meta, contentChars: content.length });
      history.push({ role: 'tool', tool_call_id: call.id, content });
    }
    if (finishRequested) {
      return finishWithOneProduct({ turn, summary: finishRequested.summary });
    }
    if (newInformation) {
      noProgressTurns = 0;
    } else {
      noProgressTurns += 1;
      history.push({
        role: 'user',
        content: noProgressTurns >= 2
          ? '连续两轮没有获得新资料。停止重复核对，立即进入最终成品阶段。'
          : `本轮没有获得新资料。除非还有明确且尚未读取的必要文件，否则立即调用 ${finishToolName || '结束读取工具'}。`
      });
      if (noProgressTurns >= 2 && finalInstruction) {
        return finishWithOneProduct({ turn, summary: '没有发现新的必要资料，使用已读取内容完成。', forced: true });
      }
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => { clearTimeout(timer); reject(new ApiError('本次任务已取消。')); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ *
 * 上下文轮换：一个对话最多 N 集
 * ------------------------------------------------------------------ */

class Conversation {
  constructor({ system, cap, maxContextChars = 900000, id = 1 } = {}) {
    this.system = String(system || '');
    this.cap = Math.max(1, Number(cap) || 3);
    this.maxContextChars = maxContextChars;
    this.id = id;
    this.turns = [];
    this.dropped = 0;
  }

  get filled() { return this.turns.length; }

  get isFull() { return this.turns.length >= this.cap; }

  /** 满了才轮换；空对话不轮换 */
  rotateIfNeeded() {
    if (!this.turns.length) return false;
    if (!this.isFull) return false;
    this.reset();
    return true;
  }

  reset() {
    this.dropped += this.turns.length;
    this.turns = [];
    this.id += 1;
  }

  push(userText, assistantText) {
    this.turns.push({ user: String(userText || ''), assistant: String(assistantText || '') });
  }

  messages(nextUserText) {
    const list = [];
    if (this.system) list.push({ role: 'system', content: this.system });
    for (const turn of this.turns) {
      list.push({ role: 'user', content: turn.user });
      list.push({ role: 'assistant', content: turn.assistant });
    }
    if (nextUserText !== undefined) list.push({ role: 'user', content: String(nextUserText) });
    return list;
  }

  describe() {
    return { conversationId: this.id, filled: this.filled, cap: this.cap, dropped: this.dropped };
  }
}

/* ------------------------------------------------------------------ *
 * 输出清洗
 * ------------------------------------------------------------------ */

function unwrapFences(raw) {
  let text = String(raw || '').trim();
  const whole = text.match(/^```(?:txt|text|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n?```$/);
  if (whole) return whole[1].trim();
  // 只拆除完整的外层围栏；开头有围栏但结尾缺失时必须保留截断证据。
  return text.trim();
}

/** 去掉模型常见的开场白与收尾寒暄 */
function stripPreamble(text) {
  const lines = String(text || '').split(/\r?\n/);
  const chatter = /^(好的|以下是|下面是|这是|已按|根据你的|希望|如需|以上是|注：|说明：|注意：)/;
  while (lines.length && (!lines[0].trim() || chatter.test(lines[0].trim()))) lines.shift();
  while (lines.length && (!lines[lines.length - 1].trim() || chatter.test(lines[lines.length - 1].trim()))) lines.pop();
  return lines.join('\n').trim();
}

function normalizeReply(raw) {
  let text = stripPreamble(unwrapFences(raw));
  // 成品结束标记之后的内容属于模型继续思考/重复生成的尾巴，不能再
  // 混入正文。某些自定义接口不支持工具调用，会绕过 runToolAgent 的
  // stopMarker，因此这里再做一次最终兜底。
  const marker = '<<<AIGC_FINAL_DONE>>>';
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) text = text.slice(0, markerIndex).trimEnd();
  return text;
}

function modelDisplayName(model) {
  const id = String(model || '').trim();
  if (/deepseek-flash/i.test(id)) return 'DeepSeek V4.1 Flash';
  if (/deepseek-v4-pro/i.test(id)) return 'DeepSeek V4 Pro';
  return id || '未知模型';
}

function modelFamily(model) {
  const id = String(model || '').toLowerCase();
  if (id.includes('flash')) return 'flash';
  if (id.includes('pro')) return 'pro';
  return '';
}

function assertResponseModel(requestedModel, responseModel) {
  const requested = modelFamily(requestedModel);
  const actual = modelFamily(responseModel);
  if (requested && actual && requested !== actual) {
    throw new ApiError(`已选择 ${modelDisplayName(requestedModel)}，但接口实际返回 ${modelDisplayName(responseModel)}。本集已停止且不会写入文件，请检查服务商的模型映射。`);
  }
}

function stampOneModelHeader(content, model) {
  const header = `【生成模型：${modelDisplayName(model)}】`;
  const marker = /^[ \t]*【生成模型[：:][^\r\n】]*】[ \t]*$/gmi;
  let found = false;
  const replaced = String(content || '').replace(marker, () => { found = true; return header; }).trim();
  return found ? replaced : `${header}\n\n${replaced}`.trim();
}

/** 模型名称由接口响应写入，避免让模型在正文里自行猜测后把 Flash 写成 Pro。 */
function stampGenerationModel(content, model, kind = '') {
  const text = String(content || '').trim();
  if (kind === 'pair') {
    const parts = splitBundle(text);
    if (parts.ok) {
      return `${stampOneModelHeader(parts.shotlist, model)}\n\n${BUNDLE_DELIMITER}\n\n${stampOneModelHeader(parts.storyboard, model)}`;
    }
  }
  return stampOneModelHeader(text, model);
}

/* ------------------------------------------------------------------ *
 * 结构完整性校验 —— 拦住"半截产物"
 * ------------------------------------------------------------------ */

const SHOTLIST_COLUMNS = ['镜号', '时长', '景别', '摄法', '拍摄角度', '构图', '画面内容', '台词', '音效', '入镜角色', '场景', '时间地点'];

const CLOSERS = /[。！？…”"』」）)】\]》>|*}》」]$/;
const DANGLING = /[、，：；「『（(【\[《<—–\-△{]$/;

function splitTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|')) return null;
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * 模型在达到单次输出上限后续写，有时会把上一轮未完成的表格行和
 * 下一轮完整重写的同一行直接粘在一起：
 *   | 32 | ... | 薛妩：你咬他大| 32 | ...完整内容... |
 * 这不是内容缺失，而是同一镜头的重复前缀。只在“行数超 12、首尾镜号
 * 相同、后半段恰好是完整 12 列”这三个条件同时满足时保留后半行，避免
 * 对普通表格或正文中的竖线做猜测性改写。
 */
function normalizeConcatenatedShotRows(text) {
  const source = String(text || '');
  const repairs = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (!cells || cells.length <= SHOTLIST_COLUMNS.length) continue;
    const numbers = [...lines[index].matchAll(/\|\s*(\d{1,4})\s*\|/g)].map((item) => Number(item[1]));
    if (numbers.length < 2 || numbers[0] !== numbers[numbers.length - 1]) continue;
    const last = lines[index].lastIndexOf(`| ${numbers[numbers.length - 1]} |`);
    const fallbackLast = lines[index].lastIndexOf(`|${numbers[numbers.length - 1]}|`);
    const start = Math.max(last, fallbackLast);
    if (start <= 0) continue;
    const candidate = lines[index].slice(start).trim();
    const candidateCells = splitTableRow(candidate);
    if (!candidateCells || candidateCells.length !== SHOTLIST_COLUMNS.length) continue;
    lines[index] = candidate;
    repairs.push(`第 ${index + 1} 行：检测到镜头 ${numbers[0]} 的续写粘连，保留后半段完整 12 列行。`);
  }
  return { normalizedContent: lines.join('\n'), formatRepairs: repairs };
}

/** 保留字符位置，遮住代码内容及转义标记，避免把字面量当 Markdown。 */
function markdownScan(text) {
  const source = String(text || '');
  const chars = source.split('');
  const hide = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
    }
  };
  let fence = null;
  let offset = 0;
  for (const line of source.split('\n')) {
    const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/);
    if (fence) {
      hide(offset, offset + line.length);
      if (opening && opening[1][0] === fence.character && opening[1].length >= fence.length && !opening[2].trim()) fence = null;
    } else if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      hide(offset, offset + line.length);
    }
    offset += line.length + 1;
  }
  let masked = chars.join('');
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === '\\' && /[*`【】\\]/.test(masked[index + 1] || '')) {
      hide(index + 1, index + 2);
      index += 1;
      continue;
    }
    if (masked[index] !== '`') continue;
    let length = 1;
    while (masked[index + length] === '`') length += 1;
    let close = index + length;
    let found = -1;
    while (close < masked.length) {
      close = masked.indexOf('`', close);
      if (close < 0) break;
      let closeLength = 1;
      while (masked[close + closeLength] === '`') closeLength += 1;
      if (closeLength === length) { found = close; break; }
      close += closeLength;
    }
    if (found >= 0) { hide(index, found + length); index = found + length - 1; }
    else index += length - 1;
  }
  masked = chars.join('');
  return { masked, unclosedFence: Boolean(fence) };
}

function boldMarkers(masked) {
  const markers = [];
  for (const match of masked.matchAll(/\*{2,}/g)) {
    // 四个及以上星号也可能是分隔线，不擅自重写。
    if (match[0].length > 3) continue;
    const before = masked[match.index - 1] || '';
    const after = masked[match.index + match[0].length] || '';
    markers.push({ at: match.index, length: match[0].length,
      open: Boolean(after && !/\s/.test(after)), close: Boolean(before && !/\s/.test(before)) });
  }
  return markers;
}

/** 只移除无法配对的排版符号；绝不补句子、场景、对白或镜头。 */
function normalizeMarkdownFormatting(text) {
  const source = String(text || '');
  const { masked } = markdownScan(source);
  const markers = boldMarkers(masked);
  const pending = [];
  const unmatched = [];
  let previous = 0;
  for (const marker of markers) {
    // 加粗可跨行，但不能跨空段落。忽略合法跨行加粗中的奇数单行。
    if (/\r?\n[ \t]*\r?\n/.test(masked.slice(previous, marker.at))) {
      unmatched.push(...pending.splice(0));
    }
    if (marker.close && pending.length) pending.pop();
    else if (marker.open) pending.push(marker);
    else if (marker.close) unmatched.push(marker);
    // 两边都是空白的 ** 是字面标记，不当成需要修复的加粗。
    previous = marker.at + marker.length;
  }
  unmatched.push(...pending);
  unmatched.sort((a, b) => a.at - b.at);
  let normalizedContent = source;
  for (const marker of [...unmatched].reverse()) {
    normalizedContent = normalizedContent.slice(0, marker.at) + normalizedContent.slice(marker.at + marker.length);
  }
  const formatRepairs = unmatched.map((marker) => {
    const line = source.slice(0, marker.at).split('\n').length;
    return `第 ${line} 行：移除未配对的加粗标记，正文文字保持原样。`;
  });
  const warnings = unmatched.length
    ? [`发现 ${unmatched.length} 处未配对的加粗排版，已在本地整理；没有改动正文或重新调用模型。`]
    : [];
  return { normalizedContent, formatRepairs, warnings };
}

function validateFormattedContent(text, validate) {
  const formatting = normalizeMarkdownFormatting(text);
  const verdict = validate(formatting.normalizedContent);
  const problems = [...verdict.problems];
  if (!formatting.normalizedContent.trim() && !problems.includes('输出为空。')) problems.unshift('输出为空。');
  const normalizedContent = verdict.normalizedContent ?? formatting.normalizedContent;
  return { ...verdict, ok: problems.length === 0, problems,
    warnings: [...formatting.warnings, ...(verdict.warnings || [])],
    normalizedContent,
    formatRepairs: [...formatting.formatRepairs, ...(verdict.formatRepairs || [])] };
}

/** 实质截断信号：空正文、围栏或内容标签未闭合；粗体错误独立本地处理。 */
function balanceProblems(text) {
  const problems = [];
  if (!String(text || '').trim()) return ['输出为空。'];
  const { masked, unclosedFence } = markdownScan(text);
  if (unclosedFence) problems.push('代码围栏未闭合，疑似被截断。');
  const open = (masked.match(/【/g) || []).length;
  const close = (masked.match(/】/g) || []).length;
  if (open !== close) problems.push(`【】标记不配对（${open} 开 / ${close} 闭），疑似被截断。`);
  return problems;
}

/** 去掉活动的粗体符号再检查结尾，避免 ** 掩盖未完成句或题头。 */
function semanticTail(text) {
  const source = String(text || '');
  const markers = boldMarkers(markdownScan(source).masked);
  let plain = source;
  for (const marker of markers.reverse()) plain = plain.slice(0, marker.at) + plain.slice(marker.at + marker.length);
  // 单星号斜体或多星号排版也不能充当正文的句末标点。
  plain = plain.trimEnd().replace(/(?<!\\)[*_]+$/, '').trimEnd();
  return stripEndMarkers(plain).trimEnd();
}

function tailIsBareHeader(text, kind) {
  const line = semanticTail(text).split(/\r?\n/).filter((item) => item.trim()).pop()?.trim().replace(/^#{1,6}\s*/, '') || '';
  if (kind === 'script') {
    return /^\d{1,4}\s*[-–—_]\s*\d{1,3}(?!\d)(?:\s|[.、:：]|$)/.test(line)
      || /^(?:场景|Scene)\s*[一二三四五六七八九十百\d]+\s*[:：.、]/i.test(line)
      || /^\d{1,4}\s+[\s\S]*\[(?:内|外)\]\s*\[[^\]\n]{1,4}\]/.test(line);
  }
  return kind === 'storyboard' && /^第\s*\d+\s*组\s*[（(]/.test(line);
}

/**
 * 去掉结尾的成片标记再判断，例如 `——本集完——` / `（完）` / `【本集完】`。
 * 不去掉的话这些正当收尾会被误判成"结尾不完整"。
 */
function stripEndMarkers(text) {
  return String(text || '')
    // ——本集完—— / ——第二季终—— / ——全剧终—— 这类破折号包起来的收尾标记
    .replace(/[\s]*[-—–－]{2,}\s*[^\n]{0,12}?(?:完|终)\s*[-—–－]{2,}\s*$/, '')
    // （完）/【本集完】/【第一季终】 这类括号收尾标记
    .replace(/[\s]*[（(【\[]\s*[^\n]{0,12}?(?:完|终)\s*[）)】\]]\s*$/, '')
    .trim();
}

/**
 * 结尾是否像被截断。
 * 两种信号分开处理：
 *   结尾停在断句符号上（、，：；「『（(【[《<—–-△{）→ 强信号，一律算截断
 *   结尾没有任何句末标点                    → 弱信号，由调用方决定是否算问题
 */
function tailLooksTruncated(text) {
  const tail = semanticTail(text);
  if (!tail) return false;
  if (DANGLING.test(tail)) return true;
  return !CLOSERS.test(tail);
}

/** 尾行是不是一条结构完整的镜头行（镜头号 + 区间/分隔符 都齐全） */
function isCompleteShotLine(line) {
  const text = String(line || '').trim();
  if (!SHOT_LINE.test(text)) return false;
  if (/\[\s*\d+\s*秒?\s*[-–—~至]\s*\d+\s*秒?\s*[\]）)]/.test(text)) return true;
  return (text.match(/[|｜]/g) || []).length >= 3;
}

/* ------------------------------------------------------------------ *
 * 结构识别用的模式
 *
 * 设计原则（重要）：不同项目、不同时期的产物格式差别很大 —— 实测见过
 *   · 台词加粗  **薛无**：台词      与  不加粗  薛无（急忙）：台词
 *   · 题头 **77-1 场景 [内][夜]**  与  52-1 场景 [内][日]  (36s)
 *   · 时段 日/夜/上午/中午/午/下午/傍晚/晚/午后/晨/早 共 11 种
 *   · 提示词有分组的，也有整集一条平铺的
 * 所以：**实质截断信号（内容标签不闭合、结尾悬空）一律硬拦；
 * 只涉及粗体排版时本地整理，绝不因此反复请求生成；
 * 格式没认出来只警告不拦；格式认出来了但内部自相矛盾才硬拦。**
 * 否则校验器会把用户合法的历史产物全部拒之门外。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 可开关的校验项
 *
 * 每一项都能在「AI 直连」页单独关掉，关掉后既不拦也不警告。
 * severity:
 *   error → 命中的话**不写文件**，属于"这批产物肯定有问题"
 *   warn  → 照写，但在日志里打 ⚠，属于"规范类提醒，你人工看一眼"
 * scope: all / script / shotlist / storyboard
 * ------------------------------------------------------------------ */

const VALIDATION_CHECKS = [
  { id: 'balancedMarkers', label: '标记闭合', scope: 'all', severity: 'error', default: true,
    desc: '检查内容标签【】和代码围栏是否闭合；单独的粗体排版错误会在本地整理，不会因此停止生成。' },
  { id: 'tailComplete', label: '结尾完整性', scope: 'all', severity: 'error', default: true,
    desc: '结尾不能停在断句符号上（、，：；（【[—△{），也不能整段没有句末标点。' },
  { id: 'sceneHeaders', label: '剧本场景题头', scope: 'script', severity: 'warn', default: true,
    desc: '至少要有「场号 场景名 [内/外] [时段]」形式的题头。认不出来只警告不拦。' },
  { id: 'dialogueLines', label: '剧本台词行', scope: 'script', severity: 'error', default: true,
    desc: '至少要有可识别的台词行：加粗「**角色**：」、提示式「角色（动作）：」或普通「角色：」。' },
  { id: 'tableHeader', label: '分镜表 12 列', scope: 'shotlist', severity: 'error', default: true,
    desc: '找到表头后逐行核对列数；某行列数不对视为表格被截断。列名与标准不同只警告。' },
  { id: 'shotNumbering', label: '分镜镜号连续', scope: 'shotlist', severity: 'warn', default: true,
    desc: '镜号应从 1 起连续递增。' },
  { id: 'groupHeaders', label: '提示词分组标题', scope: 'storyboard', severity: 'error', default: true,
    desc: '识别「第X组（镜头A-B，总时长XX秒）」。没有分组但有镜头行时只警告。' },
  { id: 'groupShotRange', label: '分组镜头范围', scope: 'storyboard', severity: 'error', default: true,
    desc: '写出的镜头不能少于组标题声明的数量（少 = 截断）。多出来只警告。' },
  { id: 'groupDuration', label: '分组时长自洽', scope: 'storyboard', severity: 'warn', default: true,
    desc: '组内镜头秒数合计要与组标题的总时长一致；单组不超过设定上限。' },
  { id: 'styleBlock', label: '统一风格段', scope: 'storyboard', severity: 'warn', default: true,
    desc: '整集通常只出现一次【统一风格与约束】。' }
];

function defaultValidationChecks() {
  const checks = {};
  for (const item of VALIDATION_CHECKS) checks[item.id] = item.default;
  return checks;
}

/** 把项目里存的开关合并成"是否启用"的判断函数 */
function resolveValidationChecks(value) {
  const merged = { ...defaultValidationChecks(), ...(value && typeof value === 'object' ? value : {}) };
  const known = new Set(VALIDATION_CHECKS.map((item) => item.id));
  return {
    values: merged,
    on: (id) => (known.has(id) ? merged[id] !== false : false)
  };
}

const SCENE_HEADER = /^\s*(?:\*\*)?\s*\d{1,4}(?:\s*[-–—_]\s*\d{1,3})?\s*[\.、]?\s+\S+\s*\[(?:内|外)\]\s*\[[^\]\n]{1,4}\]\s*(?:\*\*)?/gm;
const DIALOGUE_BOLD = /\*\*[^*\n]{1,14}\*\*\s*[：:]/g;
const DIALOGUE_HINT = /^[\u4e00-\u9fffA-Za-z·]{1,10}\s*[（(][^）)\n]{1,12}[）)]\s*[：:]\s*\S/gm;
const DIALOGUE_PLAIN = /^([\u4e00-\u9fffA-Za-z·]{1,10})\s*[：:]\s*\S/gm;
// 这些是元信息行，长得像「角色：台词」但不是台词
const META_LEAD = new Set([
  '人物', '出场人物', '对应小说章节', '源自小说', '预计时长', '任务类型', '参考素材', '声音',
  '分镜序列', '生成模型', '核心角色', '核心场景', '核心道具', '音色参考', '统一风格与约束',
  '正文剧本', '后期字幕', '后期剪辑', '备注', '说明', '注', '镜号', '时间地点', '场景'
]);

function countScriptDialogues(text) {
  const bold = (text.match(DIALOGUE_BOLD) || []).length;
  const hint = (text.match(DIALOGUE_HINT) || []).length;
  let plain = 0;
  for (const match of text.matchAll(DIALOGUE_PLAIN)) {
    if (!META_LEAD.has(match[1])) plain += 1;
  }
  return { total: bold + hint + plain, bold, hint, plain };
}

// 镜头行实际有两种写法，都要认：
//   镜头1：[0秒-2秒]，中心构图，全景，平视，…   ← 老项目在用的写法
//   镜头2 | 4秒 | 近景 | 描述…                  ← 竖线表格式写法
const SHOT_LINE = /^镜头\s*\d+\s*[:：|｜]/;

/** 从镜头行里取时长（秒）。支持 [起-止]、| N秒 | 与 ：N秒 三种写法 */
function shotSeconds(line) {
  const text = String(line);
  const range = text.match(/\[\s*(\d+)\s*秒?\s*[-–—~至]\s*(\d+)\s*秒?\s*[\]）)]/);
  if (range) return Math.max(0, Number(range[2]) - Number(range[1]));
  const piped = text.match(/[|｜]\s*(\d+)\s*秒/);
  if (piped) return Number(piped[1]);
  const single = text.match(/[:：]\s*(\d+)\s*秒/);
  if (single) return Number(single[1]);
  return 0;
}

function validateScriptContent(text, checksOrOn) {
  const on = typeof checksOrOn === 'function' ? checksOrOn : resolveValidationChecks(checksOrOn).on;
  const problems = on('balancedMarkers') ? balanceProblems(text) : [];
  const warnings = [];
  if (on('tailComplete') && tailLooksTruncated(text)) problems.push('剧本以断句符号或未完成句结尾，疑似被截断。');
  if (on('tailComplete') && tailIsBareHeader(text, 'script')) problems.push('剧本结尾只有场景题头、缺少该场正文，疑似被截断。');

  const scenes = on('sceneHeaders') ? (text.match(SCENE_HEADER) || []).length : 0;
  const dialogues = on('dialogueLines') ? countScriptDialogues(text) : { total: 1, bold: 0, hint: 0, plain: 0 };

  if (on('sceneHeaders') || on('dialogueLines')) {
    if (!scenes && !dialogues.total) {
      problems.push('既没有场景题头、也没有任何可识别的台词行，完全不像剧本，疑似生成失败或被截断。');
    } else if (!scenes && on('dialogueLines')) {
      warnings.push('没有解析到场景题头（本项目剧本可能用别的题头写法，已放行，请人工确认）。');
    } else if (!dialogues.total && on('sceneHeaders')) {
      problems.push(`解析到 ${scenes} 个场景题头，但没有任何可识别的台词行，疑似被截断。`);
    }
  }
  if (on('dialogueLines') && (dialogues.hint || dialogues.plain)) {
    warnings.push(`台词以非加粗形式书写（加粗 ${dialogues.bold} 行 / 提示式 ${dialogues.hint} 行 / 普通 ${dialogues.plain} 行），已按本项目既有写法放行。`);
  }
  return { ok: problems.length === 0, problems, warnings, stats: { scenes, dialogues: dialogues.total } };
}

function validateShotlistContent(text, checksOrOn) {
  const on = typeof checksOrOn === 'function' ? checksOrOn : resolveValidationChecks(checksOrOn).on;
  const tableRepair = normalizeConcatenatedShotRows(text);
  const normalizedText = tableRepair.normalizedContent;
  const problems = on('balancedMarkers') ? balanceProblems(normalizedText) : [];
  const warnings = [];
  // 两部分之间的 Markdown 分隔线不是正文中的断句破折号。
  // 仅略过独占行的分隔线；最后一条真实镜头仍要检查完整性。
  const tailContent = normalizedText.replace(/(?:\r?\n[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}))+\s*$/, '').trimEnd();
  if (on('tailComplete') && tailLooksTruncated(tailContent)) problems.push('分镜表以断句符号或未完成行结尾，疑似被截断。');
  const lines = normalizedText.split(/\r?\n/);
  let headerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (cells && cells.length >= 8 && cells[0].includes('镜号')) { headerIndex = index; break; }
  }
  if (headerIndex < 0) {
    if (!on('tableHeader')) return { ok: problems.length === 0, problems, warnings, stats: { rows: 0, shots: 0 }, normalizedContent: normalizedText, formatRepairs: tableRepair.formatRepairs };
    const anyRow = lines.some((line) => splitTableRow(line));
    if (anyRow) warnings.push('没有找到标准表头（含「镜号」的 12 列表），本项目可能用别的分镜格式，已放行，请人工确认。');
    else problems.push('既没有分镜表表头、也没有任何表格行，完全不像分镜表，疑似生成失败或被截断。');
    return { ok: problems.length === 0, problems, warnings, stats: { rows: 0, shots: 0 }, normalizedContent: normalizedText, formatRepairs: tableRepair.formatRepairs };
  }
  const header = splitTableRow(lines[headerIndex]);
  if (header.length !== SHOTLIST_COLUMNS.length) {
    if (on('tableHeader')) problems.push(`分镜表表头为 ${header.length} 列，应为 12 列。`);
  } else {
    const mismatch = SHOTLIST_COLUMNS.filter((name, index) => header[index] !== name);
    if (mismatch.length && on('tableHeader')) warnings.push(`分镜表列名与标准略有差异：${mismatch.join('、')}（已放行，请人工确认）。`);
  }
  let rows = 0;
  let previousShot = 0;
  const badRows = [];
  const badShotNo = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (!cells) continue;
    if (isSeparatorRow(cells)) continue;
    rows += 1;
    if (cells.length !== 12) badRows.push(index + 1);
    const shotNo = Number(String(cells[0]).replace(/[^\d]/g, ''));
    if (!Number.isFinite(shotNo) || shotNo !== previousShot + 1) badShotNo.push(`${lines[index].slice(0, 24)}…`);
    else previousShot = shotNo;
  }
  if (!rows) {
    if (on('tableHeader')) problems.push('分镜表只有表头、没有任何数据行，疑似被截断。');
  } else {
    // 表头在、行数不对 = 表格被截断，硬拦
    if (badRows.length && on('tableHeader')) problems.push(`有 ${badRows.length} 行列数不等于 12（第 ${badRows.slice(0, 5).join('、')} 行），表格疑似被截断。`);
    if (badShotNo.length && on('shotNumbering')) warnings.push(`镜号不是从 1 起严格连续：${badShotNo.slice(0, 3).join(' / ')}（已放行，请人工确认）。`);
  }
  return { ok: problems.length === 0, problems, warnings, stats: { rows, shots: previousShot }, normalizedContent: normalizedText, formatRepairs: tableRepair.formatRepairs };
}

function validateStoryboardContent(text, options = {}) {
  const on = typeof options.on === 'function' ? options.on : resolveValidationChecks(options.checks).on;
  const groupMaxSeconds = Number(options.groupMaxSeconds) || 30;
  const groupMaxShots = Number(options.groupMaxShots) || 0;
  const problems = on('balancedMarkers') ? balanceProblems(text) : [];
  const warnings = [];
  // 尾行本身是一条写完整的镜头行时，不因为"没有句末标点"判截断
  const tailLine = text.trimEnd().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '';
  if (on('tailComplete') && tailLooksTruncated(text)
    && (!isCompleteShotLine(tailLine) || DANGLING.test(semanticTail(text)))) {
    problems.push('提示词以断句符号或未完成行结尾，疑似被截断。');
  }
  if (on('tailComplete') && tailIsBareHeader(text, 'storyboard')) problems.push('提示词结尾只有分组标题、缺少该组镜头正文，疑似被截断。');

  const styleBlocks = on('styleBlock') ? (text.match(/【统一风格与约束】/g) || []).length : 0;
  if (on('styleBlock') && styleBlocks > 1) warnings.push(`【统一风格与约束】出现了 ${styleBlocks} 次，整集通常只出现一次（已放行，请人工确认本集是否被拼成了多段）。`);

  const headerRegex = /^第(\d+)组（镜头(\d+)-(\d+)，总时长(\d+)秒）.*$/gm;
  const groups = [];
  let match;
  while ((match = headerRegex.exec(text))) {
    groups.push({
      group: Number(match[1]),
      from: Number(match[2]),
      to: Number(match[3]),
      seconds: Number(match[4]),
      at: match.index
    });
  }

  const allShotLines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => SHOT_LINE.test(line));

  if (!groups.length) {
    if (!on('groupHeaders')) return { ok: problems.length === 0, problems, warnings, stats: { groups: 0, shots: allShotLines.length } };
    // 没有分组标题但有镜头行 → 本项目就是平铺结构，放行（只警告）
    if (allShotLines.length) {
      warnings.push(`没有分组标题（「第X组（镜头A-B，总时长XX秒）」），本集是平铺镜头结构，已放行（共 ${allShotLines.length} 个镜头行）。`);
      return { ok: problems.length === 0, problems, warnings, stats: { groups: 0, shots: allShotLines.length } };
    }
    problems.push('既没有分组标题、也没有任何镜头行，完全不像分镜提示词，疑似生成失败或被截断。');
    return { ok: problems.length === 0, problems, warnings, stats: { groups: 0, shots: 0 } };
  }

  if (!styleBlocks && on('styleBlock')) warnings.push('没有【统一风格与约束】段落（本集规范可能不含此项，已放行）。');
  const rawHeaderCount = (text.match(/^第\d+组（/gm) || []).length;
  if (rawHeaderCount !== groups.length && on('groupHeaders')) warnings.push('存在无法解析的分组标题（括号或「总时长XX秒」写法不符），已放行，请人工确认。');

  let previousTo = 0;
  groups.forEach((group, index) => {
    const label = `第${group.group}组`;
    const end = groups[index + 1]?.at ?? text.length;
    const body = text.slice(group.at, end);
    const ranged = on('groupShotRange');
    if (group.group !== index + 1 && ranged) warnings.push(`${label} 组号不连续。`);
    if (group.from !== previousTo + 1 && ranged) warnings.push(`${label} 起始镜号 ${group.from} 与上一组结尾 ${previousTo} 不衔接。`);
    if (group.to < group.from && ranged) problems.push(`${label} 镜号范围倒置。`);
    const dur = on('groupDuration');
    if (dur && group.seconds <= 4) warnings.push(`${label} 总时长 ${group.seconds} 秒，低于 4 秒下限，通常应与相邻组并组。`);
    if (dur && group.seconds > groupMaxSeconds) warnings.push(`${label} 总时长 ${group.seconds} 秒，超出 ${groupMaxSeconds} 秒上限。`);
    const shotCount = group.to - group.from + 1;
    if (dur && groupMaxShots && shotCount > groupMaxShots) warnings.push(`${label} 含 ${shotCount} 个镜头，超出 ${groupMaxShots} 镜上限。`);

    const shotLines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => SHOT_LINE.test(line));
    if (!shotLines.length) {
      if (ranged) problems.push(`${label} 只有标题、没有任何镜头行，疑似被截断。`);
    } else {
      const lastShot = Number(String(shotLines[shotLines.length - 1]).match(/\d+/)?.[0] || 0);
      // 写出的镜头比声明的少 → 截断，硬拦；比声明的多 → 只是分组不一致，警告
      if (ranged && lastShot < group.to) problems.push(`${label} 声明到镜头 ${group.to}，实际只写到镜头 ${lastShot}，疑似被截断。`);
      else if (ranged && lastShot > group.to) warnings.push(`${label} 声明到镜头 ${group.to}，实际写到镜头 ${lastShot}，分组范围与内容不符。`);
      if (ranged && group.to >= group.from && lastShot >= group.to) {
        const shotNumbers = new Set(shotLines.map((line) => Number(line.match(/\d+/)?.[0] || 0)));
        const missing = [];
        for (let shot = group.from; shot <= group.to; shot += 1) {
          if (!shotNumbers.has(shot)) missing.push(shot);
          if (missing.length >= 10) break;
        }
        if (missing.length) problems.push(`${label} 缺少声明范围内的镜头 ${missing.join('、')}${missing.length >= 10 ? '等' : ''}，疑似被截断。`);
      }
      const shotSum = shotLines.reduce((sum, line) => sum + shotSeconds(line), 0);
      if (dur && shotSum && Math.abs(shotSum - group.seconds) > 1) {
        warnings.push(`${label} 声明总时长 ${group.seconds} 秒，组内镜头秒数合计 ${shotSum} 秒，对不上。`);
      }
    }
    previousTo = group.to;
  });

  if (/【台词整合】|【台词文稿匹配】/.test(text)) warnings.push('出现了【台词整合】或【台词文稿匹配】（本项目规范通常不输出这两项）。');
  return { ok: problems.length === 0, problems, warnings, stats: { groups: groups.length, shots: previousTo } };
}

function validateScript(text, checksOrOn) {
  return validateFormattedContent(text, (content) => validateScriptContent(content, checksOrOn));
}

function validateShotlist(text, checksOrOn) {
  return validateFormattedContent(text, (content) => validateShotlistContent(content, checksOrOn));
}

function validateStoryboard(text, options = {}) {
  return validateFormattedContent(text, (content) => validateStoryboardContent(content, options));
}

/* ------------------------------------------------------------------ *
 * 一次出两份：剧本 →（分镜表 ＋ Seedance 提示词）
 *
 * 实际生产中这两步通常合并成一次调用：模型先写出 12 列分镜表，
 * 紧接着在同一份回复里写出提示词。程序按分隔行拆成两个文件分别落盘。
 * ------------------------------------------------------------------ */

const BUNDLE_DELIMITER = '===提示词===';
// 模型经常把第二段标题写成「## 生视频提示词（第127集）」或
// 「## 视频提示词：第127集」。旧正则只接受恰好一行“提示词”，
// 这会把已经完整返回的两段误判成“只返回了分镜表”，进而停止批量任务。
// 标题是结构提示，不是正文；这里允许常见的“生视频/视频/Seedance/分镜”前缀和集数后缀。
const BUNDLE_DELIMITER_LINE = /^[ \t]*={2,}[ \t]*(?:Seedance[ \t]*)?(?:(?:生)?视频[ \t]*)?(?:分镜[ \t]*)?提示词(?:[ \t]*[（(][^\n]{0,40}[）)])?[ \t]*={2,}[ \t]*$/mi;
const BUNDLE_HEADING_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:【[ \t]*)?(?:第二(?:部分|份成品)[：:\-— \t]*)?(?:Seedance[ \t]*)?(?:2\.0[ \t]*)?(?:(?:生)?视频[ \t]*)?(?:分镜[ \t]*)?提示词(?:[ \t]*】)?(?:[ \t]*[（(][^\n]{0,40}[）)]|[ \t]*[：:\-—]?[ \t]*(?:第[ \t]*)?\d{1,4}[ \t]*(?:集[上中下]?|[上中下]集))?[：:]?[ \t]*$/gmi;
// 模型有时会给标题加 Markdown 粗体、引用符，或在整行前面混入 BOM/零宽字符。
// 这些字符不属于正文结构，清掉后再识别，避免“正文已经完整但只认到分镜表”的误报。
const BUNDLE_LOOSE_HEADING_LINE = /^[ \t>*`_~]*(?:#{1,6}[ \t]*)?(?:【[ \t]*)?(?:(?:第二(?:部分|份成品)|第[二2]部分)[：:\-— \t]*)?(?:Seedance[ \t]*)?(?:2\.0[ \t]*)?(?:(?:生)?视频[ \t]*)?(?:分镜[ \t]*)?提示词[^\r\n]{0,80}[】*_`~]*[ \t]*$/gmi;

// 切分只识别文档身份，不能拿完整质量校验作门槛。否则一个缺列的表格
// 会把已经存在的提示词一起藏掉，用户只能看到误导性的“模型只返回分镜表”。
function looksLikeShotlist(text) {
  return String(text || '').split(/\r?\n/).some((line) => {
    const cells = splitTableRow(line);
    return cells && cells.length >= 8 && (/(?:镜号|镜头号)/.test(cells[0])
      || (/\d/.test(cells[0]) && !isSeparatorRow(cells)));
  });
}

/** 用实际镜头行核对两份成品，声明到镜头 N 不代表真的写了 N 个镜头。 */
function bundleCoverage(shotlist, storyboard) {
  const lines = String(shotlist || '').split(/\r?\n/);
  const header = lines.findIndex((line) => {
    const cells = splitTableRow(line);
    return cells && cells.length >= 8 && /(?:镜号|镜头号)/.test(cells[0]);
  });
  const expected = new Set();
  for (const line of lines.slice(header < 0 ? 0 : header + 1)) {
    const cells = splitTableRow(line);
    if (!cells || cells.length < 8 || isSeparatorRow(cells)) continue;
    const number = String(cells[0]).match(/\d+/);
    if (number && Number(number[0]) > 0) expected.add(Number(number[0]));
  }
  const actual = new Set();
  for (const line of String(storyboard || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!SHOT_LINE.test(trimmed)) continue;
    actual.add(Number(trimmed.match(/\d+/)[0]));
  }
  const expectedShots = [...expected].sort((a, b) => a - b);
  const actualShots = [...actual].sort((a, b) => a - b);
  const missingShots = expectedShots.filter((number) => !actual.has(number));
  return { expectedShots, actualShots, missingShots,
    complete: expectedShots.length > 0 && missingShots.length === 0 };
}

function bundleCandidates(text) {
  const candidates = [];
  const exact = BUNDLE_DELIMITER_LINE.exec(text);
  if (exact) candidates.push(exact);
  for (const match of text.matchAll(BUNDLE_HEADING_LINE)) candidates.push(match);
  // 宽松兜底只用于“已确认前半段是分镜表”的文本，兼容 **## 生视频提示词（第N集）**、
  // > 视频提示词：第N集 等模型装饰写法。后续仍会经过提示词质量与镜头覆盖校验。
  for (const match of text.matchAll(BUNDLE_LOOSE_HEADING_LINE)) candidates.push(match);
  // 有些模型完全省略标题，直接从第一组提示词开始。只有前半段已像 12 列分镜表时才采用。
  // 有些版本没有第二段标题，直接从第一组或提示词的第一个结构块开始。
  // 只有前半段已经像 12 列分镜表时才采用，避免误切正文中的同名标签。
  for (const pattern of [
    /^[ \t]*第\s*1\s*组[（(]/gm,
    /^[ \t]*【核心角色】/gm,
    /^[ \t]*【核心场景】/gm,
    /^[ \t]*【分镜序列】/gm,
    /^[ \t]*【统一风格与约束】/gm
  ]) {
    for (const match of text.matchAll(pattern)) { match.separatorLength = 0; candidates.push(match); }
  }
  return candidates.sort((a, b) => a.index - b.index);
}

/** 把"分镜表 + 提示词"的合并输出拆成两段 */
function splitBundle(content) {
  // 只移除会破坏“行首标题”识别的不可见字符；不改动正常中文、换行和标点。
  const text = String(content || '').replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '');
  const candidates = bundleCandidates(text);
  const match = candidates.find((candidate) => {
    const before = text.slice(0, candidate.index).trim();
    const after = text.slice(candidate.index + (candidate.separatorLength ?? candidate[0].length)).trim();
    return before && after && looksLikeShotlist(before);
  });
  if (!match) {
    return {
      ok: false,
      shotlist: '',
      storyboard: '',
      reason: `没有识别到完整的“分镜表＋提示词”两部分（已读 ${text.length} 字，识别到 ${candidates.length} 个候选分隔标记）。请查看保留的正文：可能缺少提示词，也可能使用了尚未识别的表格或标题写法。`
    };
  }
  const shotlist = text.slice(0, match.index).trim();
  const storyboard = text.slice(match.index + (match.separatorLength ?? match[0].length)).trim();
  const problems = [];
  if (!shotlist) problems.push(`分隔行「${BUNDLE_DELIMITER}」之前是空的，缺少分镜表。`);
  if (!storyboard) problems.push(`分隔行「${BUNDLE_DELIMITER}」之后是空的，缺少提示词。`);
  return { ok: problems.length === 0, shotlist, storyboard, reason: problems.join(' ') };
}

/** 两份分别按各自规范校验，任一不过整集都不落盘 */
function validateBundle(content, options = {}) {
  const split = splitBundle(content);
  if (!split.ok) {
    return { ok: false, problems: [split.reason], warnings: [], stats: {}, parts: split,
      normalizedContent: String(content || ''), formatRepairs: [] };
  }
  const shotlistVerdict = validateShotlist(split.shotlist, options.checks);
  const storyboardVerdict = validateStoryboard(split.storyboard, options);
  const coverage = bundleCoverage(split.shotlist, split.storyboard);
  const problems = [
    ...shotlistVerdict.problems.map((item) => `分镜表：${item}`),
    ...storyboardVerdict.problems.map((item) => `提示词：${item}`)
  ];
  if (resolveValidationChecks(options.checks).on('groupShotRange') && coverage.missingShots.length) {
    problems.push(`提示词：缺少分镜表中的镜头 ${coverage.missingShots.slice(0, 12).join('、')}${coverage.missingShots.length > 12 ? '等' : ''}，两份成品尚未完整对应。`);
  }
  const warnings = [
    ...shotlistVerdict.warnings.map((item) => `分镜表：${item}`),
    ...storyboardVerdict.warnings.map((item) => `提示词：${item}`)
  ];
  const formatRepairs = [
    ...shotlistVerdict.formatRepairs.map((item) => `分镜表：${item}`),
    ...storyboardVerdict.formatRepairs.map((item) => `提示词：${item}`)
  ];
  const parts = { ...split, shotlist: shotlistVerdict.normalizedContent, storyboard: storyboardVerdict.normalizedContent };
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    stats: { shotlist: shotlistVerdict.stats, storyboard: storyboardVerdict.stats, coverage },
    parts,
    normalizedContent: formatRepairs.length
      ? `${parts.shotlist}\n\n${BUNDLE_DELIMITER}\n\n${parts.storyboard}` : String(content || ''),
    formatRepairs
  };
}

function validateStructure(kind, text, options = {}) {
  const resolved = resolveValidationChecks(options.checks);
  if (kind === 'pair') return validateBundle(text, { ...options, checks: resolved.values });
  if (kind === 'shotlist') return validateShotlist(text, resolved.on);
  if (kind === 'storyboard') return validateStoryboard(text, { ...options, on: resolved.on });
  return validateScript(text, resolved.on);
}

/* ------------------------------------------------------------------ *
 * 集数文件名强校验 —— 不猜
 * ------------------------------------------------------------------ */

const STRICT_EPISODE_PATTERNS = [
  /^第\s*0*(\d{1,4})\s*集(?!\d)/,
  /^0*(\d{1,4})\s*集(?!\d)/,
  /^0*(\d{1,4})\s*话(?!\d)/,
  /^EP\s*0*(\d{1,4})(?!\d)/i
];

/**
 * 只接受规范命名：第N集 / N集 / N话 / EPN（允许前面有其它文字，如「01 小说原文-第1集」）
 * 不匹配返回 null —— 调用方必须报错停下，不得猜测。
 */
function episodeNumberFromName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  for (const pattern of STRICT_EPISODE_PATTERNS) {
    const match = base.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

const EPISODE_MARKER = /(?:第\s*)?0*(\d{1,4})\s*(?:集|话|章)(?!\d)|EP\s*0*(\d{1,4})(?!\d)/gi;
// 区间写法（第1-3集 / 10—12章）本身就是多集文件，两端都要登记
const EPISODE_RANGE = /0*(\d{1,4})\s*[-–—~至]\s*0*(\d{1,4})\s*(?:集|话|章)/g;
// 上/中/下 分段写法：1集上、3上_分镜、10下_分镜。流水线里长集常被拆成两段。
const EPISODE_PART_MARKER = /0*(\d{1,4})\s*(?:集|话|章)?\s*(上|中|下)(?![\d])/g;

/**
 * 扫描文件名里**全部**集号标记。
 * 用于强校验：必须恰好一个标记、且等于目标集号，否则一律拒收。
 * 「1-3合集.txt」「第1-3集.txt」「剧本转分镜9.16.md」都会被识别为不合法。
 * 「章」也是合法标记（网文原文通常一章一集，文件名形如 247_第247章 袁家百态.txt）。
 */
function strictEpisodeNumbersInName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  const found = new Set();
  for (const match of base.matchAll(EPISODE_RANGE)) {
    found.add(Number(match[1]));
    found.add(Number(match[2]));
  }
  for (const match of base.matchAll(EPISODE_MARKER)) {
    const value = Number(match[1] ?? match[2]);
    if (Number.isFinite(value)) found.add(value);
  }
  for (const match of base.matchAll(EPISODE_PART_MARKER)) {
    found.add(Number(match[1]));
  }
  return [...found].filter(Number.isFinite).sort((a, b) => a - b);
}

/** 取文件名里的 上/中/下 分段标记，没有则返回空串 */
function episodePartFromName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  const matches = [...base.matchAll(EPISODE_PART_MARKER)];
  if (!matches.length) return '';
  return matches[matches.length - 1][2];
}

const PART_ORDER = { '上': 1, '中': 2, '下': 3, '': 0 };

/**
 * 强校验入口：返回 { ok, reason, numbers, part }
 * 只在"恰好一个集号标记且等于目标"时 ok。上/中/下 分段算同一个集号，只标记 part。
 */
function checkEpisodeFileName(fileName, target) {
  const numbers = strictEpisodeNumbersInName(fileName);
  const part = episodePartFromName(fileName);
  const wanted = Number(target);
  if (!numbers.length) {
    return { ok: false, numbers, part, reason: `文件名「${fileName}」里没有可识别的集号（需要写成「${wanted}集」「第${wanted}集」「${wanted}章」或「EP${String(wanted).padStart(2, '0')}」）。` };
  }
  if (numbers.length > 1) {
    return { ok: false, numbers, part, reason: `文件名「${fileName}」里出现了多个集号（${numbers.join('、')}），无法确定是第几集。请拆分成单集文件后重试。` };
  }
  if (numbers[0] !== wanted) {
    return { ok: false, numbers, part, reason: `文件名「${fileName}」里是第 ${numbers[0]} 集，与目标第 ${wanted} 集不一致。` };
  }
  return { ok: true, numbers, part, reason: '' };
}

/* ------------------------------------------------------------------ *
 * 批量调度器
 * ------------------------------------------------------------------ */

async function loadCheckpoint(checkpoint) {
  if (!checkpoint?.load) return null;
  try { return (await checkpoint.load()) || null; }
  catch { return null; }
}

async function saveCheckpoint(checkpoint, payload) {
  if (!checkpoint?.save) return;
  try { await checkpoint.save(payload); }
  catch { /* 断点写失败不应中断产出 */ }
}

/**
 * 按「每 N 集换一个对话」跑一批任务。
 *
 * @param {object}   options
 * @param {number[]} options.episodes      待处理集号
 * @param {string}   options.kind          script | shotlist | storyboard
 * @param {object}   options.config        normalizeRunnerConfig 结果
 * @param {function} options.buildSystem   () => string | Promise<string>
 * @param {function} options.buildUser     (episodeNumber) => {text} | Promise；缺输入时应抛错
 * @param {function} options.save          async (episodeNumber, text, meta)
 * @param {object}   [options.checkpoint]  { load, save }
 * @param {function} [options.onEvent]     进度回调
 * @param {AbortSignal} [options.signal]
 */
async function runBatch(options) {
  const {
    episodes, kind, config, buildSystem, buildUser, save,
    checkpoint, onEvent = () => {}, signal, groupOptions, prepareContent, repairContent, complete
  } = options;

  const event = (payload) => { try { onEvent(payload); } catch { /* 回调不应影响主流程 */ } };
  const resume = await loadCheckpoint(checkpoint);
  const cap = config.conversationCap;

  const conversation = new Conversation({
    system: await buildSystem(),
    cap,
    maxContextChars: config.maxContextChars,
    id: (Number(resume?.conversationId) || 0) + 1
  });

  const completed = Array.isArray(resume?.completed) ? [...resume.completed] : [];
  const pending = episodes.filter((number) => !completed.includes(number));

  if (!pending.length) {
    return { ok: true, completed, skipped: episodes.length, rotations: 0, conversationId: conversation.id };
  }

  // 续跑时把已完成轮次灌回上下文，保证"每 N 集一轮"的计数与剧情连续性不丢
  if (Array.isArray(resume?.turns)) {
    for (const turn of resume.turns) conversation.push(turn.user, turn.assistant);
  }

  let rotations = Number(resume?.rotations) || 0;
  let failure = null;

  for (let index = 0; index < pending.length; index += 1) {
    const episodeNumber = pending[index];
    if (signal?.aborted) { failure = { episodeNumber, reason: '任务已取消。', cancelled: true }; break; }

    // ① 轮换判定：装满了就开新对话（system 重发一次，历史清空）
    if (conversation.rotateIfNeeded()) {
      rotations += 1;
      event({ type: 'new-conversation', episodeNumber, conversationId: conversation.id, reason: `已完成 ${cap} 集，开启新对话` });
    }

    // ② 组装本集输入（强校验在 buildUser 内完成，缺文件直接抛）
    let userBlock;
    try {
      userBlock = await buildUser(episodeNumber);
    } catch (error) {
      failure = { episodeNumber, reason: error?.message || String(error), input: true };
      event({ type: 'episode-failed', episodeNumber, reason: failure.reason });
      break;
    }

    event({
      type: 'episode-start',
      episodeNumber,
      index: index + 1,
      total: pending.length,
      completedBefore: completed.length,
      totalEpisodes: episodes.length,
      conversationId: conversation.id,
      filled: conversation.filled,
      cap
    });

    const messages = conversation.messages(userBlock.text);
    let streamed = '';
    let thinking = '';

    let result;
    try {
      const completionOptions = {
        signal,
        onDelta: (delta, meta = {}) => {
          const sourceType = meta.sourceType || meta.type || 'content';
          const eventMeta = { ...meta, sourceType, meta: { ...meta } };
          if (meta.type === 'reasoning') {
            if (sourceType === 'reasoning') thinking += delta;
            event({ ...eventMeta, type: 'delta', stream: 'reasoning', episodeNumber, text: delta, length: thinking.length });
          } else {
            streamed += delta;
            event({ ...eventMeta, type: 'delta', stream: 'content', episodeNumber, text: delta, length: streamed.length });
          }
        },
        onEvent: (payload) => {
          if (payload.type === 'retry') {
            event({
              type: 'retry', episodeNumber, reason: payload.reason, waitMs: payload.waitMs,
              attempt: payload.attempt, nextReasoningEffort: payload.nextReasoningEffort || ''
            });
          } else event({ ...payload, episodeNumber });
        }
      };
      result = typeof complete === 'function'
        ? await complete({ config, messages, episodeNumber, ...completionOptions })
        : await chatCompletion(config, messages, completionOptions);
    } catch (error) {
      failure = { episodeNumber, reason: error?.message || String(error), transient: true };
      event({ type: 'episode-failed', episodeNumber, reason: failure.reason });
      break;
    }

    let content = normalizeReply(result.content);
    if (typeof prepareContent === 'function') {
      content = await prepareContent(content, { episodeNumber, result, userBlock, config });
    }

    // ③ 排版错误在本地整理；实质结构不完整时才进入修复或拒收。
    const applyVerdict = (next) => {
      content = next.normalizedContent ?? content;
      if (next.formatRepairs?.length) {
        event({ type: 'format-repaired', episodeNumber, repairs: next.formatRepairs,
          warnings: next.warnings, content });
      }
      return next;
    };
    let verdict = applyVerdict(validateStructure(kind, content, groupOptions));
    if (!verdict.ok && typeof repairContent === 'function') {
      event({ type: 'repair-start', episodeNumber, problems: verdict.problems });
      try {
        const repaired = await repairContent({ episodeNumber, content, verdict, userBlock, config, signal });
        if (repaired?.content) {
          content = normalizeReply(repaired.content);
          if (typeof prepareContent === 'function') {
            content = await prepareContent(content, { episodeNumber, result: repaired.result || result, userBlock, config });
          }
          if (repaired.result) result = { ...result, ...repaired.result };
          verdict = applyVerdict(validateStructure(kind, content, groupOptions));
          event({ type: verdict.ok ? 'repair-done' : 'repair-failed', episodeNumber, problems: verdict.problems });
        }
      } catch (error) {
        event({ type: 'repair-failed', episodeNumber, problems: [error?.message || String(error)] });
      }
    }
    if (!verdict.ok) {
      failure = {
        episodeNumber,
        reason: `输出未通过结构校验：${verdict.problems.join(' ')}`,
        structural: true,
        problems: verdict.problems,
        preview: content.slice(-160)
      };
      event({ type: 'episode-rejected', episodeNumber, problems: verdict.problems });
      break;
    }

    // ④ 落盘
    try {
      await save(episodeNumber, content, { usage: result.usage, stats: verdict.stats, warnings: verdict.warnings,
        formatRepairs: verdict.formatRepairs, responseModel: result.responseModel || config.model });
    } catch (error) {
      failure = { episodeNumber, reason: `写入文件失败：${error?.message || String(error)}` };
      event({ type: 'episode-failed', episodeNumber, reason: failure.reason });
      break;
    }

    completed.push(episodeNumber);
    conversation.push(userBlock.text, content);
    event({
      type: 'episode-done',
      episodeNumber,
      completed: completed.length,
      total: episodes.length,
      stats: verdict.stats,
      warnings: verdict.warnings,
      thinkingLength: thinking.length,
      contentLength: content.length,
      finishReason: result.finishReason || '',
      usage: result.usage || null,
      responseModel: result.responseModel || config.model,
      agent: result.agent || null,
      conversationId: conversation.id,
      filled: conversation.filled,
      cap
    });

    await saveCheckpoint(checkpoint, {
      kind,
      completed,
      conversationId: conversation.id,
      rotations,
      turns: conversation.turns
    });
  }

  return {
    ok: !failure,
    completed,
    failure,
    rotations,
    conversationId: conversation.id,
    usage: conversation.describe()
  };
}

module.exports = {
  BUNDLE_DELIMITER,
  PROVIDERS,
  VALIDATION_CHECKS,
  defaultProviderId,
  defaultValidationChecks,
  repairBaseUrl,
  resolveValidationChecks,
  splitBundle,
  bundleCoverage,
  validateBundle,
  ApiError,
  Conversation,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  SHOTLIST_COLUMNS,
  chatCompletion,
  runToolAgent,
  checkEpisodeFileName,
  configProblems,
  episodeNumberFromName,
  episodePartFromName,
  modelDisplayName,
  normalizeReply,
  normalizeMarkdownFormatting,
  normalizeRunnerConfig,
  runBatch,
  stampGenerationModel,
  strictEpisodeNumbersInName,
  validateScript,
  validateShotlist,
  validateStoryboard,
  validateStructure
};
