/* UI motion owns root datasets, tiny navigation feedback classes, local pill
   glide/micro-feedback helpers, and one local preference. It never renders
   content, reads project files or polls. Selected micro-interaction timings
   and patterns are adapted from guanmo-ai/ui-moments (MIT). */
(function directorUIMotionScope(window, document) {
  'use strict';
  if (window.DirectorUIMotion) return;

  const STORAGE_KEY = 'director-ui-motion-v1';
  const LEVELS = Object.freeze(['full', 'reduced', 'off']);
  const GLIDE_SPECS = Object.freeze([
    { key: 'theme', track: '.theme-switcher', active: '.theme-choice.active' },
    { key: 'workspace-tabs', track: '.workspace-tabs', active: '.workspace-tab.active' },
    { key: 'asset-filters', track: '.asset-filters', active: '.asset-filter.active' },
    { key: 'membership-tabs', track: '.membership-tabs', active: '.membership-tab.active' },
    { key: 'motion-picker', track: '.ui-motion-picker', active: '.ui-motion-option.active' }
  ]);
  const DONE_SVG_NS = 'http://www.w3.org/2000/svg';
  const INVALID_SHAKE_GUARD = '.modal, .modal-overlay, .workspace-page, .editor-focus, .semantic-editor, .main, .shell, body, html';
  let initialized = false;
  let preference = 'full';
  let media = null;
  let previousPage = null;
  let snapshot = null;
  let entryElements = [];
  let modalRoot = null;
  let modalObserver = null;
  let previousModal = null;
  let resizeFrame = 0;
  const glideCache = new Map();
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

  function resolveElement(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    return target instanceof window.Element ? target : null;
  }

  function classifyToast(message) {
    const text = String(message || '');
    if (/失败|错误|无法|不能|拦截|超时|未找到|必须填写|请先|请填写|不可用|已到期|冲突|异常|无需修改/.test(text)) return 'error';
    if (/已保存|已复制|已导出|已定稿|已验收|已发布|已完成|通过|已创建|已切换|已识别|已导入|已绑定|已恢复|已移除|激活成功|已替换|已更新|已清空/.test(text)) return 'ok';
    return 'info';
  }

  function passwordEyeButtonHtml(label = '显示密钥') {
    return `<button type="button" class="ui-password-toggle" data-action="ui-toggle-password" data-revealed="false" aria-pressed="false" aria-label="${label}" title="显示或隐藏密钥"><svg class="ui-eye-icon" viewBox="0 0 20 20" aria-hidden="true"><path class="ui-eye-lid" d="M2.2 10c1.9-3.6 4.7-5.4 7.8-5.4s5.9 1.8 7.8 5.4c-1.9 3.6-4.7 5.4-7.8 5.4S4.1 13.6 2.2 10z"/><circle class="ui-eye-pupil" cx="10" cy="10" r="2.4"/><line class="ui-eye-slash" x1="3.4" y1="16.6" x2="16.6" y2="3.4"/></svg></button>`;
  }

  function createDoneCheckSvg() {
    const svg = document.createElementNS(DONE_SVG_NS, 'svg');
    svg.setAttribute('class', 'ui-done-check');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(DONE_SVG_NS, 'path');
    path.setAttribute('d', 'M2.5 7.4L5.6 10.4L11.5 3.8');
    svg.appendChild(path);
    return svg;
  }

  function pulseDone(target, { label = '', duration = 1700, preserveLabel = false } = {}) {
    const el = resolveElement(target);
    if (!el || !el.isConnected) return false;
    if (el._uiDoneTimer) {
      clearTimeout(el._uiDoneTimer);
      delete el._uiDoneTimer;
    }
    el.querySelectorAll('.ui-done-check').forEach((node) => node.remove());
    if (el._uiDoneOriginalText === undefined) el._uiDoneOriginalText = el.textContent;
    const swapText = Boolean(label) && !preserveLabel;
    if (swapText) el.textContent = label;
    el.prepend(createDoneCheckSvg());
    el.dataset.uiDone = 'true';
    const expectedText = swapText ? label : null;
    el._uiDoneTimer = window.setTimeout(() => {
      delete el._uiDoneTimer;
      if (!el.isConnected) return;
      delete el.dataset.uiDone;
      el.querySelectorAll('.ui-done-check').forEach((node) => node.remove());
      if (swapText && el._uiDoneOriginalText !== undefined && el.textContent.trim() === expectedText) {
        el.textContent = el._uiDoneOriginalText;
      }
      delete el._uiDoneOriginalText;
    }, Math.max(400, Number(duration) || 1700));
    return true;
  }

  function shake(target) {
    const el = resolveElement(target);
    if (!el || !el.isConnected || el.matches(INVALID_SHAKE_GUARD)) return false;
    el.dataset.uiInvalid = 'true';
    const clearInvalid = () => {
      delete el.dataset.uiInvalid;
      el.removeEventListener('input', clearInvalid);
      if (el._uiInvalidTimer) {
        clearTimeout(el._uiInvalidTimer);
        delete el._uiInvalidTimer;
      }
    };
    clearInvalid();
    el.dataset.uiInvalid = 'true';
    el.addEventListener('input', clearInvalid, { once: true });
    el._uiInvalidTimer = window.setTimeout(clearInvalid, 1500);
    if (get().effective === 'full') {
      el.classList.remove('ui-motion-shake');
      void el.offsetWidth;
      el.classList.add('ui-motion-shake');
      const stopShake = () => {
        el.classList.remove('ui-motion-shake');
        el.removeEventListener('animationend', stopShake);
        if (el._uiShakeTimer) {
          clearTimeout(el._uiShakeTimer);
          delete el._uiShakeTimer;
        }
      };
      el.addEventListener('animationend', stopShake, { once: true });
      el._uiShakeTimer = window.setTimeout(stopShake, 420);
    }
    return true;
  }

  function syncGlideTrack(track, specKey, activeSelector, animate = true) {
    const activeEl = track.querySelector(activeSelector);
    if (!activeEl || !activeEl.offsetWidth || !activeEl.offsetHeight) {
      track.querySelector(':scope > .ui-glide-pill')?.remove();
      delete track.dataset.uiGlideReady;
      return false;
    }
    let pill = track.querySelector(':scope > .ui-glide-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'ui-glide-pill';
      pill.setAttribute('aria-hidden', 'true');
      track.prepend(pill);
    }
    track.dataset.uiGlideReady = 'true';
    const next = {
      left: activeEl.offsetLeft,
      top: activeEl.offsetTop,
      width: activeEl.offsetWidth,
      height: activeEl.offsetHeight
    };
    const prev = glideCache.get(specKey);
    if (pill._uiGlideAnim) {
      try { pill._uiGlideAnim.cancel(); } catch { /* ignore */ }
      pill._uiGlideAnim = null;
    }
    pill.style.left = `${next.left}px`;
    pill.style.top = `${next.top}px`;
    pill.style.width = `${next.width}px`;
    pill.style.height = `${next.height}px`;
    if (animate && prev && get().effective === 'full' && typeof pill.animate === 'function'
      && (Math.abs(prev.left - next.left) > 1 || Math.abs(prev.top - next.top) > 1 || Math.abs(prev.width - next.width) > 1)) {
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      const sx = prev.width / Math.max(1, next.width);
      try {
        pill._uiGlideAnim = pill.animate([
          { transform: `translate(${dx}px, ${dy}px) scaleX(${sx})`, transformOrigin: 'left center' },
          { transform: 'translate(0, 0) scaleX(1)', transformOrigin: 'left center' }
        ], { duration: 280, easing: 'cubic-bezier(.3, 1.45, .5, 1)' });
      } catch {
        pill._uiGlideAnim = null;
      }
    }
    glideCache.set(specKey, next);
    return true;
  }

  function syncGlideTracks(root = document, { animate = true } = {}) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    let synced = 0;
    for (const spec of GLIDE_SPECS) {
      const tracks = scope.querySelectorAll(spec.track);
      tracks.forEach((track, index) => {
        const key = index ? `${spec.key}:${index}` : spec.key;
        if (syncGlideTrack(track, key, spec.active, animate)) synced += 1;
      });
    }
    return synced;
  }

  function onDelegatedClick(event) {
    const btn = event.target?.closest?.('[data-action="ui-toggle-password"]');
    if (!btn) return;
    event.preventDefault();
    const wrap = btn.closest('.ui-password-wrap');
    const input = wrap?.querySelector('input');
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(reveal));
    btn.setAttribute('aria-label', reveal ? '隐藏密钥' : '显示密钥');
    btn.dataset.revealed = String(reveal);
    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
  }

  function onResize() {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      syncGlideTracks(document, { animate: false });
    });
  }

  function init() {
    if (initialized) return get();
    initialized = true;
    preference = readPreference();
    try { media = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { media = null; }
    if (media?.addEventListener) media.addEventListener('change', apply);
    else media?.addListener?.(apply);
    document.addEventListener('visibilitychange', apply);
    document.addEventListener('click', onDelegatedClick);
    window.addEventListener('storage', onStorage);
    window.addEventListener('resize', onResize, { passive: true });
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
    syncGlideTracks(modal, { animate: !opened });
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
    const changed = pageChanged(view);
    syncGlideTracks(document, { animate: true });
    return changed;
  }

  window.DirectorUIMotion = Object.freeze({
    init, afterRender, pageChanged, get, getLevel: () => preference,
    setLevel, set: setLevel, syncGlideTracks, pulseDone, shake,
    classifyToast, passwordEyeButtonHtml, STORAGE_KEY, LEVELS
  });
  init();
})(window, document);
