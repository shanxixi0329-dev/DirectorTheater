'use strict';
const path = require('node:path');
// Cache parsed project metadata, never unverified document bytes. The episode
// reader still checks every selected document's on-disk signature.
function createProjectSessionCache({ signature, read, key, maxEntries = 6 }) {
  const entries = new Map();
  const pending = new Map();
  const generations = new Map();
  function invalidate(projectPath) {
    const id = key(projectPath);
    entries.delete(id);
    generations.set(id, (generations.get(id) || 0) + 1);
    pending.delete(id);
  }
  async function load(projectPath) {
    const id = key(projectPath);
    if (pending.has(id)) return pending.get(id);
    const generation = generations.get(id) || 0;
    const operation = (async () => {
      const stamp = await signature(projectPath);
      const cached = entries.get(id);
      if (cached && cached.stamp === stamp) {
        entries.delete(id); entries.set(id, cached);
        return cached.project;
      }
      const project = await read(projectPath);
      if ((generations.get(id) || 0) === generation) {
        entries.delete(id); entries.set(id, { stamp, project });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      }
      return project;
    })();
    pending.set(id, operation);
    try { return await operation; }
    finally { if (pending.get(id) === operation) pending.delete(id); }
  }
  return { load, invalidate, isLoading: projectPath => pending.has(key(projectPath)),
    clear: () => { for (const id of new Set([...entries.keys(), ...pending.keys()])) invalidate(id); } };
}
function recentProject(project) {
  const result = {};
  for (const field of ['id', 'title', 'projectPath', 'updatedAt', 'createdAt', 'currentEpisode', 'genre', 'status', 'unavailable']) {
    if (project[field] !== undefined) result[field] = project[field];
  }
  return result;
}
function relocateProjectReferences(project, previousRoot, selectedRoot) {
  if (!previousRoot || path.resolve(previousRoot).toLowerCase() === path.resolve(selectedRoot).toLowerCase()) return project;
  const paths = new Set(['path', 'localPath', 'filePath', 'outputPath', 'plainTextPath', 'docxPath', 'image']);
  const maps = new Set(['activeFiles', 'folders', 'seedFiles']);
  const text = new Set(['content', 'prompt', 'instruction', 'memory', 'system', 'user', 'assistant']);
  const rebase = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
    const relative = path.relative(previousRoot, value);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) ? path.join(selectedRoot, relative) : value;
  };
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [field, child] of Object.entries(value)) {
      if (paths.has(field)) value[field] = rebase(child);
      else if (maps.has(field) && child && typeof child === 'object') {
        for (const item of Object.keys(child)) child[item] = rebase(child[item]);
      } else if (!text.has(field)) visit(child);
    }
  }
  visit(project);
  return project;
}
module.exports = { createProjectSessionCache, recentProject, relocateProjectReferences };
