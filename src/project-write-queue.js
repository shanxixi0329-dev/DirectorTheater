'use strict';

function createProjectWriteQueue({ write, key, onStatus = () => {}, delayMs = 400 }) {
  const records = new Map();
  let revision = 0;
  const publish = (record, task, status, error) => {
    const event = { projectPath: task.project.projectPath, updatedAt: task.project.updatedAt,
      revision: task.revision, status, error: error ? String(error.message || error) : '' };
    record.status = event;
    try { onStatus(event); } catch { /* A closed renderer must not break a disk write. */ }
  };
  function start(record) {
    clearTimeout(record.timer); record.timer = null;
    if (record.running) return record.running;
    if (!record.pending) return Promise.resolve();
    const run = (async () => {
      while (record.pending) {
        const task = record.pending; record.pending = null;
        publish(record, task, 'saving');
        try {
          await write(task.project);
          record.error = null; record.failed = null;
          if (!record.pending) publish(record, task, 'saved');
        } catch (error) {
          record.error = error; record.failed = task;
          if (!record.pending) publish(record, task, 'error', error);
        }
      }
    })();
    record.running = run;
    return run.finally(() => {
      if (record.running === run) record.running = null;
      if (record.pending) void start(record);
    });
  }
  function enqueue(project) {
    const id = key(project.projectPath);
    const record = records.get(id) || { pending: null, running: null, timer: null, error: null, failed: null };
    records.set(id, record);
    const task = { project: structuredClone(project), revision: ++revision };
    record.pending = task; record.error = null; record.failed = null;
    publish(record, task, 'queued');
    clearTimeout(record.timer);
    if (!record.running) record.timer = setTimeout(() => { void start(record); }, delayMs);
    return task.revision;
  }
  async function flush(projectPath) {
    const selected = projectPath ? [records.get(key(projectPath))].filter(Boolean) : [...records.values()];
    await Promise.all(selected.map(async record => {
      if (record.failed && !record.pending && !record.running) {
        record.pending = record.failed; record.error = null;
      }
      do { await start(record); } while (record.pending || record.running);
      if (record.error) throw record.error;
    }));
  }
  function hasWork(projectPath) {
    const record = records.get(key(projectPath));
    return Boolean(record && (record.pending || record.running || record.failed));
  }
  return { enqueue, flush, hasWork };
}

module.exports = { createProjectWriteQueue };
