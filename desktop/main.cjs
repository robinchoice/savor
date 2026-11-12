// Savor desktop shell: starts this computer's daemon and shows its UI, or the UI of another computer paired with the app.
// The window keeps a persistent browser session, so logins inside previews and links survive restarts.
const { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, shell } = require('electron')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { checkForUpdate } = require('./updates.cjs')
const computers = require('./computers.cjs')

const PORT = Number(process.env.SAVOR_PORT ?? 4317)
const HOME = process.env.SAVOR_HOME ?? path.join(os.homedir(), '.savor')
const LOCAL_ORIGIN = `http://localhost:${PORT}`
const CONNECT_PAGE = path.join(__dirname, 'connect.html')
const CONNECT_URL = pathToFileURL(CONNECT_PAGE).href
let daemon = null
let win = null
// The paired computers (computers.cjs), the one the window shows (null: the connect page), and the
// origin of a pairing link just opened, which may show until its computer is in.
let state = null
let showing = null
let pending = null
const computersFile = () => path.join(app.getPath('userData'), 'computers.json')
const setState = (next) => {
  state = next
  computers.save(computersFile(), state)
}

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
  // Installed apps send the anonymous daily usage ping (server/usage.ts), builds run from source don't.
  if (app.isPackaged) env.SAVOR_USAGE_URL ??= 'https://savor.diespaetzles.lol/usage'
  // Inside an AppImage, library paths point into the image and break tools the agents run.
  if (process.env.APPDIR) for (const key of ['LD_LIBRARY_PATH', 'PYTHONHOME', 'PYTHONPATH']) if (env[key]?.includes(process.env.APPDIR)) delete env[key]
  return env
}

const daemonEntry = () => (app.isPackaged ? path.join(process.resourcesPath, 'savor', 'server', 'index.mjs') : path.join(__dirname, '..', 'bin', 'savor.js'))

// One start at a time, also when the window and the app's start both ask for it.
let starting = null
async function ensureDaemon() {
  if (await portOpen()) return true
  starting ??= (async () => {
    daemon ??= spawn(process.execPath, [daemonEntry()], { env: daemonEnv(), stdio: 'inherit' }).on('exit', () => (daemon = null))
    for (let i = 0; i < 100 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 100))
    starting = null
    return portOpen()
  })()
  return starting
}

// Electron shows no context menu on its own; this one offers what a browser would for links, images, selections and fields.
async function contextMenu(contents, params) {
  const groups = []
  if (params.misspelledWord) {
    const fixes = params.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }))
    groups.push(fixes.length ? fixes : [{ label: 'No suggestions', enabled: false }])
  }
  if (params.linkURL)
    groups.push([
      { label: 'Open Link in Browser', click: () => openOutside(params.linkURL) },
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
  // Or it goes to a conversation in another project, picked in a dialog of the UI.
  const text = projectRoot && accessOf(computers.originOf(contents.getURL())) === 'local' && (params.selectionText.trim() || (await clipboard.readText()).trim())
  if (text) {
    const first = text.split('\n')[0]
    const shown = first.length > 40 || text.includes('\n') ? `${first.slice(0, 40)}…` : first
    const send = (action, value) => () => contents.send('context-action', action, value)
    const file = projectFile(projectRoot, text)
    groups.push([
      ...(file ? [{ label: `Open “${shown}” in Files`, click: send('open', file) }] : []),
      { label: `Quote “${shown}” in Conversation`, click: send('quote', text) },
      { label: `Run “${shown}” in Another Project…`, click: send('elsewhere', text) },
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

// The window shows one computer at a time: this one, a paired one, or the connect page to pair one.
function createWindow() {
  win = new BrowserWindow({ width: 1500, height: 950, backgroundColor: '#121212', title: 'Savor', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs') } })
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  // A link to another site opens in the browser; the window itself never leaves Savor, it has no way back.
  const stayInSavor = (e) => {
    if (accessOf(computers.originOf(e.url))) return
    e.preventDefault()
    openOutside(e.url)
  }
  win.webContents.on('will-navigate', stayInSavor)
  win.webContents.on('will-redirect', stayInSavor)
  // Leaving the page of a pairing link ends its trust, whether its computer came in or not.
  win.webContents.on('did-navigate', (_e, url) => computers.originOf(url) !== pending && (pending = null))
  // A computer that can't be reached leads to the connect page, with the others to choose from.
  win.webContents.on('did-fail-load', (_e, code, _description, url, mainFrame) => {
    if (!mainFrame || code === -3 || url.startsWith('file:')) return
    const origin = computers.originOf(url)
    openConnect({ error: 'unreachable', name: state.computers.find((c) => computers.originOf(c.url) === origin)?.name ?? new URL(url).host })
  })
  win.webContents.on('context-menu', async (_e, params) => {
    const menu = await contextMenu(win.webContents, params)
    if (menu.items.length) menu.popup({ window: win })
  })
}

const openOutside = (url) => /^(https?|mailto):/.test(url) && shell.openExternal(url)

async function openLocal() {
  showing = computers.LOCAL
  const stateFile = path.join(HOME, 'state.json')
  if (!(await ensureDaemon()) || !fs.existsSync(stateFile)) return openConnect({ error: 'local' })
  const { token } = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  win.loadURL(`${LOCAL_ORIGIN}/?token=${token}`)
}

function openComputer(id) {
  if (id === computers.LOCAL && state.server) return openLocal()
  const computer = state.computers.find((c) => c.id === id)
  if (!computer) return openConnect()
  showing = computer.id
  win.loadURL(computer.url)
}

function openConnect(query = {}) {
  showing = null
  win.loadFile(CONNECT_PAGE, { query })
}

// Release builds carry app-update.yml pointing at GitHub Releases; AppImage, dmg and exe update themselves.
const updater = () => (app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')) ? require('electron-updater').autoUpdater : null)

// What preload.cjs offers the UI (computers.access). This computer's page may ask for everything. Paired computers
// and the connect page only for what doesn't touch this computer's files and programs: notifications, updates and
// the computers. The page of a pairing link only learns and switches between the computers, it changes none.
const senderOrigin = (e) => computers.originOf(e.senderFrame.url)
const accessOf = (origin) => computers.access(state, origin, { local: LOCAL_ORIGIN, pending })
const fromConnect = (e) => e.senderFrame.url.split('?')[0] === CONNECT_URL
const fromUi = (e) => accessOf(senderOrigin(e)) === 'local'
const fromComputer = (e) => fromConnect(e) || ['local', 'computer'].includes(accessOf(senderOrigin(e)))
const fromSavor = (e) => fromConnect(e) || accessOf(senderOrigin(e)) !== null
ipcMain.on('is-local', (e) => (e.returnValue = fromUi(e)))
// The folder of the project the UI shows, which the context menu offers actions for.
let projectRoot = null
ipcMain.on('context-actions', (e, root) => fromUi(e) && (projectRoot = typeof root === 'string' ? root : null))
// Notifications are shown from here because only the shell can bring its window to the front on a click.
// They stay referenced until closed, otherwise the click is lost; the same tag replaces the older one.
const notifications = new Map()
// A click opens the conversation only while the window still shows the computer it came from.
ipcMain.on('notify', (e, { title, body, hash, tag }) => {
  if (!fromSavor(e)) return
  const from = senderOrigin(e)
  notifications.get(tag)?.close()
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (computers.originOf(win.webContents.getURL()) === from) win.webContents.send('open', hash)
  })
  n.on('close', () => notifications.get(tag) === n && notifications.delete(tag))
  notifications.set(tag, n)
  n.show()
})
// A folder opens in the file manager, a file is only revealed there: opening it could run it.
ipcMain.on('show-path', (e, file) => {
  if (!fromUi(e) || typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) return
  if (fs.statSync(file).isDirectory()) shell.openPath(file)
  else shell.showItemInFolder(file)
})
ipcMain.handle('pick-folder', async (e) => (fromUi(e) ? ((await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? null) : null))
// The version of a release that finished downloading and waits to be installed.
let ready = null
ipcMain.handle('ready-update', (e) => (fromSavor(e) ? ready : null))
// Resolves to the newer version, which then downloads in the background, or to null when this one is current.
let download = null
ipcMain.handle('check-for-updates', async (e) => {
  const autoUpdater = fromSavor(e) && updater()
  const found = autoUpdater ? await checkForUpdate(autoUpdater, ready) : null
  if (!found) return null
  download = found.download
  return found.version
})
// Waits for the download, then replaces the app and starts it again without asking.
ipcMain.handle('install-update', async (e) => {
  if (!fromSavor(e) || !(ready || download)) return
  await download
  updater().quitAndInstall(true, true)
})

// ---- other computers ----

// The page of a computer reports it once it is in; a paired computer is added to the list then.
ipcMain.on('connected', (e, info) => {
  const origin = senderOrigin(e)
  const access = accessOf(origin)
  if (access === 'local') {
    showing = computers.LOCAL
    if (state.last !== computers.LOCAL) setState({ ...state, last: computers.LOCAL })
    return
  }
  if (!access || typeof info !== 'object' || !info) return
  const computer = computers.computerAt(origin, info)
  showing = computer.id
  pending = null
  setState(computers.remember(state, computer))
})
ipcMain.handle('computers', (e) => {
  if (!fromSavor(e)) return null
  const local = state.server ? [{ id: computers.LOCAL, name: os.hostname(), via: 'local' }] : []
  return { server: state.server, current: showing, list: [...local, ...state.computers.map(({ id, name, via }) => ({ id, name, via }))] }
})
ipcMain.on('open-computer', (e, id) => fromSavor(e) && openComputer(id))
// Opens a pairing link in the window; the computer's own page pairs. Resolves to false for anything else.
ipcMain.handle('pair-computer', (e, link) => {
  const url = fromComputer(e) && computers.pairingUrl(link)
  if (!url) return false
  pending = computers.originOf(url)
  showing = null
  win.loadURL(url)
  return true
})
// Forgets a computer in this app. A direct one also loses its login here; the relay keeps the device key,
// which serves every computer paired through it.
ipcMain.handle('forget-computer', async (e, id) => {
  const computer = fromComputer(e) && state.computers.find((c) => c.id === id)
  if (!computer) return
  setState(computers.forget(state, id))
  if (computer.via === 'direct') await win.webContents.session.clearStorageData({ origin: computers.originOf(computer.url) })
  if (showing === id) openStart()
})
// Off, the app starts no Savor of its own and is only a client of the paired computers.
ipcMain.handle('set-server', (e, on) => {
  if (!fromComputer(e)) return
  setState({ ...state, server: on === true })
  if (state.server) ensureDaemon()
  else if (showing === computers.LOCAL) openStart()
})
ipcMain.handle('device-name', (e) => (fromSavor(e) ? os.hostname() : null))

function openStart() {
  const id = computers.startId(state)
  if (id === null) openConnect()
  else openComputer(id)
}

// Checks for a new release on start and every ten minutes. It downloads in the background, then the UI
// offers to install it; otherwise it installs on the next quit. Switched off in the settings, only a
// check from the UI downloads, and only its "Install and restart" installs.
const autoUpdate = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).autoUpdate !== false
  } catch {
    return true
  }
}
function watchUpdates() {
  const autoUpdater = updater()
  if (!autoUpdater) return
  autoUpdater.on('error', (e) => console.error('Update check failed:', e.message))
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version
    win?.webContents.send('update-ready', ready)
  })
  app.on('before-quit', () => (autoUpdater.autoInstallOnAppQuit = autoUpdate()))
  const check = () =>
    autoUpdate() &&
    checkForUpdate(autoUpdater, ready)
      .then((found) => found?.download?.catch(() => {}))
      .catch(() => {})
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
    state = computers.load(computersFile())
    createWindow()
    // This computer's Savor runs while the app is open, whichever computer it shows: its workflows keep their schedule.
    if (state.server) ensureDaemon()
    openStart()
    watchUpdates()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('quit', () => daemon?.kill())
}
