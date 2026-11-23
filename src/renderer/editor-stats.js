(function exposeDirectorEditorStats(globalScope) {
  'use strict';

  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
  const whitespace = /^\s+$/u;
  // Common Chinese/English text has one UTF-16 unit per grapheme. Anything
  // involving combining marks, surrogate pairs or other scripts uses Intl.
  const commonText = /^[\x00-\x7f\u00a0\u2010-\u2027\u202f\u2030-\u205e\u3000-\u3029\u3030-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff01-\uff60]*$/;
  const countCache = new Map();

  function count(value) {
    const text = String(value ?? '');
    if (!text) return 0;
    if (countCache.has(text)) return countCache.get(text);
    let total = 0;
    if (commonText.test(text)) total = text.replace(/\s/g, '').length;
    else if (segmenter) {
      for (const item of segmenter.segment(text)) if (!whitespace.test(item.segment)) total += 1;
    } else {
      for (const item of text) if (!whitespace.test(item)) total += 1;
    }
    // Cursor and selection events must not re-segment the entire document.
    if (text.length <= 4 * 1024 * 1024) {
      if (countCache.size >= 4) countCache.delete(countCache.keys().next().value);
      countCache.set(text, total);
    }
    return total;
  }

  function finiteIndex(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
  }

  function measure(value, selection = {}) {
    const text = String(value ?? '');
    const result = { count: count(text), selectedCount: 0, hasSelection: false };
    const hasStart = Object.prototype.hasOwnProperty.call(selection, 'start')
      || Object.prototype.hasOwnProperty.call(selection, 'selectionStart');
    const hasEnd = Object.prototype.hasOwnProperty.call(selection, 'end')
      || Object.prototype.hasOwnProperty.call(selection, 'selectionEnd');
    if (!hasStart || !hasEnd) return result;
    const rawStart = selection.start ?? selection.selectionStart;
    const rawEnd = selection.end ?? selection.selectionEnd;
    if (!Number.isFinite(Number(rawStart)) || !Number.isFinite(Number(rawEnd))) return result;
    const start = Math.max(0, Math.min(text.length, finiteIndex(rawStart, 0)));
    const end = Math.max(0, Math.min(text.length, finiteIndex(rawEnd, 0)));
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (low === high) return result;
    result.hasSelection = true;
    result.selectedCount = count(text.slice(low, high));
    return result;
  }

  function label(result, { selection = true } = {}) {
    const value = result || { count: 0, selectedCount: 0, hasSelection: false };
    const suffix = selection && value.hasSelection ? ` · 选中 ${value.selectedCount} 字` : '';
    return `字数 ${value.count}（不含空白）${suffix}`;
  }

  function renderFooter(initialText = '') {
    return `<div class="editor-stats" data-editor-stats aria-live="polite">${escapeHTML(label(measure(initialText)))}</div>`;
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function update(footer, value, options = {}) {
    const result = measure(value, options.selection === false ? {} : options);
    if (footer) {
      const text = label(result, { selection: options.selection !== false });
      if (footer.textContent !== text) footer.textContent = text;
    }
    return result;
  }

  function updateFromInput(footer, input, options = {}) {
    if (!input) return update(footer, '', options);
    return update(footer, input.value, {
      ...options,
      start: input.selectionStart,
      end: input.selectionEnd
    });
  }

  const api = { count, measure, label, renderFooter, update, updateFromInput };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.DirectorEditorStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
