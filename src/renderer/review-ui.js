'use strict';
window.createReviewUI = function ({ project, view, api, canEdit, render, toast, label, onEpisodeChange }) {
  const sessions = new Map();
  let activeSession = null, skipRemember = false;
  const draw = () => {
    // Background review loading must not rebuild a document the user is typing
    // in, or reload an embedded HTML/video preview on a different page.
    if (!view || ['review', 'review-notes'].includes(view())) {
      skipRemember = true;
      render();
    } else {
      document.querySelectorAll('.episode-rail [data-action="select-episode"][data-episode]').forEach(button => {
        const html = badge(button.dataset.episode);
        const existing = button.querySelector('.review-dot');
        if ((existing?.outerHTML || '') === html) return;
        existing?.remove();
        if (html) button.insertAdjacentHTML('beforeend', html);
      });
    }
  };
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = (v) => { const n = Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0; return `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, '0')}`; };
  const current = () => {
    const key = project()?.projectPath;
    if (!key) return null;
    if (!sessions.has(key)) sessions.set(key, { db: null, loading: false, selected: '', search: '', filter: 'all', exportScope: 'issues', includeHistory: false, positions: {}, orientations: {}, draft: {}, drafts: {}, speed: 1, volume: 1, muted: false, loop: false, fit: 'contain', busy: false });
    const session = sessions.get(key); session.projectRef = project(); return session;
  };
  const selected = () => current()?.db?.videos.find((v) => v.id === current().selected);
  const episodeOptions = () => {
    const p = project(), keys = new Set((p?.episodes || []).map((ep) => Number(ep.number)));
    // 视频文件名可能已经写了“第17集上/下”，即使项目还没拆集，也保留这个可选归类。
    for (const video of current()?.db?.videos || []) if (video.episode != null && Number.isFinite(Number(video.episode))) keys.add(Number(video.episode));
    return [...keys].sort((a, b) => a - b);
  };
  function remember() {
    if (skipRemember) { skipRemember = false; return; }
    const s = activeSession, video = document.querySelector('#review-video');
    if (!s) return;
    if (video && video.dataset.videoId) {
      s.positions[video.dataset.videoId] = { seconds: video.currentTime || 0, playing: !video.paused && !video.ended };
      s.speed = video.playbackRate; s.volume = video.volume; s.muted = video.muted; s.loop = video.loop;
    }
    const form = document.querySelector('#review-note-text');
    if (form && video?.dataset.videoId === s.selected) s.draft = { ...s.draft, text: form.value, prompt: document.querySelector('#review-note-prompt')?.value || s.draft.prompt || '',
      seconds: document.querySelector('#review-note-time').value, category: document.querySelector('#review-note-category').value, shotId:document.querySelector('#review-note-shot')?.value||'' };
    if (form && video?.dataset.videoId === s.selected) s.drafts[s.selected] = { ...s.draft };
    if (video && view && view() !== 'review') {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
    }
  }
  async function load(force = false) {
    const s = current(), p = project();
    if (!s || s.loading || (s.db && !force)) return;
    s.loading = true;
    try {
      s.db = await api.reviewLoad(p);
      if (!s.selected) s.selected = s.db.videos.find(v => !v.missing && Number(v.episode) === Number(p.currentEpisode))?.id
        || s.db.videos.find((v) => !v.missing)?.id || s.db.videos[0]?.id || '';
      if (project()?.projectPath === p.projectPath) draw();
    } catch (err) { s.error = err.message; toast(err.message); }
    finally { s.loading = false; }
  }
  const statusLabel = (v) => v.openCount ? `待解决 ${v.openCount}` : v.needsRevision ? '需修改' : ({ pending: '待审', passed: '已通过', issues: '待复核' }[v.status] || '待审');
  function badge(episode) {
    const videos = current()?.db?.videos.filter(v => !v.missing && v.episode != null && (Number(v.episode) === Number(episode)
      || (Number(v.episode) === Number(episode) + 0.5 && !project()?.episodes.some(ep => Number(ep.number) === Number(v.episode))))) || [];
    const count = videos.reduce((n, v) => n + (v.openCount || 0), 0), pending = videos.filter(v=>v.status==='issues'&&!v.openCount).length;
    const description=[count?`${count} 条未解决审片意见`:'',pending?`${pending} 个视频待复核`:''].filter(Boolean).join('；');
    return description ? `<i class="review-dot" title="${description}" aria-label="${description}"></i>` : '';
  }
  function notesHTML(notes, all = false) {
    const s = current();
    return notes.length ? notes.map((n) => {
      const v = s.db.videos.find((item) => item.id === n.videoId);
      return `<article class="review-note ${n.resolved ? 'resolved' : 'open'}"><div class="review-note-head"><strong>${v?.episode == null ? '未匹配集数' : `第 ${label(v.episode)} 集`} · ${clock(n.seconds)}</strong><span class="badge ${n.resolved ? 'pass' : 'danger'}">${n.resolved ? '已解决' : '待解决'} · ${e(n.category)}${n.shotLabel?` · 镜头 ${e(n.shotLabel)}`:''}</span></div>${all ? `<p class="hint">${e(v?.relative || v?.name)}</p>` : ''}${n.screenshotUrl ? `<a href="${e(n.screenshotUrl)}" data-review-image="${e(n.screenshotUrl)}" title="点击查看大图"><img class="review-note-image" src="${e(n.screenshotUrl)}" alt="${e(clock(n.seconds))} 视频截图" /></a>` : ''}<p class="review-note-body">${e(n.text)}</p>${n.prompt ? `<details open><summary>提示词修改意见</summary><p class="review-note-body">${e(n.prompt)}</p></details>` : ''}<div class="form-actions"><button class="button quiet small" data-action="review-jump" data-id="${n.id}">定位视频</button><button class="button quiet small" data-action="review-edit" data-id="${n.id}">编辑</button><button class="button secondary small" data-action="review-resolve" data-id="${n.id}" data-resolved="${!n.resolved}">${n.resolved ? '重新打开' : '标记已解决'}</button><button class="button quiet small" data-action="review-delete" data-id="${n.id}">删除</button></div></article>`;
    }).join('') : '<div class="review-empty">暂无审片意见。播放到问题位置，即可截图并记录。</div>';
  }
  function videoLabel(video) {
    if (video?.episode == null) return '未匹配集数';
    const base = Math.floor(Number(video.episode));
    const part = video.part || video.name?.match(/\d+\s*(?:集|话)?\s*(上|中|下)/)?.[1] || '';
    return `第 ${part ? `${base}${part}` : label(video.episode)} 集`;
  }
  function renderReview() {
    const s = current(), db = s?.db, v = selected(), d = s?.draft || {};
    const disabled = canEdit() ? '' : 'disabled';
    if (!db) return `<section class="view review-view"><div class="card">${e(s?.error || '正在读取审片记录…')}</div></section>`;
    const videos = db.videos.filter(item => !item.missing);
    const orientation = s.orientations[v?.id] || 'unknown';
    const at = videos.findIndex(item => item.id === v?.id);
    const transport = v ? `<div class="review-transport" aria-label="播放和审核操作">
      <div class="review-controls review-primary-controls">
        <button class="button quiet small" data-action="review-prev" ${at <= 0 ? 'disabled' : ''}>上一视频</button>
        <button class="button secondary small" data-action="review-play" id="review-play">播放</button>
        <button class="button quiet small" data-action="review-back" title="快退 5 秒">−5秒</button>
        <button class="button quiet small" data-action="review-forward" title="快进 5 秒">+5秒</button>
        <button class="button quiet small" data-action="review-next" ${at >= videos.length - 1 ? 'disabled' : ''}>下一视频</button>
        <label>倍速 <select id="review-speed" aria-label="播放倍速">${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(n => `<option value="${n}" ${s.speed === n ? 'selected' : ''}>${n}×</option>`).join('')}</select></label>
        <button class="button quiet small" data-action="review-mute" id="review-mute">${s.muted ? '恢复声音' : '静音'}</button>
        <label>音量 <input id="review-volume" aria-label="音量" type="range" min="0" max="1" step="0.01" value="${s.volume}" /></label>
        <button class="button quiet small" data-action="review-fullscreen">全屏</button>
        <details class="review-more" ${s.moreOpen ? 'open' : ''}><summary>更多</summary><div class="review-controls">
          <button class="button quiet small" data-action="review-frame-back" title="前移约 1/30 秒">前一帧</button>
          <button class="button quiet small" data-action="review-frame" title="后移约 1/30 秒">后一帧</button>
          <label><input id="review-loop" type="checkbox" ${s.loop ? 'checked' : ''} /> 循环</label>
          <label>画面 <select id="review-fit"><option value="contain" ${s.fit === 'contain' ? 'selected' : ''}>完整显示</option><option value="cover" ${s.fit === 'cover' ? 'selected' : ''}>填满</option></select></label>
          <button class="button quiet small" data-action="review-pip">画中画</button>
          <span class="hint">空格播放；← → 快进退；↑ ↓ 音量。</span>
        </div></details>
      </div>
      <div class="review-timeline"><span id="review-clock">0:00.00 / 0:00.00</span><input id="review-progress" type="range" min="0" max="1" step="0.01" value="0" aria-label="播放进度" /></div>
      <div class="review-decision">
        <button class="button secondary small" data-action="review-capture" ${disabled}>截图记录</button>
        <button class="button small" data-action="review-pass" ${disabled || (v.openCount ? 'disabled title="先处理未解决意见"' : '')}>审核通过</button>
        <button class="button secondary small" data-action="review-issue" ${disabled}>需修改</button>
        <button class="button quiet small" data-action="review-pending" ${disabled}>设为待审</button>
        <button class="button quiet small" data-action="review-note-focus">记录意见</button>
      </div>
    </div>` : '';
    return `<section class="view review-view">
      <div class="review-workspace-heading"><strong>审片</strong><span class="review-folder-path" title="${e(db.folder)}">${e(db.folder || '选择视频文件夹开始审片')}</span><div class="form-actions">
        <button class="button secondary small" data-action="review-folder" ${disabled}>选择视频文件夹</button>
        <button class="button quiet small" data-action="review-rescan" ${db.folder && canEdit() ? '' : 'disabled'}>刷新视频</button>
        <button class="button secondary small" data-view="review-notes">审片意见</button>
      </div></div>
      ${db.warnings?.length ? `<p class="notice">${e(db.warnings.join('；'))}</p>` : ''}
      <div class="review-layout">
        <aside class="review-playlist card"><div class="card-title"><h3>视频列表</h3><span class="badge" title="项目集数与当前视频数量">${project().episodes.length} 集 · ${videos.length} 视频</span></div>
          <input id="review-video-search" placeholder="查找集数、视频名称" value="${e(s.search)}" aria-label="搜索视频" />
          <div class="review-video-items">${videos.map(item => {
            const match = `${item.name} ${videoLabel(item)}`.toLowerCase().includes(s.search.toLowerCase());
            return `<button class="review-video-item ${item.id === s.selected ? 'current' : ''} ${item.openCount || item.needsRevision ? 'has-issues' : ''}" data-action="review-select" data-video-id="${item.id}" data-review-name="${e(item.name.toLowerCase())}" aria-current="${item.id === s.selected}" ${match ? '' : 'hidden'}>
              <strong>${e(videoLabel(item))}${item.openCount || item.needsRevision || item.status === 'issues' ? '<i class="review-dot" aria-label="有审片意见"></i>' : ''}</strong><span title="${e(item.relative)}">${e(item.relative || item.name)}</span><small>${statusLabel(item)}</small>
            </button>`;
          }).join('') || '<p class="hint">暂无视频，请选择视频文件夹。</p>'}</div>
        </aside>
        <div class="review-player-column"><article class="card review-player-card">
          ${v ? `<div class="review-current-head"><div><h2 title="${e(v.name)}">${e(videoLabel(v))} · ${e(v.name)}</h2><span class="badge ${v.openCount ? 'danger' : v.status === 'passed' ? 'pass' : ''}">${statusLabel(v)}</span></div><div class="form-actions">
            <label>归属集数 <select id="review-episode" ${disabled}><option value="">未匹配</option>${episodeOptions().map(key => `<option value="${key}" ${v.episode != null && Number(v.episode) === key ? 'selected' : ''}>第 ${label(key)} 集</option>`).join('')}</select></label>
            <button class="button quiet small" data-action="review-external">外部播放</button>
          </div></div>${transport}
          <div class="review-video-stage" data-orientation="${orientation}" aria-label="${orientation === 'portrait' ? '竖屏预览' : '视频预览'}">
            <video id="review-video" data-video-id="${v.id}" src="${e(v.url)}" preload="metadata" controls playsinline style="object-fit:${s.fit}" aria-label="审片视频"></video>
            <div id="review-play-error" hidden>无法解码此视频，可通过上方“外部播放”打开。</div>
          </div>` : '<div class="review-empty"><h2>准备开始审片</h2><p>选择视频文件夹后，在这里播放视频。</p></div>'}
        </article>
        ${v ? `<article class="card review-note-form"><div class="card-title"><h3>${d.id ? '编辑意见' : '记录审片意见'}</h3><span class="hint">${e(videoLabel(v))} · 保存到项目的“07 AI规则与记忆 / 审片意见”</span></div>
          <div class="review-controls"><label>时间（秒） <input id="review-note-time" type="number" min="0" step="0.01" value="${e(d.seconds ?? 0)}" ${disabled} /></label><button class="button quiet small" data-action="review-current-time" ${disabled}>取当前时间</button>
            <label>类型 <select id="review-note-category" ${disabled}>${['画面', '剧情', '台词', '声音', '字幕', '提示词', '其他'].map(c => `<option ${d.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
            <label>对应镜头（可选） <select id="review-note-shot" ${disabled}><option value="${e(d.shotId || '')}">${e(d.shotLabel || '不绑定镜头')}</option></select></label>
          </div>${d.screenshot ? `<img class="review-draft-image" src="${e(d.screenshot)}" alt="当前意见截图" />` : ''}
          <div class="field"><label>问题描述</label><textarea id="review-note-text" rows="3" placeholder="哪里有问题，希望如何调整？" ${disabled}>${e(d.text)}</textarea></div>
          <div class="form-actions"><button class="button" data-action="review-save" ${s.busy || !canEdit() ? 'disabled' : ''}>${s.busy ? '保存中…' : '保存意见'}</button><button class="button quiet" data-action="review-clear" ${disabled}>新建一条</button></div>
        </article><article class="card"><div class="card-title"><h3>当前视频意见</h3></div><div class="review-video-notes">${notesHTML(db.notes.filter(n => n.videoId === v.id).sort((a, b) => a.seconds - b.seconds))}</div></article>` : ''}
        </div>
      </div>
    </section>`;
  }

  function exportCount(s) {
    return s.db.videos.filter(v => (s.includeHistory || !v.missing) && (s.exportScope === 'all' || (s.exportScope === 'passed' ? v.status === 'passed' && !v.openCount : v.openCount || v.status === 'issues'))).length;
  }
  function exportControls(s) {
    return `<div class="card review-export-controls"><label>导出范围 <select id="review-export-scope"><option value="issues" ${s.exportScope === 'issues' ? 'selected' : ''}>待整改（仅问题文件）</option><option value="passed" ${s.exportScope === 'passed' ? 'selected' : ''}>仅已通过</option><option value="all" ${s.exportScope === 'all' ? 'selected' : ''}>全部视频</option></select></label><label><input type="checkbox" id="review-export-history" ${s.includeHistory ? 'checked' : ''}/> 包含历史版本</label><span class="hint" id="review-export-count">将导出 ${exportCount(s)} 个视频</span><button class="button" data-action="review-export">导出 Excel / 网页</button><p class="hint">“待整改”只包含未解决意见、需修改或待复核的视频；只导出待解决意见。通过和未审文件不会混入。</p></div>`;
  }
  function filteredNotes(s) {
    return s.db.notes.filter(n=>{const v=s.db.videos.find(x=>x.id===n.videoId);return (s.filter==='all'||(s.filter==='open'?!n.resolved:n.resolved))&&[v?.name,v?.episode==null?'':label(v.episode),n.text,n.prompt].join(' ').toLowerCase().includes(s.search.toLowerCase());}).sort((a,b)=>{const av=s.db.videos.find(v=>v.id===a.videoId),bv=s.db.videos.find(v=>v.id===b.videoId);return (av?.episode??Infinity)-(bv?.episode??Infinity)||a.seconds-b.seconds;});
  }
  function refreshNoteList(s){const list=document.getElementById('review-notes-list');if(list)list.innerHTML=notesHTML(filteredNotes(s),true);}
  function renderNotes() {
    const s = current(), db = s?.db;
    if (!db) return `<section class="view"><h1>审片意见</h1><div class="card">${e(s?.error || '正在读取…')}</div></section>`;
    const open = db.notes.filter((n) => !n.resolved).length;
    const notes = filteredNotes(s);
    return `<section class="view review-notes-view"><div class="page-heading"><div><div class="eyebrow">REVIEW NOTES</div><h1>审片意见</h1><p class="hint">${db.notes.length} 条意见 · ${open} 条待解决 · ${db.videos.filter((v) => v.status === 'passed' && !v.openCount).length} 个视频通过</p></div><div class="form-actions"><button class="button secondary" data-view="review">返回审片</button><button class="button secondary" data-action="review-open-folder">打开意见文件夹</button></div></div>${exportControls(s)}<div class="card review-note-filters"><input id="review-notes-search" aria-label="搜索审片意见" placeholder="搜索集数、视频、问题或提示词" value="${e(s.search)}"/><select id="review-note-filter"><option value="all" ${s.filter === 'all' ? 'selected' : ''}>全部意见</option><option value="open" ${s.filter === 'open' ? 'selected' : ''}>待解决</option><option value="resolved" ${s.filter === 'resolved' ? 'selected' : ''}>已解决</option></select></div><div id="review-notes-list">${notesHTML(notes, true)}</div>${db.videos.length ? `<details class="card review-status-list"><summary>全部视频审核状态（${db.videos.length}）</summary><table class="review-status-table"><thead><tr><th>集数</th><th>视频</th><th>状态</th><th></th></tr></thead><tbody>${db.videos.map((v) => `<tr><td>${v.episode == null ? '未匹配' : `第${label(v.episode)}集`}${badge(v.episode)}</td><td>${e(v.name)}${v.missing ? ' · 历史版本' : ''}</td><td>${statusLabel(v)}</td><td><button class="button quiet small" data-action="review-open-video" data-video-id="${v.id}">查看视频</button></td></tr>`).join('')}</tbody></table></details>` : ''}</section>`;
  }
  async function fillShotPicker(s){
    const picker=document.getElementById('review-note-shot'),v=selected(),p=project();
    if(!picker||v?.episode==null||!api.directorSnapshot||!(p?.episodes||[]).some(ep=>Number(ep.number)===Number(v.episode)))return;
    const videoId=v.id;picker.disabled=true;
    try {
      const data=await api.directorSnapshot({...p,currentEpisode:v.episode});
      if(picker!==document.getElementById('review-note-shot')||selected()?.id!==videoId)return;
      picker.innerHTML='<option value="">不绑定镜头</option>'+data.shots.map(shot=>'<option value="'+e(shot.id)+'">'+e(shot.label)+' · '+e(shot.heading||'分镜表')+' · 第'+shot.line+'行</option>').join('');
      if(s.draft.shotId&&!data.shots.some(shot=>shot.id===s.draft.shotId))picker.innerHTML+='<option value="'+e(s.draft.shotId)+'">旧镜头 '+e(s.draft.shotLabel||'')+'（已变化）</option>';
      picker.value=s.draft.shotId||'';
    } finally {
      if(picker===document.getElementById('review-note-shot'))picker.disabled=!canEdit();
    }
  }
  function afterRender() {
    load().catch((err) => toast(err.message));
    const s = current(), video = document.querySelector('#review-video');
    if (!s) return;
    activeSession = s;
    updateWorkspaceSize();
    void fillShotPicker(s).catch(err=>toast(err.message));
    if (video) {
      const position = s.positions[s.selected] || { seconds: 0, playing: false };
      video.playbackRate = s.speed; video.volume = s.volume; video.muted = s.muted; video.loop = s.loop;
      const update = () => {
        const progress = document.querySelector('#review-progress'), counter = document.querySelector('#review-clock');
        if (progress) { progress.max = Number.isFinite(video.duration) ? video.duration : Math.max(1, video.currentTime); progress.value = video.currentTime; }
        if (counter) counter.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
        const play = document.getElementById('review-play');
        if (play) { play.textContent = video.paused || video.ended ? '播放' : '暂停'; play.setAttribute('aria-pressed', String(!video.paused)); }
        const mute = document.getElementById('review-mute');
        if (mute) { mute.textContent = video.muted ? '恢复声音' : '静音'; mute.setAttribute('aria-pressed', String(video.muted)); }
      };
      video.addEventListener('loadedmetadata', () => {
        const shape = video.videoWidth && video.videoHeight
          ? (video.videoHeight > video.videoWidth ? 'portrait' : 'landscape')
          : 'unknown';
        s.orientations[video.dataset.videoId || s.selected] = shape;
        const stage = document.querySelector('.review-video-stage');
        if (stage) { stage.dataset.orientation = shape; stage.setAttribute('aria-label', shape === 'portrait' ? '竖屏预览' : shape === 'landscape' ? '横屏预览' : '视频预览'); }
        video.currentTime = Math.min(position.seconds, Math.max(0, video.duration - 0.001)); update();
        if (position.playing) video.play().catch(() => {});
      }, { once: true });
      video.addEventListener('timeupdate', update); video.addEventListener('durationchange', update);
      video.addEventListener('play', update); video.addEventListener('pause', update); video.addEventListener('ended', update);
      video.addEventListener('volumechange', update);
      update();
      video.addEventListener('error', () => { const error = document.querySelector('#review-play-error'); if (error) error.hidden = false; });
      video.addEventListener('volumechange', () => { s.volume = video.volume; s.muted = video.muted; const slider = document.querySelector('#review-volume'); if (slider) slider.value = video.volume; });
      video.addEventListener('ratechange', () => { s.speed = video.playbackRate; const speed = document.querySelector('#review-speed'); if (speed) speed.value = video.playbackRate; });
      // Native video controls can leave focus on the page body after a mouse
      // pause. Keep the next keyboard shortcut anchored to the player so a
      // Space press never scrolls the long review page.
      const focusVideo = () => {
        try { video.focus({ preventScroll: true }); } catch { video.focus(); }
      };
      video.addEventListener('pointerdown', focusVideo, { capture: true });
      video.addEventListener('click', focusVideo);
      const bind = (id, event, fn) => document.querySelector(`#${id}`)?.addEventListener(event, fn);
      bind('review-progress', 'input', (ev) => { video.currentTime = Number(ev.target.value); update(); });
      bind('review-speed', 'change', (ev) => { video.playbackRate = Number(ev.target.value); });
      bind('review-volume', 'input', (ev) => { video.volume = Number(ev.target.value); video.muted = false; });
      bind('review-loop', 'change', (ev) => { video.loop = ev.target.checked; });
      bind('review-fit', 'change', (ev) => { s.fit = ev.target.value; video.style.objectFit = s.fit; });
      document.querySelector('.review-more')?.addEventListener('toggle', ev => { s.moreOpen = ev.target.open; updateWorkspaceSize(); });
      bind('review-episode', 'change', async (ev) => {
        try {
          const key = ev.target.value === '' ? null : Number(ev.target.value);
          if (key != null && await onEpisodeChange?.(key) === false) { ev.target.value = String(selected()?.episode ?? ''); return; }
          s.db = await api.reviewAct(project(), { action: 'assign', videoId: s.selected, episode: ev.target.value }); draw();
        }
        catch (err) { toast(err.message); }
      });
    }
    document.querySelector('#review-video-search')?.addEventListener('input', (ev) => {
      s.search = ev.target.value;
      document.querySelectorAll('[data-review-name]').forEach((el) => { el.hidden = !`${el.dataset.reviewName} ${el.textContent}`.toLowerCase().includes(s.search.toLowerCase()); });
    });
    document.querySelector('#review-note-filter')?.addEventListener('change', (ev) => { s.filter = ev.target.value; refreshNoteList(s); });
    const updateExportCount = () => { const count = document.querySelector('#review-export-count'); if(count)count.textContent = `将导出 ${exportCount(s)} 个视频`; };
    document.querySelector('#review-export-scope')?.addEventListener('change', ev => { s.exportScope = ev.target.value; updateExportCount(); });
    document.querySelector('#review-export-history')?.addEventListener('change', ev => { s.includeHistory = ev.target.checked; updateExportCount(); });
    document.querySelector('#review-notes-search')?.addEventListener('input', (ev) => {
      s.search = ev.target.value;
      if (!ev.isComposing) refreshNoteList(s);
    });
  }
  function updateWorkspaceSize() {
    const workspace = document.querySelector('.review-layout');
    if (!workspace) return;
    const top = workspace.getBoundingClientRect().top + window.scrollY;
    workspace.style.setProperty('--review-workspace-height', Math.max(390, window.innerHeight - top - 14) + 'px');
  }
  window.addEventListener('resize', updateWorkspaceSize);
  document.addEventListener('fullscreenchange', () => {
    const video = document.querySelector('#review-video');
    if (video) video.controls = true;
  });
  function restoreNavigation() {
    updateWorkspaceSize();
    const s = current(), item = document.querySelector('.review-video-item.current');
    const list = item?.closest('.review-video-items');
    if (list && item && !item.hidden && s?.centered !== s.selected) {
      const rect = item.getBoundingClientRect(), box = list.getBoundingClientRect();
      list.scrollTop = Math.max(0, list.scrollTop + rect.top - box.top - (list.clientHeight - rect.height) / 2);
      s.centered = s.selected;
    }
    const rail = document.querySelector('.episode-rail button.current'), scroll = rail?.closest('.episode-rail-scroll');
    if (rail && scroll) {
      const rect = rail.getBoundingClientRect(), box = scroll.getBoundingClientRect();
      scroll.scrollLeft = Math.max(0, scroll.scrollLeft + rect.left - box.left - (scroll.clientWidth - rect.width) / 2);
    }
  }
  async function selectVideo(id) {
    const s = current(), p = project(), item = s?.db?.videos.find(v => v.id === id && !v.missing);
    if (!item || s.switching) return false;
    if (s.selected === id) return true;
    s.switching = true;
    try {
      if (item.episode != null && await onEpisodeChange?.(item.episode) === false) return false;
      if (project()?.projectPath !== p.projectPath) return false;
      s.selected = id; s.draft = s.drafts[id] || {}; draw();
      return true;
    } finally { s.switching = false; }
  }
  document.addEventListener('compositionend',ev=>{if(ev.target.id==='review-notes-search'){const s=current();s.search=ev.target.value;refreshNoteList(s);}});
  document.addEventListener('click',ev=>{const link=ev.target.closest('[data-review-image]');if(!link)return;ev.preventDefault();const focus=document.activeElement;const overlay=document.createElement('div');overlay.className='review-image-overlay';overlay.tabIndex=0;overlay.innerHTML='<button aria-label="关闭截图">×</button><img src="'+e(link.dataset.reviewImage)+'" alt="审片截图"/>';const close=()=>{overlay.remove();if(focus?.isConnected)focus.focus({preventScroll:true});};overlay.addEventListener('click',close);overlay.addEventListener('keydown',event=>{if(event.key==='Escape')close();});document.body.append(overlay);overlay.focus();});
  async function action(name, button) {
    const s = current(), p = project(), video = document.querySelector('#review-video');
    if (!s) return;
    remember();
    const save = async (input) => { s.db = await api.reviewAct(p, input); draw(); };
    if (name === 'folder') {
      const result = await api.reviewChooseFolder(p);
      if (result) { s.db = result; s.selected = result.videos.find((v) => !v.missing)?.id || ''; s.draft = {}; s.search = ''; draw(); }
    } else if (name === 'rescan') await save({ action: 'scan' });
    else if (name === 'select') await selectVideo(button.dataset.videoId);
    else if (name === 'open-video') {
      s.selected = button.dataset.videoId; s.draft = s.drafts[s.selected] || {};
      document.querySelector('[data-view="review"]')?.click();
    }
    else if (name === 'play') { if (video?.paused) await video.play(); else video?.pause(); }
    else if (['back', 'forward', 'frame', 'frame-back'].includes(name) && video) {
      if (name.startsWith('frame')) video.pause();
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + ({ back: -5, forward: 5, frame: 1 / 30, 'frame-back': -1 / 30 }[name])));
    } else if (name === 'mute' && video) video.muted = !video.muted;
    else if (name === 'fullscreen' && video) { if (document.fullscreenElement) await document.exitFullscreen(); else await video.requestFullscreen(); }
    else if (name === 'pip' && video) { if (!document.pictureInPictureEnabled) return toast('当前环境不支持画中画。'); if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }
    else if (name === 'prev' || name === 'next') {
      const list = s.db.videos.filter((v) => !v.missing), i = list.findIndex((v) => v.id === s.selected) + (name === 'next' ? 1 : -1);
      if (i >= 0 && i < list.length) await selectVideo(list[i].id);
    } else if (name === 'external') await api.reviewExternal(p, s.selected);
    else if (name === 'open-folder') await api.reviewOpenFolder(p);
    else if (name === 'note-focus') document.querySelector('#review-note-text')?.focus();
    else if (name === 'capture' && video) {
      if (video.readyState < 2 || !video.videoWidth) return toast('请等待视频画面加载完成。');
      video.pause(); const canvas = document.createElement('canvas'), scale = Math.min(1, 1920 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      s.positions[s.selected] = { seconds: video.currentTime, playing: false };
      s.draft = { ...s.draft, seconds: video.currentTime.toFixed(2), screenshot: canvas.toDataURL('image/png') }; draw();
      document.querySelector('#review-note-text')?.focus();
    } else if (name === 'current-time') { if (video) document.querySelector('#review-note-time').value = video.currentTime.toFixed(2); }
    else if (name === 'clear') {
      if ((s.draft.text || s.draft.prompt) && !await window.directorConfirm('清空未保存的意见，开始新建一条？')) return;
      s.draft = {}; s.drafts[s.selected] = {}; draw();
    }
    else if (name === 'save') {
      if (s.busy) return; s.busy = true;
      const videoId = s.selected, draft = { ...s.draft };
      s.savePromise = api.reviewAct(p, { ...draft, action: 'note', videoId }).then((db) => {
        s.db = db; s.drafts[videoId] = {}; if (s.selected === videoId) s.draft = {}; toast('意见已保存。');
      });
      try { await s.savePromise; }
      finally { s.busy = false; s.savePromise = null; draw(); }
    } else if (['pass', 'pending', 'issue'].includes(name)) await save({ action: 'status', videoId: s.selected, status: { pass: 'passed', pending: 'pending', issue: 'issues' }[name] });
    else if (name === 'resolve') await save({ action: 'resolve', id: button.dataset.id, resolved: button.dataset.resolved === 'true' });
    else if (name === 'delete') { if (await window.directorConfirm('删除这条意见？原截图和历史记录会保留。')) await save({ action: 'delete', id: button.dataset.id }); }
    else if (name === 'edit' || name === 'jump') {
      const note = s.db.notes.find((n) => n.id === button.dataset.id);
      if (!note) return;
      const targetVideo = s.db.videos.find((v) => v.id === note.videoId);
      if (targetVideo?.episode != null && await onEpisodeChange?.(targetVideo.episode) === false) return;
      const sameVideo = s.selected === note.videoId && view?.() === 'review' && document.querySelector('#review-video')?.dataset.videoId === note.videoId;
      s.selected = note.videoId;
      s.positions[s.selected] = { seconds: note.seconds, playing: false };
      s.draft = name === 'edit' ? { ...note, screenshot: '' } : (s.drafts[s.selected] || {});
      skipRemember = true;
      if (view?.() !== 'review') {
        document.querySelector('[data-view="review"]')?.click();
      } else {
        draw();
        if (sameVideo) {
          const nextVideo = document.querySelector('#review-video');
          if (nextVideo && nextVideo.readyState >= 1) {
            nextVideo.pause();
            nextVideo.currentTime = Math.min(note.seconds, Math.max(0, (nextVideo.duration || note.seconds) - 0.001));
          }
        }
        if (name === 'edit') document.querySelector('#review-note-text')?.focus();
      }
    } else if (name === 'export') {
      if(s.exporting)return;
      s.exporting=true;button.disabled=true;button.textContent='正在导出…';
      try {
        const result = await api.reviewExport(p, { scope:s.exportScope, includeHistory:s.includeHistory });
        toast(result.empty ? '这个范围没有可导出的视频，请更换导出范围。' : `已导出“${result.scopeLabel}”：${result.videoCount} 个视频、${result.count} 条记录（Excel、CSV、含截图网页）。`);
      } finally { s.exporting=false; if(button.isConnected){button.disabled=false;button.textContent='导出 Excel / 网页';} }
    }
  }
  document.addEventListener('keydown', (ev) => {
    // The handler is capture-phase and scoped to the review page. This runs
    // before the browser's body scrolling default and before a focused native
    // video control can move the document. Form fields and buttons retain
    // their normal keyboard behaviour.
    const video = document.querySelector('#review-video');
    if (!video || !document.querySelector('.review-view') || document.querySelector('.modal-overlay,.review-image-overlay,dialog[open]') || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const target = ev.target;
    const isEditable = target instanceof Element && target.closest('input,textarea,select,[contenteditable="true"]');
    const isButton = target instanceof Element && target.closest('button,[role="button"]');
    if ((isEditable || isButton) && target !== video) return;
    if (![' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === ' ') {
      if (video.paused) video.play().catch((err) => toast(err.message)); else video.pause();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (ev.key === 'ArrowLeft' ? -5 : 5)));
    } else {
      video.volume = Math.max(0, Math.min(1, video.volume + (ev.key === 'ArrowUp' ? 0.05 : -0.05)));
    }
  }, true);
  const hasDrafts = () => {
    remember();
    return [...sessions.values()].some((s) => Object.values(s.drafts).some((d) => String(d.text || '').trim() || String(d.prompt || '').trim()));
  };
  async function saveDrafts() {
    remember();
    let changed = false;
    for (const s of sessions.values()) {
      if (s.savePromise) await s.savePromise;
      for (const [videoId, draft] of Object.entries(s.drafts)) {
        if (!String(draft.text || '').trim() && !String(draft.prompt || '').trim()) continue;
        s.db = await api.reviewAct(s.projectRef, { ...draft, action: 'note', videoId, seconds: Number(draft.seconds) || 0 });
        s.drafts[videoId] = {}; if (s.selected === videoId) s.draft = {};
        changed = true;
      }
    }
    if (changed) draw();
  }
  async function refreshRemote() {
    const s = current(), p = project();
    if (!s || !p) return;
    const token = {}; s.remoteRefreshToken = token;
    remember();
    const db = await api.reviewLoad(p);
    if (current() !== s || s.remoteRefreshToken !== token || (Date.parse(db.updatedAt || '') || 0) < (Date.parse(s.db?.updatedAt || '') || 0)) return;
    s.db = db;
    if (view() === 'review-notes') {
      refreshNoteList(s);
      const template = document.createElement('template'); template.innerHTML = renderNotes();
      const host = document.querySelector('.review-notes-view .page-heading .hint'), next = template.content.querySelector('.page-heading .hint');
      if (host && next) host.textContent = next.textContent;
      const statuses = document.querySelector('.review-status-list'), latestStatuses = template.content.querySelector('.review-status-list');
      if (statuses && latestStatuses) statuses.innerHTML = latestStatuses.innerHTML;
      else if (latestStatuses) document.querySelector('.review-notes-view')?.append(latestStatuses);
    }
    else if (view() === 'review') {
      if (!document.querySelector('#review-video')) { draw(); return; }
      const v = selected();
      const template = document.createElement('template'); template.innerHTML = renderReview();
      for (const selector of ['.review-video-items', '.review-playlist .card-title']) {
        const host = document.querySelector(selector), next = template.content.querySelector(selector);
        if (host && next) host.innerHTML = next.innerHTML;
      }
      const list = document.querySelector('.review-video-notes');
      if (list && v) list.innerHTML = notesHTML(db.notes.filter(n => n.videoId === v.id).sort((a, b) => a.seconds - b.seconds));
      document.querySelectorAll('.review-video-item').forEach(button => {
        const video = db.videos.find(item => item.id === button.dataset.videoId);
        if (video) button.classList.toggle('has-issues', Boolean(video.openCount || video.needsRevision));
      });
      const pass = document.querySelector('[data-action="review-pass"]');
      if (pass && v) pass.disabled = !canEdit() || Boolean(v.openCount);
      const status = document.querySelector('.review-current-head .badge');
      if (status && v) { status.textContent = statusLabel(v); status.className = 'badge ' + (v.openCount ? 'danger' : v.status === 'passed' ? 'pass' : ''); }
    }
    document.querySelectorAll('.episode-rail [data-episode]').forEach(button => {
      button.querySelector('.review-dot')?.remove();
      const dot = badge(button.dataset.episode); if (dot) button.insertAdjacentHTML('beforeend', dot);
    });
  }
  function selectEpisode(key) {
    const s = current(), video = s?.db?.videos.find((v) => !v.missing && v.episode != null && Number(v.episode) === Number(key));
    if (!video) return;
    remember(); s.selected = video.id; s.draft = s.drafts[s.selected] || {}; skipRemember = true;
  }
  return { summary:()=>{const s=current(),p=project();if(!s?.db||!p)return {loaded:false,open:0};const videos=s.db.videos.filter(v=>!v.missing&&v.episode!=null&&Number(v.episode)===Number(p.currentEpisode));return {loaded:true,open:s.db.notes.filter(n=>!n.resolved&&videos.some(v=>v.id===n.videoId)).length,needsRevision:videos.filter(v=>v.status==='issues'&&!v.openCount).length};},renderReview, renderNotes, beforeRender: remember, afterRender, restoreNavigation, action, badge, load, hasDrafts, saveDrafts, selectEpisode, refreshRemote };
};





