(function () {
  'use strict';
  const root = document.querySelector('#modal-root');
  const app = document.querySelector('#app');
  if (!root || !app) return;
  let dialog = null;
  let returnFocus = null;
  let previousOverflow = '';
  let activeField = null;
  let serial = 0;
  const focusables = () => [...(dialog?.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])') || [])]
    .filter(element => element.getClientRects().length && !element.closest('[hidden],[inert]'));
  function sync() {
    const next = root.querySelector('.modal');
    if (next === dialog) return;
    const previous = dialog;
    dialog = next;
    if (!next) {
      if (!previous) return;
      app.inert = false;
      document.body.style.overflow = previousOverflow;
      const target = returnFocus?.isConnected ? returnFocus : app.querySelector('[aria-current="page"],#project-switch,[data-action="open-projects"]');
      target?.focus({ preventScroll: true });
      returnFocus = null;
      activeField = null;
      return;
    }
    if (!previous) {
      returnFocus = document.activeElement;
      previousOverflow = document.body.style.overflow;
      activeField = null;
    }
    next.setAttribute('role', 'dialog');
    next.setAttribute('aria-modal', 'true');
    next.tabIndex = -1;
    const heading = next.querySelector('h2,h1,h3');
    if (heading) {
      if (!heading.id) heading.id = 'director-dialog-title-' + (++serial);
      next.setAttribute('aria-labelledby', heading.id);
    } else next.setAttribute('aria-label', '导演台对话框');
    next.querySelectorAll('.modal-close').forEach(button => {
      if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', '关闭对话框');
    });
    app.inert = true;
    document.body.style.overflow = 'hidden';
    const matchingField = activeField?.id ? next.querySelector('#' + CSS.escape(activeField.id)) : null;
    // Keep focus/selection through progress and form-step replacements.
    const target = matchingField || next.querySelector('[autofocus],input:not(:disabled),textarea:not(:disabled),select:not(:disabled)') || focusables()[0] || next;
    target.focus({ preventScroll: true });
    if (matchingField && typeof matchingField.setSelectionRange === 'function' && Number.isInteger(activeField.start)) {
      try { matchingField.setSelectionRange(activeField.start, activeField.end); } catch {}
    }
  }
  root.addEventListener('focusin', event => {
    activeField = { id: event.target.id, start: event.target.selectionStart, end: event.target.selectionEnd };
  });
  root.addEventListener('input', event => {
    activeField = { id: event.target.id, start: event.target.selectionStart, end: event.target.selectionEnd };
  });
  document.addEventListener('keydown', event => {
    if (!dialog || event.isComposing || event.keyCode === 229 || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      const close = dialog.querySelector('.modal-close:not(:disabled)');
      if (close) { event.preventDefault(); event.stopPropagation(); close.click(); }
    } else if (event.key === 'Tab') {
      const controls = focusables();
      if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
      const index = controls.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
      else if (!event.shiftKey && (index === controls.length - 1 || index < 0)) { event.preventDefault(); controls[0].focus(); }
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && event.target.matches('input')) {
      const next = dialog.querySelector('[data-action="wizard-next"],[data-action="create-project"]');
      if (next && !next.disabled) { event.preventDefault(); next.click(); }
    }
  }, true);
  new MutationObserver(sync).observe(root, { childList: true, subtree: true });
})();
