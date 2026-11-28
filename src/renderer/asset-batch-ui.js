(function () {
  'use strict';

  const statusLabels = {
    queued: '排队中', submitting: '提交中', pending: '等待结果', staged: '待验收',
    published: '已发布', deferred: '已延后', uncertain: '提交不明', needs_review: '待人工处理',
    stale_parent: '母板已变化'
  };
  const categoryLabels = { character: '人物', scene: '场景', prop: '道具' };
  const phaseLabels = {
    'read-only-started': '以只读模式读取剧本与规范',
    'read-only-finished': '标准只读读取结束',
    'compatibility-warning': '切换到备用只读入口',
    'compatibility-read-only-started': '备用只读入口分析中',
    'compatibility-read-only-finished': '备用只读入口完成',
    'event': '正在分析剧本与生成结构化队列'
  };
  const escape = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const input = value => escape(value || '');
  const modelForProvider = (provider, current) => provider?.models?.includes(current) ? current : provider?.models?.[0] || '';
  const providerForModel = (providers, model) => providers.find(provider => provider.models?.includes(model))?.id || '';
  const pathKey = value => String(value || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const sanitizeSegment = value => String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '·').replace(/[. ]+$/, '').trim();
  const isAttentionState = state => ['deferred', 'uncertain', 'needs_review', 'stale_parent'].includes(state);
  const isRunningState = state => ['submitting', 'pending'].includes(state);

  function createAssetBatchUI({ project, episode, promptLibrary, api, canEdit, toast, render: rerender, onPublished }) {
    const ui = {
      projectKey: '',
      providers: [], batches: [], selectedId: '', status: null, loading: false, busy: false,
      loadedKey: '', previews: new Map(), previewLoading: new Set(), previewFailed: new Set(),
      inspectFull: null,
      archiveInfo: null,
      draft: { providerId: 'magpie', model: 'codex/gpt-image-2', customModel: '', concurrency: 3, batchName: '', queue: null, queueText: '', sourceDir: '' },
      queueSource: '', error: '',
      codex: { running: false, phase: '', detail: '', warning: '', runId: '', threadIds: [] },
      magpieStatus: null,
      filters: { category: 'all', state: 'all' },
      selectedJobs: new Set(),
      staleNotice: null,
      modal: null, // { type: 'inspect' | 'retry' | 'settings', ... }
      settingsDraft: null,
      codexDiscovery: null
    };

    function resetProjectState(nextKey) {
      ui.projectKey = nextKey;
      ui.batches = [];
      ui.selectedId = '';
      ui.status = null;
      ui.archiveInfo = null;
      ui.loadedKey = '';
      ui.previews.clear();
      ui.previewLoading.clear();
      ui.previewFailed.clear();
      ui.inspectFull = null;
      ui.draft.batchName = '';
      ui.draft.queue = null;
      ui.draft.queueText = '';
      ui.draft.sourceDir = '';
      ui.queueSource = '';
      ui.error = '';
      ui.codex = { running: false, phase: '', detail: '', warning: '', runId: '', threadIds: [] };
      ui.filters = { category: 'all', state: 'all' };
      ui.selectedJobs.clear();
      ui.staleNotice = null;
      if (ui.modal?.type !== 'settings') ui.modal = null;
    }

    if (api.onCodexQueueEvent) api.onCodexQueueEvent(payload => {
      if (!ui.codex.running && (!payload?.runId || payload.runId !== ui.codex.runId)) return;
      if (payload?.runId && ui.codex.runId && payload.runId !== ui.codex.runId) return;
      if (payload?.runId) ui.codex.runId = payload.runId;
      if (payload?.phase === 'compatibility-warning') ui.codex.warning = payload.message || '';
      if (payload?.phase === 'ai-started' || payload?.phase === 'ai-progress' || payload?.phase === 'ai-finished' || payload?.phase === 'magpie-detect') {
        ui.codex.detail = payload.detail || payload.message || phaseLabels[payload.phase] || payload.phase;
      } else if (payload?.phase === 'event') {
        const ev = payload.event || {};
        if (ev.type === 'thread.started' && ev.thread_id) {
          ui.codex.threadIds = [...new Set([...ui.codex.threadIds, ev.thread_id])];
          ui.codex.detail = `已建立只读会话 ${ev.thread_id.slice(0, 8)}…`;
        } else if (ev.type === 'turn.started') {
          ui.codex.detail = '正在逐场提取人物、场景与道具…';
        } else if (ev.type === 'item.completed' && ev.item?.type === 'reasoning') {
          ui.codex.detail = '已完成剧场推理，正在生成结构化 JSON 队列…';
        } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
          ui.codex.detail = '已收到结构化队列，正在校验格式…';
        }
      } else if (payload?.phase) {
        ui.codex.detail = phaseLabels[payload.phase] || payload.phase;
      }
      ui.codex.phase = payload?.phase || ui.codex.phase;
      rerender();
    });

    if (api.onAssetBatchEvent) api.onAssetBatchEvent(payload => {
      const p = currentProject();
      if (!p || !payload?.batchId || pathKey(payload.projectPath) !== pathKey(p.projectPath)) return;
      const snapshot = {
        id: payload.batchId,
        requested_model: payload.requested_model,
        provider_id: payload.provider_id || '',
        paused: payload.paused,
        pause_reason: payload.pause_reason,
        jobs: payload.jobs || [],
        cards: payload.cards || []
      };
      const idx = ui.batches.findIndex(b => b.id === payload.batchId);
      if (idx >= 0) ui.batches[idx] = snapshot;
      if (ui.selectedId === payload.batchId) {
        ui.status = snapshot;
        void loadPreviews();
      }
      rerender();
    });

    function currentProject() { return project(); }
    function editable() { return typeof canEdit === 'function' ? Boolean(canEdit()) : true; }
    function selectedBatch() { return ui.status?.id === ui.selectedId ? ui.status : (ui.batches.find(batch => batch.id === ui.selectedId) || ui.status); }
    function effectiveModel() {
      const custom = String(ui.draft.customModel || '').trim();
      return custom || ui.draft.model || 'codex/gpt-image-2';
    }
    function configuredProvider() {
      return ui.providers.find(provider => provider.id === ui.draft.providerId && provider.configured !== false)
        || ui.providers.find(provider => provider.configured !== false) || ui.providers[0];
    }
    function previewKey(batchId, card) {
      return `${batchId}|${card.id}|${card.sha256 || ''}`;
    }
    function setPreview(key, dataUrl) {
      ui.previews.delete(key);
      ui.previews.set(key, dataUrl);
      while (ui.previews.size > 36) ui.previews.delete(ui.previews.keys().next().value);
    }
    async function loadInspectFull(batchId, jobId) {
      const p = currentProject(), batch = selectedBatch();
      const card = batch?.cards?.find(c => c.id === jobId);
      if (!p || !batch || batch.id !== batchId || !card?.stage_path) return;
      const key = previewKey(batch.id, card);
      if (ui.inspectFull?.key === key) return;
      try {
        const result = await api.assetBatchPreview(p, batch.id, jobId);
        if (result?.dataUrl && ui.modal?.type === 'inspect' && ui.modal.batchId === batchId && ui.modal.jobId === jobId) {
          ui.inspectFull = { key, dataUrl: result.dataUrl };
          rerender();
        }
      } catch { /* Thumbnail fallback remains visible if full read fails. */ }
    }
    function setDraftQueue(queue, source) {
      ui.draft.queue = queue;
      ui.draft.queueText = JSON.stringify(queue || {}, null, 2);
      ui.queueSource = source || '';
      ui.error = '';
    }
    function safeId(value, fallback) {
      const id = String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 90);
      return id || fallback;
    }
    function queueFromLibrary() {
      const library = promptLibrary();
      const currentEpisode = Number(episode());
      if (!library || !currentEpisode) throw Error('当前集资产提示词还没有读取完成。');
      const jobs = [], usedIds = new Set(), usedTargets = new Set();
      for (const [category, info] of Object.entries(library.categories || {})) {
        const normalizedCategory = category === 'role' ? 'character' : category;
        if (!categoryLabels[normalizedCategory]) continue;
        for (const [index, entry] of (info.entries || []).entries()) {
          const baseId = safeId(entry.id || `${normalizedCategory}-${entry.name}`, `${normalizedCategory}-${index + 1}`);
          let id = baseId, suffix = 2;
          while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
          usedIds.add(id);
          const variant = sanitizeSegment(entry.variant || '');
          const baseName = sanitizeSegment(entry.name || id) || id;
          let name = baseName;
          let targetSuffix = 2;
          let targetKey = `${normalizedCategory}|${name}|${variant}`.toLocaleLowerCase();
          while (usedTargets.has(targetKey)) {
            name = `${baseName}（版本${targetSuffix++}）`;
            targetKey = `${normalizedCategory}|${name}|${variant}`.toLocaleLowerCase();
          }
          usedTargets.add(targetKey);
          jobs.push({
            id, category: normalizedCategory, name, look: variant,
            view: normalizedCategory === 'character' ? '白底三联' : normalizedCategory === 'scene' ? '正打' : '道具特写',
            episodes: [currentEpisode], source_scenes: [`${currentEpisode}-资产`],
            prompt: entry.prompt || '', background: 'opaque',
            desired_aspect_ratio: normalizedCategory === 'character' ? '9:16' : normalizedCategory === 'scene' ? '16:9' : '1:1'
          });
        }
      }
      if (!jobs.length) throw Error('当前集没有可导入的资产提示词。');
      return { schemaVersion: 1, project: currentProject()?.title || '', jobs };
    }

    function recommendSampleIds(batch) {
      const jobs = batch?.jobs || [];
      const cards = new Map((batch?.cards || []).map(c => [c.id, c]));
      const chosen = new Set();
      const charsL0 = jobs.filter(j => j.category === 'character' && !(j.references || []).length);
      for (const job of charsL0.slice(0, 2)) chosen.add(job.id);
      const charChild = jobs.find(j => j.category === 'character' && (j.references || []).some(ref => chosen.has(ref)));
      if (charChild) chosen.add(charChild.id);
      const sceneL0 = jobs.find(j => j.category === 'scene' && !(j.references || []).length);
      if (sceneL0) {
        chosen.add(sceneL0.id);
        const sceneChild = jobs.find(j => j.category === 'scene' && (j.references || []).includes(sceneL0.id));
        if (sceneChild) chosen.add(sceneChild.id);
      }
      const propL0 = jobs.find(j => j.category === 'prop' && !(j.references || []).length);
      if (propL0) chosen.add(propL0.id);
      if (!chosen.size) {
        for (const job of jobs.filter(j => cards.get(j.id)?.state !== 'published').slice(0, 6)) chosen.add(job.id);
      }
      return chosen;
    }

    function filteredCards(batch) {
      const jobs = new Map((batch?.jobs || []).map(job => [job.id, job]));
      return (batch?.cards || []).filter(card => {
        const job = jobs.get(card.id) || {};
        if (ui.filters.category !== 'all' && job.category !== ui.filters.category) return false;
        if (ui.filters.state === 'all') return true;
        if (ui.filters.state === 'attention') return isAttentionState(card.state);
        if (ui.filters.state === 'running') return isRunningState(card.state);
        if (ui.filters.state === 'staged_pending_accept') return card.state === 'staged' && !card.accepted;
        if (ui.filters.state === 'staged_accepted') return card.state === 'staged' && card.accepted;
        return card.state === ui.filters.state;
      });
    }

    async function refresh() {
      const p = currentProject();
      if (!p || ui.loading) return;
      if (ui.projectKey !== p.projectPath) resetProjectState(p.projectPath);
      const targetKey = `${p.projectPath}|${p.currentEpisode}`;
      ui.loading = true;
      try {
        const [providers, batches, archiveInfo, magpieStatus] = await Promise.all([
          api.imageProviders(),
          api.assetBatchList(p),
          api.assetArchiveInfo ? api.assetArchiveInfo(p).catch(() => null) : Promise.resolve(null),
          api.magpieDetect ? api.magpieDetect().catch(() => null) : Promise.resolve(null)
        ]);
        if (currentProject()?.projectPath !== p.projectPath) return;
        ui.providers = Array.isArray(providers) ? providers : [];
        ui.batches = Array.isArray(batches) ? batches : [];
        ui.archiveInfo = archiveInfo;
        if (magpieStatus) ui.magpieStatus = magpieStatus;
        const provider = configuredProvider();
        if (provider) {
          ui.draft.providerId = provider.id;
          ui.draft.model = modelForProvider(provider, ui.draft.model);
        }
        if (!ui.selectedId || !ui.batches.some(batch => batch.id === ui.selectedId)) {
          ui.selectedId = ui.batches[0]?.id || '';
          ui.selectedJobs.clear();
        }
        if (ui.selectedId) {
          try {
            const detailed = await api.assetBatchStatus(p, ui.selectedId);
            ui.status = { id: ui.selectedId, ...detailed };
            const idx = ui.batches.findIndex(b => b.id === ui.selectedId);
            if (idx >= 0) ui.batches[idx] = ui.status;
          } catch {
            ui.status = ui.batches.find(batch => batch.id === ui.selectedId) || null;
          }
        } else {
          ui.status = null;
        }
        ui.error = '';
      } catch (error) {
        ui.error = error.message || String(error);
      } finally {
        ui.loading = false;
        if (currentProject()?.projectPath === p.projectPath) {
          ui.loadedKey = targetKey;
          rerender();
          if (ui.status) void loadPreviews();
        }
      }
    }

    async function refreshStatus() {
      const p = currentProject();
      if (!p || !ui.selectedId) return;
      try {
        const detailed = await api.assetBatchStatus(p, ui.selectedId);
        if (currentProject()?.projectPath !== p.projectPath) return;
        ui.status = { id: ui.selectedId, ...detailed };
        const index = ui.batches.findIndex(batch => batch.id === ui.selectedId);
        if (index >= 0) ui.batches[index] = ui.status;
        ui.error = '';
      } catch (error) {
        ui.error = error.message || String(error);
      }
      if (currentProject()?.projectPath === p.projectPath) {
        rerender();
        if (ui.status) void loadPreviews();
      }
    }

    async function loadPreviews(priorityJobId = '') {
      const p = currentProject(), batch = selectedBatch();
      if (!p || !batch?.cards?.length) return;
      const pendingAll = batch.cards.filter(card => {
        if (!['staged', 'published', 'stale_parent'].includes(card.state) || !card.stage_path) return false;
        const key = previewKey(batch.id, card);
        return !ui.previews.has(key) && !ui.previewLoading.has(key) && !ui.previewFailed.has(key);
      });
      if (!pendingAll.length) return;
      const visibleSet = new Set(filteredCards(batch).map(card => card.id));
      pendingAll.sort((a, b) => {
        if (priorityJobId) {
          if (a.id === priorityJobId) return -1;
          if (b.id === priorityJobId) return 1;
        }
        return Number(visibleSet.has(b.id)) - Number(visibleSet.has(a.id));
      });
      const candidates = pendingAll.slice(0, 12);
      const hasMore = pendingAll.length > candidates.length;
      let changed = false;
      await Promise.all(candidates.map(async card => {
        const key = previewKey(batch.id, card);
        ui.previewLoading.add(key);
        try {
          const result = await api.assetBatchPreview(p, batch.id, card.id, { thumbnail: true });
          if (result?.dataUrl) {
            setPreview(key, result.dataUrl);
            changed = true;
          } else {
            ui.previewFailed.add(key);
            changed = true;
          }
        } catch {
          ui.previewFailed.add(key);
          changed = true;
        } finally {
          ui.previewLoading.delete(key);
        }
      }));
      if (changed && currentProject()?.projectPath === p.projectPath) rerender();
      if (hasMore && currentProject()?.projectPath === p.projectPath && ui.selectedId === batch.id) {
        setTimeout(() => { void loadPreviews(); }, 0);
      }
    }

    function renderProviders() {
      const provider = configuredProvider();
      const providers = ui.providers.length ? ui.providers : [{ id: 'magpie', label: 'Magpie 本机入口', models: ['codex/gpt-image-2'], configured: true }];
      return providers.map(item => `<option value="${input(item.id)}" ${item.id === (provider?.id || ui.draft.providerId) ? 'selected' : ''} ${item.configured === false ? 'disabled' : ''}>${escape(item.label || item.id)}${item.configured === false ? '（未配置）' : ''}</option>`).join('');
    }
    function renderModels() {
      const provider = ui.providers.find(item => item.id === ui.draft.providerId) || configuredProvider();
      const models = provider?.models || [ui.draft.model || 'codex/gpt-image-2'];
      return models.map(model => `<option value="${input(model)}" ${model === ui.draft.model ? 'selected' : ''}>${escape(model)}</option>`).join('');
    }
    function renderBatchCard(batch) {
      const selected = batch.id === ui.selectedId;
      const cards = batch.cards || [];
      const counts = cards.reduce((map, card) => { map[card.state] = (map[card.state] || 0) + 1; return map; }, {});
      const current = selected ? ui.status || batch : batch;
      const attention = (counts.deferred || 0) + (counts.uncertain || 0) + (counts.needs_review || 0) + (counts.stale_parent || 0);
      return `<button class="asset-batch-list-row ${selected ? 'selected' : ''}" data-action="asset-batch-select" data-batch-id="${input(batch.id)}">
        <strong>${escape(batch.id)}</strong>
        <span>${batch.paused ? '已暂停' : '就绪'} · ${counts.published || 0}/${cards.length} 已发布${attention ? ` · ${attention} 项异常` : ''}</span>
        <small>${escape(current.requested_model || '')}</small>
      </button>`;
    }

    function renderCard(card, jobs, cardsById, batchId) {
      const job = jobs.get(card.id) || {};
      const key = previewKey(batchId, card);
      const preview = ui.previews.get(key);
      const previewFailed = ui.previewFailed.has(key);
      const retryable = ['uncertain', 'deferred', 'needs_review', 'stale_parent', 'staged', 'published'].includes(card.state);
      const canAdopt = !['pending', 'uncertain', 'submitting'].includes(card.state) && !card.resume_poll;
      const checked = ui.selectedJobs.has(card.id);
      const refs = job.references || [];
      const depBadges = refs.map(refId => {
        const parentJob = jobs.get(refId);
        const parentCard = cardsById.get(refId);
        const ready = parentCard?.accepted && ['staged', 'published'].includes(parentCard.state);
        const stale = parentCard?.state === 'stale_parent';
        const cls = stale ? 'dep-stale' : ready ? 'dep-ready' : 'dep-wait';
        const tag = stale ? '母板已变' : ready ? '已就绪' : '待验收';
        return `<span class="asset-batch-dep ${cls}" title="引用母板 ${input(refId)}">依赖：${escape(parentJob?.name || refId)}（${tag}）</span>`;
      }).join('');
      const metaChips = [
        categoryLabels[job.category] || job.category,
        job.look,
        job.view,
        job.episodes?.length ? `第${job.episodes[0]}${job.episodes.length > 1 ? `–${job.episodes.at(-1)}` : ''}集` : ''
      ].filter(Boolean).join(' · ');
      const acceptedBadge = card.state === 'staged' && card.accepted ? '<span class="asset-batch-accepted">已验收</span>' : '';
      return `<article class="asset-batch-job ${card.state} ${checked ? 'is-checked' : ''}" data-job-card="${input(card.id)}">
        <label class="asset-batch-check" title="勾选此任务以选择性运行"><input type="checkbox" data-asset-batch-check="${input(card.id)}" ${checked ? 'checked' : ''} /></label>
        <button type="button" class="asset-batch-job-preview" data-action="asset-batch-inspect" data-batch-id="${input(batchId)}" data-job-id="${input(card.id)}" title="点击放大目检细节与完整提示词">
          ${preview ? `<img src="${preview}" alt="${input(job.name || card.id)}" />` : `<span>${card.stage_path ? (previewFailed ? '预览失败' : '加载中') : '待出图'}</span>`}
        </button>
        <div class="asset-batch-job-main">
          <div class="asset-batch-job-head">
            <strong title="${input(job.name || card.id)}">${escape(job.name || card.id)}</strong>
            <div class="asset-batch-status-group">${acceptedBadge}<span class="asset-batch-status ${card.state}">${statusLabels[card.state] || escape(card.state)}</span></div>
          </div>
          <p class="hint">${escape(metaChips)}${job.relative_path ? ` · ${escape(job.relative_path)}` : ''}</p>
          ${depBadges ? `<div class="asset-batch-deps">${depBadges}</div>` : ''}
          <p class="asset-batch-meta">请求 ${escape(card.requested_model || '')} · 实际 ${escape(card.actual_model || '待确认')}${card.dimensions ? ` · ${card.dimensions[0]}×${card.dimensions[1]}` : ''}</p>
          ${card.reason ? `<p class="asset-batch-error">${escape(card.reason)}</p>` : ''}
          <div class="form-actions">
            <button class="button quiet small" data-action="asset-batch-inspect" data-batch-id="${input(batchId)}" data-job-id="${input(card.id)}">目检</button>
            <button class="button quiet small" data-action="asset-batch-accept" data-batch-id="${input(batchId)}" data-job-id="${input(card.id)}" ${editable() && card.state === 'staged' && !card.accepted ? '' : 'disabled'}>验收</button>
            <button class="button quiet small" data-action="asset-batch-adopt" data-batch-id="${input(batchId)}" data-job-id="${input(card.id)}" ${editable() && canAdopt && !ui.busy ? '' : 'disabled'}>导入本地图</button>
            <button class="button quiet small" data-action="asset-batch-retry" data-batch-id="${input(batchId)}" data-job-id="${input(card.id)}" ${editable() && retryable && !ui.busy ? '' : 'disabled'}>${card.state === 'uncertain' ? '解锁重提' : '改词/重试'}</button>
            <button class="button quiet small" data-action="asset-batch-publish" data-batch-id="${input(batchId)}" data-job-id="${input(card.id)}" ${editable() && card.accepted && ['staged', 'published'].includes(card.state) && !ui.busy ? '' : 'disabled'}>发布</button>
          </div>
        </div>
      </article>`;
    }

    function renderStatus() {
      const batch = selectedBatch();
      if (!batch) return '<div class="asset-batch-status-panel"><p class="hint">还没有创建批次。点上方「① Magpie / AI 自动生成本集队列并建批」或「② 从自动制作 / 本集提示词一键建批」即可直接开始出图；也可展开「高级入口」导入外部 JSON。</p></div>';
      if (batch.error) return `<div class="asset-batch-status-panel"><p class="notice">批次 ${escape(batch.id)} 读取失败：${escape(batch.error)}</p></div>`;
      const jobs = new Map((batch.jobs || []).map(job => [job.id, job]));
      const cards = batch.cards || [];
      const cardsById = new Map(cards.map(c => [c.id, c]));
      const counts = cards.reduce((acc, c) => {
        const cat = jobs.get(c.id)?.category || 'other';
        acc.cat[cat] = (acc.cat[cat] || 0) + 1;
        acc.state[c.state] = (acc.state[c.state] || 0) + 1;
        if (isAttentionState(c.state)) acc.attention++;
        if (isRunningState(c.state)) acc.running++;
        if (c.state === 'staged' && !c.accepted) acc.unaccepted++;
        if (c.accepted && ['staged', 'published'].includes(c.state)) acc.publishable++;
        return acc;
      }, { cat: {}, state: {}, attention: 0, running: 0, unaccepted: 0, publishable: 0 });
      const canRun = cards.some(card => ['queued', 'pending'].includes(card.state));
      const selectedValid = [...ui.selectedJobs].filter(id => cardsById.has(id));
      const deferredCount = counts.state.deferred || 0;
      const visible = filteredCards(batch);
      const l0Cards = visible.filter(c => !(jobs.get(c.id)?.references || []).length);
      const l1Cards = visible.filter(c => (jobs.get(c.id)?.references || []).length > 0);

      const catPills = [
        ['all', '全部分类', cards.length],
        ['character', '人物', counts.cat.character || 0],
        ['scene', '场景', counts.cat.scene || 0],
        ['prop', '道具', counts.cat.prop || 0]
      ].map(([key, label, count]) => `<button class="asset-batch-pill ${ui.filters.category === key ? 'active' : ''}" data-action="asset-batch-filter-cat" data-filter-value="${key}">${label}<span>${count}</span></button>`).join('');

      const statePills = [
        ['all', '全部状态', cards.length],
        ['queued', '排队中', counts.state.queued || 0],
        ['running', '运行中', counts.running],
        ['staged_pending_accept', '待验收', counts.unaccepted],
        ['published', '已发布', counts.state.published || 0],
        ['stale_parent', '母板已变', counts.state.stale_parent || 0],
        ['attention', '异常/待处理', counts.attention]
      ].map(([key, label, count]) => `<button class="asset-batch-pill ${ui.filters.state === key ? 'active' : ''}" data-action="asset-batch-filter-state" data-filter-value="${key}">${label}<span>${count}</span></button>`).join('');

      const staleBanner = ui.staleNotice && ui.staleNotice.batchId === batch.id
        ? `<div class="notice asset-batch-stale-banner">母板更新影响了 ${ui.staleNotice.ids.length} 张下游派生图（${escape(ui.staleNotice.names.join('、'))}），已自动标记为「母板已变化」。<button class="button quiet small" data-action="asset-batch-filter-state" data-filter-value="stale_parent">只看受影响图</button></div>`
        : '';

      const layerHtml = (title, note, list) => !list.length ? '' : `<div class="asset-batch-layer">
        <div class="asset-batch-layer-head"><strong>${title}</strong><span>${list.length} 项 · ${note}</span></div>
        <div class="asset-batch-jobs">${list.map(card => renderCard(card, jobs, cardsById, batch.id)).join('')}</div>
      </div>`;

      const totalCards = cards.length;
      const publishedCount = counts.state.published || 0;
      const stagedAcceptedCount = cards.filter(c => c.state === 'staged' && c.accepted).length;
      const stagedUnacceptedCount = counts.unaccepted || 0;
      const runningCount = counts.running || 0;
      const attentionCount = counts.attention || 0;
      const pct = (n) => totalCards ? Math.round((n / totalCards) * 1000) / 10 : 0;
      const donePercent = totalCards ? Math.round((publishedCount / totalCards) * 100) : 0;
      const progressBar = totalCards ? `<div class="asset-batch-progress" aria-label="批次完成进度 ${donePercent}%">
        <div class="asset-batch-progress-track">
          ${publishedCount ? `<span class="asset-batch-progress-seg is-published" style="width:${pct(publishedCount)}%" title="已发布 ${publishedCount}"></span>` : ''}
          ${stagedAcceptedCount ? `<span class="asset-batch-progress-seg is-accepted" style="width:${pct(stagedAcceptedCount)}%" title="已验收待发布 ${stagedAcceptedCount}"></span>` : ''}
          ${stagedUnacceptedCount ? `<span class="asset-batch-progress-seg is-staged" style="width:${pct(stagedUnacceptedCount)}%" title="已暂存待验收 ${stagedUnacceptedCount}"></span>` : ''}
          ${runningCount ? `<span class="asset-batch-progress-seg is-running" style="width:${pct(runningCount)}%" title="运行中 ${runningCount}"></span>` : ''}
          ${attentionCount ? `<span class="asset-batch-progress-seg is-attention" style="width:${pct(attentionCount)}%" title="异常/待处理 ${attentionCount}"></span>` : ''}
        </div>
        <div class="asset-batch-progress-meta">
          <strong>${donePercent}%</strong>
          <span>已发布 ${publishedCount}</span>
          ${stagedAcceptedCount ? `<span>已验收待发 ${stagedAcceptedCount}</span>` : ''}
          ${stagedUnacceptedCount ? `<span>待验收 ${stagedUnacceptedCount}</span>` : ''}
          ${runningCount ? `<span>运行中 ${runningCount}</span>` : ''}
          ${attentionCount ? `<span class="is-warn">异常 ${attentionCount}</span>` : ''}
        </div>
      </div>` : '';

      return `<div class="asset-batch-status-panel">
        <div class="asset-batch-status-head">
          <div>
            <strong>批次 ${escape(batch.id)}</strong>
            <span>锁定模型：<code>${escape(batch.requested_model || '')}</code> · ${batch.paused ? `已暂停（${escape(batch.pause_reason || '人工暂停')}）` : '可继续运行'} · 已发布 ${publishedCount}/${totalCards}</span>
          </div>
          <div class="form-actions">
            <button class="button small" data-action="asset-batch-run-selected" data-batch-id="${input(batch.id)}" ${editable() && selectedValid.length && !ui.busy ? '' : 'disabled'}>运行选中项 (${selectedValid.length})</button>
            <button class="button secondary small" data-action="asset-batch-run" data-batch-id="${input(batch.id)}" ${editable() && canRun && !ui.busy ? '' : 'disabled'}>${ui.busy ? '运行中…' : batch.paused ? '按就绪度续跑' : '运行全部就绪'}</button>
            <button class="button quiet small" data-action="asset-batch-pause" data-batch-id="${input(batch.id)}" ${editable() && ui.busy ? '' : 'disabled'}>暂停</button>
            ${deferredCount ? `<button class="button quiet small" data-action="asset-batch-retry-deferred" data-batch-id="${input(batch.id)}" ${editable() && !ui.busy ? '' : 'disabled'}>重试延期项 (${deferredCount})</button>` : ''}
            ${counts.unaccepted ? `<button class="button quiet small" data-action="asset-batch-accept-all" data-batch-id="${input(batch.id)}" ${editable() && !ui.busy ? '' : 'disabled'}>一键验收暂存 (${counts.unaccepted})</button>` : ''}
            <button class="button quiet small" data-action="asset-batch-publish-all" data-batch-id="${input(batch.id)}" ${editable() && counts.publishable && !ui.busy ? '' : 'disabled'}>发布已验收 (${counts.publishable})</button>
          </div>
        </div>
        ${progressBar}
        ${staleBanner}
        <div class="asset-batch-filterbar">
          <div class="asset-batch-pills">${catPills}</div>
          <div class="asset-batch-pills">${statePills}</div>
          <div class="asset-batch-select-tools">
            <button class="button quiet small" data-action="asset-batch-select-samples" data-batch-id="${input(batch.id)}">勾选推荐样图包</button>
            <button class="button quiet small" data-action="asset-batch-select-l0" data-batch-id="${input(batch.id)}">勾选未完成 L0</button>
            <button class="button quiet small" data-action="asset-batch-select-visible" data-batch-id="${input(batch.id)}">全选当前</button>
            <button class="button quiet small" data-action="asset-batch-select-clear">清空</button>
          </div>
        </div>
        ${visible.length
          ? `${layerHtml('L0 独立母板', '无前置依赖，优先样图目检验收', l0Cards)}${layerHtml('L1+ 派生图', '母板验收通过后自动解锁并带参考图提交', l1Cards)}`
          : '<p class="hint">当前筛选条件下没有匹配的任务。</p>'}
      </div>`;
    }

    function renderWorkbench() {
      const p = currentProject();
      if (!p) return '';
      if (ui.projectKey && ui.projectKey !== p.projectPath) resetProjectState(p.projectPath);
      const queue = ui.draft.queue;
      const hasQueueText = Boolean(ui.draft.queueText.trim());
      const codexRunningText = ui.codex.detail || phaseLabels[ui.codex.phase] || '正在分析当前集剧本…';
      const codexStatus = ui.codex.running
        ? `<div class="asset-batch-codex-bar is-running"><span>自动提取队列：${escape(codexRunningText)}${ui.codex.threadIds.length ? ` · 会话 ${escape(ui.codex.threadIds.at(-1).slice(0, 8))}` : ''}</span><button class="button quiet small" data-action="asset-batch-codex-cancel">取消任务</button></div>`
        : ui.codex.warning ? `<p class="notice asset-batch-codex-status">${escape(ui.codex.warning)}</p>` : '';
      const archiveDesc = ui.archiveInfo?.boundRoot
        ? `当前发布与读取目录（已绑定本机图库）：<code>${escape(ui.archiveInfo.boundRoot)}</code>`
        : `当前发布目录（项目默认）：<code>${escape(ui.archiveInfo?.outputRoot || '06 资产/images')}</code>`;
      const magpieBadge = ui.magpieStatus
        ? (ui.magpieStatus.online
          ? `<span class="badge pass" title="网关地址 ${input(ui.magpieStatus.baseUrl)} · 可用文本模型 ${ui.magpieStatus.textModels?.length || 0} 个">Magpie 在线 · ${escape(ui.magpieStatus.recommendedModel || 'Codex 通道就绪')}</span>`
          : `<span class="badge warn" title="${input(ui.magpieStatus.error || '本机网关未运行')}">Magpie 离线（可使用项目 API 或本机 Codex）</span>`)
        : '';
      const activeBatch = selectedBatch();
      const step1Done = Boolean(activeBatch || ui.batches.length);
      const step2Done = Boolean(activeBatch?.cards?.some(c => c.accepted || c.state === 'published'));
      const step3Done = Boolean(activeBatch?.cards?.length && activeBatch.cards.every(c => c.state === 'published'));
      return `<section class="asset-batch-workbench card">
        <div class="asset-batch-heading">
          <div>
            <div class="eyebrow">ASSET BATCH · 批量生图工作台</div>
            <h2>全自动资产提取与分层批量生图</h2>
            <p>无需手写 JSON：直接由本机 Magpie（直连 Codex / 路由组）、项目 API 或「自动制作」资产库自动生成分层生图队列，按 L0 母板 → L1 换装/四视图顺序出图并一键白底归档。</p>
          </div>
          <div class="asset-batch-head-actions">
            ${magpieBadge}
            <span class="badge">${ui.loading ? '读取中' : `${ui.batches.length} 个批次`}</span>
            <button class="button quiet small" data-action="asset-batch-open-settings">图像入口与 Magpie / Codex 设置</button>
          </div>
        </div>
        <ol class="asset-batch-pipeline-steps" aria-label="生图三步流程">
          <li class="${step1Done ? 'is-done' : 'is-current'}"><span>1</span><div><strong>自动准备资产队列</strong><small>Magpie / AI 读剧本或直接承接「自动制作」资产库</small></div></li>
          <li class="${step2Done ? 'is-done' : step1Done ? 'is-current' : ''}"><span>2</span><div><strong>分层生图与目检</strong><small>先出 L0 母板验收，再自动带母板参考出 L1 派生图</small></div></li>
          <li class="${step3Done ? 'is-done' : step2Done ? 'is-current' : ''}"><span>3</span><div><strong>一键白底校验归档</strong><small>自动转纯白底、SHA-256 核验并回显到本集素材页</small></div></li>
        </ol>
        <div class="asset-batch-archive-bar">
          <span class="asset-batch-archive-path">${archiveDesc}</span>
          <div class="form-actions">
            <button class="button quiet small" data-action="bind-archive-root" ${editable() ? '' : 'disabled'}>重绑归档目录</button>
            ${ui.archiveInfo?.boundRoot ? `<button class="button quiet small" data-action="asset-batch-unbind-root" ${editable() ? '' : 'disabled'}>恢复项目默认</button>` : ''}
            <button class="button quiet small" data-action="asset-batch-detect-magpie">检测 Magpie</button>
          </div>
        </div>
        <div class="asset-batch-controls">
          <label>图像入口<select data-asset-batch-field="provider">${renderProviders()}</select></label>
          <label>图像模型<select data-asset-batch-field="model">${renderModels()}</select></label>
          <label>自定义模型 ID（可选覆盖）<input data-asset-batch-field="customModel" type="text" value="${input(ui.draft.customModel)}" placeholder="留空使用左侧所选模型" /></label>
          <label>并发数<input data-asset-batch-field="concurrency" type="number" min="1" max="32" value="${input(ui.draft.concurrency)}" /></label>
          <label>批次名称（可选）<input data-asset-batch-field="batchName" type="text" value="${input(ui.draft.batchName)}" placeholder="如 第${episode()}集-首轮样图" /></label>
        </div>
        <div class="form-actions asset-batch-toolbar">
          <button class="button small" data-action="asset-batch-ai-auto" ${editable() && !ui.busy && !ui.codex.running ? '' : 'disabled'}>${ui.codex.running ? '正在生成队列…' : '① Magpie / AI 自动生成本集队列并建批'}</button>
          <button class="button secondary small" data-action="asset-batch-from-automation" ${editable() && !ui.busy && !ui.codex.running ? '' : 'disabled'}>② 从自动制作 / 本集提示词一键建批</button>
          <button class="button quiet small" data-action="asset-batch-codex-prepare" ${editable() && !ui.busy && !ui.codex.running ? '' : 'disabled'}>用本机 Codex CLI 准备</button>
          <button class="button quiet small" data-action="asset-batch-refresh">刷新批次</button>
        </div>
        ${codexStatus}
        ${ui.error ? `<p class="notice">${escape(ui.error)}</p>` : ''}
        <details class="asset-batch-queue-editor" ${queue && !ui.batches.length ? 'open' : ''}>
          <summary>高级入口：导入外部队列 JSON / 手动编辑原始队列${queue ? `（当前草稿 ${queue.jobs?.length || 0} 项 · ${escape(ui.queueSource || '已就绪')}）` : ''}</summary>
          <div class="form-actions" style="margin:8px 0">
            <button class="button secondary small" data-action="asset-batch-import-queue" ${editable() ? '' : 'disabled'}>导入外部队列 JSON</button>
            <button class="button secondary small" data-action="asset-batch-from-library" ${editable() ? '' : 'disabled'}>仅加载本集提示词到草稿</button>
            <button class="button small" data-action="asset-batch-create" ${editable() && hasQueueText && !ui.busy && !ui.codex.running ? '' : 'disabled'}>从下方草稿创建批次</button>
          </div>
          <textarea data-asset-batch-field="queueText" rows="7" placeholder="正常使用无需手写 JSON；点上方「① Magpie / AI 自动生成并建批」或「② 从自动制作/提示词一键建批」即可自动完成。">${escape(ui.draft.queueText)}</textarea>
        </details>
        <div class="asset-batch-layout">
          <aside class="asset-batch-list">
            <div class="card-title"><h3>已保存批次</h3><span>${ui.batches.length}</span></div>
            ${ui.batches.length ? ui.batches.map(renderBatchCard).join('') : '<p class="hint">点上方「① Magpie / AI 自动生成本集队列并建批」即可开始。</p>'}
          </aside>
          ${renderStatus()}
        </div>
      </section>`;
    }

    function renderInspectModal(modal) {
      const batch = selectedBatch();
      if (!batch || batch.id !== modal.batchId) return '';
      const jobs = new Map((batch.jobs || []).map(j => [j.id, j]));
      const cardsById = new Map((batch.cards || []).map(c => [c.id, c]));
      const card = cardsById.get(modal.jobId);
      const job = jobs.get(modal.jobId);
      if (!card || !job) return '';
      const inspectKey = previewKey(batch.id, card);
      const preview = (ui.inspectFull?.key === inspectKey ? ui.inspectFull.dataUrl : '') || ui.previews.get(inspectKey);
      const previewFailed = ui.previewFailed.has(inspectKey);
      const canAdopt = !['pending', 'uncertain', 'submitting'].includes(card.state) && !card.resume_poll;
      const list = filteredCards(batch);
      const index = list.findIndex(c => c.id === card.id);
      const zoom = modal.zoom || 'fit';
      const bg = modal.bg || 'white';
      const promptValue = modal.promptDraft ?? card.prompt_override ?? job.prompt ?? '';
      const reasonValue = modal.reasonDraft ?? (card.state === 'uncertain' ? '' : '已核对画面，调整后重新生成');
      const retryable = ['uncertain', 'deferred', 'needs_review', 'stale_parent', 'staged', 'published'].includes(card.state);
      const refs = (job.references || []).map(refId => {
        const pJob = jobs.get(refId), pCard = cardsById.get(refId);
        const usedHash = card.parent_hashes?.[refId] || '';
        const match = !usedHash || (pCard?.sha256 && usedHash === pCard.sha256);
        return `<li><strong>${escape(pJob?.name || refId)}</strong>（${escape(refId)}）· 状态：${escape(statusLabels[pCard?.state] || pCard?.state || '未知')}${usedHash ? ` · 指纹${match ? '一致' : '已变化'}` : ''}</li>`;
      }).join('');
      return `<div class="modal-overlay" data-action="asset-batch-modal-backdrop"><div class="modal asset-batch-modal asset-batch-inspect-modal">
        <div class="modal-head">
          <div>
            <h2>目检 · ${escape(job.name || card.id)}</h2>
            <p class="hint">${escape(categoryLabels[job.category] || job.category)} · ${escape([job.look, job.view].filter(Boolean).join(' / ') || '标准')} · 状态：${escape(statusLabels[card.state] || card.state)}${card.accepted ? '（已验收）' : ''}</p>
          </div>
          <div class="form-actions">
            <button class="button quiet small" data-action="asset-batch-inspect-nav" data-dir="-1" ${index > 0 ? '' : 'disabled'}>上一张</button>
            <button class="button quiet small" data-action="asset-batch-inspect-nav" data-dir="1" ${index >= 0 && index < list.length - 1 ? '' : 'disabled'}>下一张</button>
            <button class="modal-close" data-action="asset-batch-close-modal" aria-label="关闭对话框">×</button>
          </div>
        </div>
        <div class="asset-batch-inspect-body">
          <div class="asset-batch-inspect-viewer">
            <div class="asset-batch-inspect-tools">
              <div class="asset-batch-pills">
                <button class="asset-batch-pill ${zoom === 'fit' ? 'active' : ''}" data-action="asset-batch-inspect-zoom" data-value="fit">适应窗口</button>
                <button class="asset-batch-pill ${zoom === '100' ? 'active' : ''}" data-action="asset-batch-inspect-zoom" data-value="100">100% 原大</button>
                <button class="asset-batch-pill ${zoom === '150' ? 'active' : ''}" data-action="asset-batch-inspect-zoom" data-value="150">150% 细节</button>
              </div>
              <div class="asset-batch-pills">
                <button class="asset-batch-pill ${bg === 'white' ? 'active' : ''}" data-action="asset-batch-inspect-bg" data-value="white">纯白底</button>
                <button class="asset-batch-pill ${bg === 'dark' ? 'active' : ''}" data-action="asset-batch-inspect-bg" data-value="dark">深灰底</button>
                <button class="asset-batch-pill ${bg === 'checker' ? 'active' : ''}" data-action="asset-batch-inspect-bg" data-value="checker">棋盘格</button>
              </div>
            </div>
            <div class="asset-batch-stage bg-${bg} zoom-${zoom}">
              ${preview ? `<img src="${preview}" alt="${input(job.name || card.id)}" />` : card.stage_path ? `<p class="hint">${previewFailed ? '暂存图片读取失败，请检查文件或重新生成。' : '正在加载暂存图片预览…'}</p>` : '<p class="hint">当前任务尚无暂存图片，可先运行批次或导入本地图片。</p>'}
            </div>
          </div>
          <div class="asset-batch-inspect-side">
            <dl class="asset-batch-meta-grid">
              <dt>任务 ID</dt><dd><code>${escape(job.id)}</code></dd>
              <dt>适用集数 / 分场</dt><dd>第 ${escape((job.episodes || []).join('、'))} 集 · ${escape((job.source_scenes || []).join('、') || '未标注')}</dd>
              <dt>归档路径</dt><dd><code>${escape(job.relative_path || '')}</code></dd>
              <dt>请求 / 实际模型</dt><dd>${escape(card.requested_model || batch.requested_model || '')} / <strong>${escape(card.actual_model || '待确认')}</strong></dd>
              <dt>尺寸与指纹</dt><dd>${card.dimensions ? `${card.dimensions[0]}×${card.dimensions[1]}` : '待生成'}${card.sha256 ? ` · <code>${escape(card.sha256.slice(0, 12))}</code>` : ''}</dd>
            </dl>
            ${refs ? `<div class="asset-batch-inspect-section"><h4>引用母板</h4><ul>${refs}</ul></div>` : ''}
            ${card.reason ? `<p class="asset-batch-error">当前状态说明：${escape(card.reason)}</p>` : ''}
            <div class="asset-batch-inspect-section">
              <label>完整提示词（改词后点击「改词重跑」生效）
                <textarea id="asset-batch-modal-prompt" data-asset-batch-modal-field="promptDraft" rows="6">${escape(promptValue)}</textarea>
              </label>
            </div>
            ${retryable ? `<div class="asset-batch-inspect-section">
              <label>${card.state === 'uncertain' ? '人工核对结论（解锁提交不明任务必填）' : '重试原因 / 备注'}
                <input id="asset-batch-modal-reason" data-asset-batch-modal-field="reasonDraft" type="text" value="${input(reasonValue)}" placeholder="${card.state === 'uncertain' ? '例如：已核对供应端记录，确认无重复生图任务' : '可选说明重试原因'}" />
              </label>
            </div>` : ''}
            <div class="form-actions asset-batch-inspect-actions">
              <button class="button small" data-action="asset-batch-accept" data-batch-id="${input(batch.id)}" data-job-id="${input(card.id)}" ${editable() && card.state === 'staged' && !card.accepted ? '' : 'disabled'}>验收通过</button>
              <button class="button secondary small" data-action="asset-batch-publish" data-batch-id="${input(batch.id)}" data-job-id="${input(card.id)}" ${editable() && card.accepted && ['staged', 'published'].includes(card.state) && !ui.busy ? '' : 'disabled'}>发布归档</button>
              <button class="button secondary small" data-action="asset-batch-adopt" data-batch-id="${input(batch.id)}" data-job-id="${input(card.id)}" ${editable() && canAdopt && !ui.busy ? '' : 'disabled'}>导入本地图</button>
              <button class="button quiet small" data-action="asset-batch-modal-confirm-retry" data-batch-id="${input(batch.id)}" data-job-id="${input(card.id)}" ${editable() && retryable && !ui.busy ? '' : 'disabled'}>${card.state === 'uncertain' ? '解锁并重提' : '保存改词并重新排队'}</button>
            </div>
          </div>
        </div>
      </div></div>`;
    }

    function renderRetryModal(modal) {
      const batch = selectedBatch();
      const job = batch?.jobs?.find(j => j.id === modal.jobId);
      const card = batch?.cards?.find(c => c.id === modal.jobId);
      if (!batch || !job || !card) return '';
      const isUncertain = card.state === 'uncertain';
      return `<div class="modal-overlay" data-action="asset-batch-modal-backdrop"><div class="modal asset-batch-modal asset-batch-retry-modal">
        <div class="modal-head">
          <h2>${isUncertain ? '解锁提交不明任务' : '改词 / 重新排队'} · ${escape(job.name || card.id)}</h2>
          <button class="modal-close" data-action="asset-batch-close-modal" aria-label="关闭对话框">×</button>
        </div>
        <p class="hint">${isUncertain ? '上次提交状态不明，为避免重复扣费，请先到供应端确认无重复任务后填写核对结论。' : '可保留原提示词或直接微调提示词，确认后任务将回到「排队中」等待下次运行。'}</p>
        <div class="field"><label>${isUncertain ? '人工核对结论（必填）' : '重试原因'}</label>
          <input id="asset-batch-modal-reason" data-asset-batch-modal-field="reasonDraft" type="text" value="${input(modal.reasonDraft)}" placeholder="${isUncertain ? '例如：已核对供应端日志，确认本次调用未扣费' : '例如：调整白底/侧脸比例'}" />
        </div>
        <div class="field"><label>提示词（可选修改）</label>
          <textarea id="asset-batch-modal-prompt" data-asset-batch-modal-field="promptDraft" rows="7">${escape(modal.promptDraft)}</textarea>
        </div>
        <div class="form-actions">
          <button class="button" data-action="asset-batch-modal-confirm-retry" data-batch-id="${input(batch.id)}" data-job-id="${input(card.id)}">${isUncertain ? '确认解锁并重新排队' : '确认重新排队'}</button>
          <button class="button secondary" data-action="asset-batch-close-modal">取消</button>
        </div>
      </div></div>`;
    }

    function renderSettingsModal() {
      const draft = ui.settingsDraft || {};
      const discovery = ui.codexDiscovery;
      return `<div class="modal-overlay" data-action="asset-batch-modal-backdrop"><div class="modal asset-batch-modal asset-batch-settings-modal">
        <div class="modal-head">
          <h2>图像入口与 Codex 本机设置</h2>
          <button class="modal-close" data-action="asset-batch-close-modal" aria-label="关闭对话框">×</button>
        </div>
        <p class="hint">以下配置仅保存在本机用户目录（<code>userData</code>），绝不写入项目文件夹或共享盘，也不会随公开仓库同步。</p>
        <div class="asset-batch-settings-group">
          <h3>OpenAI 兼容图像 API（可分发版驱动 B）</h3>
          <div class="field"><label>Base URL</label><input id="img-cfg-oa-url" data-asset-batch-settings-field="openaiBaseUrl" type="text" value="${input(draft.openaiBaseUrl)}" placeholder="https://api.openai.com 或中转地址" /></div>
          <div class="field"><label>API Key${draft.hasOpenaiApiKey ? `（已保存：${escape(draft.openaiApiKeyMasked)}，留空保持不变）` : ''}</label><div class="ui-password-wrap"><input id="img-cfg-oa-key" data-asset-batch-settings-field="openaiApiKey" type="password" value="${input(draft.openaiApiKey || '')}" placeholder="${draft.hasOpenaiApiKey ? '留空沿用已保存密钥，输入新值可覆盖' : '填写图像 API Key'}" />${window.DirectorUIMotion?.passwordEyeButtonHtml?.() || ''}</div></div>
          <div class="field"><label>默认图像模型</label><input id="img-cfg-oa-model" data-asset-batch-settings-field="openaiModel" type="text" value="${input(draft.openaiModel)}" placeholder="gpt-image-2.5" /></div>
          ${draft.hasOpenaiApiKey ? `<label class="asset-batch-inline-check"><input type="checkbox" data-asset-batch-settings-field="clearOpenaiApiKey" ${draft.clearOpenaiApiKey ? 'checked' : ''} /> 清除已保存的 API Key</label>` : ''}
        </div>
        <div class="asset-batch-settings-group">
          <h3>Magpie 本机入口（个人版驱动 A · 同时支持文本队列与图像生成）</h3>
          <div class="grid two">
            <div class="field"><label>网关地址</label><input id="img-cfg-magpie-url" data-asset-batch-settings-field="magpieBaseUrl" type="text" value="${input(draft.magpieBaseUrl)}" placeholder="http://127.0.0.1:3425" /></div>
            <div class="field"><label>队列生成文本模型（留空自动优选 Codex / 路由组）</label><input id="img-cfg-magpie-text-model" data-asset-batch-settings-field="magpieTextModel" type="text" value="${input(draft.magpieTextModel || '')}" placeholder="如 codex/gpt-6.2-sol 或 group/smart-split" /></div>
          </div>
          <div class="form-actions" style="margin-top:8px">
            <button class="button quiet small" data-action="asset-batch-detect-magpie">检测 Magpie 网关状态</button>
            ${ui.magpieStatus ? `<span class="hint">${ui.magpieStatus.online ? `在线 · 发现 ${ui.magpieStatus.textModels?.length || 0} 个模型（推荐 ${escape(ui.magpieStatus.recommendedModel || '默认')}）` : `未连接：${escape(ui.magpieStatus.error || '请先启动 Magpie')}`}</span>` : ''}
          </div>
        </div>
        <div class="asset-batch-settings-group">
          <h3>Codex 只读队列准备（路线 A）</h3>
          <div class="field"><label>手动 codex.exe 路径（留空则按 PATH → 本机安装目录自动发现）</label><input id="img-cfg-codex-path" data-asset-batch-settings-field="codexPath" type="text" value="${input(draft.codexPath)}" placeholder="留空自动发现" /></div>
          <div class="grid two">
            <div class="field"><label>指定模型（留空沿用 Codex config.toml）</label><input id="img-cfg-codex-model" data-asset-batch-settings-field="codexModel" type="text" value="${input(draft.codexModel)}" placeholder="留空沿用默认模型" /></div>
            <div class="field"><label>推理档位</label><select data-asset-batch-settings-field="codexReasoningEffort">
              <option value="low" ${(draft.codexReasoningEffort || 'low') === 'low' ? 'selected' : ''}>低（最快，推荐）</option>
              <option value="medium" ${draft.codexReasoningEffort === 'medium' ? 'selected' : ''}>中（更细致）</option>
              <option value="high" ${draft.codexReasoningEffort === 'high' ? 'selected' : ''}>高（深度分析，较慢）</option>
            </select></div>
          </div>
          <div class="form-actions" style="margin-top:8px">
            <button class="button quiet small" data-action="asset-batch-discover-codex">检测本机 Codex 入口</button>
          </div>
          ${discovery ? `<div class="asset-batch-discovery-box">${discovery.error
            ? `<p class="asset-batch-error">${escape(discovery.error)}</p>`
            : `<p class="hint">已选中：<code>${escape(discovery.selected)}</code></p><ul>${(discovery.candidates || []).map(c => `<li><code>${escape(c.path)}</code> · ${escape(c.version)}</li>`).join('')}</ul>`}</div>` : ''}
        </div>
        <div class="form-actions" style="margin-top:14px">
          <button class="button" data-action="asset-batch-save-settings" ${editable() ? '' : 'disabled'}>保存本机设置</button>
          <button class="button secondary" data-action="asset-batch-close-modal">关闭</button>
        </div>
      </div></div>`;
    }

    function renderModal(modalRoot) {
      if (!ui.modal || !modalRoot) return false;
      let html = '';
      if (ui.modal.type === 'inspect') html = renderInspectModal(ui.modal);
      else if (ui.modal.type === 'retry') html = renderRetryModal(ui.modal);
      else if (ui.modal.type === 'settings') html = renderSettingsModal();
      if (!html) { ui.modal = null; return false; }
      modalRoot.innerHTML = html;
      return true;
    }

    async function action(actionName, button, event) {
      if (actionName === 'asset-batch-close-modal') { ui.modal = null; ui.inspectFull = null; rerender(); return; }
      if (actionName === 'asset-batch-modal-backdrop') {
        const overlay = document.querySelector('#modal-root .modal-overlay');
        if (event && event.target === overlay && button === overlay) { ui.modal = null; ui.inspectFull = null; rerender(); }
        return;
      }
      if (actionName === 'asset-batch-open-settings') {
        const cfg = api.imageConfigGet ? await api.imageConfigGet() : {};
        ui.settingsDraft = { ...cfg, openaiApiKey: '', clearOpenaiApiKey: false };
        ui.codexDiscovery = null;
        ui.modal = { type: 'settings' };
        rerender();
        return;
      }
      if (actionName === 'asset-batch-discover-codex') {
        try { ui.codexDiscovery = api.codexDiscover ? await api.codexDiscover(String(ui.settingsDraft?.codexPath || '').trim()) : { error: '未接入检测接口' }; }
        catch (error) { ui.codexDiscovery = { error: error.message || String(error) }; }
        rerender();
        return;
      }
      if (actionName === 'asset-batch-save-settings') {
        if (!editable()) return toast('会员已到期，当前只能阅读。');
        try {
          const saved = await api.imageConfigSave(ui.settingsDraft || {});
          ui.settingsDraft = { ...saved, openaiApiKey: '', clearOpenaiApiKey: false };
          ui.providers = await api.imageProviders();
          const provider = configuredProvider();
          if (provider && !ui.providers.some(item => item.id === ui.draft.providerId && item.configured !== false)) {
            ui.draft.providerId = provider.id;
            ui.draft.model = modelForProvider(provider, ui.draft.model);
          }
          ui.modal = null;
          toast('已保存本机图像入口与 Codex 设置。');
          rerender();
        } catch (error) {
          toast(error.message || String(error));
        }
        return;
      }

      const p = currentProject();
      if (!p) return;

      if (actionName === 'asset-batch-unbind-root') {
        if (!editable()) return;
        ui.archiveInfo = await api.unbindArchiveRoot(p);
        toast('已恢复默认项目图片目录（06 资产/images）。');
        rerender();
        if (typeof onPublished === 'function') void onPublished();
        return;
      }
      if (actionName === 'asset-batch-import-queue') {
        const chosen = await api.chooseAssetBatchQueue();
        if (chosen) {
          ui.draft.sourceDir = chosen.path ? String(chosen.path).replace(/[\\/][^\\/]+$/, '') : '';
          setDraftQueue(chosen.queue, chosen.name);
          rerender();
        }
        return;
      }
      if (actionName === 'asset-batch-detect-magpie') {
        try {
          const url = ui.modal?.type === 'settings' ? String(ui.settingsDraft?.magpieBaseUrl || '').trim() : '';
          ui.magpieStatus = api.magpieDetect ? await api.magpieDetect(url) : { online: false, error: '未接入检测接口' };
          toast(ui.magpieStatus.online
            ? `Magpie 网关在线（发现 ${ui.magpieStatus.textModels?.length || 0} 个模型，推荐 ${ui.magpieStatus.recommendedModel || '默认'}）。`
            : `Magpie 网关未连接：${ui.magpieStatus.error || '请确认 Magpie 正在运行'}`);
        } catch (error) {
          ui.magpieStatus = { online: false, error: error.message || String(error) };
          toast(ui.magpieStatus.error);
        }
        rerender();
        return;
      }
      if (actionName === 'asset-batch-ai-auto') {
        if (!editable()) return toast('当前为只读模式，请先在右上角「会员中心」激活会员。');
        ui.codex = { running: true, phase: 'magpie-detect', detail: '正在通过 Magpie / AI 网关读取本集剧本…', warning: '', runId: '', threadIds: [] };
        ui.error = '';
        rerender();
        try {
          const result = await api.codexPrepareQueueViaAi(p, { episode: Number(episode()), source: 'auto' });
          if (pathKey(currentProject()?.projectPath) !== pathKey(p.projectPath)) return;
          ui.draft.sourceDir = '';
          setDraftQueue(result.queue, `${result.mode} · 第${result.episode}集`);
          const model = effectiveModel();
          const batchName = String(ui.draft.batchName || '').trim() || `ep${result.episode}-${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
          const created = await api.assetBatchCreate(p, {
            batchId: batchName, queue: result.queue, model, providerId: ui.draft.providerId
          });
          ui.selectedId = created.id;
          ui.status = created;
          ui.draft.batchName = '';
          ui.batches = [created, ...ui.batches.filter(item => item.id !== created.id)];
          ui.selectedJobs = recommendSampleIds(created);
          toast(`已通过 ${result.mode} 提取 ${result.queue.jobs.length} 项资产并自动建立批次 ${created.id}，可直接点击「运行选中项」出图！`);
        } catch (error) {
          if (pathKey(currentProject()?.projectPath) !== pathKey(p.projectPath)) return;
          ui.error = error.message || String(error);
          toast(ui.error);
        } finally {
          ui.codex.running = false;
          if (pathKey(currentProject()?.projectPath) === pathKey(p.projectPath)) rerender();
        }
        return;
      }
      if (actionName === 'asset-batch-from-automation') {
        if (!editable()) return toast('当前为只读模式，请先在右上角「会员中心」激活会员。');
        ui.busy = true; ui.error = ''; rerender();
        try {
          let queue = null;
          let sourceLabel = '';
          if (api.codexBuildQueueFromRegistry) {
            try {
              const regRes = await api.codexBuildQueueFromRegistry(p, Number(episode()));
              if (regRes?.queue?.jobs?.length) {
                queue = regRes.queue;
                sourceLabel = `自动制作资产库 · 第${episode()}集`;
              }
            } catch { /* Fall back to current episode TXT prompt library below. */ }
          }
          if (!queue) {
            queue = queueFromLibrary();
            sourceLabel = `第${episode()}集资产提示词 TXT`;
          }
          ui.draft.sourceDir = '';
          setDraftQueue(queue, sourceLabel);
          const model = effectiveModel();
          const batchName = String(ui.draft.batchName || '').trim() || `ep${episode()}-auto-${Date.now().toString(36).slice(-4)}`;
          const created = await api.assetBatchCreate(p, {
            batchId: batchName, queue, model, providerId: ui.draft.providerId
          });
          ui.selectedId = created.id;
          ui.status = created;
          ui.draft.batchName = '';
          ui.batches = [created, ...ui.batches.filter(item => item.id !== created.id)];
          ui.selectedJobs = recommendSampleIds(created);
          toast(`已从「${sourceLabel}」提取 ${queue.jobs.length} 项资产并建批 ${created.id}，已自动勾选推荐样图！`);
        } catch (error) {
          ui.error = error.message || String(error);
          toast(ui.error);
        } finally {
          ui.busy = false;
          rerender();
          void loadPreviews();
        }
        return;
      }
      if (actionName === 'asset-batch-from-library') {
        try { ui.draft.sourceDir = ''; setDraftQueue(queueFromLibrary(), `第${episode()}集资产提示词`); toast('已读取本集资产提示词到队列草稿。'); rerender(); }
        catch (error) { toast(error.message || String(error)); }
        return;
      }
      if (actionName === 'asset-batch-codex-cancel') {
        if (api.codexCancelQueue) await api.codexCancelQueue(ui.codex.runId || undefined);
        toast('已请求取消 Codex 读取任务。');
        return;
      }
      if (actionName === 'asset-batch-codex-prepare') {
        if (!editable()) return;
        ui.codex = { running: true, phase: 'read-only-started', detail: '正在启动只读模式…', warning: '', runId: '', threadIds: [] };
        ui.error = '';
        rerender();
        try {
          const result = await api.codexPrepareQueue(p, {
            episode: Number(episode()),
            allowCompatibilityFallback: true
          });
          if (pathKey(currentProject()?.projectPath) !== pathKey(p.projectPath)) return;
          ui.draft.sourceDir = '';
          setDraftQueue(result.queue, `Codex ${result.mode} · 第${result.episode}集${result.episodeFile ? `（${result.episodeFile}）` : ''}`);
          ui.codex.warning = result.warning || '';
          ui.codex.runId = result.runId || ui.codex.runId;
          ui.codex.threadIds = result.threadIds || ui.codex.threadIds;
          toast(`Codex 已整理 ${result.queue.jobs.length} 项第 ${result.episode} 集资产队列，请核对后创建批次。`);
        } catch (error) {
          if (pathKey(currentProject()?.projectPath) !== pathKey(p.projectPath)) return;
          ui.error = error.message || String(error);
          toast(ui.error);
        } finally {
          ui.codex.running = false;
          if (pathKey(currentProject()?.projectPath) === pathKey(p.projectPath)) rerender();
        }
        return;
      }
      if (actionName === 'asset-batch-create') {
        if (!editable()) return;
        let queue;
        try { queue = JSON.parse(ui.draft.queueText || '{}'); }
        catch (error) { ui.error = `队列 JSON 无法解析：${error.message}`; rerender(); return; }
        const model = effectiveModel();
        ui.busy = true; ui.error = ''; rerender();
        try {
          const result = await api.assetBatchCreate(p, {
            batchId: String(ui.draft.batchName || '').trim() || undefined,
            queue, model, providerId: ui.draft.providerId,
            sourceDir: ui.draft.sourceDir || undefined
          });
          ui.selectedId = result.id;
          ui.status = result;
          ui.draft.queue = queue;
          ui.draft.batchName = '';
          ui.batches = [result, ...ui.batches.filter(item => item.id !== result.id)];
          ui.selectedJobs = recommendSampleIds(result);
          toast(`已创建批次 ${result.id}（锁定模型 ${model}）。`);
        } catch (error) {
          ui.error = error.message || String(error);
          toast(ui.error);
        } finally {
          ui.busy = false;
          rerender();
          void loadPreviews();
        }
        return;
      }
      if (actionName === 'asset-batch-refresh') { ui.loadedKey = ''; return refresh(); }
      if (actionName === 'asset-batch-select') {
        ui.selectedId = button.dataset.batchId || '';
        ui.selectedJobs.clear();
        ui.staleNotice = null;
        ui.status = ui.batches.find(item => item.id === ui.selectedId) || null;
        rerender();
        void refreshStatus();
        return;
      }
      if (actionName === 'asset-batch-filter-cat') {
        ui.filters.category = button.dataset.filterValue || 'all';
        rerender();
        return;
      }
      if (actionName === 'asset-batch-filter-state') {
        ui.filters.state = button.dataset.filterValue || 'all';
        rerender();
        return;
      }
      if (actionName === 'asset-batch-select-clear') { ui.selectedJobs.clear(); rerender(); return; }
      if (actionName === 'asset-batch-select-samples') {
        const batch = selectedBatch();
        if (batch) {
          ui.selectedJobs = recommendSampleIds(batch);
          toast(`已勾选推荐样图包（${ui.selectedJobs.size} 项）。`);
          rerender();
        }
        return;
      }
      if (actionName === 'asset-batch-select-l0') {
        const batch = selectedBatch();
        if (batch) {
          const cards = new Map((batch.cards || []).map(c => [c.id, c]));
          ui.selectedJobs = new Set((batch.jobs || [])
            .filter(j => !(j.references || []).length && !['staged', 'published'].includes(cards.get(j.id)?.state))
            .map(j => j.id));
          rerender();
        }
        return;
      }
      if (actionName === 'asset-batch-select-visible') {
        const batch = selectedBatch();
        if (batch) {
          for (const card of filteredCards(batch)) ui.selectedJobs.add(card.id);
          rerender();
        }
        return;
      }

      if (actionName === 'asset-batch-inspect') {
        const bId = button.dataset.batchId || ui.selectedId;
        const jobId = button.dataset.jobId;
        if (!bId || !jobId) return;
        ui.inspectFull = null;
        ui.modal = { type: 'inspect', batchId: bId, jobId, zoom: 'fit', bg: 'white' };
        rerender();
        void loadPreviews(jobId);
        void loadInspectFull(bId, jobId);
        return;
      }
      if (actionName === 'asset-batch-inspect-nav' && ui.modal?.type === 'inspect') {
        const batch = selectedBatch();
        const list = filteredCards(batch);
        const cur = list.findIndex(c => c.id === ui.modal.jobId);
        const next = list[cur + Number(button.dataset.dir || 0)];
        if (next) {
          ui.inspectFull = null;
          ui.modal = { type: 'inspect', batchId: batch.id, jobId: next.id, zoom: ui.modal.zoom || 'fit', bg: ui.modal.bg || 'white' };
          rerender();
          void loadPreviews(next.id);
          void loadInspectFull(batch.id, next.id);
        }
        return;
      }
      if (actionName === 'asset-batch-inspect-zoom' && ui.modal?.type === 'inspect') {
        ui.modal.zoom = button.dataset.value || 'fit';
        rerender();
        return;
      }
      if (actionName === 'asset-batch-inspect-bg' && ui.modal?.type === 'inspect') {
        ui.modal.bg = button.dataset.value || 'white';
        rerender();
        return;
      }

      const batchId = button.dataset.batchId || ui.selectedId;
      if (!batchId) return;

      if (actionName === 'asset-batch-run' || actionName === 'asset-batch-run-selected') {
        if (!editable()) return;
        const batch = selectedBatch();
        const ids = actionName === 'asset-batch-run-selected'
          ? [...ui.selectedJobs].filter(id => batch?.cards?.some(c => c.id === id))
          : undefined;
        if (actionName === 'asset-batch-run-selected' && !ids.length) return toast('请先勾选至少一项任务。');
        ui.selectedId = batchId; ui.busy = true; ui.error = ''; rerender();
        const requestedModel = batch?.requested_model;
        const providerId = batch?.provider_id || providerForModel(ui.providers, requestedModel) || ui.draft.providerId;
        let runError = '';
        try {
          const snapshot = await api.assetBatchRun(p, {
            batchId, providerId, concurrency: Number(ui.draft.concurrency) || 3,
            ids, resume: Boolean(batch?.paused)
          });
          ui.status = { id: batchId, ...snapshot };
          const pendingCount = (snapshot.cards || []).filter(c => c.state === 'pending').length;
          toast(pendingCount
            ? `已提交/查询完毕，仍有 ${pendingCount} 项等待供应端出图，稍后可再次点击“运行全部就绪”回收结果。`
            : ids ? `选中任务（${ids.length} 项）运行结束，结果已写入状态卡。` : '批次运行结束，结果已写入状态卡。');
        } catch (error) {
          runError = error.message || String(error);
          ui.error = runError;
          toast(runError);
        } finally {
          ui.busy = false;
          await refresh();
          if (runError) {
            ui.error = runError;
            rerender();
          }
        }
        return;
      }
      if (actionName === 'asset-batch-pause') {
        if (!editable()) return;
        try { await api.assetBatchPause(p, batchId); toast('已请求暂停，当前已提交任务会先完成状态落盘。'); }
        finally { await refresh(); }
        return;
      }
      if (actionName === 'asset-batch-retry-deferred') {
        if (!editable()) return;
        const retried = await api.assetBatchRetryDeferred(p, batchId);
        await refreshStatus();
        toast(retried?.length ? `已将 ${retried.length} 项延期任务重新排队。` : '当前没有可重试的延期项。');
        return;
      }
      if (actionName === 'asset-batch-accept-all') {
        if (!editable()) return;
        const accepted = await api.assetBatchAcceptMany(p, batchId);
        await refreshStatus();
        toast(accepted?.length ? `已批量验收 ${accepted.length} 张暂存图。` : '没有待验收的暂存图。');
        return;
      }
      if (actionName === 'asset-batch-accept') {
        if (!editable()) return;
        await api.assetBatchAccept(p, batchId, button.dataset.jobId);
        await refreshStatus();
        toast('已验收当前暂存图，下游依赖已可解锁。');
        return;
      }
      if (actionName === 'asset-batch-adopt') {
        if (!editable()) return;
        const chosen = await api.chooseAssetBatchImage();
        if (!chosen) return;
        const batch = selectedBatch();
        const staleIds = await api.assetBatchAdopt(p, { batchId, jobId: button.dataset.jobId, bytes: chosen.bytes, actualModel: batch.requested_model });
        await refreshStatus();
        if (Array.isArray(staleIds) && staleIds.length) {
          const jobs = new Map((selectedBatch()?.jobs || []).map(j => [j.id, j]));
          ui.staleNotice = { batchId, ids: staleIds, names: staleIds.map(id => jobs.get(id)?.name || id) };
          rerender();
          toast(`本地图已入暂存；同时有 ${staleIds.length} 张下游派生图标为「母板已变化」。`);
        } else {
          toast('本地图已进入暂存状态，请目检验收。');
        }
        return;
      }
      if (actionName === 'asset-batch-retry') {
        if (!editable()) return;
        const batch = selectedBatch();
        const jobId = button.dataset.jobId;
        const job = batch?.jobs?.find(j => j.id === jobId);
        const card = batch?.cards?.find(c => c.id === jobId);
        if (!job || !card) return;
        ui.modal = {
          type: 'retry', batchId, jobId,
          reasonDraft: card.state === 'uncertain' ? '' : '已核对，调整后重新生成',
          promptDraft: card.prompt_override ?? job.prompt ?? ''
        };
        rerender();
        return;
      }
      if (actionName === 'asset-batch-modal-confirm-retry') {
        if (!editable()) return;
        const jobId = button.dataset.jobId || ui.modal?.jobId;
        const batch = selectedBatch();
        const card = batch?.cards?.find(c => c.id === jobId);
        const job = batch?.jobs?.find(j => j.id === jobId);
        if (!card || !job) return;
        const reason = String(ui.modal?.reasonDraft || '').trim();
        if (card.state === 'uncertain' && !reason) {
          toast('解锁提交不明任务必须填写人工核对结论。');
          window.DirectorUIMotion?.shake?.('#asset-batch-modal-reason');
          document.querySelector('#asset-batch-modal-reason')?.focus();
          return;
        }
        const promptDraft = ui.modal?.promptDraft;
        const promptOverride = typeof promptDraft === 'string'
          ? (promptDraft === (job.prompt ?? '') ? null : promptDraft)
          : undefined;
        try {
          await api.assetBatchRetry(p, { batchId, jobId, reason: reason || '重新排队', prompt: promptOverride });
          if (ui.modal?.type === 'retry') ui.modal = null;
          await refreshStatus();
          toast('任务已重新排队，可点击运行继续生成。');
        } catch (error) {
          toast(error.message || String(error));
        }
        return;
      }
      if (actionName === 'asset-batch-publish' || actionName === 'asset-batch-publish-all') {
        if (!editable()) return;
        const ids = actionName === 'asset-batch-publish'
          ? [button.dataset.jobId]
          : (selectedBatch()?.cards || []).filter(card => card.accepted && ['staged', 'published'].includes(card.state)).map(card => card.id);
        if (!ids.length) return toast('没有可发布的已验收图片。');
        try {
          await api.assetBatchPublish(p, batchId, ids);
          await refreshStatus();
          if (typeof onPublished === 'function') await onPublished();
          toast(`已发布 ${ids.length} 张成品图并刷新素材页。`);
        } catch (error) {
          ui.error = error.message || String(error);
          toast(ui.error);
          rerender();
        }
        return;
      }
    }

    function handleInput(event) {
      const target = event.target;
      const modalField = target?.dataset?.assetBatchModalField;
      if (modalField && ui.modal) {
        ui.modal[modalField] = target.value;
        return true;
      }
      const settingsField = target?.dataset?.assetBatchSettingsField;
      if (settingsField && ui.settingsDraft) {
        ui.settingsDraft[settingsField] = target.type === 'checkbox' ? target.checked : target.value;
        return true;
      }
      const field = target?.dataset?.assetBatchField;
      if (!field) return false;
      if (field === 'queueText') {
        ui.draft.queueText = target.value;
        const createBtn = document.querySelector('[data-action="asset-batch-create"]');
        if (createBtn) createBtn.disabled = !(editable() && Boolean(ui.draft.queueText.trim()) && !ui.busy && !ui.codex.running);
      } else if (field === 'customModel') {
        ui.draft.customModel = target.value;
      } else if (field === 'batchName') {
        ui.draft.batchName = target.value;
      } else if (field === 'concurrency') {
        ui.draft.concurrency = Math.min(32, Math.max(1, Number(target.value) || 1));
      }
      return true;
    }

    function handleChange(event) {
      const target = event.target;
      const checkJobId = target?.dataset?.assetBatchCheck;
      if (checkJobId) {
        if (target.checked) ui.selectedJobs.add(checkJobId);
        else ui.selectedJobs.delete(checkJobId);
        rerender();
        return true;
      }
      const settingsField = target?.dataset?.assetBatchSettingsField;
      if (settingsField && ui.settingsDraft) {
        ui.settingsDraft[settingsField] = target.type === 'checkbox' ? target.checked : target.value;
        return true;
      }
      const field = target?.dataset?.assetBatchField;
      if (!field) return false;
      if (field === 'provider') {
        ui.draft.providerId = target.value;
        const provider = ui.providers.find(item => item.id === ui.draft.providerId);
        ui.draft.model = modelForProvider(provider, ui.draft.model);
        rerender();
      } else if (field === 'model') {
        ui.draft.model = target.value;
        rerender();
      } else if (field === 'concurrency') {
        ui.draft.concurrency = Math.min(32, Math.max(1, Number(target.value) || 1));
      }
      return true;
    }

    function afterRender() {
      const p = currentProject();
      if (!p) return;
      if (ui.projectKey !== p.projectPath) resetProjectState(p.projectPath);
      const key = `${p.projectPath}|${p.currentEpisode}`;
      if (ui.loadedKey !== key && !ui.loading) void refresh();
      else if (ui.status) void loadPreviews();
    }

    function invalidate() { ui.loadedKey = ''; if (currentProject()) void refresh(); }
    function trimCache() { ui.previews.clear(); ui.previewLoading.clear(); ui.inspectFull = null; }
    function isBusy() { return Boolean(ui.busy || ui.codex.running); }

    return { render: renderWorkbench, renderModal, afterRender, invalidate, trimCache, action, handleInput, handleChange, isBusy };
  }

  window.createAssetBatchUI = createAssetBatchUI;
}());
