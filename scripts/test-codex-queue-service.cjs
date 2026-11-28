'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCodexQueueService,
  resolveEpisodeScriptFile,
  prepareRawQueueForNormalize,
  knownReadOnlyFailure,
  usageLimitFailure,
  authFailure
} = require('../src/codex-queue-service');

function queueMessage(jobs) {
  return JSON.stringify({
    schemaVersion: 1,
    jobs: jobs || [{
      id: 'female-identity',
      category: 'character',
      name: '女主身份母板',
      look: '身份母板',
      view: '白底三联',
      episodes: [1],
      source_scenes: ['1-1'],
      prompt: '女性，27岁，白底三联。',
      references: [],
      background: 'opaque',
      desired_aspect_ratio: '9:16',
      scale: ''
    }]
  });
}

function event(text) {
  return { type: 'item.completed', item: { type: 'agent_message', text } };
}

async function makeFixtureProject(scriptName = '1集.txt', scriptBody = '第1集测试剧本内容') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'director-codex-'));
  const scriptDir = path.join(root, '03 剧本');
  await fs.mkdir(scriptDir, { recursive: true });
  if (scriptName) await fs.writeFile(path.join(scriptDir, scriptName), scriptBody, 'utf8');
  return {
    root,
    project: {
      title: '测试项目',
      projectPath: root,
      currentEpisode: 1,
      folders: { script: scriptDir },
      memory: { characters: '女主沈晓君，27岁。' }
    }
  };
}

test('Codex 队列服务经 stdin 注入只读上下文、禁用 MCP 且不使用危险绕过参数', async () => {
  const { root, project } = await makeFixtureProject('第01集.txt', '1-1 客厅\n女主沈晓君出场。');
  const calls = [];
  const service = createCodexQueueService({
    userData: () => root,
    skillRoots: [],
    discover: async () => ({
      selected: 'C:/Codex/codex.exe',
      candidates: [{ path: 'C:/Codex/codex.exe', version: 'codex-cli 0.171.0' }]
    }),
    processRunner: async (file, args, options) => {
      calls.push({ file, args, input: options.input });
      const thread = { type: 'thread.started', thread_id: 'thread-direct' };
      options.onEvent(thread);
      const answer = event(queueMessage());
      options.onEvent(answer);
      return { code: 0, stdout: JSON.stringify(thread) + '\n' + JSON.stringify(answer), stderr: '' };
    }
  });

  const result = await service.prepare(project, { episode: 1 });
  assert.equal(result.mode, 'read-only');
  assert.equal(result.episodeFile, '第01集.txt');
  assert.equal(result.queue.jobs.length, 1);
  assert.equal(result.queue.jobs[0].background, 'opaque');
  assert.equal(result.queue.jobs[0].desired_aspect_ratio, '9:16');
  assert.deepEqual(result.threadIds, ['thread-direct']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'exec');
  assert.equal(calls[0].args.includes('-s'), true);
  assert.equal(calls[0].args[calls[0].args.indexOf('-s') + 1], 'read-only');
  assert.equal(calls[0].args.includes('mcp_servers={}'), true);
  assert.equal(calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(calls[0].args.includes('--ignore-user-config'), false);
  assert.equal(calls[0].args.at(-1), '-');
  assert.match(calls[0].input, /女主沈晓君出场/);
  assert.match(calls[0].input, /禁止调用任何命令/);
});

test('Codex 队列服务保留 thread、标准只读阻塞后切换备用只读入口并规范化队列', async () => {
  const { root, project } = await makeFixtureProject('1集.txt', '1-1 场景测试');
  const calls = [];
  const service = createCodexQueueService({
    userData: () => root,
    skillRoots: [],
    discover: async () => ({
      selected: 'C:/WindowsApps/path-entry',
      candidates: [{ path: 'C:/WindowsApps/path-entry', version: 'path' }, { path: 'fallback-entry', version: 'fallback' }]
    }),
    processRunner: async (file, args, options) => {
      calls.push({ file, args });
      const thread = { type: 'thread.started', thread_id: file.includes('WindowsApps') ? 'thread-standard' : 'thread-fallback' };
      options.onEvent(thread);
      if (file.includes('WindowsApps')) {
        const failure = { type: 'error', message: 'Failed to create unified exec process: registered Core process has no package identity' };
        options.onEvent(failure);
        return { code: -1, stdout: JSON.stringify(failure), stderr: failure.message };
      }
      const answer = event(queueMessage());
      options.onEvent(answer);
      return { code: 0, stdout: JSON.stringify(thread) + '\n' + JSON.stringify(answer), stderr: '' };
    }
  });
  const result = await service.prepare(project, { episode: 1, allowCompatibilityFallback: true });
  assert.equal(result.mode, 'compatibility-read-only');
  assert.equal(result.queue.jobs.length, 1);
  assert.deepEqual(result.threadIds, ['thread-standard', 'thread-fallback']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0], 'exec');
  assert.equal(calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(calls[1].args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(knownReadOnlyFailure('registered Core process has no package identity'), true);
  assert.equal(usageLimitFailure('You have hit your usage limit'), true);
  assert.equal(authFailure('401 Unauthorized'), true);
});

test('Codex 队列服务识别额度错误并停止，不伪造队列且保留事件日志', async () => {
  const { root, project } = await makeFixtureProject('1集.txt', '1-1 剧本');
  const service = createCodexQueueService({
    userData: () => root,
    skillRoots: [],
    discover: async () => ({ selected: 'path-entry', candidates: [{ path: 'path-entry', version: 'path' }] }),
    processRunner: async (_file, _args, options) => {
      options.onEvent({ type: 'thread.started', thread_id: 'thread-quota' });
      return { code: 1, stdout: '', stderr: 'You have hit your usage limit' };
    }
  });
  await assert.rejects(
    service.prepare(project, { episode: 1 }),
    error => error.code === 'CODEX_QUOTA' && /使用上限/.test(error.message)
  );
  const runs = await fs.readdir(path.join(root, 'codex-queue-runs'));
  assert.equal(runs.length, 1);
  const eventsLog = await fs.readFile(path.join(root, 'codex-queue-runs', runs[0], 'events.jsonl'), 'utf8');
  assert.match(eventsLog, /thread-quota/);
});

test('准确匹配补零与 EP 集号，缺失目标集时明确报错而不误读其他集', async () => {
  const { root, project } = await makeFixtureProject('EP05.txt', '第5集正文');
  await fs.writeFile(path.join(project.folders.script, '第01集.docx'), 'placeholder', 'utf8');
  const ep5 = await resolveEpisodeScriptFile(project.folders.script, 5);
  assert.equal(ep5.fileName, 'EP05.txt');
  const ep1 = await resolveEpisodeScriptFile(project.folders.script, 1);
  assert.equal(ep1.fileName, '第01集.docx');
  const ep9 = await resolveEpisodeScriptFile(project.folders.script, 9);
  assert.equal(ep9.filePath, '');
  const ep9WithStaleActive = await resolveEpisodeScriptFile(project.folders.script, 9, ep5.filePath);
  assert.equal(ep9WithStaleActive.filePath, '');

  const service = createCodexQueueService({ userData: () => root, skillRoots: [] });
  await assert.rejects(
    service.prepare({ ...project, activeFiles: { script: ep5.filePath } }, { episode: 9 }),
    error => error.code === 'SCRIPT_NOT_FOUND'
  );
});

test('自动拓扑重排母板先后顺序，同时保留循环依赖拦截并支持取消运行', async () => {
  const sorted = prepareRawQueueForNormalize({
    schemaVersion: 1,
    jobs: [
      { id: 'SC01-four', category: 'scene', name: '客厅四视图', look: '', view: '空间四视图', episodes: [1], source_scenes: ['1-1'], prompt: 'p2', references: ['SC01-front'], background: 'white', desired_aspect_ratio: '16:9', scale: '' },
      { id: 'SC01-front', category: 'scene', name: '客厅', look: '日间', view: '正打', episodes: [1], source_scenes: ['1-1'], prompt: 'p1', references: [], background: 'opaque', desired_aspect_ratio: '16:9', scale: '' }
    ]
  }, { episode: 1, projectTitle: '样片' });
  assert.deepEqual(sorted.jobs.map(j => j.id), ['SC01-front', 'SC01-four']);
  assert.equal(sorted.jobs[1].background, 'opaque');
  assert.equal('scale' in sorted.jobs[0], false);

  const { root, project } = await makeFixtureProject('1集.txt', '1-1 取消测试');
  const service = createCodexQueueService({
    userData: () => root,
    skillRoots: [],
    discover: async () => ({ selected: 'codex-entry', candidates: [{ path: 'codex-entry', version: '1.0' }] }),
    processRunner: (_file, _args, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(Error('已取消 Codex 队列准备任务'), { code: 'CODEX_CANCELLED' }));
      }, { once: true });
    })
  });
  const promise = service.prepare(project, { episode: 1, owner: 42 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(service.isBusy(), true);
  assert.equal(service.isWindowBusy(42), true);
  assert.equal(service.cancel(), true);
  await assert.rejects(promise, error => error.code === 'CODEX_CANCELLED');
  assert.equal(service.isBusy(), false);
});

test('超时错误即使推理文本含数字 429 也不会误判为额度耗尽', async () => {
  const { root, project } = await makeFixtureProject('1集.txt', '1-1 超时测试');
  const service = createCodexQueueService({
    userData: () => root,
    skillRoots: [],
    discover: async () => ({ selected: 'codex-entry', candidates: [{ path: 'codex-entry', version: '1.0' }] }),
    processRunner: async (_file, _args, options) => {
      options.onEvent({ type: 'thread.started', thread_id: 'thread-timeout' });
      options.onEvent({ type: 'item.completed', item: { type: 'reasoning', text: '门牌号 429 号房间，思考中...' } });
      throw Object.assign(Error('Codex 只读任务超时（超过 5 秒）'), {
        code: 'CODEX_TIMEOUT',
        stdout: '{"type":"item.completed","item":{"type":"reasoning","text":"429"}}',
        stderr: ''
      });
    }
  });
  await assert.rejects(
    service.prepare(project, { episode: 1, timeoutMs: 5000 }),
    error => error.code === 'CODEX_TIMEOUT'
  );
  assert.equal(usageLimitFailure('门牌号 429 号'), false);
  assert.equal(usageLimitFailure('HTTP 429 Too Many Requests'), true);
});
