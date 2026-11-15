// The colour band under the Pleasance wordmark. Hovering it pops up the Pleasance apps like the macOS Dock:
// they grow with the pointer, the name shows above the icon under it, Savor carries a dot and free places
// show as dashed tiles. Touch opens it with a tap, the keyboard with Enter or the arrows. The list comes
// from pleasance.org/apps.json on first use, without cookies or referrer.
const APPS_URL = 'https://pleasance.org/apps.json'
const GLOW = ['#F2545B', '#FB8C45', '#F2C14E', '#6CCF8E', '#46BFE0', '#8E92F8', '#C39BF2']
// Savor's section of the colour band, as in apps.json
const BAND = { from: 5.5, to: 6.45 }
// Icons sit this far above the band, clear of the wordmark. The list starts ABOVE px up, so the wordmark
// beneath stays clickable while the dock is open.
const LIFT = 26
const ABOVE = 20
const GAP = 6
// Free spots are smaller than apps
const FREE = 0.6

const de = document.documentElement.lang === 'de'
const TEXT = de
  ? { tools: 'Werkzeuge von Pleasance', here: 'Du bist hier', desktop: 'Desktop-App', free: 'Freier Platz' }
  : { tools: 'Tools by Pleasance', here: 'You are here', desktop: 'Desktop app', free: 'Free spot' }

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const sum = (values) => values.reduce((a, b) => a + b, 0)

// Colour at a position from 1 to 7, linear in sRGB between neighbouring stages
function bandColor(position) {
  const p = clamp(position, 1, 7)
  const i = Math.min(5, Math.floor(p - 1))
  const t = p - 1 - i
  let hex = '#'
  for (const k of [1, 3, 5]) {
    const a = Number.parseInt(GLOW[i].slice(k, k + 2), 16)
    const b = Number.parseInt(GLOW[i + 1].slice(k, k + 2), 16)
    hex += Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0')
  }
  return hex
}

// Icons grow the closer the pointer gets, their neighbours make room, and the spot under the pointer stays
// under it. All values are viewport pixels.
function dockLayout({ sizes: rest, gap, grow, reach, center, pointer, min, max }) {
  const unit = Math.max(...rest) + gap
  const restWidth = sum(rest) + gap * (rest.length - 1)
  const restLeft = clamp(center - restWidth / 2, min, max - restWidth)
  const centers = []
  let x = restLeft
  for (const size of rest) {
    centers.push(x + size / 2)
    x += size + gap
  }
  const sizes = rest.map((size, i) => {
    if (pointer === null) return size
    const distance = Math.abs(pointer - centers[i]) / unit
    const closeness = distance >= reach ? 0 : (Math.cos((distance / reach) * Math.PI) + 1) / 2
    return size * (1 + grow * closeness)
  })
  const width = sum(sizes) + gap * (sizes.length - 1)
  // The point under the pointer keeps its share of the row, so the row grows around it instead of sliding away
  const share = pointer === null ? 0.5 : clamp((pointer - restLeft) / restWidth, 0, 1)
  const anchor = pointer ?? restLeft + restWidth / 2
  x = clamp(anchor - share * width, min, max - width)
  return sizes.map((size) => {
    const slot = { left: x, size }
    x += size + gap
    return slot
  })
}

// Only web links, so a broken or hijacked file cannot plant javascript: URLs
function webUrl(value) {
  try {
    return typeof value === 'string' && /^https?:$/.test(new URL(value).protocol)
  } catch {
    return false
  }
}
const stage = (n) => typeof n === 'number' && n >= 1 && n <= 7
function validApps(json) {
  const apps = json?.apps
  if (!Array.isArray(apps)) return null
  const valid = apps.every(
    (app) =>
      typeof app?.name === 'string' &&
      app.name.length > 0 &&
      app.name.length <= 40 &&
      webUrl(app.url) &&
      webUrl(app.icon) &&
      stage(app.band?.from) &&
      stage(app.band?.to) &&
      (app.desktop === undefined || typeof app.desktop === 'boolean'),
  )
  return valid ? apps : null
}

const root = document.querySelector('.dock')
const button = root.querySelector('button')
const middle = (app) => (app.band.from + app.band.to) / 2
const markerStage = (BAND.from + BAND.to) / 2
const isCurrent = (app) => new URL(app.url).origin === location.origin
root.style.setProperty('--glow', bandColor(markerStage))
root.style.setProperty('--above', `${ABOVE}px`)
root.style.setProperty('--rise', `${LIFT - ABOVE}px`)

let slots = []
let request
let open = false
let pointer = null
let hot = -1
let row = []
let rootLeft = 0
let list = null
let label = null
let closeTimer

// Seven places in band order. A place holds the apps whose section centres on it, a place without one shows
// as a free spot.
function slotsOf(apps) {
  return [1, 2, 3, 4, 5, 6, 7].flatMap((place) => {
    const here = apps.filter((app) => Math.round(middle(app)) === place).sort((a, b) => middle(a) - middle(b))
    return here.length > 0 ? here.map((app) => ({ app, stage: place })) : [{ app: null, stage: place }]
  })
}

function load() {
  request ??= fetch(APPS_URL, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then((response) => response.json())
    .then((json) => {
      const apps = validApps(json)
      if (!apps) throw new Error('apps.json does not match')
      slots = slotsOf(apps)
    })
    // The next hover tries again
    .catch(() => {
      request = undefined
    })
  return request
}

function place() {
  const touch = matchMedia('(pointer: coarse)').matches
  const width = document.documentElement.clientWidth
  // Smaller tiles on narrow screens, so the row still fits when it grows
  const units = slots.reduce((n, slot) => n + (slot.app ? 1 : FREE), 0) + 1.2
  const base = Math.min(touch ? 40 : 34, (width - 16 - GAP * (slots.length - 1)) / units)
  const r = root.getBoundingClientRect()
  rootLeft = r.left
  row = dockLayout({
    sizes: slots.map((slot) => (slot.app ? base : base * FREE)),
    gap: GAP,
    grow: touch ? 0.45 : 0.75,
    reach: 2.5,
    center: r.left + r.width / 2,
    pointer,
    min: 8,
    max: width - 8,
  })
  draw()
}

function draw() {
  if (!list) return
  const first = row[0]
  const last = row.at(-1)
  const rowLeft = first.left - rootLeft - 12
  list.style.left = `${rowLeft}px`
  list.style.width = `${last.left + last.size - first.left + 24}px`
  row.forEach((at, i) => {
    const item = list.children[i]
    item.style.left = `${at.left - rootLeft - rowLeft}px`
    item.style.width = item.style.height = `${at.size}px`
  })
  const slot = slots[hot]
  const at = row[hot]
  label.hidden = !slot
  if (!slot) return
  const note = slot.app ? (isCurrent(slot.app) ? TEXT.here : slot.app.desktop ? TEXT.desktop : '') : ''
  label.textContent = slot.app?.name ?? TEXT.free
  if (note) label.append(Object.assign(document.createElement('small'), { textContent: note }))
  label.style.left = `${at.left - rootLeft + at.size / 2 - rowLeft}px`
  label.style.bottom = `${LIFT - ABOVE + at.size + 8}px`
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function build() {
  list = document.createElement('ul')
  list.id = 'pleasance-apps'
  list.setAttribute('aria-label', TEXT.tools)
  slots.forEach((slot, i) => {
    const item = document.createElement('li')
    if (slot.app) {
      const app = slot.app
      const link = document.createElement('a')
      link.href = app.url
      if (isCurrent(app)) link.setAttribute('aria-current', 'page')
      const icon = Object.assign(document.createElement('img'), { src: app.icon, alt: '', width: 40, height: 40 })
      icon.referrerPolicy = 'no-referrer'
      const name = Object.assign(document.createElement('span'), {
        className: 'name',
        textContent: app.desktop ? `${app.name}, ${TEXT.desktop}` : app.name,
      })
      link.append(icon, name)
      if (isCurrent(app)) link.append(Object.assign(document.createElement('span'), { className: 'running' }))
      link.addEventListener('focus', () => focusIcon(i))
      link.addEventListener('keydown', keyInDock)
      link.addEventListener('click', () => link.classList.add('launching'))
      item.append(link)
    } else {
      item.className = 'free'
      item.setAttribute('aria-hidden', 'true')
      item.style.setProperty('--free', bandColor(slot.stage))
    }
    list.append(item)
  })
  label = Object.assign(document.createElement('li'), { className: 'tip', hidden: true })
  label.setAttribute('aria-hidden', 'true')
  list.append(label)
  root.append(list)
  // Pops out of the band, the icons nearest to the marker first
  if (reduced()) return
  slots.forEach((slot, i) =>
    list.children[i].animate(
      [
        { opacity: 0, transform: 'translateY(14px) scale(0.4)' },
        { opacity: 1, offset: 0.5 },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 320, delay: Math.abs(slot.stage - markerStage) * 28, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'backwards' },
    ),
  )
}

// Set while the dock should be open, so a slow first load cannot open it after the pointer has already left
let wanted = false
async function show() {
  clearTimeout(closeTimer)
  wanted = true
  await load()
  if (!wanted || open || slots.length === 0) return
  open = true
  pointer = null
  root.classList.add('open')
  button.setAttribute('aria-expanded', 'true')
  build()
  place()
  document.addEventListener('pointerdown', outside)
  addEventListener('resize', place)
}
function close() {
  clearTimeout(closeTimer)
  // Focus on an icon that is about to vanish goes back to the band
  if (open && root.contains(document.activeElement) && document.activeElement !== button) button.focus()
  wanted = false
  open = false
  pointer = null
  hot = -1
  root.classList.remove('open')
  button.setAttribute('aria-expanded', 'false')
  list?.remove()
  list = null
  document.removeEventListener('pointerdown', outside)
  removeEventListener('resize', place)
}
function closeSoon() {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(close, 300)
}
// Taps outside close the dock on touch screens
function outside(event) {
  if (!root.contains(event.target)) close()
}

// Index of the icon under the point, only over the icons themselves, not over the band or the gap above it
function hit(x, y) {
  const bottom = root.getBoundingClientRect().top - LIFT
  return row.findIndex(
    (slot) => y <= bottom + 4 && y >= bottom - slot.size - 4 && x >= slot.left - GAP / 2 && x <= slot.left + slot.size + GAP / 2,
  )
}

// Mouse: hovering opens, leaving closes after a moment
root.addEventListener('pointerenter', (event) => event.pointerType === 'mouse' && show())
root.addEventListener('pointerleave', (event) => event.pointerType === 'mouse' && closeSoon())
root.addEventListener('pointermove', (event) => {
  if (!open) return
  pointer = event.clientX
  hot = hit(event.clientX, event.clientY)
  place()
})
root.addEventListener('focusout', (event) => {
  if (!root.contains(event.relatedTarget)) close()
})

// Touch: tapping the band opens, sliding onto an icon and lifting opens that app
let dragging = false
// The click that follows a tap must not reopen what the tap closed
let tapped = false
button.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse') return
  event.preventDefault()
  tapped = true
  if (open) return close()
  button.setPointerCapture(event.pointerId)
  dragging = true
  show()
})
button.addEventListener('pointerup', (event) => {
  if (!dragging) return
  dragging = false
  const index = hit(event.clientX, event.clientY)
  const app = slots[index]?.app
  if (!app || isCurrent(app)) return
  list?.children[index]?.firstChild?.classList.add('launching')
  location.assign(app.url)
})
button.addEventListener('pointercancel', () => {
  dragging = false
  tapped = false
})
button.addEventListener('click', () => {
  if (tapped) tapped = false
  else show()
})

// Keyboard: Enter or the arrows open, arrows walk the apps, Escape closes
const appLinks = () => (list ? [...list.querySelectorAll('a')] : [])
button.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') return close()
  if (!['Enter', ' ', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  await show()
  const all = appLinks()
  const start = Math.max(
    0,
    all.findIndex((link) => link.getAttribute('aria-current') === 'page'),
  )
  const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
  all[clamp(start + step, 0, all.length - 1)]?.focus()
})
function keyInDock(event) {
  if (event.key === 'Escape') return close()
  const all = appLinks()
  const i = all.indexOf(document.activeElement)
  const next = event.key === 'ArrowLeft' ? i - 1 : event.key === 'ArrowRight' ? i + 1 : -1
  if (i < 0 || next < 0 || next >= all.length) return
  event.preventDefault()
  all[next].focus()
}
function focusIcon(index) {
  const slot = row[index]
  if (!slot) return
  pointer = slot.left + slot.size / 2
  hot = index
  place()
}

// Back from an app opened here, the page may come out of the bfcache as it was left
addEventListener('pageshow', (event) => event.persisted && close())
