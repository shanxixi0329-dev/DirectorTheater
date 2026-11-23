'use strict';

// Apply only changes made by this window. Stable identities let two windows
// save different episodes without replacing each other's episode records.
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => value === undefined ? undefined : structuredClone(value);
function mergeProject(base, local, latest, trail = '') {
  if (equal(base, local)) return clone(latest);
  if (equal(base, latest) || equal(local, latest)) return clone(local);
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(latest)) {
    const key = ['id', 'number', 'path'].find(field => [...base, ...local, ...latest].every(item =>
      item && typeof item === 'object' && item[field] !== undefined)
      && [base, local, latest].every(items => new Set(items.map(item => String(item[field]))).size === items.length));
    if (key) {
      const maps = [base, local, latest].map(items => new Map(items.map(item => [String(item[key]), item])));
      const ids = new Set([...latest, ...local].map(item => String(item[key])));
      return [...ids].map(id => mergeProject(maps[0].get(id), maps[1].get(id), maps[2].get(id), trail + '[' + id + ']')).filter(item => item !== undefined);
    }
  }
  if ([base, local, latest].every(value => value && typeof value === 'object' && !Array.isArray(value))) {
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(latest)])) {
      // Selection and derived display fields belong to the saving window.
      if (!trail && ['currentEpisode', 'targetDuration', 'updatedAt', 'activeFiles', 'outline', 'script', 'shotlist', 'storyboard'].includes(key)) {
        result[key] = clone(local[key]);
      } else if (key === 'updatedAt') result[key] = clone(local[key]);
      else {
        const value = mergeProject(base[key], local[key], latest[key], trail ? trail + '.' + key : key);
        if (value !== undefined) result[key] = value;
      }
    }
    return result;
  }
  throw new Error('其他窗口已修改同一项项目资料（' + (trail || '项目') + '）。本窗修改已保留，请先刷新核对后再保存。');
}

function createSerialQueue() {
  const pending = new Map();
  return async (key, action) => {
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    pending.set(key, next);
    try { return await next; }
    finally { if (pending.get(key) === next) pending.delete(key); }
  };
}
module.exports = { mergeProject, createSerialQueue };
