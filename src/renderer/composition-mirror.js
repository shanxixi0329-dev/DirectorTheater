(function exposeCompositionMirror(scope) {
  'use strict';
  const states = new WeakMap();
  function frame(view, nativeValue) {
    const base = String(view.baseValue ?? '');
    const start = Math.max(0, Math.min(Number(view.start) || 0, base.length));
    const end = Math.max(start, Math.min(Number(view.end) || start, base.length));
    const prefix = base.slice(0, start), suffix = base.slice(end);
    // compositionupdate precedes the native value update in some IMEs. The
    // following input event switches to the actual textarea as source of truth.
    const value = view.useNative ? String(nativeValue ?? '') : prefix + String(view.data ?? '') + suffix;
    if (value.length >= prefix.length + suffix.length && value.startsWith(prefix) && value.endsWith(suffix)) {
      return { value, start, end: value.length - suffix.length };
    }
    // Re-conversion and selection replacement can change the reported range.
    let from = 0, beforeEnd = base.length, afterEnd = value.length;
    while (from < beforeEnd && from < afterEnd && base[from] === value[from]) from++;
    while (beforeEnd > from && afterEnd > from && base[beforeEnd - 1] === value[afterEnd - 1]) { beforeEnd--; afterEnd--; }
    return { value, start: from, end: afterEnd };
  }
  function unmark(layer) {
    const parents = new Set();
    for (const caret of layer.querySelectorAll('.composition-caret')) {
      if (caret.parentNode) parents.add(caret.parentNode);
      caret.remove();
    }
    for (const marker of layer.querySelectorAll('.composition-preview,.composition-selection')) {
      const parent = marker.parentNode;
      marker.replaceWith(...marker.childNodes);
      if (parent) parents.add(parent);
    }
    for (const parent of parents) parent.normalize();
  }
  function clear(layer) {
    if (!layer) return;
    unmark(layer);
    if (states.has(layer)) layer._sourceText = null;
    states.delete(layer);
  }
  function mark(line, from, to, className = 'composition-preview') {
    const document = line.ownerDocument;
    const walker = document.createTreeWalker(line, 4);
    const nodes = []; let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = Math.max(0, from - offset), end = Math.min(node.length, to - offset);
      if (end > start) nodes.push({ node, start, end });
      offset += node.length;
    }
    for (const { node, start, end } of nodes) {
      const fragment = document.createDocumentFragment();
      if (start) fragment.append(document.createTextNode(node.data.slice(0, start)));
      const span = document.createElement('span');
      span.className = className;
      span.textContent = node.data.slice(start, end);
      fragment.append(span);
      if (end < node.length) fragment.append(document.createTextNode(node.data.slice(end)));
      node.replaceWith(fragment);
    }
  }
  function insertCaret(line, offset) {
    const document = line.ownerDocument;
    const marker = document.createElement('span'); marker.className = 'composition-caret';
    const walker = document.createTreeWalker(line, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset <= node.length) {
        const range = document.createRange(); range.setStart(node, offset); range.collapse(true); range.insertNode(marker); return;
      }
      offset -= node.length;
    }
    line.append(marker);
  }
  function render(layer, view, nativeValue, renderLine, selection = null) {
    const current = frame(view, nativeValue);
    const lines = current.value.split('\n');
    const previous = states.get(layer)?.lines || String(view.baseValue ?? '').split('\n');
    unmark(layer);
    let first = 0, oldEnd = previous.length, newEnd = lines.length;
    while (first < oldEnd && first < newEnd && previous[first] === lines[first]) first++;
    while (oldEnd > first && newEnd > first && previous[oldEnd - 1] === lines[newEnd - 1]) { oldEnd--; newEnd--; }
    if (layer.children.length !== previous.length) { first = 0; oldEnd = layer.children.length; newEnd = lines.length; }
    // Patch only affected logical lines. The textarea, its undo stack and all
    // unchanged highlight rows remain attached during the IME transaction.
    for (let index = oldEnd - 1; index >= first; index--) layer.children[index].remove();
    const fragment = layer.ownerDocument.createDocumentFragment();
    for (let index = first; index < newEnd; index++) {
      const line = layer.ownerDocument.createElement('div');
      line.className = 'highlight-line'; line.dataset.lineIndex = String(index);
      line.innerHTML = renderLine(lines[index], index);
      fragment.append(line);
    }
    layer.insertBefore(fragment, layer.children[first] || null);
    for (let index = first; index < layer.children.length; index++) layer.children[index].dataset.lineIndex = String(index);
    const selectedStart = Math.max(current.start, Math.min(Number(selection?.start) || 0, current.value.length));
    const selectedEnd = Math.min(current.end, Math.max(0, Math.min(Number(selection?.end) || 0, current.value.length)));
    const caret = selection ? Math.max(0, Math.min(selection.backward ? selection.start : selection.end, current.value.length)) : null;
    let offset = 0, caretAdded = false;
    for (let index = 0; index < lines.length; index++) {
      const from = Math.max(0, current.start - offset), to = Math.min(lines[index].length, current.end - offset);
      if (to > from) mark(layer.children[index], from, to);
      const selectedFrom = Math.max(0, selectedStart - offset), selectedTo = Math.min(lines[index].length, selectedEnd - offset);
      if (selectedTo > selectedFrom) mark(layer.children[index], selectedFrom, selectedTo, 'composition-selection');
      if (!caretAdded && caret !== null && caret <= offset + lines[index].length) {
        insertCaret(layer.children[index], Math.max(0, caret - offset)); caretAdded = true;
      }
      offset += lines[index].length + 1;
    }
    layer._sourceText = null;
    states.set(layer, { lines });
    return current;
  }
  const api = { frame, render, clear };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.DirectorCompositionMirror = api;
})(typeof window === 'object' ? window : globalThis);
