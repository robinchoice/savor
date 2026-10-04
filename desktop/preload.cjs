// What the Savor UI can ask the desktop shell for: the system's folder dialog and an update check.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('savorDesktop', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
})
