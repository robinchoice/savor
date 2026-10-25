import DOMPurify from 'dompurify'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { lang, t } from './i18n'

export type PreviewKind = 'pdf' | 'docx' | 'xlsx'

// Read-only previews. The files are other people's data: Word documents become sanitized HTML,
// spreadsheets plain text in a table, and PDFs open in the browser's own viewer.
export default function FileViewer({ kind, blob, url, name }: { kind: PreviewKind; blob: Blob; url: string; name: string }) {
  if (kind === 'docx') return <Docx blob={blob} />
  if (kind === 'xlsx') return <Workbook blob={blob} />
  // Phones (Chrome on Android, some WebViews) have no PDF viewer for a page.
  if (!navigator.pdfViewerEnabled) return <p class="muted">{t('PDFs can\'t be shown here on this device. Download the file to open it.')}</p>
  return <iframe class="pdf-frame" src={url} title={name} />
}

function Docx({ blob }: { blob: Blob }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    import('mammoth')
      .then(async (m) => m.convertToHtml({ arrayBuffer: await blob.arrayBuffer() }))
      .then((r) => setHtml(DOMPurify.sanitize(r.value)), () => setError(t('This Word document can\'t be read.')))
  }, [blob])
  // Footnote links point to anchors in the document, not to Savor's routes.
  const onClick = (e: MouseEvent) => {
    const href = (e.target as Element).closest('a')?.getAttribute('href')
    if (!href?.startsWith('#')) return
    e.preventDefault()
    ;(e.currentTarget as Element).querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: 'center' })
  }
  if (error) return <div class="error-text">{error}</div>
  if (html === null) return <Loading />
  return <div class="md docx-page" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function Workbook({ blob }: { blob: Blob }) {
  const [sheets, setSheets] = useState<{ sheet: string; data: unknown[][] }[] | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    import('read-excel-file/universal').then((m) => m.default(blob)).then(setSheets, () => setError(t('This Excel file can\'t be read.')))
  }, [blob])
  if (error) return <div class="error-text">{error}</div>
  if (!sheets) return <Loading />
  if (!sheets.length) return <p class="muted">{t('No sheets in this file.')}</p>
  return (
    <>
      {sheets.length > 1 && (
        <div class="segmented">
          {sheets.map((s, i) => (
            <button key={s.sheet} type="button" class={i === active ? 'selected' : ''} onClick={() => setActive(i)}>
              {s.sheet}
            </button>
          ))}
        </div>
      )}
      <Table key={active} rows={sheets[active].data} />
    </>
  )
}

export function CsvTable({ value }: { value: string }) {
  const rows = useMemo(() => parseCsv(value), [value])
  return <Table rows={rows} />
}

// RFC 4180, with the delimiter guessed from the first line: German spreadsheets write semicolons.
function parseCsv(text: string) {
  // Excel's "CSV UTF-8" starts with a byte order mark.
  text = text.replace(/^\uFEFF/, '')
  const first = text.split(/\r?\n/, 1)[0]
  const delimiter = [',', ';', '\t'].reduce((a, b) => (first.split(b).length > first.split(a).length ? b : a))
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') cell += text[i++]
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && !cell) quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

// A, B, … Z, AA, AB, … like the spreadsheet's own column names.
const column = (i: number): string => (i >= 26 ? column(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26))

// read-excel-file reads dates as UTC.
function cellText(v: unknown) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.getUTCHours() || v.getUTCMinutes() ? v.toLocaleString(lang, { timeZone: 'UTC' }) : v.toLocaleDateString(lang, { timeZone: 'UTC' })
  if (typeof v === 'number') return v.toLocaleString(lang, { maximumFractionDigits: 10, useGrouping: false })
  if (typeof v === 'boolean') return v ? t('TRUE') : t('FALSE')
  return String(v)
}

const MAX_ROWS = 1000

function Table({ rows }: { rows: unknown[][] }) {
  const shown = rows.slice(0, MAX_ROWS)
  const width = shown.reduce((n, r) => Math.max(n, r.length), 0)
  if (!rows.length) return <p class="muted">{t('This sheet is empty.')}</p>
  return (
    <>
      <div class="sheet">
        <table>
          <thead>
            <tr>
              <th />
              {Array.from({ length: width }, (_, j) => (
                <th key={j}>{column(j)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                <th>{i + 1}</th>
                {Array.from({ length: width }, (_, j) => (
                  <td key={j} class={typeof r[j] === 'number' ? 'num' : ''}>
                    {cellText(r[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_ROWS && <p class="muted small">{t('Showing the first {n} of {total} rows.', { n: MAX_ROWS.toLocaleString(lang), total: rows.length.toLocaleString(lang) })}</p>}
    </>
  )
}

const Loading = () => <p class="muted pad">{t('Loading preview…')}</p>
