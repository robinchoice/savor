// Savor desktop shell: starts the daemon and shows the UI in its own window.
// The window keeps a persistent browser session, so logins inside previews and links survive restarts.
const { app, BrowserWindow, dialog, shell } = require('electron')
const { execFileSync, spawn } = require('node:child_process')
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

async function ensureDaemon() {
  if (await portOpen()) return
  const entry = app.isPackaged ? path.join(process.resourcesPath, 'savor', 'server', 'index.mjs') : path.join(__dirname, '..', 'bin', 'savor.js')
  daemon = spawn(process.execPath, [entry], { env: daemonEnv(), stdio: 'inherit' })
  for (let i = 0; i < 100 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 100))
}

async function createWindow() {
  await ensureDaemon()
  const stateFile = path.join(HOME, 'state.json')
  if (!(await portOpen()) || !fs.existsSync(stateFile)) {
    dialog.showErrorBox('Savor could not start', 'The Savor daemon did not come up. Start the app from a terminal to see its output.')
    return app.quit()
  }
  const { token } = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  win = new BrowserWindow({ width: 1500, height: 950, backgroundColor: '#121212', title: 'Savor', autoHideMenuBar: true })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadURL(`http://localhost:${PORT}/?token=${token}`)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
  app.whenReady().then(() => {
    createWindow()
    // Release builds carry app-update.yml pointing at GitHub Releases; AppImage, dmg and exe update themselves.
    if (app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
      const { autoUpdater } = require('electron-updater')
      autoUpdater.on('error', (e) => console.error('Update check failed:', e.message))
      autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    }
  })
  app.on('window-all-closed', () => app.quit())
  app.on('quit', () => daemon?.kill())
}
