'use strict';

// A split episode keeps its original integer slot as 上. 下 uses the half slot
// between that episode and the next integer, so existing episode numbers stay put.
const HALF = 0.5;
const EPSILON = 0.000001;

function baseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number + EPSILON) : 0;
}

function isLowerKey(value) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number - baseNumber(number) - HALF) < EPSILON;
}

function episodeByKey(project, key) {
  return (project?.episodes || []).find((episode) => Number(episode.number) === Number(key)) || null;
}

function partForKey(project, key) {
  const recorded = String(episodeByKey(project, key)?.part || '');
  return recorded === '上' || recorded === '下' ? recorded : (isLowerKey(key) ? '下' : '');
}

function label(project, key) {
  return `${baseNumber(key)}${partForKey(project, key)}`;
}

function fileStem(project, key) {
  const part = partForKey(project, key);
  return `${baseNumber(key)}集${part === '下' ? '下' : ''}`;
}

function filePart(fileName) {
  const base = String(fileName || '').split(/[\\/]/).at(-1).replace(/\.[^.]+$/, '');
  const match = base.match(/(?:第\s*)?0*\d{1,4}\s*(?:集|话|章)?\s*(上|中|下)(?!\d)/);
  return match?.[1] || '';
}

function matchingPart(project, key, fileName, source = false) {
  if (source) return true; // 上下集可共用同一章原文，剧本及成品各自独立。
  const wanted = partForKey(project, key);
  const found = filePart(fileName);
  if (wanted === '下') return found === '下';
  if (wanted === '上') return found === '' || found === '上';
  return true;
}

function splitEpisode(project, key) {
  const base = baseNumber(key);
  const upper = episodeByKey(project, base);
  if (!upper || upper.part || episodeByKey(project, base + HALF)) {
    throw new Error(`第 ${base} 集已拆分，或当前集不能再拆分。`);
  }
  upper.part = '上';
  const lower = {
    number: base + HALF,
    part: '下',
    title: '',
    targetSeconds: Number(upper.targetSeconds) || Number(project.targetDuration) || 120,
    status: '待创作',
    outline: { content: '', versions: [], updatedAt: null },
    script: { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null },
    shotlist: { content: '', versions: [], updatedAt: null },
    storyboard: { content: '', versions: [], checks: [], confirmedChecks: [], updatedAt: null },
    activeFiles: { source: '', outline: '', script: '', shotlist: '', storyboard: '' }
  };
  project.episodes.push(lower);
  project.episodes.sort((a, b) => Number(a.number) - Number(b.number));
  project.season = { ...(project.season || {}),
    numberedEpisodes: Number(project.season?.numberedEpisodes) || Number(project.season?.endEpisode) - Number(project.season?.startEpisode) + 1,
    totalEpisodes: project.episodes.length };
  return lower;
}

function numberedEpisodePlan(project, start, count) {
  const existing = new Map((project.episodes || []).map((episode) => [Number(episode.number), episode]));
  const numbered = Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return { number, title: '', targetSeconds: Number(project.targetDuration) || 120, status: '待创作', ...(existing.get(number) || {}) };
  });
  const extras = [...existing.values()].filter((episode) => isLowerKey(episode.number)
    && Number(episode.number) > start && Number(episode.number) < start + count);
  return [...numbered, ...extras].sort((a, b) => Number(a.number) - Number(b.number));
}

const api = { baseNumber, isLowerKey, episodeByKey, partForKey, label, fileStem, filePart, matchingPart, splitEpisode, numberedEpisodePlan };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.episodeSlots = api;
