const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('practiceDesktop', {
  setNeedsSave: value => ipcRenderer.send('practice:needs-save', value),
});
