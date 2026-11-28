'use strict';
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const MAGPIE_MODELS = [
  'codex/gpt-image-2', 'zqknow-2/doubao-seedream-5-0-pro-260628',
  'zqknow-2/doubao-seedream-5-5-261028', 'zqknow-2/vod-image-GEM-2.5',
  'zqknow-2/vod-image-GEM-3.0', 'zqknow-2/vod-image-GEM-3.6',
  'zqknow-2/vod-image-OG-image2.5_sunburst_low', 'zqknow-2/wan2.7-image',
  'zqknow-2/wan2.7-image-pro', 'zqknow-2/z-image-turbo',
  'workbuddy/hunyuan-image-alpha', 'workbuddy-ai/hy-image-3.5'
];

function providerError(message, options = {}) { return Object.assign(new Error(message), options); }
const apiBackground = value => value === 'white' ? 'opaque' : (value || 'auto');

function classifyProviderError(message, status, fallbackCode = 'PROVIDER_ERROR') {
  const text = String(message || '');
  if (status === 401 || status === 403 || /unauthorized|invalid[_\s-]*api[_\s-]*key|forbidden|未授权|权限失效|认证失败/i.test(text)) {
    return 'UNAUTHORIZED';
  }
  if (status === 429 || /rate[_\s-]*limit|quota|usage limit|too many requests|额度耗尽|使用上限|限流|\b429\b/i.test(text)) {
    return 'QUOTA';
  }
  if (/moderation|safety|content[_\s-]*policy|policy violation|nsfw|审核|敏感内容|安全策略/i.test(text)) {
    return 'MODERATION';
  }
  return fallbackCode;
}

function requestJson(url, body, headers = {}, timeoutMs = 900000) {
  const target = new URL(url), transport = target.protocol === 'https:' ? https : http;
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let timer;
    const request = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (timer) clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = value?.error?.message || value?.message || text.slice(0, 240);
          const code = classifyProviderError(detail, response.statusCode, 'HTTP_ERROR');
          reject(providerError(`图像入口返回 HTTP ${response.statusCode}${detail ? '：' + detail : ''}`, {
            status: response.statusCode, code, body: text
          }));
          return;
        }
        resolve({ value, headers: response.headers });
      });
    });
    request.on('error', error => { if (timer) clearTimeout(timer); reject(error); });
    timer = setTimeout(() => request.destroy(providerError('图像入口请求超时', { code: 'TIMEOUT' })), timeoutMs);
    request.write(payload);
    request.end();
  });
}

function stripAuthHeader(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() !== 'authorization') out[k] = v;
  }
  return out;
}

function requestBytes(url, headers = {}, timeoutMs = 900000, redirectsLeft = 5) {
  const target = new URL(url), transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let timer;
    const request = transport.get({
      protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, headers
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        if (timer) clearTimeout(timer);
        response.resume();
        if (redirectsLeft <= 0) {
          reject(providerError('图像下载重定向次数过多', { code: 'REDIRECT_LIMIT' }));
          return;
        }
        const nextUrl = new URL(response.headers.location, url);
        const nextHeaders = nextUrl.origin === target.origin ? headers : stripAuthHeader(headers);
        requestBytes(nextUrl.href, nextHeaders, timeoutMs, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (timer) clearTimeout(timer);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(providerError('图像下载返回 HTTP ' + response.statusCode, { status: response.statusCode }));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    request.on('error', error => { if (timer) clearTimeout(timer); reject(error); });
    timer = setTimeout(() => request.destroy(providerError('图像下载超时', { code: 'TIMEOUT' })), timeoutMs);
  });
}

function firstText(content = []) { return content.filter(item => item?.type === 'text').map(item => item.text || '').join('\n'); }

function parseProviderResponse(result) {
  const root = result?.result || result, content = root?.content || [];
  const text = firstText(content);
  if (root?.isError) {
    const message = text || root.error?.message || '图像工具返回错误';
    throw providerError(message, { code: classifyProviderError(message, root.status, 'MCP_TOOL_ERROR') });
  }
  const image = content.find(item => item?.type === 'image' && item.data);
  if (image) return { status: 'ready', bytes: Buffer.from(image.data, 'base64'), actual_model: root.actual_model || root.model || '' };
  let parsedTextJson = null;
  if (text.trim().startsWith('{')) {
    try { parsedTextJson = JSON.parse(text.trim()); } catch {}
  }
  const structured = root?.structuredContent || root?.data || (parsedTextJson && typeof parsedTextJson === 'object' ? parsedTextJson : {});
  const id = structured.id || structured.generation_id || structured.task_id || text.match(/\b(?:id|task_id|generation_id)\b["'：:=\s]+([A-Za-z0-9._:-]+)/i)?.[1];
  const rawUrl = structured.url || structured.image_url || text.match(/https?:\/\/[^\s"'<>，。；：！？）》】、]+/)?.[0] || '';
  const url = rawUrl ? String(rawUrl).replace(/[)\]},.;，。；：！？）》】、]+$/, '') : '';
  if (url) return { status: 'ready', url, actual_model: structured.model || root.actual_model || root.model || '' };
  const localPath = structured.path || structured.file_path || structured.output_path
    || text.match(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>]+?\.(?:png|jpe?g|webp)(?=[\s"'<>)\]},;]|$)/i)?.[0];
  if (localPath) return { status: 'ready', path: localPath.trim(), actual_model: structured.model || root.actual_model || root.model || '' };
  if (id) return { status: 'pending', provider_id: id, actual_model: structured.model || root.actual_model || root.model || '' };
  const classified = classifyProviderError(text, root?.status, 'PROVIDER_RESPONSE');
  if (classified !== 'PROVIDER_RESPONSE') {
    throw providerError(text || '图像入口返回错误', { code: classified });
  }
  throw providerError('图像入口返回中没有图片、下载地址或任务号', { code: 'PROVIDER_RESPONSE' });
}

function createMcpClient({ baseUrl = process.env.MAGPIE_ADDR || 'http://127.0.0.1:3425' } = {}) {
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/mcp/magpie/image';
  let sessionId = '', initialized = false, initializing = null, requestId = 0;
  const nextRequestId = () => ++requestId;
  async function ensureInitialized() {
    if (initialized) return;
    if (!initializing) {
      initializing = requestJson(endpoint, {
        jsonrpc: '2.0', id: nextRequestId(), method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'director-theater', version: '0.1.13' } }
      }).then(response => {
        sessionId = response.headers['mcp-session-id'] || '';
        initialized = true;
      }).finally(() => { initializing = null; });
    }
    await initializing;
  }
  async function call(method, params = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ensureInitialized();
      const usedSession = sessionId;
      let response;
      try {
        response = await requestJson(endpoint, { jsonrpc: '2.0', id: nextRequestId(), method, params }, usedSession ? { 'mcp-session-id': usedSession } : {});
      } catch (error) {
        if (attempt === 0 && usedSession && [400, 404].includes(error?.status)) {
          initialized = false;
          sessionId = '';
          continue;
        }
        throw error;
      }
      if (response.value?.error) {
        const message = response.value.error.message || 'Magpie MCP 调用失败';
        throw providerError(message, { code: classifyProviderError(message, response.value.error.status, response.value.error.code || 'MCP_ERROR') });
      }
      return response.value?.result || response.value;
    }
  }
  return { call };
}

function createMagpieProvider(options = {}) {
  const client = options.client || createMcpClient(options);
  async function callTool(name, argumentsValue) { return parseProviderResponse(await client.call('tools/call', { name, arguments: argumentsValue })); }
  async function finish(result) {
    if (result.status !== 'ready') return result;
    if (!result.bytes && result.url) result.bytes = await requestBytes(result.url);
    if (!result.bytes && result.path) result.bytes = await fs.readFile(result.path);
    if (!result.bytes) throw providerError('Magpie 返回了空图像', { code: 'PROVIDER_RESPONSE' });
    return result;
  }
  return {
    id: 'magpie', models: MAGPIE_MODELS,
    async submit(job) {
      const result = await finish(await callTool('generate_image', {
        prompt: job.prompt, model: job.requested_model, size: job.size || job.desired_aspect_ratio || '16:9',
        background: apiBackground(job.background), quality: job.quality || 'auto', reference_images: job.reference_files || []
      }));
      return result.actual_model ? result : { ...result, actual_model: job.requested_model };
    },
    async poll({ provider_id, requested_model }) {
      const result = await finish(await callTool('generation_result', { id: provider_id }));
      return { ...result, actual_model: result.actual_model || requested_model };
    }
  };
}

function openAiSize(value) {
  const raw = String(value || '').trim();
  if (/^\d+x\d+$/i.test(raw) || raw === 'auto') return raw;
  return {
    '9:16': '1024x1536',
    '3:4': '1024x1536',
    '16:9': '1536x1024',
    '4:3': '1536x1024',
    '1:1': '1024x1024'
  }[raw] || '1536x1024';
}

function createOpenAiProvider(config = {}) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, ''), apiKey = String(config.apiKey || '');
  if (!baseUrl || !apiKey) throw providerError('图像 API 需要填写 Base URL 和 API Key', { code: 'UNAUTHORIZED' });
  const apiOrigin = new URL(baseUrl).origin;
  async function call(endpoint, body) { return (await requestJson(baseUrl + endpoint, body, { Authorization: 'Bearer ' + apiKey })).value; }
  async function extract(value, requestedModel) {
    const item = value?.data?.[0] || value?.output?.[0] || value?.images?.[0];
    let bytes = null;
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (item?.url) {
      const urlOrigin = new URL(item.url).origin;
      bytes = await requestBytes(item.url, urlOrigin === apiOrigin ? { Authorization: 'Bearer ' + apiKey } : {});
    }
    if (!bytes) throw providerError('图像 API 返回中没有图片数据', { code: 'PROVIDER_RESPONSE' });
    return {
      status: 'ready',
      bytes,
      provider_id: value?.id || item?.id || undefined,
      actual_model: value?.model || item?.model || requestedModel || config.model || ''
    };
  }
  return {
    id: 'openai-image-api', models: [...new Set([config.model || 'gpt-image-2.5', 'gpt-image-2.5', 'gpt-image-2', 'gpt-image-1.5'].filter(Boolean))],
    async submit(job) {
      const size = openAiSize(job.size || job.desired_aspect_ratio || '16:9');
      if (job.reference_files?.length) {
        const images = [];
        for (const file of job.reference_files) images.push('data:image/png;base64,' + (await fs.readFile(file)).toString('base64'));
        return extract(await call('/v1/images/edits', {
          model: job.requested_model, prompt: job.prompt, images,
          size,
          background: apiBackground(job.background), quality: job.quality || 'auto'
        }), job.requested_model);
      }
      return extract(await call('/v1/images/generations', {
        model: job.requested_model, prompt: job.prompt,
        size,
        background: apiBackground(job.background), quality: job.quality || 'auto'
      }), job.requested_model);
    },
    async poll() { throw providerError('OpenAI 图像 API 当前返回同步结果，不支持使用旧 provider_id 轮询', { code: 'PROVIDER_RESPONSE' }); }
  };
}

function createImageProviders({ magpie = {}, openai = {}, getOpenAiConfig = null, getMagpieConfig = null } = {}) {
  function resolvedOpenAi() {
    const dynamic = (typeof getOpenAiConfig === 'function' ? getOpenAiConfig() : null) || {};
    return {
      baseUrl: String(dynamic.baseUrl ?? openai.baseUrl ?? '').trim(),
      apiKey: String(dynamic.apiKey ?? openai.apiKey ?? '').trim(),
      model: String(dynamic.model ?? openai.model ?? 'gpt-image-2.5').trim() || 'gpt-image-2.5'
    };
  }
  function resolvedMagpie() {
    const dynamic = (typeof getMagpieConfig === 'function' ? getMagpieConfig() : null) || {};
    return {
      baseUrl: String(dynamic.baseUrl ?? magpie.baseUrl ?? process.env.MAGPIE_ADDR ?? 'http://127.0.0.1:3425').trim()
    };
  }
  return {
    list() {
      const oa = resolvedOpenAi();
      const oaModels = [...new Set([oa.model, 'gpt-image-2.5', 'gpt-image-2', 'gpt-image-1.5'].filter(Boolean))];
      return [
        { id: 'magpie', label: 'Magpie 本机入口', models: MAGPIE_MODELS, configured: true },
        { id: 'openai-image-api', label: 'OpenAI 图像 API', models: oaModels, configured: Boolean(oa.baseUrl && oa.apiKey) }
      ];
    },
    get(id, config = {}) {
      if (id === 'magpie') return createMagpieProvider({ ...resolvedMagpie(), ...config });
      if (id === 'openai-image-api') return createOpenAiProvider({ ...resolvedOpenAi(), ...config });
      throw providerError('未知图像驱动：' + id, { code: 'CONFIG' });
    }
  };
}

module.exports = {
  MAGPIE_MODELS, createImageProviders, createMagpieProvider, createOpenAiProvider,
  parseProviderResponse, classifyProviderError
};
