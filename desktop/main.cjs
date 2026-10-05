// Savor desktop shell: starts the daemon and shows the UI in its own window.
// The window keeps a persistent browser session, so logins inside previews and links survive restarts.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const PORT = Number(process.env.SAVOR_PORT ?? 4317)
const HOME = process.env.SAVOR_HOME ?? path.join(os.homedir(), '.savor')
let daemon = null
let win = null

const portOpen = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => (s.end(), resolve(true)))
    s.on('error', () => resolve(false))
  })

// Apps started from a desktop launcher don't see the PATH of the user's shell, where agent CLIs
// like claude or codex usually live.
function shellPath() {
  if (process.platform === 'win32') return process.env.PATH
  try {
    const out = execFileSync(process.env.SHELL || '/bin/bash', ['-ilc', 'printf "__SAVOR__%s__SAVOR__" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.match(/__SAVOR__(.*)__SAVOR__/)?.[1] || process.env.PATH
  } catch {
    return process.env.PATH
  }
}

function daemonEnv() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SAVOR_PORT: String(PORT), PATH: shellPath() }
  // Inside an AppImage, library paths point into the image and break tools the agents run.
  if (process.env.APPDIR) for (const key of ['LD_LIBRARY_PATH', 'PYTHONHOME', 'PYTHONPATH']) if (env[key]?.includes(process.env.APPDIR)) delete env[key]
  return env
}

const daemonEntry = () => (app.isPackaged ? path.join(process.resourcesPath, 'savor', 'server', 'index.mjs') : path.join(__dirname, '..', 'bin', 'savor.js'))

async function ensureDaemon() {
  if (await portOpen()) return
  daemon = spawn(process.execPath, [daemonEntry()], { env: daemonEnv(), stdio: 'inherit' })
  for (let i = 0; i < 100 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 100))
}

// Electron shows no context menu on its own; this one offers what a browser would for links, images, selections and fields.
function contextMenu(contents, params) {
  const groups = []
  if (params.misspelledWord) {
    const fixes = params.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }))
    groups.push(fixes.length ? fixes : [{ label: 'No suggestions', enabled: false }])
  }
  if (params.linkURL)
    groups.push([
      { label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
      { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
    ])
  if (params.mediaType === 'image')
    groups.push([
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
    ])
  const flags = params.editFlags
  if (params.isEditable)
    groups.push([
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { role: 'selectAll', enabled: flags.canSelectAll },
    ])
  else if (params.selectionText.trim()) groups.push([{ role: 'copy' }])
  return Menu.buildFromTemplate(groups.flatMap((group, i) => (i ? [{ type: 'separator' }, ...group] : group)))
}

async function createWindow() {
  await ensureDaemon()
  const stateFile = path.join(HOME, 'state.json')
  if (!(await portOpen()) || !fs.existsSync(stateFile)) {
    dialog.showErrorBox('Savor could not start', 'The Savor daemon did not come up. Start the app from a terminal to see its output.')
    return app.quit()
  }
  const { token } = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  win = new BrowserWindow({ width: 1500, height: 950, backgroundColor: '#121212', title: 'Savor', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs') } })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('context-menu', (_e, params) => {
    const menu = contextMenu(win.webContents, params)
    if (menu.items.length) menu.popup({ window: win })
  })
  win.loadURL(`http://localhost:${PORT}/?token=${token}`)
}

// Release builds carry app-update.yml pointing at GitHub Releases; AppImage, dmg and exe update themselves.
const updater = () => (app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')) ? require('electron-updater').autoUpdater : null)

// What preload.cjs offers the UI. Only the Savor page itself may ask.
const fromUi = (e) => new URL(e.senderFrame.url).origin === `http://localhost:${PORT}`
ipcMain.handle('pick-folder', async (e) => (fromUi(e) ? ((await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? null) : null))
// Resolves to the newer version, which then downloads and installs on quit, or to null when this one is current.
let download = null
ipcMain.handle('check-for-updates', async (e) => {
  const result = fromUi(e) ? await updater()?.checkForUpdates() : null
  if (!result?.isUpdateAvailable) return null
  download = result.downloadPromise
  return result.updateInfo.version
})
// Waits for the download, then replaces the app and starts it again.
ipcMain.handle('install-update', async (e) => {
  if (!fromUi(e) || !download) return
  await download
  updater().quitAndInstall()
})

// `--daemon`: only the daemon, without a window, e.g. as a system service. The AppImage then is the
// installation: the daemon exits once the AppImage was replaced by an update and no agent is working,
// and the service manager starts the new version. Running it synchronously keeps Electron from
// initializing a display.
if (process.argv.includes('--daemon')) {
  const env = { ...daemonEnv(), ...(process.env.APPIMAGE && { SAVOR_EXIT_ON_UPDATE: process.env.APPIMAGE }) }
  process.exit(spawnSync(process.execPath, [daemonEntry()], { env, stdio: 'inherit' }).status ?? 1)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
  app.whenReady().then(() => {
    createWindow()
    const autoUpdater = updater()
    if (autoUpdater) {
      autoUpdater.on('error', (e) => console.error('Update check failed:', e.message))
      autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    }
  })
  app.on('window-all-closed', () => app.quit())
  app.on('quit', () => daemon?.kill())
}
