// Local production records. No model calls, browser automation, or API credentials.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const extras = require('./production-extras');
const qaEngine = require('./production-qa');
const hash = text => crypto.createHash('sha256').update(String(text || '')).digest('hex');
const stamp = () => new Date().toISOString();
const roles = [
  { id: 'director', name: '导演统筹', deps: [], brief: '逐集阅读定稿剧本；以小说补充动机和因果；列出戏剧目标、情绪转折、连续性和待确认问题。引用原句与位置，不能只写通读完成。' },
  { id: 'assets', name: '资产与连续性', deps: ['director'], brief: '提取本集入镜角色、场景、道具；列出服饰、伤势、持物、场景状态及前后集衔接。对白提及的人不自动算入镜人物。保留同义名依据。' },
  { id: 'shotlist', name: '12列分镜', deps: ['director', 'assets'], brief: '按定稿剧本逐镜拆解，完整输出12列Markdown：镜号、时长、景别、摄法、拍摄角度、构图、画面内容、台词、音效、入镜角色、场景、时间地点。严格遵守项目模板白名单；不改台词，保留独立V.O./O.S.，按自然语速安排时长，不补空镜凑时长。' },
  { id: 'prompt', name: 'Seedance提示词', deps: ['shotlist'], brief: '只从已验收分镜推导可复制的完整提示词，不重新导演、不增删剧情和台词。时长与镜头对应，按项目规则分组，核对结构化资产定义和实际入镜引用。' },
  { id: 'qc', name: '独立质检', deps: ['shotlist', 'prompt'], brief: '逐句核对剧本、分镜、提示词对白顺序；检查漏戏、自然口播、时间轴、12列、规则白名单、资产引用及连续性。每个问题写集数/组/镜/组内秒、证据、原因与可复制替换。区分确定错误、生成风险、待人工确认；静态扫描不等于语义或画面验收。' },
  { id: 'post', name: '后期交接', deps: ['qc'], brief: '按集整理人物牌、地点牌、字幕和声音交接；写明组/镜/组内秒及前后镜头；不虚构尚未生成视频的实际时间码。导出完整字段。' }
];
const principles = '定稿剧本是剧情和对白依据；规则约束格式；小说只补充因果与动机。先分镜后提示词。原件只读，修订保留历史。未经核验的记忆不得当作事实。项目规则优先于历史项目的时长数字。';
function fresh() { return extras.shape({ schema: 2, revision: 0, episodes: {}, memory: [], events: [] }); }
function createEpisode(number) {
  return { number, paused: false, documents: {}, tasks: roles.map(r => ({ id: r.id, status: 'pending', versions: [], issues: [], prepared: null })) };
}
function dependencies(ep, task) { return roles.find(r => r.id === task.id).deps.map(id => ep.tasks.find(t => t.id === id)); }
function ready(ep, task) { return dependencies(ep, task).every(t => t.status === 'approved'); }
function invalidate(ep, id) {
  for (const task of ep.tasks) {
    if (roles.find(r => r.id === task.id).deps.includes(id)) {
      if (task.versions.length || task.prepared) task.status = 'stale';
      task.prepared = null;
      invalidate(ep, task.id);
    }
  }
}
function localChecks(id, text, ep) {
  const items = [];
  const issue = (detail, level = 'error') => items.push({ level, detail });
  if (!text.trim()) issue('结果为空。');
  if (id === 'shotlist' && text.trim()) {
    const rows = text.split(/\r?\n/).filter(l => /^\s*\|/.test(l));
    if (rows.length < 3) issue('未检测到包含表头、分隔行、镜头行的Markdown表格。');
    rows.forEach((line, i) => {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
      if (cells.length !== 12) issue(`表格第${i + 1}行是${cells.length}列，应为12列。`);
    });
  }
  if (['shotlist', 'prompt'].includes(id) && !ep.documents.script?.content) issue('缺少本集定稿剧本快照，无法核对内容。');
  items.push({ level: 'notice', detail: '本地检查仅验证基础结构与资料完整性；对白、时长、镜头语义和画面效果仍需质检证据。' });
  return items;
}
function contextText(project, db, ep, task) {
  const role = roles.find(r => r.id === task.id);
  const docs = Object.entries(ep.documents).map(([kind, doc]) => `### ${kind}（来源：${doc.path || '编辑器当前稿'}；SHA256：${doc.hash}）\n${doc.content}`).join('\n\n');
  const facts = {rules:db.rules||{},assets:(db.assets||[]).map(a=>({name:a.name,kind:a.kind,version:a.versions.filter(v=>v.from<=ep.number&&v.to>=ep.number).at(-1)})).filter(a=>a.version),relations:(db.relations||[]).filter(r=>r.from<=ep.number&&r.to>=ep.number)};
  const references = (ep.references || []).map(doc => `### ${doc.name}（${doc.path}）\n${doc.content}`).join('\n\n') + '\n\n### 本项目结构化规则与逐集资产关系\n待确认条目只作待核查线索，不得写成确定事实。\n' + JSON.stringify(facts,null,2);
  const accepted = dependencies(ep, task).map(t => `### 已验收：${roles.find(r => r.id === t.id).name}\n${t.versions.at(-1)?.content || ''}`).join('\n\n');
  const memories = db.memory.filter(m => m.status === 'confirmed' && (!m.from || m.from <= ep.number) && (!m.to || m.to >= ep.number));
  return `# ${project.title} · 第${ep.number}集 · ${role.name}\n\n## 本次职责\n${role.brief}\n\n## 制作约定\n${principles}\n\n## 项目规则与记忆\n${ep.policy?.priority || ''}\n${JSON.stringify(ep.policy?.memory || {}, null, 2)}\n\n## 规则和参照全文\n${references || '未导入：执行前请补充本项目规则，不得自行套用其他项目时长。'}\n\n## 已确认连续性\n${memories.map(m => `${m.text}\n依据：${m.evidence}`).join('\n') || '暂无；不得补造。'}\n\n## 本集资料快照\n${docs}\n\n## 上游验收结果\n${accepted || '无'}\n\n## 本轮返修问题\n${task.issues.filter(i => !i.resolved).map(i => `${i.location}：${i.detail}\n证据：${i.evidence}`).join('\n') || '无'}\n\n## 交付\n输出完整结果；不以摘要代替正文。事实不明处列出待确认项。只完成当前职责。`;
}
function createService() {
  const locks = new Map();
  async function withLock(project, action) {
    const key = path.resolve(project.projectPath);
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }
  function directory(project) { return path.join(path.resolve(project.projectPath), '.ai-director', 'production-v2'); }
  async function load(project) {
    try { const db = JSON.parse(await fs.readFile(path.join(directory(project), 'ledger.json'), 'utf8')); if (db.schema !== 2) throw new Error('不支持的制作记录版本。'); return extras.shape(db); }
    catch (e) { if (e.code === 'ENOENT') return fresh(); throw e; }
  }
  async function save(project, db) {
    const dir = directory(project); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'ledger.json');
    try { await fs.copyFile(file,path.join(dir,'ledger.before-2.1.json'),require('fs').constants.COPYFILE_EXCL); } catch(e) { if(!['ENOENT','EEXIST'].includes(e.code))throw e; }
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }
  async function act(project, input) { return withLock(project, async () => {
    const db = await load(project);
    if (input.revision !== db.revision) throw new Error('制作记录已更新，请刷新后重试。');
    const number = Number(input.episode || project.currentEpisode);
    if (!Number.isInteger(number) || number < 1) throw new Error('集数无效。');
    let ep = db.episodes[number];
    if (!ep) ep = db.episodes[number] = createEpisode(number);
    const task = ep.tasks.find(t => t.id === input.task);
    let output = {};
    if (['prepare', 'result', 'approve'].includes(input.action) && Object.keys(ep.documents).length) {
      for (const kind of ['source', 'script', 'shotlist', 'storyboard']) {
        if (ep.documents[kind]?.hash !== hash(project[kind]?.content || '')) throw new Error('编辑器资料已变更，请先同步本集资料并复核下游任务。');
      }
      if (hash(JSON.stringify(ep.policy)) !== hash(JSON.stringify({ priority: project.executionPriority || '', memory: project.memory || {} }))) throw new Error('项目规则或记忆已变更，请重新同步本集资料。');
    }
    switch (input.action) {
      case 'sync': {
        let changed = false;
        const policy = { priority: project.executionPriority || '', memory: project.memory || {} };
        const references = project.productionReferences || [];
        if (hash(JSON.stringify(ep.policy)) !== hash(JSON.stringify(policy)) || hash(JSON.stringify(ep.references)) !== hash(JSON.stringify(references))) changed = true;
        ep.policy = policy; ep.references = references;
        for (const kind of ['source', 'script', 'shotlist', 'storyboard']) {
          const content = String(project[kind]?.content || '');
          const digest = hash(content);
          if (ep.documents[kind]?.hash !== digest) changed = true;
          ep.documents[kind] = { content, hash: digest, path: project.activeFiles?.[kind] || '', at: stamp() };
        }
        if (changed) for (const t of ep.tasks) { if (t.versions.length || t.prepared) t.status = 'stale'; t.prepared = null; }
        break;
      }
      case 'pause': ep.paused = !ep.paused; break;
      case 'prepare': {
        if (!task || ep.paused || !ready(ep, task)) throw new Error('请先恢复制作并验收上游任务。');
        if (!ep.documents.script?.content) throw new Error('请先同步本集定稿剧本。');
        invalidate(ep, task.id);
        const prompt = contextText(project, db, ep, task);
        const token = crypto.randomUUID();
        task.prepared = { token, prompt, at: stamp(), hashes: Object.fromEntries(Object.entries(ep.documents).map(([k,v]) => [k,v.hash])), contextHash: hash(prompt) };
        task.status = 'waiting';
        output.prompt = prompt;
        break;
      }
      case 'result': {
        if (!task?.prepared || ep.paused || !ready(ep, task)) throw new Error('请先生成最新任务单，再回收本轮结果。');
        const content = String(input.content || '').trim(); if (!content) throw new Error('请粘贴完整结果。');
        if (input.taskToken && input.taskToken !== task.prepared.token) throw Error('任务单已变化，旧回复不会写入当前任务。');
        const checks = localChecks(task.id, content, ep);
        if (['shotlist','prompt'].includes(task.id)) {
          const documents = extras.currentDocuments(ep);
          documents[task.id === 'shotlist' ? 'shotlist' : 'prompt'] = content;
          checks.push(...qaEngine.check({...documents,rules:db.rules}).findings);
        }
        const v = { id: crypto.randomUUID(), at: stamp(), content, hash: hash(content), taskToken: task.prepared.token, inputHashes: task.prepared.hashes, checks };
        task.versions.push(v); task.status = 'review'; invalidate(ep, task.id); break;
      }
      case 'approve': {
        if (!task || task.status !== 'review' || !ready(ep, task) || ep.paused) throw new Error('只有待验收且上游有效的结果可以验收。');
        if (task.issues.some(i => !i.resolved)) throw new Error('请先处理未解决问题。');
        if (task.versions.at(-1).checks.some(i => i.level === 'error')) throw new Error('本地结构检查未通过，请修订后重新回收。');
        task.status = 'approved'; task.versions.at(-1).approvedAt = stamp(); break;
      }
      case 'issue': {
        if (!task || !String(input.detail || '').trim() || !String(input.evidence || '').trim() || !String(input.location || '').trim()) throw new Error('问题需要位置、描述和原文证据。');
        task.issues.push({ id: crypto.randomUUID(), location: input.location, detail: input.detail, evidence: input.evidence, resolved: false, at: stamp() });
        task.status = 'rework'; task.prepared = null; invalidate(ep, task.id); break;
      }
      case 'resolve': {
        const issue = task?.issues.find(i => i.id === input.issue); if (!issue) throw new Error('找不到问题。');
        if (!String(input.evidence || '').trim()) throw new Error('请填写复查证据。');
        issue.resolved = true; issue.resolution = input.evidence; issue.resolvedAt = stamp(); break;
      }
      case 'memory': {
        if (!String(input.text || '').trim() || !String(input.evidence || '').trim()) throw new Error('连续性记忆需要内容和依据。');
        const from = Number(input.from) || number, to = Number(input.to) || from;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new Error('记忆适用集数无效。');
        db.memory.push({ id: crypto.randomUUID(), text: input.text, evidence: input.evidence, from, to, status: 'pending', at: stamp() }); break;
      }
      case 'confirm-memory': {
        const memory = db.memory.find(m => m.id === input.memory); if (!memory) throw new Error('找不到记忆。');
        memory.status = 'confirmed'; memory.confirmedAt = stamp();
        for (const episode of Object.values(db.episodes)) if (episode.number >= memory.from && episode.number <= memory.to) for (const t of episode.tasks) { if (t.versions.length || t.prepared) t.status = 'stale'; t.prepared = null; }
        break;
      }
      case 'export': {
        const destination = path.join(project.projectPath, '10 制作任务与交接', `第${number}集-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`);
        await fs.mkdir(destination, { recursive: true });
        for (const t of ep.tasks) {
          const name = roles.find(r => r.id === t.id).name;
          if (t.prepared) await fs.writeFile(path.join(destination, `${name}-任务单.md`), t.prepared.prompt, 'utf8');
          for (let i = 0; i < t.versions.length; i++) await fs.writeFile(path.join(destination, `${name}-v${i+1}.md`), t.versions[i].content, 'utf8');
        }
        await fs.writeFile(path.join(destination, '制作记录.json'), JSON.stringify({ episode: ep, memory: db.memory, events: db.events, exportedAt: stamp() }, null, 2), 'utf8');
        output.outputPath = destination; break;
      }
      default: {
        const result = await extras.apply(db, ep, input, project);
        if (result === null) throw new Error('未知制作操作。');
        output = result;
        if(['rules','asset','relation'].includes(input.action)) {
          for(const episode of Object.values(db.episodes)) {
            if(input.action!=='rules' && (episode.number<Number(input.from)||episode.number>Number(input.to)))continue;
            for(const t of episode.tasks){if(t.versions.length||t.prepared)t.status='stale';t.prepared=null;}
            episode.qa=null;
          }
        }
      }
    }
    db.revision++;
    db.events.push({ at: stamp(), episode: number, action: input.action, task: input.task || '', revision: db.revision });
    await save(project, db);
    return { db, ...output };
  }); }
  return { load, act };
}
module.exports = { roles, principles, fresh, createEpisode, ready, localChecks, contextText, createService };
