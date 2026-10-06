// Savor desktop shell: starts the daemon and shows the UI in its own window.
// The window keeps a persistent browser session, so logins inside previews and links survive restarts.
const { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, shell } = require('electron')
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
  // The selection, or else the clipboard, goes to the open project: run in its terminal (several lines
  // are only pasted), quoted in its conversation, or opened in Files when it names one of its files.
  const text = projectRoot && (params.selectionText.trim() || clipboard.readText().trim())
  if (text) {
    const first = text.split('\n')[0]
    const shown = first.length > 40 || text.includes('\n') ? `${first.slice(0, 40)}…` : first
    const send = (action, value) => () => contents.send('context-action', action, value)
    const file = projectFile(projectRoot, text)
    groups.push([
      ...(file ? [{ label: `Open “${shown}” in Files`, click: send('open', file) }] : []),
      { label: `Quote “${shown}” in Conversation`, click: send('quote', text) },
      { label: text.includes('\n') ? `Paste “${shown}” into Terminal` : `Run “${shown}” in Terminal`, click: send('terminal', text) },
    ])
  }
  return Menu.buildFromTemplate(groups.flatMap((group, i) => (i ? [{ type: 'separator' }, ...group] : group)))
}

// A file of the project named like `src/app.ts:42:7`, absolute or relative to the project folder.
function projectFile(root, text) {
  const m = text.match(/^(\S+?)(?::(\d+))?(?::\d+)?$/)
  if (!m) return null
  const file = path.resolve(root, m[1])
  const rel = path.relative(root, file)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  try {
    if (!fs.statSync(file).isFile()) return null
  } catch {
    return null
  }
  return { path: rel.split(path.sep).join('/'), line: m[2] ? Number(m[2]) : null }
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
// The folder of the project the UI shows, which the context menu offers actions for.
let projectRoot = null
ipcMain.on('context-actions', (e, root) => fromUi(e) && (projectRoot = typeof root === 'string' ? root : null))
// Notifications are shown from here because only the shell can bring its window to the front on a click.
// They stay referenced until closed, otherwise the click is lost; the same tag replaces the older one.
const notifications = new Map()
ipcMain.on('notify', (e, { title, body, hash, tag }) => {
  if (!fromUi(e)) return
  notifications.get(tag)?.close()
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('open', hash)
  })
  n.on('close', () => notifications.get(tag) === n && notifications.delete(tag))
  notifications.set(tag, n)
  n.show()
})
ipcMain.handle('pick-folder', async (e) => (fromUi(e) ? ((await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? null) : null))
// The version of a release that finished downloading and waits to be installed.
let ready = null
ipcMain.handle('ready-update', (e) => (fromUi(e) ? ready : null))
// Resolves to the newer version, which then downloads in the background, or to null when this one is current.
let download = null
ipcMain.handle('check-for-updates', async (e) => {
  const result = fromUi(e) ? await updater()?.checkForUpdates() : null
  if (!result?.isUpdateAvailable) return null
  download = result.downloadPromise
  return result.updateInfo.version
})
// Waits for the download, then replaces the app and starts it again without asking.
ipcMain.handle('install-update', async (e) => {
  if (!fromUi(e) || !(ready || download)) return
  await download
  updater().quitAndInstall(true, true)
})

// Checks for a new release on start and every ten minutes. It downloads in the background, then the UI
// offers to install it; otherwise it installs on the next quit.
function watchUpdates() {
  const autoUpdater = updater()
  if (!autoUpdater) return
  autoUpdater.on('error', (e) => console.error('Update check failed:', e.message))
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version
    win?.webContents.send('update-ready', ready)
  })
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, 10 * 60_000)
}

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
    watchUpdates()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('quit', () => daemon?.kill())
}
