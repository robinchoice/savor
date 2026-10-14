import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('a project folder moves, archives or follows its symlink, and its conversations, worktrees and Claude Code sessions come along', { timeout: 90_000 }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'savor-move-')))
  const home = path.join(tmp, 'home')
  const dev = path.join(tmp, 'dev')
  const claude = path.join(tmp, 'claude')
  const log = path.join(tmp, 'agents.jsonl')
  const sessions = (dir) => path.join(claude, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))
  const port = await new Promise((resolve) => {
    const listener = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = listener.address()
      listener.close(() => resolve(port))
    })
  })
  const base = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.mjs')], {
    env: { ...process.env, SAVOR_HOME: home, SAVOR_PORT: String(port), SAVOR_USAGE_URL: '', SAVOR_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), FAKE_AGENT_LOG: log, CLAUDE_CONFIG_DIR: claude },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = new Promise((resolve) => server.on('exit', resolve))
  const sleepers = []
  let browser, client
  try {
    await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('Savor running') && resolve()))
    const { token, mcpToken } = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
    const api = async (method, url, body) => {
      const r = await fetch(`${base}/api${url}`, { method, headers: { cookie: `savor_token=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const until = async (fn) => {
      for (let i = 0; i < 150; i++) {
        const v = await fn()
        if (v) return v
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('timed out')
    }
    const concluded = (pid, tid, text) => until(async () => (await api('GET', `/projects/${pid}/threads/${tid}`)).body.messages.some((m) => m.kind === 'conclusion' && m.text === text))
    const runs = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const project = async (id) => (await api('GET', '/projects')).body.find((p) => p.id === id)
    const commit = (dir) => execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' })

    // A real move: the folder goes to the archive, a symlink stays at the old path.
    const alphaPath = path.join(dev, 'alpha')
    const alpha = (await api('POST', '/projects', { path: alphaPath, create: true, name: 'Alpha' })).body
    await api('PATCH', `/projects/${alpha.id}`, { agent: { provider: 'claude' } })
    commit(alphaPath)
    const main = (await api('POST', `/projects/${alpha.id}/threads`, { text: 'hello main' })).body
    const side = (await api('POST', `/projects/${alpha.id}/threads`, { text: 'hello side', worktree: 'side' })).body
    await concluded(alpha.id, main.id, 'Echo: hello main')
    await concluded(alpha.id, side.id, 'Echo: hello side')
    const sid = (await api('GET', `/projects/${alpha.id}/threads/${main.id}`)).body.thread.agentSessions[0].sessionId
    fs.mkdirSync(sessions(alphaPath), { recursive: true })
    fs.writeFileSync(path.join(sessions(alphaPath), `${sid}.jsonl`), '{}\n')
    const archive = path.join(dev, '_archive', 'alpha')

    // A registered process blocks the move, one outside Savor only warns.
    client = new Client({ name: 'move-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?project=${alpha.id}&thread=${main.id}`), { requestInit: { headers: { authorization: `Bearer ${mcpToken}` } } }))
    const registered = spawn('sleep', ['60'], { cwd: alphaPath })
    const outside = spawn('sleep', ['60'], { cwd: alphaPath })
    sleepers.push(registered, outside)
    await client.callTool({ name: 'register_process', arguments: { pid: registered.pid, name: 'dev server', command: 'sleep 60', cwd: alphaPath } })
    let plan = (await api('POST', `/projects/${alpha.id}/move`, { path: archive, dryRun: true })).body
    assert.equal(plan.mode, 'move')
    assert.match(plan.blockers.join(' '), /Registered processes still run: dev server/)
    assert.equal((await api('POST', `/projects/${alpha.id}/move`, { path: archive })).status, 400)
    registered.kill()
    await until(async () => !(await api('POST', `/projects/${alpha.id}/move`, { path: archive, dryRun: true })).body.blockers.length)
    plan = (await api('POST', `/projects/${alpha.id}/move`, { path: archive, dryRun: true })).body
    assert.deepEqual(plan.processes.map((p) => p.pid), [outside.pid])
    assert.equal(plan.claudeSessions, 1)
    assert.equal(plan.worktrees, 1)
    const refused = await api('POST', `/projects/${alpha.id}/move`, { path: archive })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /Processes outside Savor/)
    assert.ok(fs.existsSync(alphaPath) && !fs.lstatSync(alphaPath).isSymbolicLink())
    outside.kill()
    await until(async () => !(await api('POST', `/projects/${alpha.id}/move`, { path: archive, dryRun: true })).body.processes.length)

    assert.equal((await api('POST', `/projects/${alpha.id}/move`, { path: archive })).body.path, archive)
    assert.equal((await project(alpha.id)).path, archive)
    assert.equal(fs.readlinkSync(alphaPath), archive)
    assert.ok(fs.existsSync(path.join(sessions(archive), `${sid}.jsonl`)))
    assert.ok(!fs.existsSync(sessions(alphaPath)))
    assert.equal(JSON.parse(fs.readFileSync(path.join(archive, '.savor', 'project.json'), 'utf8')).path, archive)
    // The worktree finds the moved checkout without the symlink, and both conversations continue.
    fs.unlinkSync(alphaPath)
    const worktree = (await api('GET', `/projects/${alpha.id}/threads/${side.id}`)).body.thread.worktree.path
    assert.match(execFileSync('git', ['-C', worktree, 'rev-parse', '--git-common-dir']).toString(), new RegExp(`^${archive}/\\.git`))
    const before = runs().length
    await api('POST', `/projects/${alpha.id}/threads/${main.id}/messages`, { text: 'after the move' })
    await concluded(alpha.id, main.id, 'Echo: after the move')
    await api('POST', `/projects/${alpha.id}/threads/${side.id}/messages`, { text: 'side after the move' })
    await concluded(alpha.id, side.id, 'Echo: side after the move')
    const resumed = runs().slice(before)
    assert.ok(resumed.some((r) => r.cwd === archive && r.argv.includes('--resume') && r.argv.includes(sid)), JSON.stringify(resumed))
    assert.ok(resumed.some((r) => r.cwd === worktree))
    // The folder of another project is taken.
    const beta0 = path.join(dev, 'taken')
    const taken = (await api('POST', '/projects', { path: beta0, create: true, name: 'Taken' })).body
    assert.match((await api('POST', `/projects/${alpha.id}/move`, { path: beta0, dryRun: true })).body.blockers[0], /folder of the project Taken/)

    // The case of a folder archived by hand behind a symlink: the project points at the real folder, the symlink goes.
    const realBeta = path.join(dev, '_archive', 'beta')
    const linkBeta = path.join(dev, 'beta')
    fs.mkdirSync(realBeta, { recursive: true })
    execFileSync('git', ['init', '-q', realBeta])
    fs.symlinkSync('_archive/beta', linkBeta)
    const beta = (await api('POST', '/projects', { path: linkBeta, name: 'Beta' })).body
    await api('PATCH', `/projects/${beta.id}`, { agent: { provider: 'claude' } })
    const old = (await api('POST', `/projects/${beta.id}/threads`, { text: 'hello beta' })).body
    await concluded(beta.id, old.id, 'Echo: hello beta')
    const betaSid = (await api('GET', `/projects/${beta.id}/threads/${old.id}`)).body.thread.agentSessions[0].sessionId
    fs.mkdirSync(sessions(linkBeta), { recursive: true })
    fs.writeFileSync(path.join(sessions(linkBeta), `${betaSid}.jsonl`), '{}\n')
    fs.mkdirSync(sessions(realBeta), { recursive: true })
    fs.writeFileSync(path.join(sessions(realBeta), 'other.jsonl'), '{}\n')
    assert.match((await api('POST', `/projects/${beta.id}/move`, { path: path.join(dev, 'elsewhere'), dryRun: true })).body.blockers[0], /is a symlink to/)
    plan = (await api('POST', `/projects/${beta.id}/move`, { path: realBeta, dryRun: true })).body
    assert.deepEqual([plan.mode, plan.symlink, plan.claudeSessions, plan.blockers], ['relink', true, 1, []])

    // In the settings: check, then point the project at the real folder without keeping the symlink.
    browser = await chromium.launch({ executablePath: process.env.SAVOR_CHROMIUM })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
    await page.goto(`${base}/?token=${token}#/p/${beta.id}/settings`)
    await page.click('text=Skip setup').catch(() => {})
    await page.waitForSelector('.move-section')
    await page.fill('.move-section input[aria-label="New path"]', realBeta)
    await page.click('.move-section button:has-text("Check")')
    await page.waitForSelector('.move-plan >> text=already is this folder')
    await page.uncheck('.move-plan input[type=checkbox]')
    await page.click('.move-plan button:has-text("Point here")')
    await page.waitForSelector(`.move-section >> text=The project is now at ${realBeta}.`)
    assert.equal((await project(beta.id)).path, realBeta)
    assert.ok(!fs.existsSync(linkBeta) && !fs.lstatSync(linkBeta, { throwIfNoEntry: false }))
    assert.deepEqual(fs.readdirSync(sessions(realBeta)).sort(), [`${betaSid}.jsonl`, 'other.jsonl'].sort())
    assert.ok(!fs.existsSync(sessions(linkBeta)))
    await api('POST', `/projects/${beta.id}/threads/${old.id}/messages`, { text: 'beta after the move' })
    await concluded(beta.id, old.id, 'Echo: beta after the move')
    assert.ok(runs().some((r) => r.cwd === realBeta && r.argv.includes(betaSid)))

    // A folder moved by hand without a symlink: opening it at its new place brings the project along.
    const gammaPath = path.join(dev, 'gamma')
    const gamma = (await api('POST', '/projects', { path: gammaPath, create: true, name: 'Gamma' })).body
    fs.mkdirSync(sessions(gammaPath), { recursive: true })
    fs.writeFileSync(path.join(sessions(gammaPath), 'g.jsonl'), '{}\n')
    const gammaMoved = path.join(dev, '_archive', 'gamma')
    fs.renameSync(gammaPath, gammaMoved)
    assert.equal(await project(gamma.id), undefined)
    assert.equal((await api('POST', '/projects', { path: gammaMoved })).body.id, gamma.id)
    assert.equal((await project(gamma.id)).path, gammaMoved)
    assert.equal((await api('GET', '/projects')).body.filter((p) => p.id === gamma.id).length, 1)
    assert.ok(fs.existsSync(path.join(sessions(gammaMoved), 'g.jsonl')))

    // Agents move and remove projects only after the user approves it in their conversation.
    const answer = async (choice) => {
      const pending = await until(async () => (await api('GET', `/projects/${alpha.id}/threads/${main.id}`)).body.messages.find((m) => m.approval?.status === 'pending'))
      await api('POST', `/projects/${alpha.id}/threads/${main.id}/approvals/${pending.id}`, { choice })
      return pending.approval
    }
    let call = client.callTool({ name: 'move_project', arguments: { project: taken.id, archive: true, link: false } })
    const card = await answer('allow')
    assert.equal(card.title, 'Move Taken?')
    assert.match(card.detail, new RegExp(`Moves ${beta0} to ${path.join(dev, '_archive', 'taken')}\\.`))
    assert.equal(JSON.parse((await call).content[0].text).path, path.join(dev, '_archive', 'taken'))
    assert.ok(!fs.existsSync(beta0))
    call = client.callTool({ name: 'remove_project', arguments: { project: taken.id } })
    await answer('deny')
    assert.equal((await call).content[0].text, 'The user kept the project.')
    assert.ok(await project(taken.id))
    call = client.callTool({ name: 'remove_project', arguments: { project: taken.id } })
    await answer('allow')
    await call
    assert.equal(await project(taken.id), undefined)
    assert.match((await client.callTool({ name: 'remove_project', arguments: { project: alpha.id } })).content[0].text, /runs in that project/)
  } finally {
    for (const s of sleepers) s.kill()
    await client?.close().catch(() => {})
    await browser?.close()
    server.kill()
    await exited
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
