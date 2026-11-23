'use strict';
const path = require('node:path');
const labels = {
  'director-home': '制作总览', 'shot-studio': '镜头工作台', generate: '生成', project: '项目文件',
  outline: '大纲', script: '剧本', shotlist: '分镜', storyboard: '提示词', 'quality-center': '检查与优化',
  assets: '素材', 'html-relationships': '人物关系网', 'html-assets': '素材可视化', 'html-post': '后期剪辑可视化',
  'html-other': '其他 HTML 资料', review: '审片', 'review-notes': '审片意见', rules: '规则与设置',
  home: '首页', workbench: '工作台', production: '制作', quality: '检查', export: '导出'
};
function createWorkspaceWindows({ BrowserWindow, screen, dialog, smokeMode, beforeClose, isBusy, isWindowBusy = () => false, cancelWork, onClosed }) {
  const windows = new Map();
  let sequence = 0;
  const get = sender => [...windows.values()].find(entry => entry.win.webContents === sender);
  const live = () => [...windows.values()].filter(entry => !entry.win.isDestroyed());
  function broadcast(channel, payload, except) {
    for (const { win } of live()) if (win.webContents.id !== except) win.webContents.send(channel, payload);
  }
  function list() {
    const displays = screen.getAllDisplays();
    return live().map(({ win, meta, number }) => ({ id: win.id, number, ...meta, focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(),
      screen: displays.findIndex(display => display.id === screen.getDisplayMatching(win.getBounds()).id) + 1 }));
  }
  function announce() { broadcast('workspace:windows', list()); }
  function update(sender, value = {}) {
    const entry = get(sender);
    if (!entry) return;
    entry.meta = { projectPath: String(value.projectPath || ''), title: String(value.title || '').slice(0, 150),
      view: labels[value.view] ? value.view : 'script', episode: String(value.episode || '').slice(0, 24), currentEpisode: Number(value.currentEpisode) || null };
    entry.win.setTitle([entry.meta.title, entry.meta.episode ? '第' + entry.meta.episode + '集' : '', labels[entry.meta.view], '导演台剧场 V0.1.12'].filter(Boolean).join(' · '));
    announce();
  }
  async function create(input = {}, sender) {
    const origin = get(sender)?.win;
    const cursor = screen.getCursorScreenPoint();
    if (input.dragOut && origin) {
      const b = origin.getBounds();
      if (cursor.x >= b.x && cursor.x <= b.x + b.width && cursor.y >= b.y && cursor.y <= b.y + b.height) return null;
    }
    const bootstrap = { projectPath: typeof input.projectPath === 'string' ? input.projectPath : '',
      view: labels[input.view] ? input.view : 'director-home', episode: Number(input.episode) || null };
    const area = (input.dragOut ? screen.getDisplayNearestPoint(cursor) : origin ? screen.getDisplayMatching(origin.getBounds()) : screen.getPrimaryDisplay()).workArea;
    const previous = origin?.getBounds();
    const width = Math.min(previous?.width || 1480, area.width), height = Math.min(previous?.height || 940, area.height);
    const x = Math.max(area.x, Math.min(input.dragOut ? cursor.x - width / 2 : (previous?.x ?? area.x) + 32, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(input.dragOut ? cursor.y - 32 : (previous?.y ?? area.y) + 32, area.y + area.height - height));
    const win = new BrowserWindow({ icon: path.join(__dirname, 'assets/brand-v008/app-icon.ico'),
      x: Math.round(x), y: Math.round(y), width, height, minWidth: Math.min(860, area.width), minHeight: Math.min(620, area.height),
      backgroundColor: '#151817', titleBarStyle: 'hiddenInset', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false } });
    const entry = { win, bootstrap, meta: { view: bootstrap.view, projectPath: bootstrap.projectPath }, number: ++sequence, allowed: false, prompting: false };
    const senderId = win.webContents.id;
    windows.set(win.id, entry);
    win.on('app-command', (_event, command) => {
      const direction = command === 'browser-backward' ? -1 : command === 'browser-forward' ? 1 : 0;
      if (direction && !win.webContents.isDestroyed()) win.webContents.send('workspace:episode-step', direction);
    });
    for (const event of ['focus', 'hide', 'show', 'minimize', 'restore', 'moved']) win.on(event, announce);
    const windowId = win.id;
    win.on('closed', () => { windows.delete(windowId); onClosed(win, senderId); announce(); });
    win.on('close', event => {
      if (entry.allowed || smokeMode) return;
      event.preventDefault();
      if (entry.prompting) return;
      entry.prompting = true;
      void (async () => {
        try {
          const state = await win.webContents.executeJavaScript('typeof directorCloseState === "function" ? directorCloseState() : ({dirty:false,running:false})');
          const last = live().length === 1;
          if (state.running || isWindowBusy(win) || (last && isBusy())) {
            const choice = await dialog.showMessageBox(win, { type: 'warning', title: '任务仍在运行', message: last ? '当前窗口仍有关联任务，关闭会中断任务。' : '当前窗口仍有关联任务，可以隐藏窗口并继续运行。',
              buttons: ['继续运行', last ? '停止任务并关闭' : '隐藏窗口，后台运行'], defaultId: 0, cancelId: 0, noLink: true });
            if (choice.response !== 1) return;
            if (!last) { win.hide(); return; }
            cancelWork();
          }
          if (state.dirty) {
            const choice = await dialog.showMessageBox(win, { type: 'question', title: '保存修改后关闭窗口？',
              message: '第 ' + (state.episodeLabel || '') + ' 集还有未保存的修改。', detail: '其他窗口会继续保留。',
              buttons: ['保存并关闭', '不保存关闭', '取消'], defaultId: 0, cancelId: 2, noLink: true });
            if (choice.response === 2) return;
            if (choice.response === 0) await win.webContents.executeJavaScript('directorSaveBeforeClose()');
          }
          await beforeClose();
          entry.allowed = true;
          win.close();
        } catch (error) {
          if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'error', title: '窗口尚未关闭',
            message: '请先处理未完成的保存。', detail: error.message || String(error), buttons: ['确定'] });
        } finally { entry.prompting = false; }
      })();
    });
    // Native Reload and Ctrl+R also pass through beforeunload. Keep drafts and
    // running tasks protected even when the application menu initiates reload.
    win.webContents.on('will-prevent-unload', event => {
      if (entry.allowed || entry.allowReload) { event.preventDefault(); return; }
      if (entry.prompting) return;
      entry.prompting = true;
      void (async () => {
        try {
          const state = await win.webContents.executeJavaScript('directorCloseState()');
          if (state.running || isWindowBusy(win)) {
            await dialog.showMessageBox(win, { type: 'info', title: '任务仍在运行', message: '当前窗口还有任务，请等待任务完成后再刷新。', buttons: ['继续工作'] });
            return;
          }
          const choice = await dialog.showMessageBox(win, { type: 'question', title: '保存修改后刷新？', message: '当前窗口还有未保存的修改。',
            buttons: ['保存并刷新', '不保存刷新', '取消'], defaultId: 0, cancelId: 2, noLink: true });
          if (choice.response === 2) return;
          if (choice.response === 0) await win.webContents.executeJavaScript('directorSaveBeforeClose()');
          await beforeClose(); entry.allowReload = true; win.webContents.reload();
        } catch (error) {
          if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'error', title: '刷新尚未完成', message: '修改已保留，请先处理保存问题。', detail: error.message, buttons: ['确定'] });
        } finally { entry.prompting = false; }
      })();
    });
    win.webContents.on('did-finish-load', () => { entry.allowReload = false; });
    win.webContents.once('did-fail-load', (_event, code, description) => { if (smokeMode) { console.error(code, description); require('electron').app.exit(1); } });
    win.webContents.once('did-finish-load', () => { if (smokeMode) setTimeout(() => win.close(), 250); });
    await win.loadFile(path.join(__dirname, 'renderer/index.html'));
    if (!smokeMode && !win.isDestroyed()) win.show();
    announce();
    return win;
  }
  function moveToNextScreen(sender) {
    const win = get(sender)?.win;
    if (!win) return false;
    const displays = screen.getAllDisplays();
    if (displays.length < 2) return false;
    const current = screen.getDisplayMatching(win.getBounds());
    const target = displays[(displays.findIndex(display => display.id === current.id) + 1) % displays.length].workArea;
    if (win.isMaximized()) win.unmaximize();
    const bounds = win.getBounds(), width = Math.min(bounds.width, target.width), height = Math.min(bounds.height, target.height);
    win.setBounds({ x: target.x + Math.round((target.width - width) / 2), y: target.y + Math.round((target.height - height) / 2), width, height });
    win.show(); win.focus(); return true;
  }
  // A disconnected display must not strand an open project off screen.
  screen.on('display-removed', () => { for (const { win } of live()) {
    const bounds = win.getBounds(), visible = screen.getAllDisplays().some(({ workArea: a }) => bounds.x < a.x + a.width && bounds.y < a.y + a.height && bounds.x + bounds.width > a.x && bounds.y + bounds.height > a.y);
    if (!visible) { const a = screen.getPrimaryDisplay().workArea; win.setBounds({ x: a.x, y: a.y, width: Math.min(bounds.width, a.width), height: Math.min(bounds.height, a.height) }); }
  } });
  return { create, get, live, list, update, broadcast, moveToNextScreen, labels };
}
module.exports = { createWorkspaceWindows };
