// Savor desktop shell: starts the daemon and shows the UI in its own window.
// The window keeps a persistent browser session, so logins inside previews and links survive restarts.
const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const PORT = Number(process.env.SAVOR_PORT ?? 4317)
const HOME = process.env.SAVOR_HOME ?? path.join(os.homedir(), '.savor')
let daemon = null

const portOpen = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => (s.end(), resolve(true)))
    s.on('error', () => resolve(false))
  })

async function ensureDaemon() {
  if (await portOpen()) return
  daemon = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'savor.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SAVOR_PORT: String(PORT) },
    stdio: 'inherit',
  })
  for (let i = 0; i < 100 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 100))
}

async function createWindow() {
  await ensureDaemon()
  const { token } = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'))
  const win = new BrowserWindow({ width: 1500, height: 950, backgroundColor: '#121212', title: 'Savor', autoHideMenuBar: true })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.loadURL(`http://localhost:${PORT}/?token=${token}`)
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('quit', () => daemon?.kill())
