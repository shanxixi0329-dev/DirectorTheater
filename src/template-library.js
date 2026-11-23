const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const crypto = require('crypto');

const keyHex = process.env.DIRECTOR_THEATER_TEMPLATE_KEY || '';
const contentKey = /^[a-f0-9]{64}$/i.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;

const CATALOG = Object.freeze([
  { id: 'duration-1.0', category: 'planning', slot: 'duration', label: '短剧时长配置 1.0', fileName: '小说原文生成短剧时长配置提示词 1.0.md' },
  { id: 'outline-1.0', category: 'planning', slot: 'seriesOutline', label: 'AI漫剧全剧大纲 1.0', fileName: '小说原文生成AI漫剧全剧大纲提示词 1.0.md' },
  { id: 'script-6.0', category: 'script', slot: 'script', label: '原文生成剧本 6.0 精简生产版', fileName: '原文生成剧本_6.0_精简生产版（居导）.md', default: true },
  { id: 'script-6.1', category: 'script', slot: 'script', label: '原文生成剧本 6.1 深度思考版', fileName: '原文生成剧本_6.1_深度思考生产版.md' },
  { id: 'shotlist-16.9', category: 'shotlist', slot: 'shotlist', label: '剧本转分镜 16:9', fileName: '剧本转分镜16.9.md', default: true },
  { id: 'shotlist-16.9-exaggerated', category: 'shotlist', slot: 'shotlist', label: '剧本转分镜 16:9 夸张表现版', fileName: '剧本转分镜16.9_夸张表现版.md' },
  { id: 'shotlist-9.16', category: 'shotlist', slot: 'shotlist', label: '剧本转分镜 9:16', fileName: '剧本转分镜9.16.md' },
  { id: 'prompt-15', category: 'prompt', slot: 'prompt15', label: '分镜转提示词 15秒', fileName: '分镜转提示词15s.md', default: true },
  { id: 'prompt-30', category: 'prompt', slot: 'prompt30', label: '分镜转提示词 30秒', fileName: '分镜转提示词30s.md', default: true },
  { id: 'prompt-30-exaggerated', category: 'prompt', slot: 'prompt30', label: '分镜转提示词 30秒 夸张表现版', fileName: '分镜转提示词30s_夸张表现版.md' }
]);

function descriptor(item) {
  return {
    id: item.id,
    category: item.category,
    slot: item.slot,
    label: item.label,
    name: item.fileName,
    path: path.join(__dirname, 'templates', `${item.fileName}.dtp`),
    builtin: true,
    encrypted: true
  };
}

function listBuiltinTemplates() {
  if (!contentKey) return [];
  return CATALOG.map(descriptor).filter(item => existsSync(item.path));
}

function builtinTemplateById(id) {
  return listBuiltinTemplates().find(item => item.id === id) || null;
}

function builtinDefaults() {
  const output = { promptMode: '30' };
  for (const item of listBuiltinTemplates()) {
    if (item.category === 'planning' || CATALOG.find(entry => entry.id === item.id)?.default) {
      output[item.slot] = item;
    }
  }
  return output;
}

async function decryptTemplateFile(filePath) {
  if (!contentKey) throw new Error('当前版本请使用自行导入的要求文件。');
  const payload = await fs.readFile(filePath);
  if (payload.subarray(0, 4).toString('ascii') !== 'DTP1' || payload.length < 33) throw new Error('内置提示词文件已损坏。');
  const iv = payload.subarray(4, 16);
  const tag = payload.subarray(16, 32);
  const encrypted = payload.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', contentKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function readBuiltinTemplate(id) {
  const selected = builtinTemplateById(id);
  if (!selected) throw new Error('没有找到这份内置提示词。');
  return { template: selected, content: await decryptTemplateFile(selected.path) };
}

async function materializeBuiltinTemplate(id, targetRoot) {
  const result = await readBuiltinTemplate(id);
  const directory = path.join(targetRoot, 'director-theater-templates');
  await fs.mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, result.template.name);
  await fs.writeFile(outputPath, result.content, 'utf8');
  return { ...result.template, path: outputPath, materialized: true };
}

module.exports = { CATALOG, listBuiltinTemplates, builtinTemplateById, builtinDefaults, decryptTemplateFile, readBuiltinTemplate, materializeBuiltinTemplate };
