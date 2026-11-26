// Warm standby (cloud/standby.sh): a primary with a systemd user unit backs up its work, a standby with a
// system unit (Savor Cloud) takes it over while the primary is fenced, and gives it back. Each instance keeps
// its own identity and devices. restic runs against a local repository, systemctl is a stand-in.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'cloud/standby.sh')
const has = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`]); return true } catch { return false } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-standby-'))
let server
after(() => {
  server?.kill('SIGKILL')
  fs.rmSync(TMP, { recursive: true, force: true })
})

const BIN = path.join(TMP, 'bin')
fs.mkdirSync(BIN)
// $FAKE_SYSTEMD/user: savor.service is a user unit; active: it runs; pid: the MainPID of the system unit.
fs.writeFileSync(path.join(BIN, 'systemctl'), `#!/bin/bash
[ "$1" = --user ] && { shift; [ -f "$FAKE_SYSTEMD/user" ] || exit 1; }
case $1 in
  cat|reset-failed) exit 0 ;;
  is-active) [ -f "$FAKE_SYSTEMD/active" ] ;;
  is-failed) exit 1 ;;
  stop) rm -f "$FAKE_SYSTEMD/active" ;;
  start) touch "$FAKE_SYSTEMD/active" ;;
  show) cat "$FAKE_SYSTEMD/pid" 2>/dev/null || echo 0 ;;
esac
`, { mode: 0o755 })

function instance(name, { user }) {
  const home = path.join(TMP, name)
  const systemd = path.join(home, 'systemd')
  fs.mkdirSync(systemd, { recursive: true })
  if (user) fs.writeFileSync(path.join(systemd, 'user'), '')
  fs.mkdirSync(path.join(home, '.savor'))
  fs.writeFileSync(path.join(systemd, 'active'), '')
  const env = { ...process.env, HOME: home, SAVOR_HOME: path.join(home, '.savor'), SAVOR_STANDBY_NAME: name, SAVOR_STANDBY_SETTLE: '0', FAKE_SYSTEMD: systemd, PATH: `${BIN}:${process.env.PATH}`,
    RESTIC_REPOSITORY: path.join(TMP, 'repo'), RESTIC_PASSWORD: 'test', RESTIC_CACHE_DIR: path.join(TMP, `cache-${name}`) }
  const run = async (...args) => {
    const r = await promisify(execFile)('bash', [SCRIPT, ...args], { env }).catch((e) => e)
    return { code: r.code ?? 0, out: `${r.stdout}${r.stderr}` }
  }
  const state = () => JSON.parse(fs.readFileSync(path.join(home, '.savor/state.json'), 'utf8'))
  const active = () => fs.existsSync(path.join(systemd, 'active'))
  return { home, systemd, run, state, active, savor: path.join(home, '.savor') }
}

const thread = (id) => ({
  id, title: 'Release', label: null, createdAt: '2026-11-26T10:00:00.000Z', updatedAt: '2026-11-26T10:00:00.000Z',
  agent: { provider: 'claude', model: '', reasoning: 'high', fast: false, ultracode: false, permissionMode: 'acceptEdits' },
  agentSessions: [{ provider: 'claude', sessionId: 'session-on-agent' }], preview: null, unread: false, completed: false,
  needsYou: false, error: null, workingSince: '2026-11-26T10:00:00.000Z', worktree: { branch: 'wip', path: '/elsewhere/wip' },
})
const messages = (dir) => fs.readFileSync(path.join(dir, '.savor/threads/t1/messages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).text)

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

async function checkDaemon(instance, token, project) {
  const port = await freePort()
  server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, HOME: instance.home, SAVOR_HOME: instance.savor, SAVOR_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stderr.on('data', (chunk) => { output += chunk })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('Savor running')) resolve()
    })
    server.on('error', reject)
    server.on('exit', (code) => reject(new Error(`daemon exited with ${code}:\n${output}`)))
  })
  const api = (route) => fetch(`http://127.0.0.1:${port}/api${route}`, { headers: { cookie: `savor_token=${token}` } }).then((res) => res.json())
  assert.deepEqual((await api('/projects')).map((p) => [p.id, p.path]), [['p1', project]])
  assert.deepEqual((await api('/projects/p1/threads')).map((thread) => thread.id), ['t1'])
  const exited = new Promise((resolve) => server.on('exit', resolve))
  server.kill('SIGTERM')
  await exited
  server = null
}

test('the standby takes the work over and gives it back, and only one instance works', { skip: !has('restic') && 'restic is not installed', timeout: 180_000 }, async () => {
  // A repository with one commit, which the standby clones.
  const remote = path.join(TMP, 'remote.git')
  const seed = path.join(TMP, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  execFileSync('git', ['-C', seed, 'commit', '-q', '--allow-empty', '-m', 'start'])
  execFileSync('git', ['clone', '-q', '--bare', seed, remote])

  const agent = instance('agent', { user: true })
  const project = path.join(agent.home, 'dev/shop')
  execFileSync('git', ['clone', '-q', remote, project])
  fs.mkdirSync(path.join(project, '.savor/threads/t1'), { recursive: true })
  fs.writeFileSync(path.join(project, '.savor/project.json'), JSON.stringify({ id: 'p1', name: 'shop', path: project }))
  fs.writeFileSync(path.join(project, '.savor/threads/t1/thread.json'), JSON.stringify(thread('t1')))
  fs.writeFileSync(path.join(project, '.savor/threads/t1/messages.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-11-26T10:00:00.000Z', kind: 'user', text: 'on agent' }) + '\n')
  fs.writeFileSync(path.join(project, '.savor/processes.json'), JSON.stringify([{ pid: 1 }]))
  fs.writeFileSync(path.join(agent.savor, 'state.json'), JSON.stringify({ token: 'agent-token', identity: 'agent-key', relayToken: 'a', devices: [{ id: 'phone-at-agent' }], projects: [{ id: 'p1', path: project }], presets: [{ id: 'x', name: 'Opus', agent: thread('').agent }], relay: { url: null, enabled: false } }))

  const kunde0 = instance('kunde0', { user: false })
  const own = path.join(kunde0.home, 'dev/own')
  fs.mkdirSync(path.join(own, '.savor'), { recursive: true })
  fs.writeFileSync(path.join(own, '.savor/project.json'), JSON.stringify({ id: 'p0', name: 'own', path: own }))
  fs.writeFileSync(path.join(kunde0.savor, 'state.json'), JSON.stringify({ token: 'kunde0-token', identity: 'kunde0-key', relayToken: 'k', devices: [{ id: 'phone-at-kunde0' }], projects: [{ id: 'p0', path: own }], presets: [], relay: { url: 'https://relay', enabled: true } }))

  // The primary sets up the repository, holds the lease and backs up.
  let r = await agent.run('init')
  assert.equal(r.code, 0, r.out)
  r = await agent.run('tick')
  assert.equal(r.code, 0, r.out)
  assert.match((await agent.run('status')).out, /owner: agent/)
  const copy = path.join(kunde0.home, 'read-only-copy')
  r = await kunde0.run('copy', copy)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(messages(path.join(copy, project)), ['on agent'])
  assert.deepEqual(kunde0.state().projects, [{ id: 'p0', path: own }])

  const agentState = agent.state()
  fs.writeFileSync(path.join(agent.savor, 'state.json'), JSON.stringify({
    ...agentState, projects: [{ id: 'home', path: agent.home }],
  }))
  fs.rmSync(path.join(agent.savor, 'standby/backed-up'))
  r = await agent.run('tick')
  assert.equal(r.code, 1)
  assert.match(r.out, /overlaps or links to machine state/)
  fs.writeFileSync(path.join(agent.savor, 'state.json'), JSON.stringify(agentState))

  // A backup minutes old means the primary still works: no takeover without --force.
  r = await kunde0.run('take')
  assert.equal(r.code, 1)
  assert.match(r.out, /seems to be working/)
  // take only prepares; the next tick, outside Savor's service, ends Savor's process and systemd starts it again.
  await takeOver(kunde0)

  // The primary is fenced: it stops and doesn't start again.
  r = await agent.run('tick')
  assert.equal(r.code, 0, r.out)
  assert.equal(agent.active(), false)

  // The standby has the work in a clone of the repository, with its own identity and devices.
  const taken = kunde0.state()
  const shop = path.join(kunde0.home, 'standby-projects/p1')
  assert.deepEqual(taken.projects, [{ id: 'p1', path: shop }])
  assert.equal(taken.identity, 'kunde0-key')
  assert.deepEqual(taken.devices, [{ id: 'phone-at-kunde0' }])
  assert.equal(taken.presets[0].name, 'Opus')
  assert.ok(fs.existsSync(path.join(shop, '.git')))
  const t = JSON.parse(fs.readFileSync(path.join(shop, '.savor/threads/t1/thread.json'), 'utf8'))
  assert.deepEqual([t.agentSessions, t.worktree, t.workingSince], [[], null, null])
  assert.deepEqual(messages(shop), ['on agent'])
  assert.equal(fs.existsSync(path.join(shop, '.savor/processes.json')), false)

  // A start is blocked while the standby owns the shared projects.
  r = await agent.run('may-start')
  assert.equal(r.code, 1)
  assert.match(r.out, /owner is kunde0/)
  assert.equal(fs.existsSync(path.join(kunde0.savor, 'standby/pending.json')), false)

  await checkDaemon(kunde0, 'kunde0-token', shop)

  // The standby works and backs up, then gives the work back and returns to its own projects.
  fs.appendFileSync(path.join(shop, '.savor/threads/t1/messages.jsonl'), JSON.stringify({ id: 'm2', ts: '2026-11-27T10:00:00.000Z', kind: 'user', text: 'on kunde0' }) + '\n')
  r = await kunde0.run('tick')
  assert.equal(r.code, 0, r.out)
  r = await kunde0.run('give')
  assert.equal(r.code, 0, r.out)
  assert.equal(kunde0.state().projects[0].id, 'p1', 'give waits for the tick')
  r = await kunde0.run('tick')
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(kunde0.state().projects, [{ id: 'p0', path: own }])
  assert.equal(kunde0.state().identity, 'kunde0-key')
  assert.match((await kunde0.run('status')).out, /owner: agent/)

  // The primary starts again and brings in what the standby did, in its own folder.
  r = await agent.run('tick')
  assert.equal(r.code, 0, r.out)
  assert.equal(agent.active(), true)
  r = await agent.run('may-start')
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(agent.state().projects, [{ id: 'p1', path: project }])
  assert.equal(agent.state().identity, 'agent-key')
  assert.deepEqual(messages(project), ['on agent', 'on kunde0'])
  await checkDaemon(agent, 'agent-token', project)
  // Brought in once: a later start keeps what the primary does from then on.
  fs.appendFileSync(path.join(project, '.savor/threads/t1/messages.jsonl'), JSON.stringify({ id: 'm3', ts: '2026-11-27T11:00:00.000Z', kind: 'user', text: 'back home' }) + '\n')
  r = await agent.run('may-start')
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(messages(project), ['on agent', 'on kunde0', 'back home'])

  // When the standby can't give the work back, the primary claims it, and the standby goes back to its own.
  r = await agent.run('tick')
  assert.equal(r.code, 0, r.out)
  fs.rmSync(path.join(agent.savor, 'standby/backed-up'))
  await takeOver(kunde0)
  r = await agent.run('tick')
  assert.equal(agent.active(), false)
  r = await agent.run('claim')
  assert.equal(r.code, 0, r.out)
  r = await kunde0.run('tick')
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(kunde0.state().projects, [{ id: 'p0', path: own }])
  assert.equal(agent.active(), true)
})

async function takeOver(standby) {
  const daemon = spawn('sleep', ['600'])
  fs.writeFileSync(path.join(standby.systemd, 'pid'), String(daemon.pid))
  const ended = new Promise((resolve) => daemon.on('exit', resolve))
  let r = await standby.run('take', '--force')
  assert.equal(r.code, 0, r.out)
  assert.equal(standby.state().projects[0].id, 'p0', 'take waits for the tick')
  r = await standby.run('tick')
  assert.equal(r.code, 0, r.out)
  await ended
}
