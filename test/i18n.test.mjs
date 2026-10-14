import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import de, { patterns } from '../web/de.ts'

const WEB = path.join(import.meta.dirname, '../web')
const str = `'((?:[^'\\\\]|\\\\.)*)'`
const unquote = (s) => s.replace(/\\(.)/g, '$1')

// Every text the UI passes to t(), tr() or plural() as a literal, with the file it is in.
function keys() {
  const found = new Map()
  for (const file of fs.readdirSync(WEB).filter((f) => /\.tsx?$/.test(f) && !['de.ts', 'i18n.ts'].includes(f))) {
    const src = fs.readFileSync(path.join(WEB, file), 'utf8')
    for (const m of src.matchAll(new RegExp(`\\b(?:t|tr)\\(${str}`, 'g'))) found.set(unquote(m[1]), file)
    for (const m of src.matchAll(new RegExp(`\\bplural\\([^,]+,\\s*${str},\\s*${str}`, 'g'))) found.set(unquote(m[1]), file).set(unquote(m[2]), file)
  }
  return found
}

test('every text in the UI has a German translation with the same placeholders', () => {
  const missing = [...keys()].filter(([k]) => !(k in de)).map(([k, file]) => `${file}: ${k}`)
  assert.deepEqual(missing, [])
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const mismatched = Object.entries(de).filter(([en, text]) => names(en).join() !== names(text).join()).map(([en]) => en)
  assert.deepEqual(mismatched, [])
})

test('the patterns for texts from the daemon match whole texts and use only their groups', () => {
  for (const [re, text] of patterns) {
    assert.ok(re.source.startsWith('^') && re.source.endsWith('$'), `${re} should match whole texts`)
    const groups = new RegExp(`${re.source}|`).exec('').length - 1
    for (const [, n] of text.matchAll(/\$(\d)/g)) assert.ok(Number(n) <= groups, `${re} has no group ${n}`)
  }
})
