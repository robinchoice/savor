// What the Savor UI can ask the desktop shell for: the system's folder dialog and file manager, updates, notifications,
// the context menu and the computers the app is paired with. The pages of other computers and the connect page get no
// access to this computer's files, so only this computer's page sees the folder dialog, the file manager and the context menu.
const { contextBridge, ipcRenderer } = require('electron')

const local = ipcRenderer.sendSync('is-local')

contextBridge.exposeInMainWorld('savorDesktop', {
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  // Calls back with the version once a new release is downloaded and ready to install.
  onUpdateReady: (cb) => {
    ipcRenderer.on('update-ready', (_e, version) => cb(version))
    ipcRenderer.invoke('ready-update').then((version) => version && cb(version))
  },
  // Shows a system notification; a click brings the window to the front and calls back with its hash.
  notify: (options) => ipcRenderer.send('notify', options),
  onOpen: (cb) => ipcRenderer.on('open', (_e, hash) => cb(hash)),
  // The computers: this one unless the app is only a client, and the paired ones. `current` is the one shown.
  computers: () => ipcRenderer.invoke('computers'),
  openComputer: (id) => ipcRenderer.send('open-computer', id),
  // Opens a pairing link in the window; false when it is none.
  pairComputer: (link) => ipcRenderer.invoke('pair-computer', link),
  forgetComputer: (id) => ipcRenderer.invoke('forget-computer', id),
  setServer: (on) => ipcRenderer.invoke('set-server', on),
  // The page tells which computer it reached, once it is in.
  connected: (info) => ipcRenderer.send('connected', info),
  deviceName: () => ipcRenderer.invoke('device-name'),
  ...(local && {
    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    // Shows a file or folder outside the projects in the system's file manager.
    showPath: (path) => ipcRenderer.send('show-path', path),
    // While a project is shown, the context menu offers actions for its folder; cb gets the chosen one. null withdraws them.
    setContextActions: (root, cb) => {
      ipcRenderer.removeAllListeners('context-action')
      if (cb) ipcRenderer.on('context-action', (_e, action, value) => cb(action, value))
      ipcRenderer.send('context-actions', root)
    },
  }),
})
