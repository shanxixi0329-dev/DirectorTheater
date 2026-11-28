'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { deflateSync, crc32 } = require('node:zlib');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const mammoth = require('mammoth');

const { normalizeDocxRawText } = require('../src/global-text-search');
const { validateStoryboard } = require('../src/document-checks');
const { createQualityService, dialogues } = require('../src/quality-service');
const { createReviewService } = require('../src/review-service');
const { createWorkspaceService } = require('../src/workspace-service');
const { createAssetBatchService } = require('../src/asset-batch-service');
const { createArchiveLibrary } = require('../src/asset-archive-library');
const { prepareImage, inspectPng } = require('../src/asset-image-utils');
const { createOpenAiProvider, parseProviderResponse } = require('../src/image-providers');
const workflowFiles = require('../src/workflow-files');
const shotlistDuration = require('../src/renderer/shotlist-duration');

function makePng(r, g, b, width = 2, height = 2) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const chunk = (name, payload) => {
    const out = Buffer.alloc(12 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    out.write(name, 4, 'ascii');
    payload.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    let dst = y * stride + 1;
    for (let x = 0; x < width; x += 1) {
      raw[dst++] = r;
      raw[dst++] = g;
      raw[dst++] = b;
    }
  }
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function roundTripDocx(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const paragraphs = (lines.length ? lines : ['']).map((line) => new Paragraph({
    children: line ? [new TextRun(line)] : []
  }));
  const buf = await Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
  return normalizeDocxRawText((await mammoth.extractRawText({ buffer: buf })).value);
}

test('DOCX 读写多轮往返严格幂等，不倍增空行且保留 Markdown 表格', async () => {
  const sample = [
    '| 镜号 | 时长 | 画面 |',
    '| --- | --- | --- |',
    '| 1-1 | 0s-3s | 开场空镜 |',
    '',
    '林青：第一句。',
    '',
    '',
    '周明：第二句。'
  ].join('\n');
  let current = sample;
  for (let i = 0; i < 4; i += 1) {
    current = await roundTripDocx(current);
    assert.equal(current, sample);
  }
  assert.equal(shotlistDuration.calculate(current).seconds, 3);
});

test('分镜时长解析支持小数秒钟表与英文 s/sec 区间单位', () => {
  const table = [
    '| 镜号 | 时间 | 画面 |',
    '| --- | --- | --- |',
    '| 1 | 00:00.5-00:03.0 | 镜头1 |',
    '| 2 | 3s-6.5s | 镜头2 |',
    '| 3 | 6.5sec-9sec | 镜头3 |'
  ].join('\n');
  const result = shotlistDuration.calculate(table);
  assert.equal(result.shotCount, 3);
  assert.equal(result.seconds, 8.5);
});

test('编辑器多段加粗选区不破坏中间文字', () => {
  const scope = {};
  const src = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/editor-formatting.js'), 'utf8');
  require('node:vm').runInNewContext(src, scope);
  const input = '**甲**和**乙**';
  const toggled = scope.EditorFormatting.toggleBold(input, 0, input.length);
  assert.equal(toggled.value, '****甲**和**乙****');
  assert.equal(toggled.enabled, true);
  const single = scope.EditorFormatting.toggleBold('**甲**', 0, 5);
  assert.equal(single.value, '甲');
  assert.equal(single.enabled, false);
});

test('提示词本地质检识别单字台词并合并同镜头多段口播时长', () => {
  const script = '1-1 客厅 [内] [日]\n林青：嗯。\n林青：今天必须把这件事彻底查清楚才行。';
  const storyboard = [
    '第1组（镜头1-2，总时长5秒）',
    '参考素材：@[林青] @[客厅]',
    '分镜序列：',
    '镜头1：[0秒-2秒] @[林青]在@[客厅]点头说：{嗯。}',
    '镜头2：[2秒-5秒] @[林青]在@[客厅]继续说：{今天必须把这件事}停顿后又说：{彻底查清楚才行，绝对不能再拖延下去。}'
  ].join('\n');
  const results = validateStoryboard(storyboard, script, '', {
    storyboard: { references: true, speakers: true, speechTiming: true, dialogueMatch: true, dialogueCoverage: true }
  });
  assert.equal(results.some(r => r.title === '缺少人物台词'), false);
  assert.equal(results.some(r => r.title === '口播时间不足'), true);
});

test('质量服务支持 @[素材]、加粗说话人保护及 DOCX 撤销', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-quality-audit-'));
  try {
    const scriptDir = path.join(root, '03 剧本');
    await fs.mkdir(scriptDir, { recursive: true });
    const docxFile = path.join(scriptDir, '1集.docx');
    const initial = '1-1 客厅\n**林青**：不能改我。';
    const writeDocx = async (file, text) => {
      const lines = text.split(/\r?\n/);
      const doc = new Document({ sections: [{ children: lines.map(l => new Paragraph({ children: l ? [new TextRun(l)] : [] })) }] });
      await fs.writeFile(file, await Packer.toBuffer(doc));
    };
    const readDocx = async (file) => normalizeDocxRawText((await mammoth.extractRawText({ path: file })).value);
    await writeDocx(docxFile, initial);

    assert.ok(dialogues(initial).some(line => line.includes('林青')));

    const svc = createQualityService({
      readDocument: readDocx,
      saveDocument: async (_p, _k, content, file) => { await writeDocx(file, content); return { path: file, content }; },
      complete: async () => ({ content: JSON.stringify({ content: '1-1 客厅（微调动作）\n**林青**：不能改我。', changes: ['微调'] }) })
    });
    const project = {
      projectPath: root,
      currentEpisode: 1,
      activeFiles: { script: docxFile },
      script: { content: initial },
      aiRunner: { provider: 'openai', apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'gpt-4o' }
    };
    const report = await svc.check(project, {
      kind: 'script', content: initial,
      settings: { semantic: false, items: ['structure'] }
    });
    const candidate = await svc.propose(project, report, '只微调说明');
    const applied = await svc.apply(project, candidate.id);
    assert.ok((await readDocx(docxFile)).includes('微调动作'));
    await svc.undo(project, applied.id);
    assert.equal(await readDocx(docxFile), initial);

    const sbReport = await svc.check({ ...project, activeFiles: { storyboard: '' } }, {
      kind: 'storyboard',
      content: '镜头1：@[林青]看着@[未知道具]',
      assets: { assets: [{ id: 'C001', name: '林青', aliases: [] }] },
      settings: { semantic: false, items: ['assets'] },
      persist: false
    });
    assert.equal(sbReport.issues.some(i => i.title.includes('@林青')), false);
    assert.equal(sbReport.issues.some(i => i.title.includes('@未知道具')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('批量生图允许返修重发布本人归档并拦截外部同名冲突；导入清单不污染批次列表', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-batch-audit-'));
  try {
    const projectDir = path.join(root, 'project');
    const userDataDir = path.join(root, 'userdata');
    await fs.mkdir(projectDir, { recursive: true });
    const project = { projectPath: projectDir, title: '测试项目' };
    const archiveLibrary = createArchiveLibrary({
      userData: () => userDataDir,
      writeAtomic: async (file, data, enc) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data, enc); }
    });
    const service = createAssetBatchService({ archiveLibrary });
    const png1 = makePng(200, 40, 40);
    const png2 = makePng(40, 200, 40);
    const queue = {
      schemaVersion: 1,
      jobs: [{
        id: 'CH01', category: 'character', name: '林青', look: '日常', view: '白底三联',
        episodes: [1], source_scenes: ['1-1'], prompt: '原提示词', references: [], background: 'opaque'
      }]
    };
    await service.create(project, 'batch-1', queue, { model: 'test-model', provider_id: 'openai-image-api' });
    let turn = 0;
    const driver = {
      submit: async () => ({ status: 'ready', bytes: (++turn === 1 ? png1 : png2), actual_model: 'test-model', provider_id: 'tk-' + turn }),
      poll: async () => ({ status: 'pending' })
    };
    await service.run(project, 'batch-1', driver);
    const afterStage = await service.inspect(project, 'batch-1');
    assert.equal(afterStage.provider_id, 'openai-image-api');
    assert.equal(afterStage.cards[0].provider_id, null);
    await service.accept(project, 'batch-1', 'CH01');
    await service.publish(project, 'batch-1', ['CH01']);

    // Retry with prompt override then revert back to null
    await service.retry(project, 'batch-1', 'CH01', { reason: '返修', prompt: '新提示词' });
    assert.equal((await service.inspect(project, 'batch-1')).cards[0].prompt_override, '新提示词');
    await service.retry(project, 'batch-1', 'CH01', { reason: '恢复原词', prompt: null });
    assert.equal((await service.inspect(project, 'batch-1')).cards[0].prompt_override, undefined);

    // Run second version, accept, and re-publish over own previous archive!
    await service.run(project, 'batch-1', driver);
    await service.accept(project, 'batch-1', 'CH01');
    await service.publish(project, 'batch-1', ['CH01']);
    const publishedFile = path.join(projectDir, '06 资产', 'images', '01 人物', '林青（日常） 第1集.png');
    assert.deepEqual(await fs.readFile(publishedFile), png2);

    // Import an external manifest and verify listBatchIds doesn't surface it as a broken batch
    const extManifest = path.join(root, 'ext-manifest.json');
    await fs.writeFile(extManifest, JSON.stringify({
      schemaVersion: 1,
      assets: [{
        id: 'EXT01', category: 'prop', name: '茶杯', episodes: [1], source_scenes: ['1-1'],
        relative_path: '03 道具/茶杯 第1集.png', state: 'published', checked_at: '2026-11-27T00:00:00.000Z'
      }]
    }), 'utf8');
    await archiveLibrary.importFile(project, extManifest);
    const batches = await service.list(project);
    assert.deepEqual(batches.map(b => b.id), ['batch-1']);
    assert.equal(batches.some(b => b.error), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('非 PNG 图像通过 nativeImage 转码为合法 PNG，而损坏 PNG 仍严格拦截', () => {
  const validPng = makePng(10, 20, 30);
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
  const fakeNative = { createFromBuffer: () => ({ isEmpty: () => false, toPNG: () => validPng }) };
  const prepared = prepareImage(fakeJpeg, { category: 'scene' }, fakeNative);
  assert.equal(inspectPng(prepared.bytes).width, 2);

  const corruptedPng = Buffer.from(validPng);
  corruptedPng[corruptedPng.length - 1] ^= 0xff;
  assert.throws(() => prepareImage(corruptedPng, { category: 'scene' }, fakeNative), /无效或超限的 PNG/);
});

test('OpenAI 图像入口去重 /v1、映射比例尺寸并解析 JSON 文本与行内路径', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: makePng(1, 2, 3).toString('base64') }], model: 'gpt-image-2.5' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const provider = createOpenAiProvider({ baseUrl: `http://127.0.0.1:${port}/v1/`, apiKey: 'sk-test', model: 'gpt-image-2.5' });
    await provider.submit({ prompt: 'test', requested_model: 'gpt-image-2.5', desired_aspect_ratio: '9:16', background: 'white' });
    assert.equal(requests[0].url, '/v1/images/generations');
    assert.equal(requests[0].body.size, '1024x1536');
    assert.equal(requests[0].body.background, 'opaque');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const fromJsonText = parseProviderResponse({ content: [{ type: 'text', text: JSON.stringify({ task_id: 'job-99', model: 'm1' }) }] });
  assert.equal(fromJsonText.provider_id, 'job-99');
  const fromSentencePath = parseProviderResponse({ content: [{ type: 'text', text: '已生成图片 C:\\out\\hero.png 请验收。' }] });
  assert.equal(fromSentencePath.path, 'C:\\out\\hero.png');
  const fromPunctUrl = parseProviderResponse({ content: [{ type: 'text', text: '下载(https://example.test/a.png)。' }] });
  assert.equal(fromPunctUrl.url, 'https://example.test/a.png');
});

test('审片导出在截图缺失时不中断且 workflow-files Windows 大小写路径校验正常', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-review-audit-'));
  try {
    const project = { projectPath: root, title: '审片测试', episodes: [{ number: 1 }] };
    assert.ok(workflowFiles.inside({ projectPath: root.toLowerCase() }, '03 剧本/1集.txt'));
    const review = createReviewService();
    const recordDir = path.join(root, '07 AI规则与记忆', '审片意见');
    await fs.mkdir(recordDir, { recursive: true });
    await fs.writeFile(path.join(recordDir, '审片记录.json'), JSON.stringify({
      version: 1,
      folder: root,
      videos: [{ id: 'v1', path: path.join(root, '1.mp4'), name: '1.mp4', relative: '1.mp4', status: 'issues', episode: 1, missing: false }],
      notes: [{ id: 'n1', videoId: 'v1', seconds: 3.5, text: '字幕错别字', prompt: '', screenshot: '截图/missing.png', resolved: false, createdAt: '2026-11-27T00:00:00Z' }]
    }), 'utf8');
    const exported = await review.exportReport(project, { scope: 'issues' });
    assert.equal(exported.empty, false);
    assert.equal(exported.count, 1);
    assert.equal(exported.warnings.length, 1);
    const html = await fs.readFile(path.join(exported.directory, '审片意见.html'), 'utf8');
    assert.ok(html.includes('字幕错别字'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('TXT 模式下重复导出 Word 不会被自身冲突拦截', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-export-audit-'));
  try {
    const docxPath = path.join(root, '1集.docx');
    let canonical = { id: 'p1', projectPath: root, currentEpisode: 1, documentFormats: { script: 'txt' }, episodes: [{ number: 1, script: { content: 'A' } }] };
    const service = createWorkspaceService({
      key: f => f.replace(/\\/g, '/').toLowerCase(),
      projectByPath: () => canonical,
      outputPath: () => docxPath,
      readDocument: f => fs.readFile(f, 'utf8'),
      broadcast: () => {}
    });
    const ev = { sender: { id: 1 } };
    await service.handle('documents:export-word', [ev, { project: canonical, kind: 'script', activePath: path.join(root, '1集.txt'), content: '版本1' }], async () => {
      await fs.writeFile(docxPath, '版本1');
      return { path: docxPath, content: '版本1' };
    });
    await fs.writeFile(docxPath, '外部Word稍作调整');
    await service.handle('documents:export-word', [ev, { project: canonical, kind: 'script', activePath: path.join(root, '1集.txt'), content: '版本2' }], async () => {
      await fs.writeFile(docxPath, '版本2');
      return { path: docxPath, content: '版本2' };
    });
    assert.equal(await fs.readFile(docxPath, 'utf8'), '版本2');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
