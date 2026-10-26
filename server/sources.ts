import fs from 'node:fs'
import path from 'node:path'
import type { Project } from './store.js'
import { chapters, CITE, CROSSREF, read, yamlGet } from './workspace.js'

// The sources of academic writing: the entries of the bibliography, the PDFs in sources/ and how often
// the manuscript cites each. Search and the BibTeX of a DOI come from open services (OpenAlex, doi.org);
// what gets added lands in the same files the agents read, so the page and the agents see one state.

const OPENALEX = process.env.SAVOR_OPENALEX_URL ?? 'https://api.openalex.org'
const DOI_ORG = process.env.SAVOR_DOI_URL ?? 'https://doi.org'
const UA = { 'user-agent': 'Savor (https://savor.pleasance.org)' }
const DOI = /^10\.\d{4,9}\/\S+$/
const MAX_PDF = 50 * 1024 * 1024

interface Entry { key: string; fields: Record<string, string> }

// Enough BibTeX for a list: entries with braced, quoted or bare values, braces inside values removed.
export function parseBib(text: string) {
  const entries: Entry[] = []
  const head = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g
  let m: RegExpExecArray | null
  while ((m = head.exec(text))) {
    let depth = 1
    let i = head.lastIndex
    for (; i < text.length && depth; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0
    if (!/^(comment|string|preamble)$/i.test(m[1])) entries.push({ key: m[2], fields: bibFields(text.slice(head.lastIndex, i - 1)) })
    head.lastIndex = i
  }
  return entries
}

function bibFields(body: string) {
  const fields: Record<string, string> = {}
  const name = /([\w-]+)\s*=\s*/g
  let m: RegExpExecArray | null
  while ((m = name.exec(body))) {
    let i = name.lastIndex
    let value: string
    if (body[i] === '{') {
      let depth = 0
      let j = i
      for (; j < body.length; j++) if (body[j] === '{') depth++; else if (body[j] === '}' && --depth === 0) break
      value = body.slice(i + 1, j)
      i = j + 1
    } else if (body[i] === '"') {
      const j = body.indexOf('"', i + 1)
      value = body.slice(i + 1, j < 0 ? body.length : j)
      i = j < 0 ? body.length : j + 1
    } else {
      value = body.slice(i).match(/^[^,}\s]*/)![0]
      i += value.length
    }
    fields[m[1].toLowerCase()] = value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
    name.lastIndex = i
  }
  return fields
}

const bibliography = (p: Project) => yamlGet(read(p, 'pandoc.yaml'), 'bibliography') ?? 'references.bib'
const entriesOf = (p: Project) => {
  const bib = bibliography(p)
  return bib.endsWith('.bib') ? parseBib(read(p, bib)) : []
}
const pdfs = (p: Project) => {
  const dir = path.join(p.path, 'sources')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => ({ path: `sources/${e.name}`, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}
const stem = (file: string) => path.basename(file, path.extname(file)).toLowerCase()
const textOf = (pdf: string) => `sources/text/${path.basename(pdf, path.extname(pdf))}.txt`

// A text copy of every PDF, page by page, so each agent can search the sources and check a cited page
// without reading the PDF (Codex and Antigravity can't). The PDF names a page's printed number when
// it has page labels. One PDF at a time, in the daemon, so a huge one is left out and a stuck one
// given up; one that can't be read is tried again only once it changes.
const MAX_TEXT_PDF = 100 * 1024 * 1024
let extracting = Promise.resolve()
const tried = new Set<string>()
function extract(p: Project, pdf: string) {
  const file = path.join(p.path, pdf)
  const stat = fs.statSync(file)
  const tag = `${file}:${stat.mtimeMs}`
  if (tried.has(tag) || stat.size > MAX_TEXT_PDF) return extracting
  tried.add(tag)
  return (extracting = extracting.then(async () => {
    try {
      const { getDocumentProxy } = await import('unpdf')
      const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)), { verbosity: 0 })
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('took longer than two minutes')), 120_000)))
      const pages = async () => {
        const labels = await doc.getPageLabels().catch(() => null)
        const out: string[] = []
        for (let n = 1; n <= doc.numPages; n++) {
          const items = (await (await doc.getPage(n)).getTextContent()).items as { str?: string; hasEOL?: boolean }[]
          const text = items.map((i) => (i.str ?? '') + (i.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim()
          const printed = labels?.[n - 1]
          out.push(`--- page ${n}${printed && printed !== String(n) ? ` (printed ${printed})` : ''} ---\n${text}\n`)
        }
        return out.join('\n')
      }
      try {
        const text = await Promise.race([late, pages()])
        fs.mkdirSync(path.join(p.path, 'sources/text'), { recursive: true })
        fs.writeFileSync(path.join(p.path, textOf(pdf)), text)
      } finally {
        clearTimeout(timer)
        await doc.loadingTask.destroy()
      }
    } catch (e) {
      console.warn(`[sources] no text from ${pdf}: ${(e as Error).message}`)
    }
  }))
}
const cleanDoi = (s?: string) => s?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase()

export function list(p: Project) {
  const cited = new Map<string, number>()
  for (const c of chapters(p))
    for (const [, key] of read(p, c.path).matchAll(CITE)) if (!CROSSREF.test(key)) cited.set(key, (cited.get(key) ?? 0) + 1)
  const files = pdfs(p)
  // PDFs an agent or the user put there or replaced get their text copy now, and copies of PDFs that
  // are gone go too, so no search finds them.
  const copied = (f: string) => fs.statSync(path.join(p.path, textOf(f)), { throwIfNoEntry: false })?.mtimeMs ?? 0
  const sourcePdfs = files.filter((f) => /\.pdf$/i.test(f.path))
  for (const f of sourcePdfs) if (copied(f.path) < f.mtime) void extract(p, f.path)
  const textDir = path.join(p.path, 'sources/text')
  const kept = new Set(sourcePdfs.map((f) => path.basename(textOf(f.path))))
  const ours = (file: string) => fs.readFileSync(file, 'utf8').startsWith('--- page ')
  if (fs.existsSync(textDir)) for (const name of fs.readdirSync(textDir)) if (name.endsWith('.txt') && !kept.has(name) && ours(path.join(textDir, name))) fs.rmSync(path.join(textDir, name), { force: true })
  const text = (file: string | null) => (file && /\.pdf$/i.test(file) && copied(file) ? textOf(file) : null)
  const byStem = new Map(files.map((f) => [stem(f.path), f.path]))
  const entries = entriesOf(p)
  // Newest first: entries are appended, PDFs without an entry were mostly just uploaded.
  const listed = entries.reverse().map((e) => ({
    key: e.key,
    title: e.fields.title ?? e.key,
    authors: e.fields.author ?? e.fields.editor ?? '',
    year: e.fields.year ?? e.fields.date?.slice(0, 4) ?? '',
    venue: e.fields.journal ?? e.fields.journaltitle ?? e.fields.booktitle ?? e.fields.publisher ?? '',
    doi: cleanDoi(e.fields.doi) ?? null,
    pages: e.fields.pages ?? '',
    file: byStem.get(e.key.toLowerCase()) ?? (e.fields.file && files.find((f) => e.fields.file.includes(path.basename(f.path)))?.path) ?? null,
    cited: cited.get(e.key) ?? 0,
  })).map((s) => ({ ...s, text: text(s.file) }))
  const linked = new Set(listed.map((s) => s.file))
  const loose = files.filter((f) => !linked.has(f.path)).map((f) => ({ key: null, title: path.basename(f.path), authors: '', year: '', venue: '', doi: null, pages: '', file: f.path, text: text(f.path), cited: 0 }))
  const keys = new Set(entries.map((e) => e.key))
  const missing = [...cited].filter(([key]) => !keys.has(key)).map(([key, n]) => ({ key, cited: n }))
  return { bibliography: bibliography(p), sources: [...loose, ...listed], missing }
}

const getJson = async (url: string) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}.`)
  return res.json() as Promise<any>
}

// Titles and abstracts, the best matches first, the most cited or the newest; a DOI finds its work directly.
export async function search(p: Project, q: string, sort: string) {
  const query = q.trim()
  if (!query) return []
  const doi = cleanDoi(query)
  const filter = doi && DOI.test(doi) ? `doi:${doi}` : `title_and_abstract.search:${query.replace(/[,:|]/g, ' ')}`
  const order = sort === 'new' ? '&sort=publication_date:desc' : sort === 'cited' ? '&sort=cited_by_count:desc' : ''
  const select = 'id,doi,title,publication_year,authorships,primary_location,cited_by_count,best_oa_location'
  const data = await getJson(`${OPENALEX}/works?filter=${encodeURIComponent(filter)}${order}&per_page=20&select=${select}`)
  const have = new Set(entriesOf(p).map((e) => cleanDoi(e.fields.doi)))
  return (data.results as any[]).map((w) => ({
    id: String(w.id).split('/').pop(),
    doi: cleanDoi(w.doi) ?? null,
    title: w.title ?? '',
    year: w.publication_year ?? null,
    authors: (w.authorships as any[]).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean),
    moreAuthors: w.authorships.length > 3,
    venue: w.primary_location?.source?.display_name ?? '',
    cited: w.cited_by_count ?? 0,
    pdf: !!w.best_oa_location?.pdf_url,
    url: w.best_oa_location?.pdf_url ?? w.best_oa_location?.landing_page_url ?? w.doi ?? null,
    added: !!w.doi && have.has(cleanDoi(w.doi)),
  }))
}

const ascii = (s: string) => s.normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
// lastname + year, like most reference managers: bloom2014, then bloom2014a, bloom2014b …
function newKey(fields: Record<string, string>, taken: Set<string>) {
  const first = (fields.author ?? fields.editor ?? '').split(/\s+and\s+/)[0]
  const last = first.includes(',') ? first.split(',')[0] : first.split(' ').pop() ?? ''
  const base = (ascii(last) || 'source') + (fields.year ?? '')
  let key = base
  for (let n = 1; taken.has(key.toLowerCase()); n++) key = base + String.fromCharCode(96 + n)
  return key
}

const isPdf = (buf: Buffer) => buf.subarray(0, 5).toString('latin1') === '%PDF-'
// Only PDFs are saved, so every name ends in .pdf whatever the upload was called.
function freePath(p: Project, name: string) {
  const base = path.basename(name, path.extname(name)).replace(/[^\p{L}\p{N}._ -]+/gu, '-').replace(/^[-. ]+/, '').slice(0, 120) || 'source'
  let rel = `sources/${base}.pdf`
  for (let n = 2; fs.existsSync(path.join(p.path, rel)); n++) rel = `sources/${base}-${n}.pdf`
  return rel
}
const save = (p: Project, rel: string, buf: Buffer) => {
  fs.mkdirSync(path.join(p.path, 'sources'), { recursive: true })
  fs.writeFileSync(path.join(p.path, rel), buf)
  void extract(p, rel)
}

// The open-access PDFs that OpenAlex knows for a DOI, the best one first. Some publishers turn
// programs away, so the next copy (a repository, a preprint) gets its turn, and the first link is
// handed back for the browser when none works.
async function openPdf(doi: string) {
  let urls: string[] = []
  try {
    const w = await getJson(`${OPENALEX}/works/doi:${encodeURIComponent(doi)}?select=best_oa_location,locations`)
    urls = [...new Set([w.best_oa_location, ...(w.locations ?? [])].map((l) => l?.pdf_url).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))]
  } catch {
    return { pdf: null, url: null }
  }
  for (const url of urls.slice(0, 3)) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) })
      if (!res.ok || Number(res.headers.get('content-length') ?? 0) > MAX_PDF) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (isPdf(buf) && buf.length <= MAX_PDF) return { pdf: buf, url }
    } catch {}
  }
  return { pdf: null, url: urls[0] ?? null }
}

// The entry comes from doi.org as the publisher registered it, with Savor's key; the PDF follows
// when it is open access, or is the one uploaded.
async function addEntry(p: Project, doi: string, pdf?: Buffer) {
  const bib = bibliography(p)
  if (!bib.endsWith('.bib')) throw new Error(`Savor adds sources only to a BibTeX file, and this project uses ${bib}.`)
  const entries = entriesOf(p)
  if (entries.some((e) => cleanDoi(e.fields.doi) === doi)) throw new Error('This source is in the bibliography already.')
  const res = await fetch(`${DOI_ORG}/${encodeURI(doi)}`, { headers: { ...UA, accept: 'application/x-bibtex' }, signal: AbortSignal.timeout(20_000) })
  const text = res.ok ? (await res.text()).trim() : ''
  const [entry] = parseBib(text)
  if (!entry) throw new Error(`doi.org has no BibTeX for ${doi}.`)
  const taken = new Set(entries.map((e) => e.key.toLowerCase()))
  const key = newKey(entry.fields, taken)
  const old = read(p, bib)
  const record = text.replace(/^(@\w+\s*\{)\s*[^,]+,/, `$1${key},`).replace(/\s*\}\s*$/, '\n}')
  fs.writeFileSync(path.join(p.path, bib), `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old.trim() ? '\n' : ''}${record}\n`)
  const found = pdf ? { pdf, url: null } : await openPdf(doi)
  const rel = found.pdf ? freePath(p, `${key}.pdf`) : null
  if (found.pdf && rel) save(p, rel, found.pdf)
  return { key, file: rel, pdfUrl: rel ? null : found.url }
}

export async function add(p: Project, doi: string) {
  const clean = cleanDoi(String(doi ?? ''))
  if (!clean || !DOI.test(clean)) throw new Error('That is not a DOI.')
  return addEntry(p, clean)
}

// A PDF names its DOI in its metadata (XMP or the info dictionary) when the publisher put it there;
// a DOI from the text could be one of its references, so only those places count.
function metadataDoi(buf: Buffer) {
  const text = buf.toString('latin1')
  const m = text.match(/(?:prism:doi|pdfx:doi|crossmark:DOI|dc:identifier)[^>]*>\s*(?:<rdf:li>)?\s*(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^<\s]+)/i) ?? text.match(/\/doi\s*\((10\.\d{4,9}\/[^)\s]+)\)/i)
  return m ? cleanDoi(m[1]) : null
}

export async function upload(p: Project, name: string, dataUrl: string) {
  const buf = Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64')
  if (!isPdf(buf)) throw new Error(`${name} is not a PDF.`)
  const doi = metadataDoi(buf)
  if (doi && !entriesOf(p).some((e) => cleanDoi(e.fields.doi) === doi)) {
    const added = await addEntry(p, doi, buf).catch(() => null)
    if (added) return added
  }
  const rel = freePath(p, name)
  save(p, rel, buf)
  return { key: null, file: rel, pdfUrl: null }
}
