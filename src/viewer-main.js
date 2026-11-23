const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { pathInside, readDocument, scanProject } = require('./viewer/project-reader');

const smokeMode = process.argv.includes('--smoke');
let mainWindow = null;
let activeRoot = '';
let settingsPath = '';

async function readSettings() {
  try { return JSON.parse(await fs.readFile(settingsPath, 'utf8')); } catch { return {}; }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

async function openProject(rootPath, remember = true) {
  const project = await scanProject(rootPath);
  activeRoot = project.rootPath;
  if (remember && !smokeMode) await writeSettings({ lastProjectPath: activeRoot });
  return project;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: !smokeMode,
    backgroundColor: '#f4f2ec',
    title: '导演台剧场 · 阅读版',
    icon: path.join(__dirname, 'assets', 'app-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'viewer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('viewer:initial', async () => {
    const smokeRoot = process.env.DIRECTOR_VIEWER_SMOKE_ROOT;
    const settings = await readSettings();
    const rootPath = smokeRoot || settings.lastProjectPath;
    if (!rootPath) return null;
    try { return await openProject(rootPath, !smokeRoot); } catch { return null; }
  });
  ipcMain.handle('viewer:choose-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要阅读的漫剧项目文件夹',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return openProject(result.filePaths[0]);
  });
  ipcMain.handle('viewer:refresh', async (_event, rootPath) => openProject(rootPath || activeRoot));
  ipcMain.handle('viewer:read-document', async (_event, filePath) => {
    if (!activeRoot) throw new Error('请先选择项目文件夹。');
    return readDocument(activeRoot, filePath);
  });
  ipcMain.handle('viewer:file-url', async (_event, filePath) => {
    if (!activeRoot || !pathInside(activeRoot, filePath)) throw new Error('只能预览当前项目文件夹内的素材。');
    return pathToFileURL(filePath).href;
  });
  ipcMain.handle('viewer:show-file', async (_event, filePath) => {
    if (!activeRoot || !pathInside(activeRoot, filePath)) return false;
    shell.showItemInFolder(filePath);
    return true;
  });
}

app.setName('导演台剧场阅读版');
app.whenReady().then(async () => {
  settingsPath = path.join(app.getPath('userData'), 'viewer-settings.json');
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  if (smokeMode) {
    try {
      const rootPath = process.env.DIRECTOR_VIEWER_SMOKE_ROOT;
      if (!rootPath) throw new Error('缺少 DIRECTOR_VIEWER_SMOKE_ROOT。');
      const project = await openProject(rootPath, false);
      const allDocuments = Object.values(project.documents).flat();
      const first = allDocuments[0];
      if (!first) throw new Error('没有识别到可阅读文档。');
      await readDocument(project.rootPath, first.path);
      console.log(`VIEWER_SMOKE_OK project=${project.name} documents=${allDocuments.length} episodes=${project.episodes.length}`);
      setTimeout(() => app.exit(0), 500);
    } catch (error) {
      console.error('VIEWER_SMOKE_FAILED ' + (error?.stack || error));
      setTimeout(() => app.exit(1), 100);
    }
  }
});

app.on('window-all-closed', () => app.quit());
