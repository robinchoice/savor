// What the Savor UI can ask the desktop shell for: the system's folder dialog and updates.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('savorDesktop', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  // Calls back with the version once a new release is downloaded and ready to install.
  onUpdateReady: (cb) => {
    ipcRenderer.on('update-ready', (_e, version) => cb(version))
    ipcRenderer.invoke('ready-update').then((version) => version && cb(version))
  },
})
