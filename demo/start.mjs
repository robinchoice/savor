// Starts the demo instance: the daemon with the fake agent, connected to the relay, with a sample project.
// Devices pair with the fixed code in SAVOR_DEMO_PAIRING (server/devices.ts), so Apple's beta review can
// try the iOS app without anyone at a computer.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.SAVOR_HOME
const RELAY = process.env.SAVOR_DEMO_RELAY ?? 'https://savor.diespaetzles.lol'
const base = `http://127.0.0.1:${process.env.SAVOR_PORT}`

const daemon = spawn(process.execPath, ['dist/server/index.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] })
daemon.on('exit', (code) => process.exit(code ?? 1))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => daemon.kill(signal))
await new Promise((resolve) =>
  daemon.stdout.on('data', (d) => {
    // The start line carries the owner token, which stays inside the container.
    for (const line of String(d).split('\n')) if (line) console.log(line.replace(/token=\w+/, 'token=…'))
    if (String(d).includes('Savor running')) resolve()
  }),
)

const token = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).token
const api = async (method, p, body) => {
  const res = await fetch(base + '/api' + p, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`)
  return res.json()
}

await api('PUT', '/relay', { url: RELAY, enabled: true })
if (!(await api('GET', '/projects')).length) {
  const dir = path.join(HOME, 'projects/weather-app')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# Weather app\n\nA small sample project. Ask the agent something in Savor.\n')
  const project = await api('POST', '/projects', { path: dir, name: 'Weather app' })
  await api('POST', `/projects/${project.id}/threads`, { text: 'Add a five-day forecast to the start page' })
}
for (let i = 0; i < 50 && (await api('GET', '/relay')).state !== 'online'; i++) await new Promise((r) => setTimeout(r, 200))
const { publicKey, state } = await api('GET', '/relay')
console.log(`Relay ${state}. Pairing link: ${RELAY}/#/rpair/${publicKey}/<SAVOR_DEMO_PAIRING>`)
