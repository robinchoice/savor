// Savor preflight for the workflows "Upstream check" and "Agent-Features übernehmen": both start an
// agent only when an agent CLI has a newer version than their last recorded run, or when work from
// it is still open. Writes .workflow-checks/upstream.json and features.json in this project in
// Savor's format (README, "Workflow preflights and outcomes"). savor-upstream-preflight.timer runs it on
// Mondays at 04:50 before "Upstream check"; whoever starts a workflow by hand runs it first. Reads the
// newest versions from the npm registry and agy (which updates itself whenever it runs), the last
// results of scripts/upstream-check.mjs and the document "Claude/Codex-Abgleich". Only agents whose CLI
// is on this computer count, as in upstream-check.mjs. Changes nothing else.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = process.env.SAVOR_PROJECT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const STATE = process.env.SAVOR_UPSTREAM_STATE || path.join(os.homedir(), '.local', 'state', 'savor-upstream-check', 'last-run.json')
const REGISTRY = process.env.SAVOR_NPM_REGISTRY || 'https://registry.npmjs.org'
const AGY = process.env.SAVOR_ANTIGRAVITY_BIN || 'agy'
// The document "Claude/Codex-Abgleich" that "Agent-Features übernehmen" reads and updates.
const DOC = path.join(PROJECT, '.savor', 'documents', '0a00a262a7be4479.md')

const ALL = [
  { provider: 'claude', name: 'Claude Code', bin: 'claude', pkg: '@anthropic-ai/claude-code', features: true },
  { provider: 'codex', name: 'Codex', bin: 'codex', pkg: '@openai/codex', features: true },
  { provider: 'opencode', name: 'OpenCode', bin: 'opencode', pkg: 'opencode-ai' },
  { provider: 'grok', name: 'Grok Build', bin: 'grok', pkg: '@xai-official/grok', features: true },
  { provider: 'antigravity', name: 'Antigravity', bin: AGY, features: true },
]
const onComputer = (bin) => (path.isAbsolute(bin) ? [''] : [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')]).some((dir) => fs.existsSync(path.join(dir, bin)))
const AGENTS = ALL.filter((a) => onComputer(a.bin))
const skipped = (features) => ALL.filter((a) => !AGENTS.includes(a) && (!features || a.features)).map((a) => `${a.name}: übersprungen, ${a.bin} fehlt auf diesem Rechner`)

const semver = (v) => String(v).match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0]
// Whether `latest` is newer than `checked`; a version that can't be read counts as new when it differs.
function newer(latest, checked) {
  const [a, b] = [semver(latest), semver(checked)]
  if (!a || !b) return String(latest) !== String(checked)
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number))
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

async function latestVersions() {
  const latest = {}
  for (const a of AGENTS) {
    if (a.pkg) {
      const r = await fetch(`${REGISTRY}/${a.pkg.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) throw new Error(`${a.pkg}: npm registry answered ${r.status}`)
      latest[a.provider] = (await r.json()).version
    } else {
      try {
        latest[a.provider] = semver(execFileSync(AGY, ['--version'], { timeout: 30_000 }).toString()) ?? 'not installed'
      } catch {
        latest[a.provider] = 'not installed'
      }
    }
  }
  return latest
}

const signal = (s) => ({ checkedAt: new Date().toISOString(), work: false, pending: false, followUp: [], ...s })
const failed = (e) => signal({ status: 'failed', reason: `Prüfung fehlgeschlagen: ${e.message}`.slice(0, 2000), evidence: [String(e.stack ?? e).slice(0, 2000)], followUp: ['Ursache beheben (Netz, npm-Registry, agy), dann `node scripts/upstream-preflight.mjs` erneut ausführen'] })

function upstream(latest) {
  let state
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return signal({ status: 'blocked', reason: 'Kein belegter Lauf von scripts/upstream-check.mjs', evidence: [`${STATE} fehlt oder ist unlesbar`], followUp: [`Einmal \`node scripts/upstream-check.mjs\` ausführen, er schreibt ${STATE}`] })
  }
  const missing = AGENTS.filter((a) => !state[a.provider]?.version)
  if (missing.length) return signal({ status: 'blocked', reason: `Kein belegter Stand für ${missing.map((a) => a.name).join(', ')}`, evidence: [`${STATE} ohne ${missing.map((a) => a.provider).join(', ')}`], followUp: [`\`node scripts/upstream-check.mjs ${missing.map((a) => a.provider).join(' ')}\` ausführen`] })
  const updated = AGENTS.filter((a) => newer(latest[a.provider], state[a.provider].version))
  const broken = AGENTS.filter((a) => state[a.provider].result === 'fail')
  return signal({
    status: 'ok',
    work: updated.length > 0,
    pending: broken.length > 0,
    reason: [
      updated.length ? `Neue Versionen: ${updated.map((a) => `${a.name} ${semver(state[a.provider].version) ?? state[a.provider].version} → ${latest[a.provider]}`).join(', ')}` : 'Keine neue Version seit dem letzten Lauf',
      broken.length ? `offene Nachprüfung: ${broken.map((a) => a.name).join(', ')}` : 'keine offene Nachprüfung',
    ].join('; '),
    evidence: AGENTS.map((a) => {
      const s = state[a.provider]
      return `${a.name}: geprüft ${s.version} (${s.result}${s.reason ? `: ${s.reason}` : ''}, ${s.at}), neueste ${latest[a.provider]}`.slice(0, 2000)
    }).concat(skipped()),
    followUp: broken.map((a) => `${a.name} ${state[a.provider].version}: FAIL „${state[a.provider].reason}“, Gegenprobe \`node scripts/upstream-check.mjs ${a.provider}\``.slice(0, 2000)),
  })
}

// The list items under a "## " heading of the document, null without that heading.
function section(doc, heading) {
  const start = doc.split('\n').findIndex((l) => l.trim() === `## ${heading}`)
  if (start < 0) return null
  const rest = doc.split('\n').slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
}

function features(latest) {
  const blocked = (reason) => signal({ status: 'blocked', reason, evidence: [DOC], followUp: ['Stand im Dokument „Claude/Codex-Abgleich“ (0a00a262a7be4479) wiederherstellen: „Zuletzt geprüft“ mit einer Version je Agent, „Neu prüfen beim nächsten Lauf“, „Als Auftrag gestartet“'] })
  let doc
  try {
    doc = fs.readFileSync(DOC, 'utf8')
  } catch {
    return blocked('Das Dokument „Claude/Codex-Abgleich“ fehlt')
  }
  const checked = section(doc, 'Zuletzt geprüft')
  const recheck = section(doc, 'Neu prüfen beim nächsten Lauf')
  const delegated = section(doc, 'Als Auftrag gestartet')
  if (!checked || !recheck || !delegated) return blocked('Ein Abschnitt fehlt im Dokument „Claude/Codex-Abgleich“')
  const agents = AGENTS.filter((a) => a.features).map((a) => ({ ...a, checked: semver(checked.find((l) => l.startsWith(`${a.name}:`)) ?? '') }))
  const missing = agents.filter((a) => !a.checked)
  if (missing.length) return blocked(`Keine geprüfte Version für ${missing.map((a) => a.name).join(', ')} unter „Zuletzt geprüft“`)
  const updated = agents.filter((a) => newer(latest[a.provider], a.checked))
  // Open items of an agent that is not on this computer wait until it is back.
  const here = (l) => !ALL.some((a) => !AGENTS.includes(a) && l.startsWith(`${a.name}:`))
  const open = [...recheck.filter(here).map((l) => `Neu prüfen: ${l}`), ...delegated.filter(here).map((l) => `Auftrag: ${l}`)]
  return signal({
    status: 'ok',
    work: updated.length > 0,
    pending: open.length > 0,
    reason: [
      updated.length ? `Neue Versionen: ${updated.map((a) => `${a.name} ${a.checked} → ${latest[a.provider]}`).join(', ')}` : 'Keine neue Version seit dem letzten Lauf',
      open.length ? `${open.length} offene Nachprüfung(en) oder Aufträge` : 'keine offene Nachprüfung',
    ].join('; '),
    evidence: agents.map((a) => `${a.name}: geprüft ${a.checked}, neueste ${latest[a.provider]}`).concat(skipped(true)),
    followUp: open.slice(0, 20).map((l) => (l.length > 400 ? `${l.slice(0, 399)}…` : l)),
  })
}

function write(name, s) {
  const dir = path.join(PROJECT, '.workflow-checks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `.${name}.tmp`), JSON.stringify(s, null, 2) + '\n')
  fs.renameSync(path.join(dir, `.${name}.tmp`), path.join(dir, name))
}

let latest
try {
  latest = await latestVersions()
} catch (e) {
  for (const name of ['upstream.json', 'features.json']) write(name, failed(e))
  process.exit(0)
}
for (const [name, fn] of [['upstream.json', upstream], ['features.json', features]]) {
  let s
  try {
    s = fn(latest)
  } catch (e) {
    s = failed(e)
  }
  write(name, s)
}
