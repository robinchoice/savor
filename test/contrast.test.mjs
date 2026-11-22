// WCAG contrast of the colour pairs in web/style.css, dark and light: text needs 4.5:1, the focus ring 3:1.
// --faint is left out: it carries secondary text below 4.5:1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8')

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

// The custom properties of the first rule with this selector
function tokens(selector) {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `no rule ${selector}`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+): ([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
}

// Lists every failing pair, so one run shows all of them
function failures(colors, pairs) {
  return pairs.flatMap(([fg, bg, minimum]) => {
    const [a, b] = [colors[fg], colors[bg]]
    if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return [`${fg} on ${bg}: not a hex colour`]
    const ratio = contrast(a, b)
    return ratio < minimum ? [`${fg} ${a} on ${bg} ${b}: ${ratio.toFixed(2)} < ${minimum}`] : []
  })
}

const family = tokens(':root')
const themes = { dark: tokens(":root,\n[data-theme='dark']"), light: tokens("[data-theme='light']") }

for (const [theme, colors] of Object.entries(themes)) {
  test(`${theme} theme colours keep their contrast`, () => {
    const pairs = []
    for (const bg of ['--bg', '--panel', '--card', '--raised', '--code-bg']) {
      for (const fg of ['--text', '--muted']) pairs.push([fg, bg, 4.5])
      pairs.push(['--accent', bg, 3])
    }
    for (const bg of ['--bg', '--panel', '--card', '--code-bg']) {
      for (const fg of ['--link', '--attn', '--needs', '--new', '--green', '--red']) pairs.push([fg, bg, 4.5])
    }
    for (const bg of ['--attn-bg', '--needs-bg', '--new-bg']) pairs.push(['--attn-ink', bg, 4.5])
    pairs.push(['--accent-ink', '--accent', 4.5])
    assert.deepEqual(failures(colors, pairs), [])
  })
}

test('ink on the product gradient keeps its contrast', () => {
  const stops = Object.fromEntries(family['--grad'].match(/#[0-9a-f]{6}/gi).map((hex, i) => [`stop ${i}`, hex]))
  assert.ok(Object.keys(stops).length >= 2)
  const pairs = Object.keys(stops).map((stop) => ['--on-grad', stop, 4.5])
  assert.deepEqual(failures({ ...family, ...stops }, pairs), [])
})
