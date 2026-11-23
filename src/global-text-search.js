'use strict';

// Both Word parsing and literal matching run outside Electron's UI thread.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const extensions = new Set(['.txt', '.md', '.markdown', '.docx']);
const fingerprint = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function timed(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description + '超过30秒，请检查磁盘或共享盘连接。')), 30000);
    })]);
  } finally { clearTimeout(timer); }
}

function decodeText(bytes) {
  // Never silently replace invalid bytes and then write damaged text back.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('文本不是有效 UTF-8，请另存为 UTF-8 后重试。'); }
}

async function scan(input, progress = () => {}) {
  const needle = String(input.needle || '');
  if (!needle) throw new Error('请填写要查找的内容。');
  const replacement = String(input.replacement ?? '');
  const errors = [], files = [], matches = [], changes = [];
  const selectedExtensions = Array.isArray(input.extensions) ? new Set(input.extensions.filter(value => extensions.has(value))) : extensions;
  const seen = new Set();
  const revision = crypto.createHash('sha256').update(JSON.stringify([input.projectPath, input.directories, [...selectedExtensions].sort(), needle, replacement]));
  let scanned = 0, replacements = 0, lastProgress = 0;
  function notify(phase, current = '', force = false) {
    if (!force && Date.now() - lastProgress < 100) return;
    lastProgress = Date.now();
    progress({ phase, scanned, total: files.length, matched: matches.length, errors: errors.length,
      current: current ? path.relative(input.projectPath, current) : '' });
  }
  function fail(file, error) {
    errors.push({ path: path.relative(input.projectPath, file), code: String(error.code || 'READ_FAILED'),
      message: String(error.message || error).slice(0, 240) });
  }
  async function visit(directory, depth = 0) {
    if (depth > 64) { fail(directory, new Error('目录层级超过64层。')); return; }
    let entries;
    try { entries = await timed(fs.readdir(directory, { withFileTypes: true }), '读取目录'); }
    catch (error) { if (error.code !== 'ENOENT') fail(directory, error); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$') || entry.name === '导演台替换备份') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile() && selectedExtensions.has(path.extname(file).toLowerCase()) && !seen.has(file)) {
        if (files.length >= 100000) throw new Error('文档超过十万个，请缩小项目范围后再查找。');
        seen.add(file); files.push(file);
      }
      notify('listing');
    }
  }
  notify('listing', '', true);
  for (const directory of input.directories) await visit(directory);
  notify('reading', '', true);
  for (const file of files) {
    try {
      const stat = await timed(fs.stat(file), '读取文件信息');
      if (stat.size > 64 * 1024 * 1024) throw new Error('单个文档超过64MB，请拆分后查找。');
      const bytes = await timed(fs.readFile(file), '读取文件');
      const digest = fingerprint(bytes);
      revision.update(JSON.stringify([path.relative(input.projectPath, file), digest]));
      const text = path.extname(file).toLowerCase() === '.docx'
        ? (await timed(require('mammoth').extractRawText({ buffer: bytes }), '解析Word')).value
        : decodeText(bytes);
      let count = 0, offset = 0, index;
      while ((index = text.indexOf(needle, offset)) !== -1) { count += 1; offset = index + needle.length; }
      if (count) {
        const first = text.indexOf(needle);
        matches.push({ path: path.relative(input.projectPath, file), count,
          line: text.slice(0, first).split(/\r?\n/).length,
          excerpt: text.slice(Math.max(0, first - 32), Math.min(text.length, first + needle.length + 64)),
          fingerprint: digest, format: path.extname(file).toLowerCase() });
        replacements += count;
        if (!input.previewOnly) changes.push({ path: file, count, fingerprint: digest,
          content: text.split(needle).join(replacement) });
      }
    } catch (error) { fail(file, error); }
    scanned += 1;
    notify('reading', file);
    // Let timers and cancellation messages run even on huge plain text files.
    if (scanned % 20 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  notify('complete', '', true);
  return { files: matches.length, replacements, matches, errors, scanned, preview: Boolean(input.previewOnly),
    complete: errors.length === 0, revision: revision.digest('hex'), changes };
}

function runSearch(input, { onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消查找。'));
    // Requiring an ASAR module through the module loader also works for the
    // installed app; do not hand an archive path to Node's worker entry loader.
    const worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      require(workerData.modulePath).scan(workerData.input,
        event => parentPort.postMessage({ type: 'progress', event }))
        .then(result => parentPort.postMessage({ type: 'result', result }))
        .catch(error => parentPort.postMessage({ type: 'error', message: error.message }));
    `, { eval: true, workerData: { modulePath: __filename, input },
      resourceLimits: { maxOldGenerationSizeMb: 384 } });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('查找已超过10分钟，请检查项目所在磁盘后重试。')), 10 * 60 * 1000);
    const cancel = () => finish(new Error('已取消查找。'));
    function finish(error, result) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    }
    signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', message => {
      if (message.type === 'progress') onProgress(message.event);
      else if (message.type === 'result') finish(null, message.result);
      else finish(new Error(message.message || '查找失败。'));
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (!settled) finish(new Error('查找进程提前退出：' + code)); });
  });
}

module.exports = { scan, runSearch, fingerprint };
