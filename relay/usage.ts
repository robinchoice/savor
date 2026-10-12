// Counts active installations of the desktop app. Once a day each installation sends a random ID
// made on its computer, its version, its platform and whether it is one of the maker's own (see
// server/usage.ts). Stored per day and ID, without IP addresses; IDs not seen for 90 days are
// deleted. Finished weeks are kept as sums only. RELAY_DB holds them across restarts.
import { DatabaseSync } from 'node:sqlite'

const DAY = 86_400_000
const KEEP_DAYS = 90
// Pings are anonymous, so anyone can send made-up IDs: this caps what a day can add to the database.
const MAX_IDS_PER_DAY = 10_000
const PLATFORMS = ['linux', 'darwin', 'win32']

export interface Ping { id: string; version: string; platform: string; internal: boolean }

const db = new DatabaseSync(process.env.RELAY_DB ?? ':memory:')
db.exec(`
  CREATE TABLE IF NOT EXISTS seen (day TEXT, week TEXT, id TEXT, internal INTEGER, platform TEXT, version TEXT, PRIMARY KEY (day, id));
  CREATE TABLE IF NOT EXISTS weeks (week TEXT, internal INTEGER, platform TEXT, version TEXT, installs INTEGER);
`)

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

// ISO week of a day, e.g. 2026-W42.
function weekOf(t: number) {
  const d = new Date(dayOf(t))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function parsePing(m: Record<string, unknown>): Ping | null {
  const { id, version, platform, internal } = m
  if (typeof id !== 'string' || !/^[\w-]{16,64}$/.test(id)) return null
  if (typeof version !== 'string' || !/^[\w.+-]{1,32}$/.test(version)) return null
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform) || typeof internal !== 'boolean') return null
  return { id, version, platform, internal }
}

export function record(p: Ping, now = Date.now()) {
  const day = dayOf(now)
  const known = db.prepare('SELECT 1 FROM seen WHERE day = ? AND id = ?').get(day, p.id)
  if (!known && (db.prepare('SELECT count(*) AS n FROM seen WHERE day = ?').get(day) as { n: number }).n >= MAX_IDS_PER_DAY) return
  db.prepare(
    `INSERT INTO seen VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET internal = excluded.internal, platform = excluded.platform, version = excluded.version`,
  ).run(day, weekOf(now), p.id, Number(p.internal), p.platform, p.version)
}

// Unique IDs per week, each counted with what it sent last that week.
const PER_WEEK = `
  SELECT week, internal, platform, version, count(*) AS installs
  FROM (SELECT week, id, max(day), internal, platform, version FROM seen WHERE %s GROUP BY week, id)
  GROUP BY week, internal, platform, version`

// Keeps finished weeks as sums, then deletes IDs not seen for 90 days.
export function prune(now = Date.now()) {
  db.prepare(`INSERT INTO weeks ${PER_WEEK.replace('%s', 'week < ? AND week NOT IN (SELECT week FROM weeks)')}`).run(weekOf(now))
  db.prepare('DELETE FROM seen WHERE day < ?').run(dayOf(now - KEEP_DAYS * DAY))
}

export function summary(now = Date.now()) {
  prune(now)
  const active = db
    .prepare('SELECT internal, count(*) AS n FROM (SELECT id, max(day), internal FROM seen WHERE day > ? GROUP BY id) GROUP BY internal')
    .all(dayOf(now - 7 * DAY)) as { internal: number; n: number }[]
  const count = (internal: number) => active.find((r) => r.internal === internal)?.n ?? 0
  const rows = [...db.prepare('SELECT * FROM weeks').all(), ...db.prepare(PER_WEEK.replace('%s', 'week = ?')).all(weekOf(now))] as { week: string; internal: number; platform: string; version: string; installs: number }[]
  return {
    active7: { internal: count(1), external: count(0) },
    weeks: rows.map((r) => ({ ...r, internal: r.internal === 1 })).sort((a, b) => a.week.localeCompare(b.week)),
  }
}
