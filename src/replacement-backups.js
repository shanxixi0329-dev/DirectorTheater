'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fingerprint } = require('./global-text-search');

function inside(root, relative) {
  const target = path.resolve(root, relative);
  const remainder = path.relative(path.resolve(root), target);
  if (!remainder || remainder.startsWith('..') || path.isAbsolute(remainder)) throw new Error('备份清单包含无效路径。');
  return target;
}

async function readManifest(project, directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (path.resolve(manifest.projectPath).toLowerCase() !== path.resolve(project.projectPath).toLowerCase()) throw new Error('该备份不属于当前项目。');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('备份清单为空或不完整。');
  return manifest;
}

async function restore(project, directory, writeAtomic) {
  const manifest = await readManifest(project, directory);
  if (manifest.restoredAt) throw new Error('这次替换已经撤销。');
  const prepared = [];
  for (const item of manifest.files) {
    const target = inside(project.projectPath, item.relative);
    const backup = inside(path.join(directory, 'original'), item.relative);
    const current = await fs.readFile(target);
    if (fingerprint(current) !== item.stagedHash) throw new Error('替换后又有修改，未撤销任何文件：' + item.relative + '。请打开备份手动合并。');
    const original = await fs.readFile(backup);
    if (fingerprint(original) !== item.originalHash) throw new Error('原文件备份校验失败：' + item.relative);
    prepared.push({ ...item, target, original, current });
  }
  const touched = [];
  try {
    for (const item of prepared) {
      if (fingerprint(await fs.readFile(item.target)) !== item.stagedHash) throw new Error('撤销前文件发生变化：' + item.relative);
      touched.push(item);
      await writeAtomic(item.target, item.original);
    }
    await writeAtomic(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, restoredAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (error) {
    const conflicts = [];
    for (const item of touched.reverse()) {
      try {
        const currentHash = fingerprint(await fs.readFile(item.target));
        if (currentHash === item.stagedHash) continue;
        if (currentHash !== item.originalHash) throw new Error('文件被再次修改');
        await writeAtomic(item.target, item.current);
      } catch { conflicts.push(item.relative); }
    }
    throw new Error(error.message + (conflicts.length ? '；以下文件请从备份核对：' + conflicts.join('、') : '；撤销未完成，已恢复到撤销前。'));
  }
  return { files: prepared.length, backupDirectory: directory, restored: true };
}

module.exports = { readManifest, restore };
