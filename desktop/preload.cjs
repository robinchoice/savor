// What the Savor UI can ask the desktop shell for: the system's folder dialog, updates and the context menu.
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
  // While a project is shown, the context menu offers actions for its folder; cb gets the chosen one. null withdraws them.
  setContextActions: (root, cb) => {
    ipcRenderer.removeAllListeners('context-action')
    if (cb) ipcRenderer.on('context-action', (_e, action, value) => cb(action, value))
    ipcRenderer.send('context-actions', root)
  },
})
