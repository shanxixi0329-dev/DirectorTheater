'use strict';
const { Worker } = require('node:worker_threads');
const crypto = require('node:crypto');
const path = require('node:path');

function createBackgroundDocumentChecks() {
  const slots = new Map();
  const cache = new Map();
  function superseded() { const error = new Error('检查已由新内容替代。'); error.code = 'CHECK_SUPERSEDED'; return error; }
  function run(kind, args, owner = 'default') {
    const hash = crypto.createHash('sha256').update(kind);
    for (const value of args) { const encoded = JSON.stringify(value ?? ''); hash.update(encoded.length + ':'); hash.update(encoded); }
    const key = hash.digest('hex');
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const slot = owner + ':' + kind;
    const prior = slots.get(slot);
    if (prior?.key === key) return prior.promise;
    if (prior) { prior.reject(superseded()); void prior.worker.terminate(); slots.delete(slot); }
    const worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      try {
        const checks = require(workerData.modulePath);
        const fn = workerData.kind === 'script' ? checks.validateLocalScript : checks.validateStoryboard;
        parentPort.postMessage({ ok: true, value: fn(...workerData.args) });
      } catch (error) { parentPort.postMessage({ ok: false, message: error.message }); }
    `, { eval: true, workerData: { kind, args, modulePath: path.join(__dirname, 'document-checks.js') },
      resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const job = { worker, key };
    job.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('文档检查超过60秒，请缩小文档后重试。')), 60000);
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (slots.get(slot) === job) slots.delete(slot);
        void worker.terminate();
        if (error) reject(error);
        else {
          if (cache.size >= 16) cache.delete(cache.keys().next().value);
          cache.set(key, value); resolve(value);
        }
      }
      job.reject = error => finish(error);
      worker.on('message', message => message.ok ? finish(null, message.value) : finish(new Error(message.message)));
      worker.on('error', error => finish(error));
      worker.on('exit', code => { if (!settled) finish(new Error('文档检查进程提前退出：' + code)); });
    });
    slots.set(slot, job);
    return job.promise;
  }
  function close() { for (const job of [...slots.values()]) job.reject(superseded()); slots.clear(); cache.clear(); }
  return { run, close };
}
module.exports = { createBackgroundDocumentChecks };
