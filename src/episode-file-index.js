'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

// Cache directory entries, not stale document bytes. Every selected document
// is still stat'ed before reading. No stat of every numbered episode on a click.
function createEpisodeFileIndex({ identifyName, identifyContent, extensions, maxDirectories = 256 }) {
  const directories = new Map(), hints = new Map();
  const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  function directoryState(directory) {
    const id = key(directory);
    if (directories.has(id)) return directories.get(id);
    if (directories.size >= maxDirectories) {
      const oldest = directories.keys().next().value;
      directories.get(oldest).watcher?.close(); directories.delete(oldest);
    }
    const state = { files: null, signature: '', generation: 0, watcher: null, pending: null };
    directories.set(id, state);
    try {
      state.watcher = fsSync.watch(directory, (event, filename) => {
        if (event === 'rename') { state.signature = ''; state.generation += 1; }
        if (filename) hints.delete(key(path.join(directory, String(filename))));
        else for (const file of state.files || []) hints.delete(key(file.path));
      });
      state.watcher.on('error', () => { state.watcher?.close(); state.watcher = null; state.signature = ''; });
      state.watcher.unref?.();
    } catch { /* Unsupported shared drives use metadata checks instead. */ }
    return state;
  }
  async function entries(directory) {
    const state = directoryState(directory);
    let stat;
    try { stat = await fs.stat(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${state.generation}`;
    if (state.signature === signature && state.files) return state.files;
    if (state.pending) return state.pending;
    const generation = state.generation;
    state.pending = fs.readdir(directory, { withFileTypes: true }).then(items => {
      const files = items.filter(item => !item.name.startsWith('.') && !item.name.startsWith('~$'))
        .filter(item => item.isDirectory() || item.isFile() && extensions.has(path.extname(item.name).toLowerCase()))
        .map(item => ({ name: item.name, path: path.join(directory, item.name), directory: item.isDirectory() }));
      state.files = files;
      state.signature = state.generation === generation ? signature : '';
      return files;
    }).finally(() => { state.pending = null; });
    return state.pending;
  }
  function seed(directory, files) {
    const root = key(directory);
    directoryState(directory);
    for (const file of files) {
      if (!key(file.path).startsWith(root + path.sep)) continue;
      directoryState(path.dirname(file.path));
      if (!hints.has(key(file.path))) hints.set(key(file.path), { number: file.episodeNumber ?? null, size: file.size,
        modifiedAt: file.modifiedAt, signature: '' });
    }
  }
  async function identify(file) {
    const number = identifyName(file.name);
    if (number !== null) return { ...file, episodeNumber: number, episodeDetectedFrom: 'fileName' };
    const state = directoryState(path.dirname(file.path));
    let hint = hints.get(key(file.path));
    if (hint?.signature && state.watcher) return { ...file, episodeNumber: hint.number, episodeDetectedFrom: 'content' };
    try {
      const stat = await fs.stat(file.path);
      const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (!hint || hint.signature !== signature) {
        const matchesSaved = hint && !hint.signature && hint.size === stat.size
          && hint.modifiedAt === stat.mtime.toISOString();
        const number = matchesSaved ? hint.number : await identifyContent(file.path);
        hint = { number, signature }; hints.set(key(file.path), hint);
      }
      return { ...file, episodeNumber: hint.number, episodeDetectedFrom: 'content' };
    } catch { return { ...file, episodeNumber: null, episodeDetectedFrom: '' }; }
  }
  async function list(directory, { extensions: selectedExtensions = extensions } = {}) {
    const files = [];
    async function visit(current, depth) {
      if (depth > 64) throw new Error('项目目录层级过深，请整理目录后重试。');
      const children = await entries(current);
      for (const child of children) {
        if (child.directory) await visit(child.path, depth + 1);
        else if (selectedExtensions.has(path.extname(child.name).toLowerCase())) files.push(child);
      }
    }
    await visit(directory, 0);
    let cursor = 0;
    const identified = new Array(files.length);
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= files.length) return;
        identified[index] = await identify(files[index]);
      }
    }));
    return identified.sort((a, b) => {
      if (a.episodeNumber !== null && b.episodeNumber !== null && a.episodeNumber !== b.episodeNumber) return a.episodeNumber - b.episodeNumber;
      if (a.episodeNumber !== null && b.episodeNumber === null) return -1;
      if (a.episodeNumber === null && b.episodeNumber !== null) return 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  }
  function clear() { for (const state of directories.values()) state.watcher?.close(); directories.clear(); hints.clear(); }
  function removeProject(projectPath) {
    const root = key(projectPath);
    for (const [directory, state] of directories) if (directory === root || directory.startsWith(root + path.sep)) {
      state.watcher?.close(); directories.delete(directory);
    }
    for (const file of hints.keys()) if (file.startsWith(root + path.sep)) hints.delete(file);
  }
  return { seed, list, clear, removeProject };
}

function createEpisodeDocumentCache({ readDocument, maxChars = 16 * 1024 * 1024, maxEntries = 96 }) {
  const cache = new Map(); let usedChars = 0;
  function remove(key) { const item = cache.get(key); if (item) usedChars -= item.content.length; cache.delete(key); }
  async function read(file) {
    const stat = await fs.stat(file);
    const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    const previous = cache.get(file);
    if (previous?.signature === signature) {
      cache.delete(file); cache.set(file, previous);
      return { name: path.basename(file), path: file, content: previous.content, updatedAt: stat.mtime.toISOString() };
    }
    remove(file);
    const content = await readDocument(file);
    // Check again after Word parsing: never label an old read with a new stat.
    const after = await fs.stat(file);
    if (after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs && content.length <= maxChars) {
      while (cache.size && (cache.size >= maxEntries || usedChars + content.length > maxChars)) remove(cache.keys().next().value);
      cache.set(file, { signature, content }); usedChars += content.length;
    }
    return { name: path.basename(file), path: file, content, updatedAt: stat.mtime.toISOString() };
  }
  return { read, clear: () => { cache.clear(); usedChars = 0; }, removeProject: projectPath => {
    const root = path.resolve(projectPath).toLowerCase() + path.sep;
    for (const file of cache.keys()) if (path.resolve(file).toLowerCase().startsWith(root)) remove(file);
  } };
}

module.exports = { createEpisodeFileIndex, createEpisodeDocumentCache };
