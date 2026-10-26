import { createContext } from 'preact'
import { apiBlob } from './api'
import { t } from './i18n'

// What the Study view lends the chat inside it: citations in answers open their source, and the sources
// picked in the list narrow the next questions. Outside of Study there is none.

export interface Source { key: string | null; title: string; authors: string; year: string; venue: string; doi: string | null; pages: string; file: string | null; text: string | null; cited: number }

export interface StudyScope {
  sources: Source[]
  open: (key: string, page: number | null) => void
  focus: Source[]
  setFocus: (focus: Source[]) => void
}

export const StudyContext = createContext<StudyScope | null>(null)

// How a message names the sources picked for it; the conversation shows it as a short note.
export const FOCUS_HEAD = '[Answer only from these sources]'
export const focusContext = (focus: Source[]) =>
  focus.length ? `\n\n${FOCUS_HEAD}\n${focus.map((s) => `- ${[s.key && `[@${s.key}]`, s.text ?? s.file ?? 'no PDF, only its entry in the bibliography'].filter(Boolean).join(' ')}`).join('\n')}` : ''

export const shortName = (s: Source) => (s.authors ? `${authorLine(s.authors)} ${s.year}`.trim() : s.title)

export const authorLine = (authors: string) => {
  const names = authors.split(/\s+and\s+/).filter(Boolean)
  const last = (n: string) => (n.includes(',') ? n.split(',')[0] : n.split(' ').pop()!)
  return names.length > 2 ? t('{name} et al.', { name: last(names[0]) }) : names.map(last).join(' & ')
}

// Pandoc citations in brackets, [@key], [@key, p. 12] or [see @a, pp. 3–5; @b], each item with its key
// and the first page it names. Not e-mail addresses, like the export's check (server/workspace.ts).
const GROUP = /\[[^\[\]]*?(?<![\p{L}\p{N}_@])-?@[\p{L}\p{N}_][^\[\]]*\]/gu
const ITEM = /(?<![\p{L}\p{N}_@])(-?@)([\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])?)([^;\]]*)/gu

export interface Cite { key: string; suppress: boolean; locator: string; page: number | null }

// Each citation group with the text around its items, so a prefix like "see" stays.
export function citationsIn(text: string) {
  const found: { start: number; end: number; parts: (string | Cite)[] }[] = []
  for (const g of text.matchAll(GROUP)) {
    const inner = g[0].slice(1, -1)
    const parts: (string | Cite)[] = []
    let at = 0
    for (const m of inner.matchAll(ITEM)) {
      if (m.index! > at) parts.push(inner.slice(at, m.index))
      const locator = m[3].replace(/^,\s*/, '').trim()
      // A page, not a chapter, section or note.
      const page = locator.match(/^(?:(?:pp?|S|Seiten?|pages?)\.?\s*)?(\d+)/i)
      parts.push({ key: m[2], suppress: m[1] === '-@', locator, page: page ? Number(page[1]) : null })
      at = m.index! + m[0].length
    }
    if (at < inner.length) parts.push(inner.slice(at))
    if (parts.some((x) => typeof x !== 'string')) found.push({ start: g.index!, end: g.index! + g[0].length, parts })
  }
  return found
}

// The PDF page of a printed page: the text copy names it when the PDF has page labels, otherwise an
// article starts on the first page of its range in the bibliography.
export async function pdfPage(base: string, source: Source, printed: number | null) {
  if (!printed) return null
  if (source.text) {
    const copy = await apiBlob(`${base}/file/raw?path=${encodeURIComponent(source.text)}`).then((b) => b.text(), () => '')
    const labelled = copy.match(new RegExp(`^--- page (\\d+) \\(printed ${printed}\\) ---$`, 'm'))
    if (labelled) return Number(labelled[1])
  }
  const range = source.pages.match(/^(\d+)\s*[-–—]+\s*(\d+)$/)
  if (range && printed >= Number(range[1]) && printed <= Number(range[2])) return printed - Number(range[1]) + 1
  return printed
}
