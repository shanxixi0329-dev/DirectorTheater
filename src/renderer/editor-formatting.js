(function exposeEditorFormatting(globalScope) {
  function toggleBold(value, selectionStart, selectionEnd) {
    const source = String(value || '');
    const start = Math.max(0, Math.min(Number(selectionStart) || 0, source.length));
    const end = Math.max(start, Math.min(Number(selectionEnd) || start, source.length));

    if (start === end) {
      const nextValue = `${source.slice(0, start)}****${source.slice(end)}`;
      return { value: nextValue, selectionStart: start + 2, selectionEnd: start + 2, enabled: true };
    }

    if (start >= 2 && source.slice(start - 2, start) === '**' && source.slice(end, end + 2) === '**') {
      const nextValue = `${source.slice(0, start - 2)}${source.slice(start, end)}${source.slice(end + 2)}`;
      return { value: nextValue, selectionStart: start - 2, selectionEnd: end - 2, enabled: false };
    }

    const selected = source.slice(start, end);
    const chunks = selected.split(/(\r?\n)/);
    const contentChunks = chunks.filter((chunk) => !/^\r?\n$/.test(chunk) && chunk.length > 0);
    const allWrapped = contentChunks.length > 0 && contentChunks.every((chunk) => /^\*\*[\s\S]*\*\*$/.test(chunk));
    const replacement = chunks.map((chunk) => {
      if (/^\r?\n$/.test(chunk) || !chunk.length) return chunk;
      if (allWrapped) return chunk.slice(2, -2);
      return /^\*\*[\s\S]*\*\*$/.test(chunk) ? chunk : `**${chunk}**`;
    }).join('');
    const nextValue = `${source.slice(0, start)}${replacement}${source.slice(end)}`;

    if (chunks.length === 1 && !allWrapped) {
      return { value: nextValue, selectionStart: start + 2, selectionEnd: start + replacement.length - 2, enabled: true };
    }
    return { value: nextValue, selectionStart: start, selectionEnd: start + replacement.length, enabled: !allWrapped };
  }

  /** Keep native IME text visible until its final input has reached the model and mirror. */
  function createCompositionGuard({ commit = () => {}, settled = () => {}, schedule } = {}) {
    const sessions = new WeakMap();
    const active = new Set();
    // A minimized Electron window may suspend rAF; commit must still finish there.
    const defer = schedule || ((callback) => setTimeout(callback, 16));

    function start(target) {
      if (!target) return;
      let session = sessions.get(target);
      if (!session) {
        session = { target, composing: true, settling: false, revision: 0,
          wrapper: target.closest?.('.highlight-editor') || null };
        sessions.set(target, session);
      }
      session.composing = true;
      session.settling = false;
      session.revision += 1;
      session.wrapper?.classList.add('ime-composing');
      active.add(session);
    }

    function finishLater(session) {
      const revision = ++session.revision;
      defer(() => {
        if (session.revision !== revision || session.composing) return;
        try {
          if (session.target.isConnected !== false) commit(session.target);
        } finally {
          session.wrapper?.classList.remove('ime-composing');
          session.settling = false;
          active.delete(session);
          sessions.delete(session.target);
          settled(session.target);
        }
      });
    }

    function end(target) {
      const session = sessions.get(target);
      if (!session) return;
      session.composing = false;
      session.settling = true;
      finishLater(session);
    }

    function input(target, isComposing = false) {
      if (isComposing && !sessions.has(target)) start(target);
      const session = sessions.get(target);
      // Chromium may deliver the final input after compositionend; wait for that input.
      if (session?.settling) finishLater(session);
    }

    return { start, end, input,
      isBlocked: (target) => Boolean(sessions.get(target)?.composing || sessions.get(target)?.settling),
      busy: () => active.size > 0 };
  }

  /** Patch the surrounding shell without detaching the live textarea's ancestor path. */
  function renderAroundEditor(root, markup, editor) {
    const oldLeaf = editor?.closest?.('.highlight-editor');
    if (!oldLeaf || !root.contains(oldLeaf)) { root.innerHTML = markup; return false; }
    const draft = root.ownerDocument.createElement('div');
    draft.innerHTML = markup;
    const nextEditor = [...draft.querySelectorAll('textarea[data-bind]')]
      .find((element) => element.dataset.bind === editor.dataset.bind);
    const nextLeaf = nextEditor?.closest('.highlight-editor');
    const ancestry = (leaf, boundary) => {
      const nodes = [];
      for (let node = leaf; node; node = node.parentNode) {
        nodes.unshift(node);
        if (node === boundary) return nodes;
      }
      return [];
    };
    const oldPath = ancestry(oldLeaf, root);
    const nextPath = ancestry(nextLeaf, draft);
    if (!nextLeaf || oldPath.length !== nextPath.length
      || oldPath.some((node, index) => node.nodeName !== nextPath[index].nodeName)) {
      root.innerHTML = markup;
      return false;
    }
    for (let depth = 0; depth < oldPath.length - 1; depth += 1) {
      const current = oldPath[depth];
      const desired = nextPath[depth];
      const kept = oldPath[depth + 1];
      const desiredKept = nextPath[depth + 1];
      if (depth) {
        for (const attribute of [...current.attributes]) if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        for (const attribute of [...desired.attributes]) current.setAttribute(attribute.name, attribute.value);
      }
      const children = [...desired.childNodes];
      const split = children.indexOf(desiredKept);
      for (const child of [...current.childNodes]) if (child !== kept) child.remove();
      for (const child of children.slice(0, split)) current.insertBefore(child, kept);
      for (const child of children.slice(split + 1)) current.appendChild(child);
    }
    return true;
  }

  const api = { toggleBold, createCompositionGuard, renderAroundEditor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.EditorFormatting = api;
})(typeof window !== 'undefined' ? window : globalThis);
