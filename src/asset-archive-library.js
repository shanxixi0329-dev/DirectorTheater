'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { normalizeManifest } = require('./asset-batch-schema');

const manifestName = '图片生成与归档清单.json';
const key = file => path.resolve(file).toLowerCase();
const hash = input => createHash('sha256').update(input).digest('hex');
const batchRoot = project => path.join(project.projectPath, '.ai-director', 'asset-batches');
const importRoot = project => path.join(project.projectPath, '.ai-director', 'asset-imports');
async function optional(action, fallback) {
  try { return await action(); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

function createArchiveLibrary({ userData, writeAtomic }) {
  const local = project => path.join(userData(), 'asset-archives', hash(key(project.projectPath)));
  const writeJson = (file, data) => writeAtomic(file, JSON.stringify(data, null, 2), 'utf8');
  function bind(project, directory) {
    return writeJson(path.join(local(project), 'binding.json'), { root: path.resolve(directory) });
  }
  async function unbind(project) {
    await fs.rm(path.join(local(project), 'binding.json'), { force: true }).catch(() => {});
  }
  async function boundRoot(project) {
    const binding = await optional(() => readJson(path.join(local(project), 'binding.json')), {});
    return binding.root || '';
  }
  function defaultRoot(project) {
    return path.join(project.projectPath, '06 资产', 'images');
  }
  async function outputRoot(project) {
    return await boundRoot(project) || defaultRoot(project);
  }
  async function info(project) {
    const bound = await boundRoot(project);
    const fallback = defaultRoot(project);
    return { boundRoot: bound, defaultRoot: fallback, outputRoot: bound || fallback };
  }
  async function importFile(project, file) {
    const rows = normalizeManifest(await readJson(file));
    // Re-importing this source replaces its snapshot; other batches remain independently readable.
    const batch = 'import-' + hash(key(file)).slice(0, 24);
    const hints = Object.fromEntries(rows.map(row => [row.id, row.path || path.resolve(path.dirname(file), row.relative_path)]));
    const revision = hash(JSON.stringify(hints));
    await writeJson(path.join(local(project), revision + '.json'), hints);
    await writeJson(path.join(importRoot(project), batch, manifestName), {
      schemaVersion: 1, hintsRevision: revision, assets: rows.map(({ path: original, ...portable }) => portable)
    });
    return rows.length;
  }
  async function read(project, episode, legacy) {
    const records = new Map(), warnings = [];
    const assetsDir = path.join(project.projectPath, '06 资产');
    const imagesDir = path.join(assetsDir, 'images');
    const binding = await boundRoot(project);
    async function collect(file, adjacentRoot, priority = 1) {
      try {
        const raw = await readJson(file);
        const hints = /^[a-f0-9]{64}$/.test(raw.hintsRevision || '')
          ? await optional(() => readJson(path.join(local(project), raw.hintsRevision + '.json')), {}) : {};
        for (const row of normalizeManifest(raw)) {
          const original = row.path || (Object.hasOwn(hints, row.id) ? hints[row.id] : '');
          const adjacent = adjacentRoot && path.join(adjacentRoot, row.relative_path);
          const rebound = binding && path.join(binding, row.relative_path);
          const projectImage = path.join(imagesDir, row.relative_path);
          const candidates = [...new Set([rebound, projectImage, original, adjacent].filter(Boolean))];
          const mapKey = row.relative_path.toLowerCase();
          const existing = records.get(mapKey);
          const incomingTime = Date.parse(row.checked_at || '') || 0;
          const existingTime = existing ? (Date.parse(existing.row.checked_at || '') || 0) : -1;
          const shouldReplace = !existing || priority > existing.priority || (priority === existing.priority && incomingTime >= existingTime);
          if (shouldReplace) {
            records.set(mapKey, { row, priority, candidates: [...new Set([...candidates, ...(existing?.candidates || [])])] });
          } else {
            existing.candidates = [...new Set([...existing.candidates, ...candidates])];
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(path.basename(path.dirname(file)) + '/' + path.basename(file) + '：' + error.message);
      }
    }
    const batches = batchRoot(project);
    const imports = importRoot(project);
    await collect(path.join(assetsDir, manifestName), assetsDir, 1);
    const importedDirs = await optional(() => fs.readdir(imports, { withFileTypes: true }), []);
    for (const dir of importedDirs.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      await collect(path.join(imports, dir.name, manifestName), '', 1);
    }
    const entries = await optional(() => fs.readdir(batches, { withFileTypes: true }), []);
    for (const dir of entries.filter(item => item.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
      const base = path.join(batches, dir.name);
      const isLegacyImport = dir.name.startsWith('import-');
      await collect(path.join(base, manifestName), '', isLegacyImport ? 1 : 2);
      const published = path.join(base, 'published');
      const receipts = await optional(() => fs.readdir(published, { withFileTypes: true }), []);
      for (const receipt of receipts) {
        if (receipt.isFile() && /\.json$/i.test(receipt.name)) await collect(path.join(published, receipt.name), '', 3);
      }
    }
    const indexedPaths = new Set(), current = [];
    for (const record of records.values()) {
      for (const file of record.candidates) indexedPaths.add(key(file));
      if (record.row.episodes.includes(episode)) current.push(record);
    }
    const archived = [];
    // Bound parallel opens on a network drive; only touch PNGs for the selected episode.
    for (let start = 0; start < current.length; start += 12) {
      archived.push(...await Promise.all(current.slice(start, start + 12).map(async ({ row, candidates }) => {
        let localPath = '';
        for (const file of candidates) {
          try {
            if (!(await fs.stat(file)).isFile()) continue;
            await fs.access(file, fs.constants.R_OK);
            localPath = file;
            break;
          } catch { /* Try the original path if the local binding is unavailable. */ }
        }
        return { ...row, archive: true, type: 'image', category: row.category === 'character' ? 'role' : row.category,
          localPath, fileUrl: localPath ? pathToFileURL(localPath).href : '', readable: Boolean(localPath) };
      })));
    }
    const fallback = (legacy || []).filter(asset => asset?.type === 'image' && asset.localPath && asset.episodes?.includes(episode) && !indexedPaths.has(key(asset.localPath)))
      .map(asset => ({ ...asset, fileUrl: pathToFileURL(asset.localPath).href }));
    return { images: [...archived, ...fallback], warnings };
  }
  return { read, bind, unbind, boundRoot, info, importFile, outputRoot };
}
module.exports = { createArchiveLibrary };
