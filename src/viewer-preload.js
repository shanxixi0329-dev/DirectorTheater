const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerApi', {
  getInitialProject: () => ipcRenderer.invoke('viewer:initial'),
  chooseProject: () => ipcRenderer.invoke('viewer:choose-project'),
  refreshProject: (rootPath) => ipcRenderer.invoke('viewer:refresh', rootPath),
  readDocument: (filePath) => ipcRenderer.invoke('viewer:read-document', filePath),
  fileUrl: (filePath) => ipcRenderer.invoke('viewer:file-url', filePath),
  showFile: (filePath) => ipcRenderer.invoke('viewer:show-file', filePath)
});
