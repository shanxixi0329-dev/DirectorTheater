'use strict';

// Production pairs are two documents and two requests. No delimiter parsing is
// involved here; bundle parsing remains available only for legacy imports.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./ai-core');
const VERSION = 'separate-documents-v1';
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const label = (stage) => stage === 'shotlist' ? '分镜' : '提示词';

function validateStage(stage, content, shotlist, options) {
  const verdict = core.validateStructure(stage, content, options);
  const normalized = verdict.normalizedContent ?? content;
  const problems = [...verdict.problems];
  if (!normalized.trim()) problems.push('成品为空。');
  // Receiving a second complete document is a real error, not extra output to
  // silently append to the first. A correction replaces the draft as a whole.
  if (stage === 'shotlist') {
    const numbers = normalized.split(/\r?\n/).flatMap(line => {
      const m = line.match(/^\s*\|\s*(?:镜头\s*)?(\d+)\s*\|/);
      return m ? [Number(m[1])] : [];
    });
    if (new Set(numbers).size !== numbers.length) problems.push('分镜中存在重复镜号，可能重复输出了两份分镜。');
  } else {
    const coverage = core.bundleCoverage(shotlist, normalized);
    verdict.stats = { ...verdict.stats, coverage };
    if (coverage.missingShots.length) problems.push(`提示词缺少镜头：${coverage.missingShots.join('、')}。`);
    if (/^\s*\|\s*镜(?:头)?号\s*\|/m.test(normalized)) problems.push('提示词中混入了分镜表；本步骤只保存提示词。');
  }
  return { ...verdict, normalizedContent: normalized, problems, ok: problems.length === 0 };
}

async function runPairPipeline({ project, episodes, config, signal, fresh, range,
  checkpointPath, buildStage, complete, archive, readTextDocument, emit, options }) {
  const cancelled = () => { if (signal?.aborted) throw new core.ApiError('任务已取消。'); };
  let previous;
  try { previous = JSON.parse(await fs.readFile(checkpointPath, 'utf8')); } catch {}
  const checkpoint = !fresh && previous?.pipeline === VERSION ? previous : {
    kind: 'pair', pipeline: VERSION, completed: [], stages: {}, sessions: {}, rotations: 0
  };
  checkpoint.stages ||= {};
  checkpoint.sessions ||= {};
  checkpoint.completed ||= [];
  const conversations = {};
  for (const stage of ['shotlist', 'storyboard']) {
    const session = checkpoint.sessions[stage];
    conversations[stage] = new core.Conversation({ system: '', cap: config.conversationCap,
      maxContextChars: config.maxContextChars, id: Number(session?.id) || 1 });
    for (const turn of session?.turns || []) conversations[stage].push(turn.user, turn.assistant);
  }
  const persist = async () => {
    for (const [stage, conversation] of Object.entries(conversations)) {
      checkpoint.sessions[stage] = { id: conversation.id, turns: conversation.turns };
    }
    checkpoint.range = range;
    checkpoint.at = new Date().toISOString();
    await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
    const temp = `${checkpointPath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(checkpoint, null, 2), 'utf8');
    await fs.rename(temp, checkpointPath);
  };
  const failures = [];
  await persist();
  for (const episodeNumber of episodes) {
    if (signal?.aborted) { failures.push({ episodeNumber, reason: '任务已取消。', cancelled: true }); break; }
    const record = checkpoint.stages[episodeNumber] ||= {};
    checkpoint.completed = checkpoint.completed.filter(number => number !== episodeNumber);
    emit({ type: 'episode-start', kind: 'pair', episodeNumber,
      conversationId: conversations.shotlist.id, filled: conversations.shotlist.filled });
    const outputs = {};
    let episodeFailed = false;
    for (const stage of ['shotlist', 'storyboard']) {
      let draftPath = '';
      try {
        cancelled();
        const input = await buildStage(episodeNumber, stage, outputs.shotlist);
        cancelled();
        const fingerprint = hash(JSON.stringify({ system: input.system, user: input.user,
          model: config.model, baseUrl: config.baseUrl, smartRead: config.smartRead,
          options, pipeline: VERSION }));
        const saved = record[stage];
        if (saved?.fingerprint === fingerprint && saved.outputPath) {
          try {
            const content = await readTextDocument(saved.outputPath);
            if (hash(content) === saved.contentHash && validateStage(stage, content, outputs.shotlist?.content, options).ok) {
              outputs[stage] = { content, outputPath: saved.outputPath };
              emit({ type: 'stage-reused', kind: 'pair', stage, episodeNumber, outputPath: saved.outputPath });
              continue;
            }
          } catch { /* Missing/changed documents must not be declared complete. */ }
        }
        delete record[stage];
        if (stage === 'shotlist') delete record.storyboard;
        checkpoint.completed = checkpoint.completed.filter(number => number !== episodeNumber);
        await persist();
        const conversation = conversations[stage];
        conversation.system = input.system;
        if (conversation.rotateIfNeeded()) {
          checkpoint.rotations += 1;
          emit({ type: 'new-conversation', kind: 'pair', stage, episodeNumber, conversationId: conversation.id });
        }
        emit({ type: 'stage-start', kind: 'pair', stage, episodeNumber,
          conversationId: conversation.id, filled: conversation.filled });
        const messages = conversation.messages(input.user);
        let result;
        let verdict;
        let content = '';
        // Native length continuation is handled by the API client. This single
        // correction is only for an actual invalid document, never a second
        // creative pass after a successful output.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          cancelled();
          emit({ type: 'stage-stream-reset', kind: 'pair', stage, episodeNumber, attempt });
          const requestMessages = attempt === 0 ? messages : [
            ...messages,
            { role: 'assistant', content },
            { role: 'user', content: `这份${label(stage)}需要修正：${verdict.problems.join('；')}。依据原始输入修正这些明确问题，保留正确内容，返回修订后的一份完整${label(stage)}，以整份替换草稿。不要追加第二份文档，不要输出另一阶段的成品。完整结束后输出 <<<AIGC_FINAL_DONE>>>。` }
          ];
          if (attempt) emit({ type: 'stage-repair', kind: 'pair', stage, episodeNumber, problems: verdict.problems });
          result = await complete({ stage, episodeNumber, messages: requestMessages, input, signal,
            onDelta: (text, meta = {}) => emit({ ...meta, type: 'delta', kind: 'pair', stage, episodeNumber,
              stream: meta.type === 'reasoning' ? 'reasoning' : 'content', text }),
            onEvent: event => emit({ ...event, kind: 'pair', pipelineStage: stage, episodeNumber }) });
          cancelled();
          content = core.stampGenerationModel(core.normalizeReply(result.content), result.responseModel || config.model, stage);
          verdict = validateStage(stage, content, outputs.shotlist?.content, options);
          content = verdict.normalizedContent;
          emit({ type: 'stage-content', kind: 'pair', stage, episodeNumber, content });
          if (verdict.ok) break;
          draftPath = path.join(path.dirname(checkpointPath), 'api-drafts', 'pair', String(episodeNumber), `${stage}.txt`);
          await fs.mkdir(path.dirname(draftPath), { recursive: true });
          await fs.writeFile(draftPath, content, 'utf8');
        }
        if (!verdict.ok) throw Error(`本集${label(stage)}待处理：${verdict.problems.join('；')}`);
        cancelled();
        const savedOutput = await archive(stage, episodeNumber, content);
        // Confirm what was saved before recording a resumable stage, including
        // DOCX outputs where file bytes differ from their editable body.
        const persistedContent = await readTextDocument(savedOutput.outputPath);
        if (!validateStage(stage, persistedContent, outputs.shotlist?.content, options).ok) throw Error('写入后的文档核对失败，未标记本步骤完成。');
        record[stage] = { fingerprint, outputPath: savedOutput.outputPath,
          contentHash: hash(persistedContent), responseModel: result.responseModel || config.model };
        outputs[stage] = { content: persistedContent, outputPath: savedOutput.outputPath };
        conversation.push(input.user, content);
        await persist();
        emit({ type: 'stage-done', kind: 'pair', stage, episodeNumber, contentLength: content.length,
          outputPath: savedOutput.outputPath, warnings: verdict.warnings, responseModel: result.responseModel || config.model });
      } catch (error) {
        const failure = { episodeNumber, stage, reason: error?.message || String(error),
          cancelled: Boolean(signal?.aborted), draftPath,
          savedShotlist: outputs.shotlist?.outputPath || '' };
        failures.push(failure);
        emit({ type: 'stage-failed', kind: 'pair', ...failure });
        episodeFailed = true;
        break;
      }
    }
    if (!episodeFailed) {
      if (!checkpoint.completed.includes(episodeNumber)) checkpoint.completed.push(episodeNumber);
      await persist();
      emit({ type: 'episode-done', kind: 'pair', episodeNumber,
        contentLength: outputs.shotlist.content.length + outputs.storyboard.content.length,
        outputPaths: [outputs.shotlist.outputPath, outputs.storyboard.outputPath],
        responseModel: record.storyboard?.responseModel || config.model });
    }
    if (signal?.aborted) break;
  }
  checkpoint.failures = failures;
  await persist();
  return { ok: failures.length === 0, completed: checkpoint.completed.filter(number => episodes.includes(number)),
    failure: failures[0] || null, failures, rotations: checkpoint.rotations,
    pipeline: VERSION, partial: Object.keys(checkpoint.stages).filter(number => checkpoint.stages[number].shotlist && !checkpoint.stages[number].storyboard).map(Number) };
}

module.exports = { runPairPipeline, validateStage };
