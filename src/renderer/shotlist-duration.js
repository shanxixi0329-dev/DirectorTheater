(function exposeShotlistDuration(globalScope) {
  function normalizedNumber(value) {
    const number = Number(String(value || '').replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }

  function parseClock(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{1,2}(?:\.\d+)?)(?::(\d{1,2}(?:\.\d+)?))?$/);
    if (!match) return null;
    if (match[3] !== undefined) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function parseTimePoint(value) {
    const text = String(value || '').trim();
    const clock = parseClock(text);
    if (clock !== null) return clock;
    const minutes = text.match(/(\d+(?:[.,]\d+)?)\s*(?:分钟|分)/);
    const seconds = text.match(/(\d+(?:[.,]\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)/i);
    if (minutes || seconds) {
      return (normalizedNumber(minutes?.[1]) || 0) * 60 + (normalizedNumber(seconds?.[1]) || 0);
    }
    return normalizedNumber(text.replace(/[^\d.,]/g, ''));
  }

  function parseDuration(value) {
    const text = String(value || '')
      .replace(/[【】\[\]]/g, '')
      .replace(/[～~—–至]/g, '-')
      .replace(/^约\s*/, '')
      .trim();
    if (!text) return null;

    const tp = '(?:\\d+:\\d+(?:\\.\\d+)?(?::\\d+(?:\\.\\d+)?)?|\\d+(?:[.,]\\d+)?\\s*(?:分钟?|分|秒|s(?:ec(?:ond)?s?)?)|\\d+(?:[.,]\\d+)?)';
    const timeline = text.match(new RegExp(`(${tp})\\s*-\\s*(${tp})`, 'i'));
    if (timeline) {
      const start = parseTimePoint(timeline[1]);
      const end = parseTimePoint(timeline[2]);
      if (start !== null && end !== null && end > start) return end - start;
    }

    const clock = parseClock(text);
    if (clock !== null) return clock;
    const minutes = text.match(/(\d+(?:[.,]\d+)?)\s*(?:分钟|分)/);
    const seconds = text.match(/(\d+(?:[.,]\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)/i);
    if (minutes || seconds) {
      const total = (normalizedNumber(minutes?.[1]) || 0) * 60 + (normalizedNumber(seconds?.[1]) || 0);
      return total > 0 ? total : null;
    }
    const plain = normalizedNumber(text);
    return plain !== null && plain > 0 ? plain : null;
  }

  function splitMarkdownRow(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.includes('|')) return [];
    const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    return withoutEdges.split('|').map((cell) => cell.trim());
  }

  function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, '')));
  }

  function isShotLabel(value) {
    return /^(?:镜头\s*)?\d+(?:[-._]\d+)*$/i.test(String(value || '').replace(/\s/g, ''));
  }

  function parseTables(content) {
    const lines = String(content || '').split(/\r?\n/);
    const tables = [];
    for (let index = 0; index < lines.length - 1; index += 1) {
      const headers = splitMarkdownRow(lines[index]);
      const separator = splitMarkdownRow(lines[index + 1]);
      if (headers.length < 2 || separator.length !== headers.length || !isSeparatorRow(separator)) continue;
      const rows = [];
      let rowIndex = index + 2;
      for (; rowIndex < lines.length; rowIndex += 1) {
        const cells = splitMarkdownRow(lines[rowIndex]);
        if (!cells.length || isSeparatorRow(cells)) break;
        if (cells.length < headers.length) cells.push(...Array(headers.length - cells.length).fill(''));
        rows.push(cells.slice(0, headers.length));
      }
      tables.push({ headers, rows });
      index = rowIndex - 1;
    }
    return tables;
  }

  function calculate(content) {
    const text = String(content || '');
    const lines = text.split(/\r?\n/);
    let tableSeconds = 0;
    let tableShots = 0;

    for (const table of parseTables(text)) {
      const durationIndex = table.headers.findIndex((cell) => /^(?:时长|时间码?|时间段)(?:\s*[（(][^）)]*[）)])?$/.test(cell.replace(/\*+/g, '').trim()));
      if (durationIndex < 0) continue;
      const detectedShotIndex = table.headers.findIndex((cell) => /^(?:镜号|镜头编号|镜头)$/.test(cell.replace(/\*+/g, '').trim()));
      const shotIndex = detectedShotIndex >= 0 ? detectedShotIndex : 0;
      for (const cells of table.rows) {
        if (!isShotLabel(cells[shotIndex])) continue;
        const seconds = parseDuration(cells[durationIndex]);
        if (seconds === null || seconds <= 0) continue;
        tableSeconds += seconds;
        tableShots += 1;
      }
    }

    if (tableShots) return { seconds: tableSeconds, shotCount: tableShots, method: 'table' };

    let timedSeconds = 0;
    let timedShots = 0;
    for (const line of lines) {
      if (!/(?:镜头|镜号)\s*\d+/i.test(line)) continue;
      const explicit = line.match(/时长\s*[：:]?\s*([^，,；;|]+)/);
      const bracketed = line.match(/[【\[]\s*([^\]】]*(?:秒|\d:\d|\d\s*s(?:ec(?:ond)?s?)?\b)[^\]】]*)[\]】]/i);
      const seconds = parseDuration(explicit?.[1] || bracketed?.[1] || '');
      if (seconds === null || seconds <= 0) continue;
      timedSeconds += seconds;
      timedShots += 1;
    }
    if (timedShots) return { seconds: timedSeconds, shotCount: timedShots, method: 'shots' };

    const declared = text.match(/(?:实际)?总时长\s*[：:]?\s*(?:约\s*)?(\d+(?:[.,]\d+)?\s*(?:分钟?|分)(?:\s*\d+(?:[.,]\d+)?\s*秒)?|\d+(?:[.,]\d+)?\s*秒)/);
    const declaredSeconds = parseDuration(declared?.[1] || '');
    if (declaredSeconds !== null && declaredSeconds > 0) return { seconds: declaredSeconds, shotCount: 0, method: 'declared' };
    return { seconds: 0, shotCount: 0, method: 'none' };
  }

  function format(seconds) {
    const rounded = Math.round((Number(seconds) || 0) * 10) / 10;
    if (rounded < 60) return `${rounded}秒`;
    const minutes = Math.floor(rounded / 60);
    const remainder = Math.round((rounded - minutes * 60) * 10) / 10;
    return remainder ? `${minutes}分${remainder}秒` : `${minutes}分钟`;
  }

  const api = { calculate, format, parseDuration, parseTables };
  globalScope.ShotlistDuration = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
