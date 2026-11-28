'use strict';
const uid = () => require('node:crypto').randomUUID();

function checkResult(level, title, detail, group = null, shot = null) {
  return { id: uid(), level, title, detail, group, shot };
}

function extractGroups(content) {
  // 同时兼容“镜头1-4”和“镜头257-1-07—257-1-13”两种项目编号。
  const header = /第\s*(\d+)\s*组\s*[（(]\s*镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[-—–]\s*(\d+(?:\s*-\s*\d+)*)\s*[，,]\s*总时长(?:约)?\s*(\d+)\s*秒\s*[）)]/g;
  const matches = [...content.matchAll(header)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    firstShot: match[2].replace(/\s+/g, ''),
    lastShot: match[3].replace(/\s+/g, ''),
    duration: Number(match[4]),
    raw: content.slice(match.index, matches[index + 1]?.index ?? content.length)
  }));
}

function extractShots(group) {
  const pattern = /镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[：:]\s*\[\s*(\d+)\s*秒\s*[-—–]\s*(\d+)\s*秒\s*\]([\s\S]*?)(?=镜头\s*\d+(?:\s*-\s*\d+)*\s*[：:]\s*\[|$)/g;
  return [...group.raw.matchAll(pattern)].map((match) => ({
    number: match[1].replace(/\s+/g, ''),
    start: Number(match[2]),
    end: Number(match[3]),
    text: match[0]
  }));
}

function chineseCharacters(text) {
  return (text.match(/[\u3400-\u9fff]/g) || []).length;
}

function normalizeTagName(value = '') {
  return String(value)
    .replace(/\s+/g, '')
    .replace(/(?:的)?(?:参考)?(?:角色|人物|场景|道具|空间结构)$/u, '')
    .trim();
}

function extractAtTags(text, knownTags = []) {
  const known = [...new Set(knownTags.map(normalizeTagName).filter(Boolean))].sort((a, b) => b.length - a.length);
  const tags = [];
  const pattern = /@\[([^\]\r\n]+)\]|@([^\s@[\]{}<>"'`，。；：、,.!?！？;:()（）]+)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = normalizeTagName(match[1] || match[2]);
    if (!raw) continue;
    const resolved = known.find((tag) => raw.startsWith(tag)) || raw;
    tags.push(resolved);
  }
  return tags;
}

function sectionHeaderMatch(content, title) {
  const escapedTitle = String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${escapedTitle}\\s*(?:(?:[：:]\\s*)|(?=\\r?$))`, 'm').exec(String(content));
}

function extractReferenceMaterial(groupRaw) {
  const referenceHeader = sectionHeaderMatch(groupRaw, '参考素材');
  if (!referenceHeader) return '';
  const contentStart = referenceHeader.index + referenceHeader[0].length;
  const sequenceHeader = sectionHeaderMatch(groupRaw.slice(contentStart), '分镜序列');
  const contentEnd = sequenceHeader ? contentStart + sequenceHeader.index : groupRaw.length;
  return groupRaw.slice(contentStart, contentEnd);
}

function extractStoryboardSequence(groupRaw) {
  const sequenceHeader = sectionHeaderMatch(groupRaw, '分镜序列');
  if (!sequenceHeader) return '';
  const contentStart = sequenceHeader.index + sequenceHeader[0].length;
  const remaining = groupRaw.slice(contentStart);
  // The final group is followed by whole-episode sections. They are summaries,
  // not shots, and must never participate in material or dialogue checking.
  const afterSequenceHeader = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:【\s*)?(?:台词整合|台词文稿匹配|统一风格与约束|实际总时长|分镜组数)(?:\s*】)?\s*(?:[：:]|$)/m.exec(remaining);
  const contentEnd = afterSequenceHeader ? contentStart + afterSequenceHeader.index : groupRaw.length;
  return groupRaw.slice(contentStart, contentEnd);
}

function extractCheckableStoryboardContent(content) {
  const raw = String(content || '');
  // “台词整合” and the matching table are delivery summaries. Everything from
  // the first summary heading to EOF is deliberately outside the checker.
  const summaryHeader = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:【\s*)?(?:台词整合|台词文稿匹配)(?:\s*】)?\s*(?:[：:]|$)/m.exec(raw);
  return summaryHeader ? raw.slice(0, summaryHeader.index) : raw;
}

function extractDialogueMarkers(text) {
  return [...new Set([...String(text).matchAll(/[（(]\s*(V\.O\.|O\.S\.)\s*[）)]/gi)].map((match) => match[1].toUpperCase()))];
}

function normalizeSpeakerName(value = '') {
  return normalizeTagName(String(value)
    .replace(/\*\*/g, '')
    .replace(/[【】\[\]]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^@\[/, '')
    .replace(/^@/, '')
    .replace(/\]$/g, '')
    .trim());
}

function isScriptSceneHeading(line = '') {
  // 剧本从“162-1”或“1-1”这类场景题头开始；前置项目说明中的冒号
  // 不能被误当作人物对白。
  return /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:\d{1,4}\s*[-—–]\s*\d+\s+\S+|第[一二三四五六七八九十百\d]+场\s*[：:\s])/.test(String(line));
}

function isScriptDialogueSpeaker(value = '') {
  const raw = String(value).replace(/\*\*/g, '').trim();
  if (!raw || raw.length > 48 || /^△/.test(raw)) return false;
  if (/^(?:【\s*)?(?:音效|字幕|制作说明|画面|动作|场景题头|对白|专业术语)(?:\s*】)?/.test(raw)) return false;
  const name = normalizeSpeakerName(raw);
  if (!name || name.length > 16) return false;
  if (!/^[\u3400-\u9fffA-Za-z0-9·\-]+$/.test(name)) return false;
  return !/^(镜头|声音|参考素材|分镜序列|任务类型|实际总时长|分镜组数|目标总时长|目标时长|总时长|时长|出场人物|人物|场景|画面|字幕|音效|AI生成模型|第\s*\d+\s*(?:集|话|章))/.test(name);
}

function normalizeDialogueText(text) {
  return String(text)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[“”"'`]/g, '')
    .replace(/[\s，。！？、；：,.!?;:]/g, '')
    .trim();
}

function extractScriptDialogues(content, { excludeRecap = false } = {}) {
  const dialogues = [];
  let insideScene = !String(content).split(/\r?\n/).some(isScriptSceneHeading);
  let includeScene = true;
  for (const [lineIndex, line] of String(content).split(/\r?\n/).entries()) {
    if (isScriptSceneHeading(line)) {
      insideScene = true;
      includeScene = !excludeRecap || !/^\s*0\s*[-—]\s*\d+\s+\S+/.test(line);
      continue;
    }
    if (!insideScene || !includeScene) continue;
    if (/^\s*△/.test(line)) continue;
    if (/^\s*【\s*AI生成模型\s*[：:]/.test(line)) continue;
    if (/^\s*第\s*\d+\s*(?:集|话|章)\s*[：:]/.test(line)) continue;
    if (/^\s*(?:目标)?总时长\s*[：:]/.test(line)) continue;
    const match = line.match(/^\s*(?:\*\*)?(.{1,32}?)(?:\*\*)?[：:]\s*(.+?)\s*$/);
    if (!match) continue;
    const speaker = match[1].replace(/\*\*/g, '').trim();
    if (!isScriptDialogueSpeaker(speaker)) continue;
    const raw = match[2].replace(/【[^】]*】/g, '').trim();
    const spoken = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
    const normalized = normalizeDialogueText(spoken);
    if (!normalized.length) continue;
    dialogues.push({ speaker, speakerName: normalizeSpeakerName(speaker), raw, spoken, normalized, markers: extractDialogueMarkers(speaker + ' ' + raw), line: lineIndex + 1 });
  }
  return dialogues;
}

function normalizeOriginalDialogueText(text = '') {
  return normalizeDialogueText(text).replace(/[…—－]/g, '');
}

function extractSourceDialogues(content = '') {
  const dialogues = [];
  const pattern = /“([^”\r\n]{1,800})”|「([^」\r\n]{1,800})」|"([^"\r\n]{1,800})"/g;
  for (const match of String(content).matchAll(pattern)) {
    const spoken = String(match[1] || match[2] || match[3] || '').trim();
    const normalized = normalizeOriginalDialogueText(spoken);
    if (normalized.length) dialogues.push({ spoken, normalized });
  }
  return dialogues;
}

function validateScriptDialogueFidelity(script = '', source = '', options = {}) {
  const scriptDialogues = extractScriptDialogues(script, { excludeRecap: true })
    .filter((item) => !/旁白|解说|字幕/.test(item.speakerName));
  const sourceDialogues = extractSourceDialogues(source);
  if (!source.trim()) return [checkResult('info', '台词对照未执行：未绑定原文', '请在“项目文件”选择本集原文，或在检查设置中关闭台词对照。这是材料缺失，不是剧本错误。')];
  if (!scriptDialogues.length) return [checkResult('info', '台词对照未执行：未识别人物台词', '当前格式未识别出人物台词，请人工确认格式；不能据此判断剧本有错。')];
  if (!sourceDialogues.length) return [checkResult('info', '台词对照未执行：原文对话未识别', '当前原文没有可识别的引号对话，不能判断台词是否改写。支持中文双引号、直双引号和「」。')];
  const sourceTexts = new Set(sourceDialogues.map((item) => item.normalized));
  const results = [];
  for (const dialogue of scriptDialogues) {
    const normalized = normalizeOriginalDialogueText(dialogue.spoken);
    if (sourceTexts.has(normalized)) continue;
    const excerpt = dialogue.spoken.slice(0, 34) + (dialogue.spoken.length > 34 ? '…' : '');
    results.push({
      ...checkResult(options.strictDialogue === true ? 'error' : 'warning', options.strictDialogue === true ? '台词未满足逐字保真要求' : '台词与当前原文未逐字匹配', '剧本中@' + dialogue.speakerName + '的“' + excerpt + '”未在当前绑定原文对话中找到完全一致内容。请核对原文章节及改编要求；本地检查无法判断改编是否合理，也不核实原文说话人。'),
      line: dialogue.line, quote: dialogue.spoken, ruleId: 'sourceDialogue'
    });
  }
  if (!results.length) results.push(checkResult('pass', '剧本台词核对通过', '当前剧本人物台词均能在本集原文对话中找到。'));
  return results;
}

function validateLocalScript(script = '', source = '', value = {}) {
  const policy = require('./local-check-policy').normalize(value);
  const enabled = policy.script;
  if (!Object.values(enabled).some(Boolean)) return [checkResult('info', '本地检查已关闭', '可在检查设置中勾选需要的项目。')];
  if (!String(script).trim()) return [checkResult('info', '暂无剧本内容', '写入或打开本集剧本后再检查。')];
  const results = [];
  if (enabled.sourceDialogue) results.push(...validateScriptDialogueFidelity(script, source, policy).map(item => ({ ...item, ruleId: 'sourceDialogue', basis: '当前绑定原文与当前剧本' })));
  if (enabled.structure) {
    const scene = String(script).split(/\r?\n/).some(isScriptSceneHeading);
    const dialogue = extractScriptDialogues(script).length > 0;
    results.push({ ...checkResult(scene && dialogue ? 'pass' : 'info',
      scene && dialogue ? '场景与台词已识别' : '结构识别不完整',
      scene && dialogue ? '已识别场景题头及人物台词；此项不判断剧情逻辑。' : '未识别到' + [!scene && '场景题头', !dialogue && '人物台词'].filter(Boolean).join('、') + '。可能采用其他格式，请人工确认。'),
      ruleId: 'structure', basis: '当前剧本格式' });
  }
  if (enabled.duplicateDialogue) {
    const dialogues = extractScriptDialogues(script);
    const duplicates = [];
    for (let index = 1; index < dialogues.length; index += 1) {
      const current = dialogues[index], previous = dialogues[index - 1];
      if (current.normalized === previous.normalized && current.speakerName === previous.speakerName) duplicates.push({
        ...checkResult('warning', '相邻台词重复，建议复核', '与上一条同人物台词相同；合理的强调、回扣可保留。'),
        line: current.line, quote: current.spoken, ruleId: 'duplicateDialogue', basis: '当前剧本相邻人物台词'
      });
    }
    results.push(...(duplicates.length ? duplicates : [{ ...checkResult('pass', '相邻重复台词核对完成', '未发现同人物相邻重复台词。'), ruleId: 'duplicateDialogue' }]));
  }
  return results;
}

function normalizeStoryboardSpeakerTag(value = '') {
  return normalizeSpeakerName(String(value)
    // 兼容“@人物使用音频说”“@人物开口说”等没有空格的 Seedance 写法。
    .replace(/(?:使用)?(?:音频|音色|声线|配音)[^，。；：{}]*/g, '')
    .replace(/(?:开口|继续|开始|随后|随即)?(?:说|发声|画外音)[^，。；：{}]*/g, '')
    .replace(/(?:正在)?(?:说话|讲话)[^，。；：{}]*/g, ''));
}

function extractStoryboardSpeaker(context, knownSpeakers = []) {
  const source = String(context || '');
  const known = [...new Set(knownSpeakers.map(normalizeSpeakerName).filter(Boolean))];
  // Seedance 的发声写法既可能是“开口说”，也可能是“画外音”。取最后一个
  // 发声提示之前的同一句片段，避免把画面里最后出现的道具或人物当作说话人。
  const cues = [...source.matchAll(/(?:开口|继续)?说|画外音/g)];
  const cue = cues.at(-1);
  const beforeSpeech = source.slice(0, cue ? cue.index : source.length);
  const recent = beforeSpeech.slice(-220);
  const clauseStart = Math.max(recent.lastIndexOf('，'), recent.lastIndexOf('。'), recent.lastIndexOf('；'), recent.lastIndexOf('：')) + 1;
  const clauseTags = extractAtTags(recent.slice(clauseStart), known).map(normalizeStoryboardSpeakerTag).filter(Boolean);
  // 在“@[江娟]指着@[鸡汤砂锅]开口说”这类结构中，发声子句里的第一个
  // @ 标签才是人物；最后一个标签可能只是道具或场景。优先按剧本已知人物名消歧。
  const knownSpeaker = clauseTags.find((tag) => known.includes(tag));
  if (knownSpeaker) return knownSpeaker;
  return clauseTags[0] || extractAtTags(recent, known).map(normalizeStoryboardSpeakerTag).filter(Boolean).at(-1) || '';
}

function extractStoryboardDialogues(content, knownSpeakers = []) {
  const dialogues = [];
  const pattern = /\{([^}\r\n]*)\}/g;
  for (const group of extractGroups(content)) {
    const sequence = extractStoryboardSequence(group.raw);
    for (const match of sequence.matchAll(pattern)) {
      const shotStart = Math.max(0, sequence.lastIndexOf('镜头', match.index));
      const context = sequence.slice(shotStart, match.index);
      const spoken = match[1].trim();
      const normalized = normalizeDialogueText(spoken);
      if (!normalized.length) continue;
      const speakerName = extractStoryboardSpeaker(context, knownSpeakers);
      const shot = context.match(/镜头\s*(\d+(?:\s*-\s*\d+)*)\s*[：:]/)?.[1]?.replace(/\s+/g, '') || null;
      dialogues.push({ spoken, normalized, speakerName, markers: extractDialogueMarkers(context), index: match.index, group: group.number, shot });
    }
  }
  return dialogues;
}

function speakerCompatible(scriptDialogue, storyboardDialogue) {
  const scriptSpeaker = normalizeSpeakerName(scriptDialogue?.speakerName || scriptDialogue?.speaker);
  const storyboardSpeaker = normalizeSpeakerName(storyboardDialogue?.speakerName || '');
  // 台词核对必须同时对上人物。提示词缺少发声人物、或由其他人物说出，
  // 都属于“提示词台词与剧本不一致”，不能当作已复刻。
  return Boolean(scriptSpeaker && storyboardSpeaker && scriptSpeaker === storyboardSpeaker);
}

function isLikelyDialogueVariant(first = '', second = '') {
  const left = String(first);
  const right = String(second);
  const shorter = Math.min(left.length, right.length);
  if (shorter < 3) return false;
  let prefix = 0;
  while (prefix < shorter && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  // 只把文本主体明显相同、但有少量改字/漏字的同一句定位为“不一致”。
  // 完全不同的台词不会被强行配对，仍按“缺少人物台词”处理。
  return prefix >= 2 && (prefix + suffix) / shorter >= 0.5;
}

function findStoryboardDialogueCoverage(scriptDialogue, storyboardDialogues) {
  const target = scriptDialogue.normalized;
  const compatible = storyboardDialogues.filter((item) => speakerCompatible(scriptDialogue, item));
  const direct = compatible.find((item) => item.normalized === target);
  if (direct) return { matched: true, items: [direct] };

  // Seedance 可能把同一句台词拆到相邻镜头中：只合并同一发声人的连续片段，
  // 且规范化后必须完全一致，避免不同人物的台词被误拼接。
  for (let start = 0; start < storyboardDialogues.length; start += 1) {
    const first = storyboardDialogues[start];
    if (!speakerCompatible(scriptDialogue, first)) continue;
    let combined = '';
    const items = [];
    for (let end = start; end < storyboardDialogues.length && end < start + 12; end += 1) {
      const item = storyboardDialogues[end];
      if (!speakerCompatible(scriptDialogue, item)) break;
      combined += item.normalized;
      items.push(item);
      if (combined === target) return { matched: true, items };
      if (!target.startsWith(combined)) break;
    }
  }

  // 文字相同但发声人物不同，不能被当成“缺少台词”；应明确提示为人物/台词不一致。
  const sameTextWrongSpeaker = storyboardDialogues.find((item) => item.normalized === target) || null;
  if (sameTextWrongSpeaker) return { matched: false, items: [], partial: sameTextWrongSpeaker, reason: 'speaker' };
  const partial = compatible.find((item) =>
    item.normalized.includes(target) || target.includes(item.normalized) || isLikelyDialogueVariant(item.normalized, target)) || null;
  return { matched: false, items: [], partial, reason: partial ? 'text' : 'missing' };
}

// 提示词质检只保留导演台实际要拦截的五类问题：缺少 @ 引用、单镜头多人
// 发声、口播时间不足、台词与剧本不一致、缺少人物台词。其余格式、组号、
// 机位、时长闭合、V.O./O.S. 等规则不再产生问题卡片。
function validateStoryboard(content, script = '', shotlist = '', value = {}) {
  const enabled = require('./local-check-policy').normalize(value).storyboard;
  if (!Object.values(enabled).some(Boolean)) return [checkResult('info', '本地检查已关闭', '可在检查设置中勾选需要的项目。')];
  const results = [];
  const checkableContent = extractCheckableStoryboardContent(content);
  if (!checkableContent.trim()) return [checkResult('info', '暂无可检查提示词', '当前集还没有可检查的 Seedance 提示词，尚未执行结构核对。')];

  const groups = extractGroups(checkableContent);
  if (!groups.length) return [checkResult('info', '提示词格式未识别，检查未完成', '未识别“第X组（镜头A-B，总时长X秒）”格式。本地规则尚未覆盖该文本，请检查格式或人工核对。')];
  const scriptDialogues = extractScriptDialogues(script);
  const knownSpeakers = scriptDialogues.map((item) => item.speakerName);
  // 素材定义按“当前集”汇总：角色、场景、道具只要在本集任意一组参考素材中
  // 定义过，后续分镜组复用时就视为有效，不要求每组重复写一次。
  const episodeDefinedTags = new Set(groups.flatMap((group) => extractAtTags(extractReferenceMaterial(group.raw))));
  for (const group of groups) {
    const sequence = extractStoryboardSequence(group.raw);
    const usedTags = new Set(extractAtTags(sequence, [...episodeDefinedTags]));

    // @ 检查只看分镜序列：序列中使用的 @ 必须在当前集参考素材中提及；
    // 参考素材多写了什么不报错。同组缺失合并成一张问题卡，避免刷屏。
    if (sequence.trim() && usedTags.size) {
        const missingTags = [...usedTags].filter((tag) => !episodeDefinedTags.has(tag));
        if (missingTags.length) results.push(checkResult('error', '缺少@', `第${group.number}组分镜序列中的@${missingTags.join('、@')}未在本集“参考素材”中提及。`, group.number));
    }

    for (const shot of extractShots(group)) {
      const shotTags = extractAtTags(shot.text, [...episodeDefinedTags]);
      // 不强制每个镜头重复写 @场景；只要该镜头已明确引用任意角色、场景或
      // 道具 @ 素材即可。只有完全没有 @ 时才判为缺少引用。
      if (!shotTags.length) {
        results.push(checkResult('error', '缺少@', `镜头${shot.number}没有任何@人物、@场景或@道具引用。`, group.number, shot.number));
      }

      const speech = [...shot.text.matchAll(/\{([^}\r\n]*)\}/g)];
      if (speech.length > 1) {
        const speakers = [...new Set(speech
          .map((item) => extractStoryboardSpeaker(shot.text.slice(0, item.index), knownSpeakers))
          .map(normalizeSpeakerName)
          .filter(Boolean))];
        if (speakers.length > 1) {
          results.push(checkResult('error', '单镜头多人发声', `镜头${shot.number}中${speakers.map((speaker) => '@' + speaker).join('、')}均有{ }台词，需要拆为独立镜头。`, group.number, shot.number));
        }
      }
      if (speech.length >= 1) {
        const words = speech.reduce((sum, item) => sum + chineseCharacters(item[1]), 0);
        const available = shot.end - shot.start;
        if (available > 0 && words / 6 > available) {
          results.push(checkResult('warning', '口播时间不足', `镜头${shot.number}约${words}字，当前约${(words / available).toFixed(1)}字/秒；4–6字/秒为正常范围，至少需要${Math.ceil(words / 6)}秒。`, group.number, shot.number));
        }
      }
    }
  }

  const storyboardDialogues = extractStoryboardDialogues(checkableContent, knownSpeakers);
  if (scriptDialogues.length) {
    const matchedStoryboardDialogues = new Set();
    const reportedStoryboardDialogues = new Set();
    for (const dialogue of scriptDialogues) {
      const coverage = findStoryboardDialogueCoverage(dialogue, storyboardDialogues);
      if (!coverage.matched) {
        const partial = coverage.partial;
        const excerpt = dialogue.spoken.slice(0, 32) + (dialogue.spoken.length > 32 ? '…' : '');
        const title = partial ? '台词和剧本不一致' : '缺少人物台词';
        const detail = coverage.reason === 'speaker'
          ? '剧本中“' + excerpt + '”应由@' + dialogue.speakerName + '说出；提示词中的发声人物不一致。'
          : partial
            ? '剧本中“' + excerpt + '”与分镜序列中的{ }台词不一致；同一人物连续拆句会自动合并后再比对。'
            : '剧本中@' + dialogue.speakerName + '的“' + excerpt + '”未在分镜序列的{ }中找到。';
        results.push(checkResult('error', title, detail, partial?.group || null, partial?.shot || null));
        if (partial) reportedStoryboardDialogues.add(partial);
        continue;
      }
      for (const item of coverage.items) matchedStoryboardDialogues.add(item);
    }
    for (const dialogue of storyboardDialogues) {
      if (matchedStoryboardDialogues.has(dialogue) || reportedStoryboardDialogues.has(dialogue)) continue;
      const relatedScriptLine = scriptDialogues.some((scriptDialogue) =>
        scriptDialogue.normalized.includes(dialogue.normalized) || dialogue.normalized.includes(scriptDialogue.normalized));
      if (relatedScriptLine) continue;
      const speaker = dialogue.speakerName ? '@' + dialogue.speakerName : '未标注人物';
      const excerpt = dialogue.spoken.slice(0, 32) + (dialogue.spoken.length > 32 ? '…' : '');
      results.push(checkResult('error', '台词和剧本不一致', '分镜序列中' + speaker + '的“' + excerpt + '”未在剧本人物台词中找到。', dialogue.group, dialogue.shot));
    }
  }

  const rules = { '缺少@': 'references', '单镜头多人发声': 'speakers', '口播时间不足': 'speechTiming', '台词和剧本不一致': 'dialogueMatch', '缺少人物台词': 'dialogueCoverage' };
  const selected = results.map(item => ({ ...item, ruleId: rules[item.title] })).filter(item => enabled[item.ruleId]);
  if ((enabled.dialogueMatch || enabled.dialogueCoverage) && !scriptDialogues.length) selected.push(checkResult('info', '台词对照未执行：缺少可识别剧本台词', '本集剧本未载入或人物台词格式未识别；其他已勾选规则仍按当前提示词检查。'));
  if (!groups.some(group => extractShots(group).length)) selected.push(checkResult('info', '逐镜检查未执行：未识别镜头时间码', '已识别分组，但镜头格式未识别，不能报告逐镜检查通过。'));
  if (!selected.length) selected.push(checkResult('pass', '所选本地规则未发现问题', '仅覆盖检查设置中启用的项目；不代表剧情、事实和成片效果已经验收。'));
  return selected;
}


module.exports = { validateScriptDialogueFidelity, validateLocalScript, validateStoryboard };
