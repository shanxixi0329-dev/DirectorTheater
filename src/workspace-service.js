'use strict';
const crypto = require('node:crypto');
const { mergeProject, createSerialQueue } = require('./workspace-sync');
function createWorkspaceService({ key, projectByPath, outputPath, readDocument, broadcast }) {
  const projects = new Map(), documents = new Map(), serial = createSerialQueue();
  const fingerprint = value => value === null ? null : crypto.createHash('sha256').update(String(value)).digest('hex');
  function remember(sender, project) {
    if (!project?.id || !project.projectPath) return;
    if (!projects.has(sender)) projects.set(sender, new Map());
    projects.get(sender).set(key(project.projectPath), structuredClone(project));
  }
  function learn(sender, document, fallbackPath) {
    if (!documents.has(sender)) documents.set(sender, new Map());
    const file = document?.path || fallbackPath;
    if (file) documents.get(sender).set(key(file), fingerprint(document ? document.content : null));
    if (document) document.workspaceVersion = fingerprint(document.content);
  }
  async function current(file) {
    try { return fingerprint(await readDocument(file)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function projectReply(sender, project) {
    const reply = structuredClone(project); remember(sender, reply);
    for (const kind of ['source', 'outline', 'script', 'shotlist', 'storyboard']) {
      const active = reply.activeFiles?.[kind] || reply[kind]?.path;
      if (active) { learn(sender, { path: active, content: reply[kind]?.content || '' }); if (reply[kind]) reply[kind].workspaceVersion = fingerprint(reply[kind].content || ''); }
    }
    return reply;
  }
  async function dispatch(channel, args, action) {
    const sender = args[0]?.sender?.id;
    if (!sender) return action();
    if (channel === 'workspace:accept') { remember(sender, args[1]); return true; }
    if (channel === 'projects:save' || channel === 'projects:rescan') {
      const incoming = structuredClone(args[1]);
      const latest = projectByPath(incoming.projectPath);
      const base = projects.get(sender)?.get(key(incoming.projectPath));
      if (!base && latest) throw new Error('请先在当前窗口打开项目，再保存修改。');
      args[1] = base && latest ? mergeProject(base, incoming, latest) : incoming;
      const result = await action();
      // Remember exactly the snapshot submitted by this renderer, not the
      // merged result: its live editor may contain newer unsaved input.
      remember(sender, channel === 'projects:rescan' ? result : incoming);
      broadcast('workspace:changed', { type: 'project', projectPath: result.projectPath }, sender);
      return channel === 'projects:rescan' ? projectReply(sender, result) : result;
    }
    if (['documents:save', 'documents:export-word'].includes(channel)) {
      const { project, kind, activePath, content } = args[1];
      const exportWord = channel === 'documents:export-word';
      const activeIsDocx = project.documentFormats?.[kind] === 'docx';
      const targetProject = exportWord ? { ...project, documentFormats: { ...project.documentFormats, [kind]: 'docx' } } : project;
      const active = exportWord ? (activePath || '').replace(/\.(txt|md|markdown|docx)$/i, '.docx') : activePath;
      const target = outputPath(targetProject, kind, active);
      return serial(key(target), async () => {
        const known = documents.get(sender), actual = await current(target);
        const expected = Object.hasOwn(args[1], 'expectedVersion') ? args[1].expectedVersion : known?.get(key(target));
        const explicitExport = exportWord && (!activeIsDocx || !known?.has(key(target)));
        if (!explicitExport && actual !== null && (expected === undefined || actual !== expected) && actual !== fingerprint(content)) {
          broadcast('workspace:changed', { type: 'document', projectPath: project.projectPath, kind, path: target, episode: project.currentEpisode, version: actual });
          throw new Error('文件已被其他窗口或外部程序更新。本窗草稿已保留，请先复制草稿，再读取最新内容进行核对。');
        }
        if (!explicitExport && actual === null && expected != null) throw new Error('文件已被移走或删除。本窗草稿已保留，请先刷新项目核对。');
        const result = await action();
        if (!exportWord || activeIsDocx) learn(sender, result);
        else if (result) result.workspaceVersion = fingerprint(result.content);
        if (!exportWord) {
          // The file guard has just verified the window's read version and
          // committed its new text. Rebase this one content field against the
          // current metadata so an accepted remote edit is not reported as a
          // second, spurious metadata conflict on the following project save.
          const base = projects.get(sender)?.get(key(project.projectPath));
          const latest = projectByPath(project.projectPath);
          const baseEpisode = base?.episodes?.find(ep => Number(ep.number) === Number(project.currentEpisode));
          const latestEpisode = latest?.episodes?.find(ep => Number(ep.number) === Number(project.currentEpisode));
          if (baseEpisode?.[kind] && latestEpisode?.[kind] && Object.prototype.hasOwnProperty.call(latestEpisode[kind], 'content')) {
            baseEpisode[kind].content = latestEpisode[kind].content;
          }
          if (kind === 'source' && base?.source && latest?.source) base.source.content = latest.source.content;
        }
        broadcast('workspace:changed', { type: 'document', projectPath: project.projectPath, kind, path: result.path, episode: project.currentEpisode, version: result.workspaceVersion }, sender);
        return result;
      });
    }
    let result = await action();
    if (['projects:open', 'projects:create', 'projects:adopt-folder', 'projects:rescan'].includes(channel) && result?.projectPath) {
      result = projectReply(sender, result);
    }
    if (channel === 'documents:open' || channel === 'episodes:finalize-output') learn(sender, result);
    if (channel === 'episodes:load-documents') {
      const p = { ...args[1].project, currentEpisode: args[1].episodeNumber };
      for (const kind of ['outline', 'script', 'shotlist', 'storyboard']) learn(sender, result[kind], outputPath(p, kind, ''));
    }
    const project = args[1]?.project || args[1];
    if (project?.projectPath && ['review:act', 'review:choose-folder'].includes(channel)) broadcast('workspace:changed', { type: 'review', projectPath: project.projectPath }, sender);
    if (project?.projectPath && ['quality:apply', 'quality:undo', 'director:apply', 'director:restore', 'documents:replace-project-text', 'documents:undo-replacement', 'episodes:finalize-output', 'episodes:discard-revisions', 'chatgpt:archive', 'chatgpt:download-latest', 'source:import'].includes(channel)
      && !(channel === 'documents:replace-project-text' && args[1]?.previewOnly)) {
      broadcast('workspace:changed', { type: 'refresh', projectPath: project.projectPath }, sender);
    }
    return result;
  }
  const indexChannels = new Set(['projects:save', 'projects:rescan', 'projects:open', 'projects:create', 'projects:adopt-folder', 'projects:forget']);
  return { handle: (channel, args, action) => indexChannels.has(channel) ? serial('project-index', () => dispatch(channel, args, action)) : dispatch(channel, args, action),
    release: sender => { projects.delete(sender); documents.delete(sender); } };
}
module.exports = { createWorkspaceService };
