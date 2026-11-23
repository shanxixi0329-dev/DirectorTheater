/* UI motion owns only root datasets, tiny navigation feedback classes and one
   local preference. It never renders content, reads project files or polls. */
(function directorUIMotionScope(window, document) {
  'use strict';
  if (window.DirectorUIMotion) return;

  const STORAGE_KEY = 'director-ui-motion-v1';
  const LEVELS = Object.freeze(['full', 'reduced', 'off']);
  let initialized = false;
  let preference = 'full';
  let media = null;
  let previousPage = null;
  let snapshot = null;
  let entryElements = [];
  let modalRoot = null;
  let modalObserver = null;
  let previousModal = null;
  const normalize = (level) => LEVELS.includes(level) ? level : 'full';

  function readPreference() {
    try { return normalize(window.localStorage.getItem(STORAGE_KEY)); }
    catch { return 'full'; }
  }

  function get() {
    const systemReduced = Boolean(media?.matches);
    const paused = Boolean(document.hidden);
    const effective = paused ? 'off' : preference === 'full' && systemReduced ? 'reduced' : preference;
    return { preference, effective, systemReduced, paused };
  }

  function clearEntries() {
    entryElements.forEach(({ element, className, cleanup }) => {
      element.removeEventListener('animationend', cleanup);
      element.classList.remove(className);
    });
    entryElements = [];
  }

  function apply() {
    const status = get();
    const root = document.documentElement;
    root.dataset.uiMotion = status.effective;
    root.dataset.uiMotionPreference = status.preference;
    root.dataset.uiMotionPaused = String(status.paused);
    if (status.effective !== 'full') clearEntries();
    const next = JSON.stringify(status);
    if (next !== snapshot) {
      snapshot = next;
      window.dispatchEvent(new window.CustomEvent('director-ui-motion-change', {
        detail: { level: status.preference, effectiveLevel: status.effective, ...status }
      }));
    }
    return status;
  }

  function onStorage(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    preference = event.key === null ? readPreference() : normalize(event.newValue);
    apply();
  }

  function init() {
    if (initialized) return get();
    initialized = true;
    preference = readPreference();
    try { media = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { media = null; }
    if (media?.addEventListener) media.addEventListener('change', apply);
    else media?.addListener?.(apply);
    document.addEventListener('visibilitychange', apply);
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', clearEntries);
    const status = apply();
    observeModalRoot();
    return status;
  }

  function setLevel(level) {
    init();
    preference = normalize(level);
    try { window.localStorage.setItem(STORAGE_KEY, preference); } catch { /* Current session still works. */ }
    return apply();
  }

  function markEntry(element, className) {
    if (!element) return;
    element.classList.add(className);
    const cleanup = (event) => {
      if (event && event.target !== element) return;
      element.classList.remove(className);
      element.removeEventListener('animationend', cleanup);
      entryElements = entryElements.filter((item) => item.element !== element);
    };
    element.addEventListener('animationend', cleanup);
    entryElements.push({ element, className, cleanup });
  }

  function modalFingerprint(modal) {
    // Use identity, not the episode/title/count/text or enabled state. A batch
    // progress re-render with new DOM nodes keeps the same identity and never
    // repeats the open animation. Generic action dialogs use their close action
    // as the fallback discriminator, without reading user-authored content.
    const classes = Array.from(modal.classList).filter((name) => !name.startsWith('ui-motion-')).sort().join(' ');
    const closeAction = modal.querySelector('.modal-close[data-action]')?.dataset.action || '';
    const kind = classes === 'action-dialog modal' ? closeAction : '';
    return `${classes}|${kind}`;
  }

  function onModalChanged() {
    // Detached animated nodes are cleaned here as well as on app re-renders.
    entryElements = entryElements.filter((item) => {
      if (item.element.isConnected) return true;
      item.element.removeEventListener('animationend', item.cleanup);
      return false;
    });
    const modal = modalRoot?.querySelector('.modal');
    if (!modal) { previousModal = null; return; }
    const fingerprint = modalFingerprint(modal);
    const opened = previousModal !== fingerprint;
    previousModal = fingerprint;
    if (opened && get().effective === 'full') markEntry(modal, 'ui-motion-modal-entry');
  }

  function observeModalRoot() {
    if (modalObserver || !window.MutationObserver) return;
    modalRoot = document.querySelector('#modal-root');
    if (!modalRoot) return;
    // Direct children only. No observation of text, attributes, form fields,
    // textarea typing, scroll, images, progress or the whole application.
    modalObserver = new window.MutationObserver(onModalChanged);
    modalObserver.observe(modalRoot, { childList: true });
    onModalChanged();
  }

  function pageChanged(view) {
    init();
    const page = String(view || 'empty');
    if (page === previousPage) return false;
    clearEntries();
    previousPage = page;
    if (get().effective !== 'full') return false;
    // Only the header and selected navigation button fade. No content ancestor
    // is touched: a fullscreen video or fixed dialog keeps its viewport anchor.
    const header = document.querySelector('.main .page-heading, .main .director-toolbar, .main .rules-toolbar, .main .asset-toolbar, .main .source-hero');
    const navigation = document.querySelector('.nav-row.active .nav-view-button, .nav button.active');
    markEntry(header, 'ui-motion-page-entry');
    markEntry(navigation, 'ui-motion-nav-entry');
    return Boolean(header || navigation);
  }

  function afterRender(view) {
    // Stale heading references are discarded even when a save rebuilt the DOM,
    // but there is no heading animation in the newly rendered same-page nodes.
    entryElements = entryElements.filter((item) => {
      if (item.element.isConnected) return true;
      item.element.removeEventListener('animationend', item.cleanup);
      return false;
    });
    return pageChanged(view);
  }

  window.DirectorUIMotion = Object.freeze({
    init, afterRender, pageChanged, get, getLevel: () => preference,
    setLevel, set: setLevel, STORAGE_KEY, LEVELS
  });
  init();
})(window, document);
