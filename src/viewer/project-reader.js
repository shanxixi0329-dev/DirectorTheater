const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');

const documentExtensions = new Set(['.txt', '.md', '.markdown', '.docx']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const audioExtensions = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);

const categoryDefinitions = [
  { key: 'source', label: '原文', prefix: '00', keywords: ['原文', '小说'] },
  { key: 'synopsis', label: '梗概', prefix: '01', keywords: ['梗概', '故事'] },
  { key: 'outline', label: '大纲', prefix: '02', keywords: ['大纲'] },
  { key: 'script', label: '剧本', prefix: '03', keywords: ['剧本'] },
  { key: 'shotlist', label: '分镜', prefix: '04', keywords: ['分镜'] },
  { key: 'prompt', label: '提示词', prefix: '05', keywords: ['提示词', 'seedance'] },
  { key: 'assets', label: '素材', prefix: '06', keywords: ['资产', '素材'] }
];

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function episodeNumberFrom(value) {
  const text = String(value || '');
  const explicit = text.match(/(?:第\s*)?(\d{1,4})\s*(?:集|话|章)/i);
  if (explicit) return Number(explicit[1]);
  const ep = text.match(/(?:^|[^a-z0-9])EP\s*(\d{1,4})(?:[^0-9]|$)/i);
  if (ep) return Number(ep[1]);
  const leading = path.basename(text).match(/^(\d{1,4})(?:[_\-\s]|$)/);
  return leading ? Number(leading[1]) : null;
}

function matchesDefinition(name, definition) {
  const normalized = String(name || '').trim().toLowerCase();
  if (new RegExp(`^${definition.prefix}(?:\\s|_|-|$)`).test(normalized)) return true;
  return definition.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

async function listDirectories(rootPath) {
  try {
    return (await fs.readdir(rootPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => naturalCompare(left.name, right.name));
  } catch {
    return [];
  }
}

async function discoverFolders(rootPath) {
  const directories = await listDirectories(rootPath);
  const folders = {};
  for (const definition of categoryDefinitions) {
    const match = directories.find((entry) => matchesDefinition(entry.name, definition));
    folders[definition.key] = match ? path.join(rootPath, match.name) : '';
  }
  return folders;
}

async function walkFiles(directory, allowedExtensions, maximum = 5000) {
  if (!directory) return [];
  const files = [];
  const pending = [directory];
  while (pending.length && files.length < maximum) {
    const current = pending.shift();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => naturalCompare(left.name, right.name));
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
        let stat = null;
        try { stat = await fs.stat(filePath); } catch { /* file changed during refresh */ }
        files.push({
          name: entry.name,
          path: filePath,
          relativePath: path.relative(directory, filePath),
          extension: path.extname(entry.name).toLowerCase(),
          episodeNumber: episodeNumberFrom(entry.name),
          size: stat?.size || 0,
          modifiedAt: stat?.mtime?.toISOString() || ''
        });
      }
      if (files.length >= maximum) break;
    }
  }
  return files.sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
}

function assetCategory(file) {
  const normalized = String(file.relativePath || file.name).toLowerCase();
  if (/(^|[\\/])01\s*人物|人物|角色/.test(normalized)) return '人物';
  if (/(^|[\\/])02\s*场景|场景/.test(normalized)) return '场景';
  if (/(^|[\\/])03\s*道具|道具|物品/.test(normalized)) return '道具';
  if (/(^|[\\/])04\s*配音|配音|音色|声音/.test(normalized)) return '配音';
  return '其他';
}

async function scanProject(rootPath) {
  const resolvedRoot = path.resolve(String(rootPath || ''));
  const rootStat = await fs.stat(resolvedRoot);
  if (!rootStat.isDirectory()) throw new Error('选择的路径不是文件夹。');
  const folders = await discoverFolders(resolvedRoot);
  const documents = {};
  await Promise.all(categoryDefinitions.filter((item) => item.key !== 'assets').map(async (definition) => {
    documents[definition.key] = await walkFiles(folders[definition.key], documentExtensions);
  }));
  const assetFiles = await walkFiles(folders.assets, new Set([...documentExtensions, ...imageExtensions, ...audioExtensions]));
  const assets = assetFiles.map((file) => ({
    ...file,
    kind: imageExtensions.has(file.extension) ? 'image' : audioExtensions.has(file.extension) ? 'audio' : 'document',
    category: assetCategory(file)
  }));
  const episodeNumbers = new Set();
  for (const files of Object.values(documents)) {
    for (const file of files) if (Number.isInteger(file.episodeNumber)) episodeNumbers.add(file.episodeNumber);
  }
  for (const file of assets) if (Number.isInteger(file.episodeNumber)) episodeNumbers.add(file.episodeNumber);
  const episodes = [...episodeNumbers].sort((left, right) => left - right);
  return {
    rootPath: resolvedRoot,
    name: path.basename(resolvedRoot),
    folders,
    documents,
    assets,
    episodes,
    scannedAt: new Date().toISOString()
  };
}

function pathInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function readDocument(rootPath, filePath) {
  if (!pathInside(rootPath, filePath)) throw new Error('只能读取当前项目文件夹内的文件。');
  const extension = path.extname(filePath).toLowerCase();
  if (!documentExtensions.has(extension)) throw new Error('阅读器仅支持 TXT、Markdown 和 Word 文档。');
  const content = extension === '.docx'
    ? (await mammoth.extractRawText({ path: filePath })).value
    : await fs.readFile(filePath, 'utf8');
  const stat = await fs.stat(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    extension,
    content: String(content || '').replace(/^\uFEFF/, ''),
    modifiedAt: stat.mtime.toISOString(),
    size: stat.size
  };
}

module.exports = {
  assetCategory,
  categoryDefinitions,
  documentExtensions,
  episodeNumberFrom,
  pathInside,
  readDocument,
  scanProject
};
