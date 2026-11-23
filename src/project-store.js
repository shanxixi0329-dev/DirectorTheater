'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function parseStore(raw) {
  const value = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  if (!value || !Array.isArray(value.projects) || value.projects.some(project =>
    !project || typeof project !== 'object' || typeof project.projectPath !== 'string' || !project.projectPath.trim())) {
    throw new Error('项目列表格式不完整');
  }
  return value;
}

function createProjectStore({ filePath, writeAtomic }) {
  let pending = Promise.resolve();
  let notice = null;
  async function load() {
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
      return parseStore(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        try {
          const recovered = parseStore(await fs.readFile(filePath + '.bak', 'utf8'));
          notice = { recovered: true, preservedPath: filePath + '.bak', message: '项目列表文件暂时缺失，已读取上次有效备份。原项目文件夹仍保持完整。' };
          return recovered;
        } catch (backupError) {
          if (backupError.code === 'ENOENT') return { projects: [] };
          notice = { recovered: false, preservedPath: filePath + '.bak', message: '项目列表文件缺失，备份也无法读取。请用“打开项目”重新加入已有项目；原备份已保留。' };
          return { projects: [] };
        }
      }
      // Permission and device errors must never turn a readable project list
      // into an empty replacement. Keep the original and surface the failure.
      if (raw === undefined) throw new Error('无法读取项目列表，原文件已保留：' + error.message);
      const preservedPath = filePath + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
      await fs.copyFile(filePath, preservedPath);
      try {
        const recovered = parseStore(await fs.readFile(filePath + '.bak', 'utf8'));
        notice = { recovered: true, preservedPath, message: '项目列表损坏，已读取上次有效备份。损坏文件已单独保留；缺少的项目可通过“打开项目”重新加入。' };
        return recovered;
      } catch {
        notice = { recovered: false, preservedPath, message: '项目列表损坏，原文件已单独保留，项目文件夹中的作品仍在。请用“打开项目”重新加入已有项目。' };
        return { projects: [] };
      }
    }
  }
  function save(value) {
    // Capture before queueing, then serialize replacements in request order.
    const snapshot = JSON.stringify(value, null, 2);
    parseStore(snapshot);
    const task = pending.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      try {
        const previous = await fs.readFile(filePath, 'utf8');
        try {
          parseStore(previous);
          await writeAtomic(filePath + '.bak', previous, 'utf8');
        } catch (error) {
          if (!(error instanceof SyntaxError) && error.message !== '项目列表格式不完整') throw error;
          // load() preserves corrupt input; never promote it to the backup.
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await writeAtomic(filePath, snapshot, 'utf8');
      // A first successful save also provides a recoverable baseline.
      try { await fs.access(filePath + '.bak'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeAtomic(filePath + '.bak', snapshot, 'utf8');
      }
    });
    pending = task;
    return task;
  }
  return { load, save, status: () => notice };
}
module.exports = { createProjectStore, parseStore };
