// The computers the desktop app shows: this one, through its own daemon, and others it was paired with by
// a pairing link, directly (Tailnet, LAN) or through a relay. The window loads the other computer's own
// page, so its requests count as a paired device's there. Kept in computers.json in the app's data folder.
const fs = require('node:fs')

const LOCAL = 'local'

// `server`: whether the app starts Savor on this computer. Off, it is only a client of the others.
function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { server: s.server !== false, last: s.last ?? LOCAL, computers: Array.isArray(s.computers) ? s.computers : [] }
  } catch {
    return { server: true, last: LOCAL, computers: [] }
  }
}

const save = (file, s) => fs.writeFileSync(file, JSON.stringify(s, null, 2))

// A pairing link from Savor's Devices page: `<address>/#/pair/<code>` for a direct connection, or
// `<relay>/#/rpair/<key>/<code>` through a relay. Returns the URL to open, or null for anything else.
function pairingUrl(text) {
  let url
  try {
    url = new URL(String(text).trim())
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  if (!/^#\/(pair\/[\w-]+|rpair\/[\w-]+\/[\w-]+(\/\d+)?)$/.test(url.hash)) return null
  return url.href
}

// What the page of a computer reported once it was in: a relay serves several computers, told apart by their key.
function computerAt(origin, { host, daemonPk }) {
  const key = typeof daemonPk === 'string' && /^[\w-]+$/.test(daemonPk) ? daemonPk : null
  return {
    id: key ? `${origin}#${key}` : origin,
    name: String(host || new URL(origin).hostname).slice(0, 60),
    url: key ? `${origin}/#/computer/${key}` : `${origin}/`,
    via: key ? 'relay' : 'direct',
  }
}

// Adds the computer or renames it, and opens it next time.
function remember(s, computer) {
  const known = s.computers.find((c) => c.id === computer.id)
  const computers = known ? s.computers.map((c) => (c.id === computer.id ? { ...c, name: computer.name } : c)) : [...s.computers, computer]
  return { ...s, computers, last: computer.id }
}

const forget = (s, id) => ({ ...s, computers: s.computers.filter((c) => c.id !== id), last: s.last === id ? LOCAL : s.last })

// The computer to open on start: the last one, else this one, else the first paired. null: none, ask for a link.
function startId(s) {
  if (s.last !== LOCAL && s.computers.some((c) => c.id === s.last)) return s.last
  if (s.server) return LOCAL
  return s.computers[0]?.id ?? null
}

const originOf = (url) => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const knownOrigin = (s, origin) => s.computers.some((c) => originOf(c.url) === origin)

// How far the shell trusts a page, by its origin. 'local': this computer's own page, only while the app runs Savor
// here (without, something else may answer on its port, such as a tunnel to another computer). 'computer': a paired
// computer. 'pairing': the page of the pairing link just opened, until its computer is in or the window leaves it.
// null: any other site, which the window doesn't show and which gets nothing from the shell.
function access(s, origin, { local, pending }) {
  if (!origin || origin === 'null') return null
  if (origin === local && s.server) return 'local'
  if (knownOrigin(s, origin)) return 'computer'
  if (origin === pending) return 'pairing'
  return null
}

module.exports = { LOCAL, load, save, pairingUrl, computerAt, remember, forget, startId, originOf, access }
