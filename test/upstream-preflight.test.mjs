import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { signalSchema } from '../server/workflow-results.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-upstream-preflight-'))
const STATE = path.join(TMP, 'last-run.json')
const AGY = path.join(TMP, 'agy')
const BIN = path.join(TMP, 'bin')
const DOC = path.join(TMP, 'project', '.savor', 'documents', '0a00a262a7be4479.md')
const versions = { '@anthropic-ai/claude-code': '2.1.304', '@openai/codex': '0.163.0', 'opencode-ai': '1.19.3', '@xai-official/grok': '1.0.62' }
let registry, url

const doc = ({ recheck = [], delegated = [], claude = '2.1.304' } = {}) => `# Claude/Codex-Abgleich

## Zuletzt geprüft

- Claude Code: ${claude} (Lauf vom 2026-10-20)
- Codex: 0.163.0 (Lauf vom 2026-10-20)
- Antigravity: 1.4.3 (Lauf vom 2026-10-20)
- Grok Build: 1.0.62 auf npm und als Binary geprüft

## Neu prüfen beim nächsten Lauf

${recheck.map((l) => `- ${l}`).join('\n')}

## Als Auftrag gestartet

${delegated.map((l) => `- ${l}`).join('\n') || 'Keine offenen Aufträge.'}

## Schon übernommen

- Claude: /btw
`

const run = (name, state) => {
  const at = '2026-10-20T03:04:00.000Z'
  fs.writeFileSync(STATE, JSON.stringify(state ?? {
    claude: { version: '2.1.304 (Claude Code)', result: 'ok', at },
    codex: { version: 'codex-cli 0.163.0', result: 'ok', at },
    opencode: { version: '1.19.3', result: 'ok', at },
    grok: { version: 'grok 1.0.62', result: 'skip', reason: 'not signed in, run grok login', at },
    antigravity: { version: '1.4.3', result: 'ok', at },
    ...(name && { [name]: { version: '1.4.3', result: 'fail', reason: 'Rate limited', at } }),
  }))
}

async function check() {
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'scripts/upstream-preflight.mjs')], {
    env: { ...process.env, HOME: TMP, PATH: BIN, SAVOR_PROJECT: path.join(TMP, 'project'), SAVOR_UPSTREAM_STATE: STATE, SAVOR_NPM_REGISTRY: url, SAVOR_ANTIGRAVITY_BIN: AGY },
  })
  const read = (name) => JSON.parse(fs.readFileSync(path.join(TMP, 'project', '.workflow-checks', name), 'utf8'))
  const signals = { upstream: read('upstream.json'), features: read('features.json') }
  // Savor accepts both: the same checks as its preflight reader.
  for (const s of Object.values(signals)) {
    assert.ok(signalSchema.safeParse(s).success, JSON.stringify(s))
    assert.ok(s.status === 'ok' && !s.pending ? !(s.followUp.length && !s.work) : s.followUp.length > 0, JSON.stringify(s))
  }
  return signals
}

before(async () => {
  registry = http.createServer((req, res) => {
    const pkg = decodeURIComponent(req.url.slice(1).replace(/\/latest$/, ''))
    if (!versions[pkg]) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: pkg, version: versions[pkg] }))
  })
  await new Promise((r) => registry.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${registry.address().port}`
  fs.writeFileSync(AGY, '#!/bin/sh\necho 1.4.3\n', { mode: 0o755 })
  // The other agents' CLIs only need to be on PATH.
  fs.mkdirSync(BIN)
  for (const bin of ['claude', 'codex', 'opencode', 'grok']) fs.writeFileSync(path.join(BIN, bin), '')
  fs.mkdirSync(path.dirname(DOC), { recursive: true })
})

after(() => {
  registry.close()
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('unchanged versions and nothing open: both skip without an agent', async () => {
  run()
  fs.writeFileSync(DOC, doc())
  const { upstream, features } = await check()
  assert.deepEqual([upstream.status, upstream.work, upstream.pending], ['ok', false, false])
  assert.deepEqual([features.status, features.work, features.pending], ['ok', false, false])
  assert.match(upstream.evidence.join('\n'), /Grok Build: geprüft grok 1\.0\.62 \(skip: not signed in/)
})

test('a newer version is work for both, OpenCode only for the upstream check', async () => {
  run()
  fs.writeFileSync(DOC, doc({ claude: '2.1.299' }))
  versions['opencode-ai'] = '1.20.0'
  try {
    const { upstream, features } = await check()
    assert.equal(upstream.work, true)
    assert.match(upstream.reason, /OpenCode 1\.19\.3 → 1\.20\.0/)
    assert.equal(features.work, true)
    assert.match(features.reason, /^Neue Versionen: Claude Code 2\.1\.299 → 2\.1\.304;/)
  } finally {
    versions['opencode-ai'] = '1.19.3'
  }
})

test('an older version on npm is no work', async () => {
  run()
  fs.writeFileSync(DOC, doc({ claude: '2.1.305' }))
  const { features } = await check()
  assert.equal(features.work, false)
})

test('open counterchecks and delegations are pending with follow-up', async () => {
  run('antigravity')
  fs.writeFileSync(DOC, doc({ recheck: ['Antigravity: Auto-Modus, Gegenprobe touch probe.txt'], delegated: ['Idle-Kompaktierung (65bf99eb1041489a)'] }))
  const { upstream, features } = await check()
  assert.deepEqual([upstream.work, upstream.pending], [false, true])
  assert.match(upstream.followUp[0], /Antigravity 1\.4\.3: FAIL „Rate limited“.*upstream-check\.mjs antigravity/)
  assert.deepEqual([features.work, features.pending], [false, true])
  assert.deepEqual(features.followUp, ['Neu prüfen: Antigravity: Auto-Modus, Gegenprobe touch probe.txt', 'Auftrag: Idle-Kompaktierung (65bf99eb1041489a)'])
})

test('a missing record blocks instead of idling', async () => {
  fs.rmSync(STATE)
  fs.writeFileSync(DOC, doc().replace('- Codex: 0.163.0 (Lauf vom 2026-10-20)\n', ''))
  let { upstream, features } = await check()
  assert.equal(upstream.status, 'blocked')
  assert.equal(features.status, 'blocked')
  assert.match(features.reason, /Codex/)
  run(undefined, { claude: { version: '2.1.304', result: 'ok', at: '2026-10-20T03:04:00.000Z' } })
  fs.writeFileSync(DOC, doc().replace('## Neu prüfen beim nächsten Lauf', '## Offen'))
  ;({ upstream, features } = await check())
  assert.match(upstream.reason, /Codex, OpenCode, Grok Build, Antigravity/)
  assert.equal(features.status, 'blocked')
})

test('an agent whose CLI is not on this computer is left out, its open items too', async () => {
  run('grok')
  fs.writeFileSync(DOC, doc({ recheck: ['Grok Build: Modelle, Gegenprobe grok models'] }))
  versions['@xai-official/grok'] = '1.0.70'
  fs.renameSync(path.join(BIN, 'grok'), path.join(TMP, 'grok'))
  try {
    const { upstream, features } = await check()
    assert.deepEqual([upstream.status, upstream.work, upstream.pending], ['ok', false, false])
    assert.deepEqual([features.status, features.work, features.pending], ['ok', false, false])
    assert.match(upstream.evidence.join('\n'), /Grok Build: übersprungen, grok fehlt auf diesem Rechner/)
  } finally {
    fs.renameSync(path.join(TMP, 'grok'), path.join(BIN, 'grok'))
    versions['@xai-official/grok'] = '1.0.62'
  }
})

test('an unreachable registry fails both', async () => {
  run()
  fs.writeFileSync(DOC, doc())
  versions['@openai/codex'] = undefined
  try {
    const { upstream, features } = await check()
    assert.equal(upstream.status, 'failed')
    assert.equal(features.status, 'failed')
    assert.match(upstream.reason, /@openai\/codex: npm registry answered 404/)
  } finally {
    versions['@openai/codex'] = '0.163.0'
  }
})
