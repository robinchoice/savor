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
  // While set, the context menu offers to run the selected or copied text; cb gets the command. null withdraws it.
  setRunInTerminal: (cb) => {
    ipcRenderer.removeAllListeners('run-in-terminal')
    if (cb) ipcRenderer.on('run-in-terminal', (_e, command) => cb(command))
    ipcRenderer.send('run-in-terminal-available', !!cb)
  },
})
