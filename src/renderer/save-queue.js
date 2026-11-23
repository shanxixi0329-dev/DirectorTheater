(function exposeSaveQueue(root) {
  'use strict';
  function createSaveQueue() {
    const pending = new Map();
    function run(key, action) {
      const previous = pending.get(key) || Promise.resolve();
      const task = previous.catch(() => {}).then(action);
      pending.set(key, task);
      const clean = () => { if (pending.get(key) === task) pending.delete(key); };
      task.then(clean, clean);
      return task;
    }
    return { run, busy: key => pending.has(key), drain: () => Promise.all([...pending.values()]) };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createSaveQueue };
  else root.DirectorSaveQueue = { createSaveQueue };
})(typeof window === 'object' ? window : globalThis);
