'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const aiCore = require('../src/ai-core');
const { extractLicenseToken } = require('../src/membership-service');
const { buildQueueFromAssetsRegistry } = require('../src/codex-queue-service');
const { createAutomationService } = require('../src/automation-service');

test('extractLicenseToken extracts DT1 token embedded inside WeChat chat text', () => {
  const sample = 'DT1.eyJwcm9kdWN0IjoiZGlyZWN0b3ItdGhlYXRlciJ9.abc123_-XYZ';
  assert.equal(extractLicenseToken(`你好，这是你的永久激活码：${sample} 直接复制激活就行`), sample);
  assert.equal(extractLicenseToken(`  ${sample}\r\n  `), sample);
  assert.equal(extractLicenseToken(''), '');
});

test('ai-core accepts local Magpie gateway without API key while remote providers still require API key', () => {
  const magpieCfg = aiCore.normalizeRunnerConfig({
    aiRunner: { provider: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', model: 'codex/gpt-6.2-sol', apiKey: '' }
  });
  assert.deepEqual(aiCore.configProblems(magpieCfg), []);

  const deepseekCfg = aiCore.normalizeRunnerConfig({
    aiRunner: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: '' }
  });
  assert.ok(aiCore.configProblems(deepseekCfg).some(msg => msg.includes('API Key')));
});

test('buildQueueFromAssetsRegistry builds layered L0 parent and L1 child references', () => {
  const registry = {
    assets: [
      {
        id: 'C001', type: 'character', name: '林青', episodes: [1, 2],
        variants: [
          { name: '居家常服', prompt: '年轻女子居家常服白底三联', episodes: [1, 2] },
          { name: '雨夜风衣', prompt: '年轻女子雨夜风衣白底三联', episodes: [2] }
        ]
      },
      {
        id: 'S001', type: 'scene', name: '老茶馆', episodes: [1],
        variants: [
          { name: '正打空景', prompt: '九十年代老茶馆正打空景', episodes: [1] },
          { name: '空间四视图', prompt: '九十年代老茶馆空间四视图', episodes: [1] }
        ]
      },
      {
        id: 'P001', type: 'prop', name: '旧怀表', episodes: [1],
        variants: [{ name: '特写', prompt: '黄铜旧怀表白底特写', episodes: [1] }]
      }
    ]
  };
  const queue = buildQueueFromAssetsRegistry(registry, { projectTitle: '测试剧' });
  assert.equal(queue.schemaVersion, 1);
  assert.equal(queue.jobs.length, 5);
  const charBase = queue.jobs.find(j => j.id === 'C001-base');
  const charChild = queue.jobs.find(j => j.id === 'C001-v2');
  assert.deepEqual(charBase.references, []);
  assert.deepEqual(charChild.references, ['C001-base']);
  const sceneChild = queue.jobs.find(j => j.id === 'S001-v2');
  assert.deepEqual(sceneChild.references, ['S001-base']);
});

test('automation-service runs assetImages stage and invokes runAssetImages hook', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-auto-img-'));
  try {
    await fs.mkdir(path.join(root, '00 小说原文'), { recursive: true });
    await fs.mkdir(path.join(root, '03 剧本'), { recursive: true });
    await fs.writeFile(path.join(root, '00 小说原文', '1集.txt'), '第1章 雨夜来信\n林青在老茶馆打开旧怀表。', 'utf8');
    await fs.writeFile(path.join(root, '03 剧本', '1集.txt'), '1-1 老茶馆 [内] [夜]\n林青：信到了。', 'utf8');
    const calls = [];
    const svc = createAutomationService({
      readDocument: f => fs.readFile(f, 'utf8'),
      readTemplate: async () => '',
      quality: { check: async () => ({ blocked: false, issues: [] }), cancel: () => {} },
      runAssetImages: async (_proj, payload) => {
        calls.push(payload);
        return { batchId: `auto-ep${payload.episode}`, total: 1, staged: 1 };
      }
    });
    const project = {
      title: '自动化联动测试',
      projectPath: root,
      currentEpisode: 1,
      episodes: [{ number: 1, activeFiles: { source: path.join(root, '00 小说原文', '1集.txt'), script: path.join(root, '03 剧本', '1集.txt') } }],
      activeFiles: { source: path.join(root, '00 小说原文', '1集.txt'), script: path.join(root, '03 剧本', '1集.txt') }
    };
    const job = await svc.run(project, { start: 1, end: 1, stages: ['assetImages'], imageProvider: 'magpie', imageModel: 'codex/gpt-image-2' });
    assert.equal(job.status, 'done');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].episode, 1);
    assert.equal(calls[0].options.imageProvider, 'magpie');
    assert.equal(calls[0].options.imageModel, 'codex/gpt-image-2');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
