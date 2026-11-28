'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageProviders, createMagpieProvider, parseProviderResponse, classifyProviderError } = require('../src/image-providers');

const image = Buffer.from('89504e470d0a1a0a', 'hex');

test('图像入口解析内嵌图片、任务号和下载地址', () => {
  assert.deepEqual(parseProviderResponse({ model: 'fixture', content: [{ type: 'image', data: image.toString('base64') }] }), {
    status: 'ready', bytes: image, actual_model: 'fixture'
  });
  assert.deepEqual(parseProviderResponse({ structuredContent: { task_id: 'task-1', model: 'fixture' } }), {
    status: 'pending', provider_id: 'task-1', actual_model: 'fixture'
  });
  assert.deepEqual(parseProviderResponse({ structuredContent: { url: 'https://example.test/image.png', model: 'fixture' } }), {
    status: 'ready', url: 'https://example.test/image.png', actual_model: 'fixture'
  });
  assert.equal(parseProviderResponse({ content: [{ type: 'text', text: 'C:\\fixture\\image.png' }] }).path, 'C:\\fixture\\image.png');
  assert.throws(() => parseProviderResponse({ content: [{ type: 'text', text: "Invalid value: 'white'" }] }), /图像入口返回中没有图片/);
});

test('Magpie 驱动保留请求模型，并能轮询回收图片', async () => {
  const calls = [];
  const client = { call: async (method, params) => {
    calls.push({ method, params });
    if (params.arguments?.id) return { structuredContent: { task_id: params.arguments.id, model: 'codex/gpt-image-2' } };
    return { structuredContent: { task_id: 'fixture-task', model: 'codex/gpt-image-2' } };
  } };
  const driver = createMagpieProvider({ client });
  const submitted = await driver.submit({ prompt: 'fixture', requested_model: 'codex/gpt-image-2', size: '1:1' });
  assert.deepEqual(submitted, { status: 'pending', provider_id: 'fixture-task', actual_model: 'codex/gpt-image-2' });
  const polled = await driver.poll({ provider_id: 'fixture-task', requested_model: 'codex/gpt-image-2' });
  assert.equal(polled.status, 'pending');
  assert.equal(calls[0].params.name, 'generate_image');
  assert.equal(calls[0].params.arguments.model, 'codex/gpt-image-2');
  assert.equal(calls[1].params.name, 'generation_result');
});

test('图像入口把白底语义转换为 opaque 参数', async () => {
  let argumentsValue;
  const client = { call: async (_method, params) => {
    argumentsValue = params.arguments;
    return { structuredContent: { task_id: 'fixture-task', model: 'codex/gpt-image-2' } };
  } };
  const driver = createMagpieProvider({ client });
  await driver.submit({ prompt: 'fixture', requested_model: 'codex/gpt-image-2', background: 'white' });
  assert.equal(argumentsValue.background, 'opaque');
});

test('MCP isError 与限流/权限/审核错误精准分类，且动态配置即时生效', () => {
  assert.throws(
    () => parseProviderResponse({ isError: true, content: [{ type: 'text', text: '429 rate limit exceeded' }] }),
    error => error.code === 'QUOTA'
  );
  assert.throws(
    () => parseProviderResponse({ isError: true, content: [{ type: 'text', text: 'content policy moderation blocked' }] }),
    error => error.code === 'MODERATION'
  );
  assert.equal(classifyProviderError('401 invalid api key', 401), 'UNAUTHORIZED');

  let oa = { baseUrl: '', apiKey: '', model: 'gpt-image-2.5' };
  const providers = createImageProviders({ getOpenAiConfig: () => oa });
  assert.equal(providers.list().find(p => p.id === 'openai-image-api').configured, false);
  oa = { baseUrl: 'https://example.test', apiKey: 'sk-fixture', model: 'gpt-image-2.5' };
  const updated = providers.list().find(p => p.id === 'openai-image-api');
  assert.equal(updated.configured, true);
  assert.equal(updated.models.includes('gpt-image-2.5'), true);
});
