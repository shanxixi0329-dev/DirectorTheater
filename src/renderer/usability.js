'use strict';

const replacementScopes = [['source', '原文'], ['synopsis', '梗概'], ['outline', '大纲'], ['script', '剧本'], ['storyboard', '分镜'], ['seedance', '提示词'], ['rules', '规则与记忆']];
const optionalWorkspaceViews = new Set(['shot-studio', 'quality-center']);

function readWorkspacePreferences() {
  try { return JSON.parse(localStorage.getItem('director-workspace-preferences') || '{}'); } catch { return {}; }
}

function localCheckPolicy() {
  return window.DirectorLocalChecks.normalize(state.project?.localCheckSettings);
}

function renderLocalCheckContext(kind) {
  const policy = localCheckPolicy();
  const items = window.DirectorLocalChecks.catalog[kind] || [];
  const count = items.filter(item => policy[kind][item.id]).length;
  const source = kind === 'script' ? state.project.activeFiles?.source : kind === 'storyboard' ? state.project.activeFiles?.script : '';
  return `<div class="local-check-context"><div><span class="eyebrow">LOCAL CHECK</span><button class="button quiet small" data-action="ux-check-settings">检查设置</button></div><p>已选 ${count} / ${items.length} 项 · ${policy.automatic ? '自动检查' : '手动检查'}</p><details><summary>查看本次检查依据</summary><p>本地内置规则，不调用 AI。只运行已勾选项目，导入的生成要求不会自动变成本地检查规则。</p><p class="path">${escapeHTML(kind === 'shotlist' ? state.project.activeFiles?.shotlist || '当前编辑器内容' : source || '未绑定对照文件')}</p><p>不判断剧情优劣、人物动机或前后集逻辑。</p></details></div>`;
}

function renderWorkspacePreferencesEntry() {
  return `<article class="card workspace-preferences-entry"><div><h2>我的工作台</h2><p class="hint">本地检查项目、检查依据与常用工具入口。</p></div><div class="form-actions"><button class="button secondary" data-action="ux-check-settings">本地检查设置</button><button class="button quiet" data-action="ux-workspace-settings">界面设置</button></div></article>`;
}

function arrangeUsabilityDialog() {
  const modal = modalRoot.querySelector('.modal');
  if (!modal || modal.querySelector('.dialog-scroll-body')) return;
  const header = modal.querySelector('.modal-head');
  const footer = modal.lastElementChild;
  if (!header || !footer?.matches('.form-actions')) return;
  const body = document.createElement('div');
  body.className = 'dialog-scroll-body';
  for (const child of [...modal.children]) if (child !== header && child !== footer) body.append(child);
  modal.insertBefore(body, footer);
  modal.classList.add('usability-dialog');
}

function renderUsabilityDialog(dialog) {
  if (dialog.type === 'local-check-settings') {
    const policy = dialog.draft;
    modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal action-dialog check-settings-dialog"><div class="modal-head"><div><span class="eyebrow">YOUR CHECKLIST</span><h2>本地检查设置</h2></div><button class="modal-close" data-action="close-action-dialog">×</button></div><p class="hint">随当前项目保存。只运行你勾选的内置规则；材料不足会标明“未检查”，不会算作剧本错误。</p><label class="check-setting-row"><input type="checkbox" data-local-check="automatic" ${policy.automatic ? 'checked' : ''}><span><strong>切集时自动检查</strong><small>关闭后仍可在编辑页点击“重新检查”。</small></span></label>${Object.entries(window.DirectorLocalChecks.catalog).map(([kind, items]) => `<fieldset class="check-setting-group"><legend>${documentKindLabel(kind)}</legend>${items.map(item => `<label class="check-setting-row"><input type="checkbox" data-local-check="${kind}.${item.id}" ${policy[kind][item.id] ? 'checked' : ''}><span><strong>${item.label}</strong><small>${item.detail}</small></span></label>`).join('')}</fieldset>`).join('')}<label class="check-setting-row"><input type="checkbox" data-local-check="strictDialogue" ${policy.strictDialogue ? 'checked' : ''}><span><strong>剧本台词严格逐字保真</strong><small>默认关闭。开启后，未匹配台词列为不符合要求；仅用于明确要求逐字保真的项目。</small></span></label><p class="hint">剧情因果、事实和连续性需结合原著及相邻集人工审阅，或到“更多工具 → 检查与优化”另行启用 API 审查。</p>${dialog.error ? `<p role="alert">${escapeHTML(dialog.error)}</p>` : ''}<div class="form-actions"><button class="button quiet" data-action="ux-check-none" ${dialog.busy ? 'disabled' : ''}>全部关闭</button><button class="button secondary" data-action="ux-check-defaults" ${dialog.busy ? 'disabled' : ''}>恢复默认</button><button class="button" data-action="ux-check-save" ${dialog.busy ? 'disabled' : ''}>${dialog.busy ? '保存中…' : '保存并检查当前页'}</button></div></div></div>`;
    return true;
  }
  if (dialog.type === 'workspace-settings') {
    const motionStatus = window.DirectorUIMotion?.get?.() || { preference: 'full', systemReduced: false };
    const motionLevel = motionStatus.preference || 'full';
    const motionChoices = [
      ['full', '完整动效', '滑动指示与触感反馈'],
      ['reduced', '精简反馈', '仅保留柔和色彩过渡'],
      ['off', '关闭动效', '静态零动画，低功耗']
    ];
    modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal action-dialog"><div class="modal-head"><h2>工作台界面</h2><button class="modal-close" data-action="close-action-dialog">×</button></div><p class="hint">不常用的工具放在“更多工具”，需要时随时打开。</p><label class="check-setting-row"><input type="checkbox" id="pin-optional-tools" ${readWorkspacePreferences().pinOptionalTools ? 'checked' : ''}><span><strong>常驻显示镜头工作台、检查与优化</strong><small>本地检查始终保留在编辑页面。</small></span></label><div class="ui-motion-setting"><div class="ui-motion-setting-head"><strong>界面动效与微交互</strong><small>${motionStatus.systemReduced ? '检测到系统减弱动画，完整档将自动降为精简' : '切页、复制、保存与校验反馈实时生效'}</small></div><div class="ui-motion-picker" role="group" aria-label="界面动效等级">${motionChoices.map(([id, title, note]) => `<button type="button" class="ui-motion-option ${motionLevel === id ? 'active' : ''}" data-action="ux-motion-level" data-motion-level="${id}" aria-pressed="${motionLevel === id}"><strong>${title}</strong><small>${note}</small></button>`).join('')}</div></div><div class="form-actions"><button class="button" data-action="ux-workspace-save">保存界面设置</button></div></div></div>`;
    return true;
  }
  return false;
}

function replacementHistory() {
  try { return JSON.parse(localStorage.getItem('director-replacements:' + projectPathKey(state.project.projectPath)) || '[]'); } catch { return []; }
}

function rememberReplacement(result) {
  try {
    const existing = replacementHistory().filter(item => item.backupDirectory !== result.backupDirectory);
    localStorage.setItem('director-replacements:' + projectPathKey(state.project.projectPath), JSON.stringify([{ ...result, at: result.at || new Date().toLocaleString('zh-CN') }, ...existing].slice(0, 10)));
  } catch {}
}

function replacementOptions(dialog) {
  return { scopes: dialog.scopes, extensions: dialog.extensions, backupRoot: dialog.backupRoot || '',
    ...(dialog.preview ? { selectedPaths: [...dialog.selectedPaths] } : {}) };
}

function selectedReplacementCount(dialog) {
  return (dialog.preview?.matches || []).filter(item => dialog.selectedPaths.has(item.path)).reduce((sum, item) => sum + item.count, 0);
}

function renderGlobalReplaceContent(dialog) {
  const busy = Boolean(dialog.busy);
  const preview = dialog.preview;
  const result = dialog.result;
  const count = preview ? selectedReplacementCount(dialog) : 0;
  const backupBase = dialog.backupRoot ? dialog.backupRoot + '\\导演台替换备份\\' + (state.project.title || '项目') : state.project.projectPath + '\\.ai-director\\全局替换备份';
  const backup = `<section class="replace-backup-card"><strong>替换前备份原文件</strong><p class="path">${escapeHTML(backupBase)}</p><p class="hint">每次建立独立子目录，保存原文件和变更清单。备份完成后才写入。</p><div class="form-actions"><button class="button quiet small" data-action="ux-backup-choose" ${busy ? 'disabled' : ''}>选择其他位置</button>${dialog.backupRoot ? `<button class="button quiet small" data-action="ux-backup-default" ${busy ? 'disabled' : ''}>使用项目内目录</button>` : ''}</div></section>`;
  let body;
  if (result) {
    body = `<div class="replace-success"><span class="eyebrow">COMPLETED</span><h3>${result.restored ? '本次替换已撤销' : `已替换 ${result.files} 个文件 · ${result.replacements} 处`}</h3><p>${result.restored ? '原文件已按备份恢复。备份仍保留。' : '仅修改所勾选的文件。完整原文件已保留，可在下方查看或撤销。'}</p></div><section class="replace-backup-card"><strong>本次备份位置</strong><p class="path">${escapeHTML(result.backupDirectory)}</p><div class="form-actions"><button class="button secondary" data-action="ux-backup-open">打开备份文件夹</button><button class="button quiet" data-action="ux-backup-copy">复制路径</button>${result.restored ? '' : `<button class="button quiet" data-action="ux-replace-undo" ${busy ? 'disabled' : ''}>撤销本次替换</button>`}</div></section>`;
  } else if (preview) {
    body = `<div class="global-replace-summary"><strong>已选 <span id="replace-selected-files">${dialog.selectedPaths.size}</span> / ${preview.files} 个文件 · <span id="replace-selected-count">${count}</span> 处</strong><span>“${escapeHTML(dialog.needle)}” → “${escapeHTML(dialog.replacement || '（删除）')}”</span></div><p class="hint">勾选要修改的文件。Word 仅在勾选时处理，文字替换会重建其排版。</p><div class="form-actions"><button class="button quiet small" data-action="ux-replace-select-all" ${busy ? 'disabled' : ''}>全选</button><button class="button quiet small" data-action="ux-replace-select-none" ${busy ? 'disabled' : ''}>全不选</button></div><div class="global-replace-results">${preview.matches.slice(0, dialog.visibleLimit || 80).map((item, index) => `<label class="replace-file-row"><input type="checkbox" data-replace-file="${index}" ${dialog.selectedPaths.has(item.path) ? 'checked' : ''} ${busy ? 'disabled' : ''}><span><strong>${escapeHTML(item.path)}</strong><small>${item.count} 处 · 首处在第 ${item.line} 行${item.format === '.docx' ? ' · Word 将重建排版' : ''}</small><code>${escapeHTML(item.excerpt)}</code></span></label>`).join('') || '<p class="hint">没有匹配结果，可以返回修改查找内容或范围。</p>'}</div>${preview.matches.length > (dialog.visibleLimit || 80) ? '<button class="button quiet small" data-action="ux-replace-more">显示更多文件</button>' : ''}${preview.errors.length ? `<div class="replace-errors" role="alert"><strong>${preview.errors.length} 项读取失败，本轮不能替换</strong>${preview.errors.slice(0, 30).map(item => `<p>${escapeHTML(item.path + '：' + item.message)}</p>`).join('')}</div>` : ''}${backup}`;
  } else {
    const previous = replacementHistory()[0];
    body = `<p class="hint">选择范围，查看命中位置，再勾选需要修改的文件。按原样匹配文字。</p><div class="replace-input-grid"><label class="field">查找内容<textarea id="find-replace-find" rows="3" ${busy ? 'disabled' : ''}>${escapeHTML(dialog.needle || '')}</textarea></label><label class="field">替换为<textarea id="find-replace-replace" rows="3" placeholder="留空表示删除" ${busy ? 'disabled' : ''}>${escapeHTML(dialog.replacement || '')}</textarea></label></div><fieldset class="replace-scope"><legend>文档范围</legend>${replacementScopes.map(([id, label]) => `<label><input type="checkbox" data-replace-scope="${id}" ${dialog.scopes.includes(id) ? 'checked' : ''} ${busy ? 'disabled' : ''}>${label}</label>`).join('')}</fieldset><fieldset class="replace-scope"><legend>文件类型</legend>${[['.txt', 'TXT'], ['.md', 'Markdown'], ['.docx', 'Word']].map(([id, label]) => `<label><input type="checkbox" data-replace-extension="${id}" ${dialog.extensions.includes(id) ? 'checked' : ''} ${busy ? 'disabled' : ''}>${label}</label>`).join('')}</fieldset>${backup}${previous ? `<p class="hint">最近一次替换：${escapeHTML(previous.at)} <button class="button quiet small" data-action="ux-replace-history">查看备份与撤销</button></p>` : ''}`;
  }
  const disabled = busy || dialog.saveFailed || (preview ? !preview.complete || !count : !dialog.scopes.length || !dialog.extensions.length);
  const stepProgress = result ? 100 : preview ? 56 : 16;
  modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal action-dialog global-replace-dialog"><div class="modal-head"><div><span class="eyebrow">FIND & REPLACE</span><h2>${result ? '替换结果与备份' : '全局查找替换'}</h2></div><button class="modal-close" data-action="close-action-dialog" ${busy && dialog.busy !== 'search' ? 'disabled' : ''}>×</button></div><div class="replace-steps" style="--step-progress:${stepProgress}"><span class="${!preview && !result ? 'current' : 'done'}">1 选择范围</span><span class="${preview && !result ? 'current' : result ? 'done' : ''}">2 预览与勾选</span><span class="${result ? 'current' : ''}">3 结果与备份</span></div>${body}<p id="global-search-progress" class="hint" role="status">${escapeHTML(dialog.progressText || '')}</p>${dialog.error ? `<p class="replace-errors" role="alert">${escapeHTML(dialog.error)}</p>` : ''}<div class="form-actions replace-footer">${result ? '<button class="button" data-action="close-action-dialog">完成</button>' : `${preview ? `<button class="button secondary" data-action="ux-replace-back" ${busy ? 'disabled' : ''}>返回修改范围</button>` : '<button class="button secondary" data-action="close-action-dialog">取消</button>'}<button class="button" data-action="confirm-action-dialog" ${disabled ? 'disabled' : ''}>${busy ? '处理中…' : preview ? `确认替换 ${count} 处` : '查找并预览'}</button>`}</div></div></div>`;
}

function renderGlobalReplaceDialog(dialog) {
  renderGlobalReplaceContent(dialog);
  arrangeUsabilityDialog();
}

async function confirmGlobalReplaceDialog(dialog) {
  if (dialog.result || dialog.busy || dialog.saveFailed) return;
  dialog.needle = dialog.preview ? dialog.needle : document.querySelector('#find-replace-find').value;
  dialog.replacement = dialog.preview ? dialog.replacement : document.querySelector('#find-replace-replace').value;
  if (!dialog.needle) {
    window.DirectorUIMotion?.shake('#find-replace-find');
    document.querySelector('#find-replace-find')?.focus();
    return showToast('请填写要查找的内容。');
  }
  if (dialog.needle === dialog.replacement) {
    window.DirectorUIMotion?.shake('#find-replace-replace');
    document.querySelector('#find-replace-replace')?.focus();
    return showToast('查找和替换内容相同，无需修改。');
  }
  const isPreview = !dialog.preview;
  if (!isPreview && (!dialog.preview.complete || !selectedReplacementCount(dialog))) return;
  dialog.error = '';
  dialog.busy = isPreview ? 'search' : 'write';
  dialog.progressText = isPreview ? '正在扫描所选范围；关闭窗口可取消。' : '正在备份并替换所选文件…';
  renderGlobalReplaceDialog(dialog);
  try {
    if (isPreview) {
      const preview = await window.directorApi.replaceProjectText(state.project, dialog.needle, dialog.replacement, true, '', replacementOptions(dialog));
      if (state.actionDialog !== dialog) return;
      dialog.preview = preview;
      dialog.selectedPaths = new Set(preview.matches.map(item => item.path));
      dialog.progressText = `已扫描 ${preview.scanned} 个文件。请核对并勾选。`;
    } else {
      const result = await replaceAllProjectText(dialog.needle, dialog.replacement, dialog.preview.revision, replacementOptions(dialog));
      dialog.result = result;
      dialog.progressText = result.refreshWarning || '';
    }
  } catch (error) { dialog.error = String(error.message || error); dialog.progressText = ''; }
  finally { dialog.busy = ''; if (state.actionDialog === dialog) renderGlobalReplaceDialog(dialog); }
}

async function handleUsabilityAction(action, button = null) {
  if (!action?.startsWith('ux-')) return false;
  const dialog = state.actionDialog;
  if (dialog?.busy) return true;
  if (action === 'ux-check-settings') {
    if (!state.project) return true;
    state.actionDialog = { type: 'local-check-settings', draft: localCheckPolicy() };
    renderActionDialog();
  } else if (action === 'ux-workspace-settings') {
    state.actionDialog = { type: 'workspace-settings' }; renderActionDialog();
  } else if (action === 'ux-motion-level') {
    const level = button?.dataset?.motionLevel || 'full';
    const next = window.DirectorUIMotion?.setLevel?.(level);
    const active = next?.preference || level;
    modalRoot.querySelectorAll('.ui-motion-option').forEach(option => {
      const selected = option.dataset.motionLevel === active;
      option.classList.toggle('active', selected);
      option.setAttribute('aria-pressed', String(selected));
    });
    window.DirectorUIMotion?.syncGlideTracks?.(modalRoot);
    const label = active === 'off' ? '已关闭界面动效。' : active === 'reduced' ? '已切换为精简反馈。' : '已切换为完整动效。';
    showToast(label);
  } else if (action === 'ux-workspace-save') {
    localStorage.setItem('director-workspace-preferences', JSON.stringify({ pinOptionalTools: document.querySelector('#pin-optional-tools').checked }));
    closeActionDialog();
  } else if (action === 'ux-check-defaults' || action === 'ux-check-none') {
    dialog.draft = window.DirectorLocalChecks.normalize();
    if (action === 'ux-check-none') for (const kind of Object.keys(window.DirectorLocalChecks.catalog)) for (const key of Object.keys(dialog.draft[kind])) dialog.draft[kind][key] = false;
    renderActionDialog();
  } else if (action === 'ux-check-save') {
    if (!state.project) return true;
    const previous = state.project.localCheckSettings;
    dialog.busy = 'saving';
    state.project.localCheckSettings = window.DirectorLocalChecks.normalize(dialog.draft);
    state.checkCache = { script: '', shotlist: '', storyboard: '' };
    markDirty();
    renderActionDialog();
    try {
      await saveProject({ renderAfter: false });
      dialog.busy = '';
      closeActionDialog();
      const run = { script: runScriptCheck, shotlist: runShotlistCheck, storyboard: runCheck }[state.view];
      if (run) await run({ silent: true });
      showToast('本地检查设置已保存。');
    } catch (error) { state.project.localCheckSettings = previous; dialog.error = String(error.message || error); }
    finally { dialog.busy = ''; if (state.actionDialog === dialog) renderActionDialog(); }
  } else if (action === 'ux-backup-choose') {
    const directory = await window.directorApi.chooseBackupDirectory();
    if (directory && state.actionDialog === dialog) { dialog.backupRoot = directory; renderActionDialog(); }
  } else if (action === 'ux-backup-default') {
    dialog.backupRoot = ''; renderActionDialog();
  } else if (action === 'ux-replace-select-all' || action === 'ux-replace-select-none') {
    dialog.selectedPaths = new Set(action === 'ux-replace-select-all' ? dialog.preview.matches.map(item => item.path) : []);
    renderActionDialog();
  } else if (action === 'ux-replace-more') {
    dialog.visibleLimit = (dialog.visibleLimit || 80) + 80; renderActionDialog();
  } else if (action === 'ux-replace-back') {
    dialog.preview = null; dialog.error = ''; dialog.progressText = ''; renderActionDialog();
  } else if (action === 'ux-backup-open') {
    try { await window.directorApi.openReplacementBackup(state.project, dialog.result.backupDirectory); }
    catch (error) { dialog.error = String(error.message || error); renderActionDialog(); }
  } else if (action === 'ux-backup-copy') {
    await window.directorApi.productionCopy(dialog.result.backupDirectory);
    window.DirectorUIMotion?.pulseDone?.(button, { label: '已复制' });
    showToast('备份路径已复制。');
  } else if (action === 'ux-replace-history') {
    dialog.result = replacementHistory()[0]; renderActionDialog();
  } else if (action === 'ux-replace-undo') {
    if (!await window.directorConfirm('恢复本次替换前的全部原文件？若文件又有新修改，将停止撤销并保留现状。', { title: '撤销这次替换', confirmLabel: '恢复原文件' })) return true;
    if (dirtyDocumentKinds().length) { showToast('当前编辑器有未保存修改，请先保存再撤销。'); return true; }
    dialog.busy = 'undo'; dialog.error = ''; renderActionDialog();
    try {
      const result = await window.directorApi.undoReplacement(state.project, dialog.result.backupDirectory);
      dialog.result = { ...dialog.result, ...result };
      await activateEpisode(state.project.currentEpisode);
      rememberReplacement(dialog.result);
      render();
    } catch (error) { dialog.error = String(error.message || error); }
    finally { dialog.busy = ''; renderActionDialog(); }
  }
  return true;
}

document.addEventListener('input', event => {
  const dialog = typeof state === 'undefined' ? null : state.actionDialog;
  if (dialog?.scope === 'global') {
    if (event.target.id === 'find-replace-find') dialog.needle = event.target.value;
    if (event.target.id === 'find-replace-replace') dialog.replacement = event.target.value;
  }
});

document.addEventListener('change', event => {
  const dialog = typeof state === 'undefined' ? null : state.actionDialog, target = event.target;
  if (!dialog || dialog.busy) return;
  if (target.dataset.localCheck) {
    const keys = target.dataset.localCheck.split('.');
    if (keys.length === 1) dialog.draft[keys[0]] = target.checked;
    else dialog.draft[keys[0]][keys[1]] = target.checked;
  }
  if (target.dataset.replaceScope) {
    const selected = new Set(dialog.scopes);
    target.checked ? selected.add(target.dataset.replaceScope) : selected.delete(target.dataset.replaceScope);
    dialog.scopes = [...selected]; renderActionDialog();
  }
  if (target.dataset.replaceExtension) {
    const selected = new Set(dialog.extensions);
    const extensions = target.dataset.replaceExtension === '.md' ? ['.md', '.markdown'] : [target.dataset.replaceExtension];
    for (const extension of extensions) target.checked ? selected.add(extension) : selected.delete(extension);
    dialog.extensions = [...selected]; renderActionDialog();
  }
  if (target.dataset.replaceFile !== undefined) {
    const item = dialog.preview.matches[Number(target.dataset.replaceFile)];
    target.checked ? dialog.selectedPaths.add(item.path) : dialog.selectedPaths.delete(item.path);
    document.querySelector('#replace-selected-files').textContent = dialog.selectedPaths.size;
    document.querySelector('#replace-selected-count').textContent = selectedReplacementCount(dialog);
    const button = document.querySelector('[data-action="confirm-action-dialog"]');
    button.textContent = `确认替换 ${selectedReplacementCount(dialog)} 处`;
    button.disabled = !dialog.preview.complete || !dialog.selectedPaths.size;
  }
});
