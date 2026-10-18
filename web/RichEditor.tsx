import { useEffect, useRef, useState } from 'preact/hooks'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Bold, Code, Heading1, Heading2, Italic, Link as LinkIcon, List, ListOrdered, Quote } from 'lucide-preact'
import { t } from './i18n'

// TipTap writes every &, < and > in text as an HTML entity, so a saved heading read "Amps &amp; Effekte" in the
// file. Keep them literal and backslash-escape them only where markdown would read an entity, a tag or a quote.
const LiteralMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event)
    ;(this.editor.markdown as any).escapeMarkdownSyntax = (text: string) =>
      text
        .replace(/&(amp|lt|gt);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>' })[e]!)
        .replace(/([\\`*_[\]~])/g, '\\$1')
        .replace(/&(?=#?\w+;)/g, '\\&')
        .replace(/<(?=[a-z/!?])/gi, '\\<')
        .replace(/^>/, '\\>')
  },
})

// Letters and digits of a markdown text, without entities and list markers: what an editor round trip must keep.
const words = (md: string) => md.replace(/&#?\w+;/g, '').replace(/^\s*(\d+[.)]|[-*+])\s/gm, '').match(/[\p{L}\p{N}]+/gu) ?? []

// Whether all words of the markdown come out again in order. Added ones are fine: a bare URL comes out as a link.
const keeps = (before: string, after: string) => {
  const out = words(after)
  let i = 0
  return words(before).every((w) => {
    while (i < out.length && out[i] !== w) i++
    return i++ < out.length
  })
}

// Rich markdown editing for documents and .md files: TipTap with markdown in and out, styled like
// rendered messages. Loaded as its own chunk (see Files.tsx).
export default function RichEditor({ value, onChange, onSave, autoFocus }: { value: string; onChange: (md: string) => void; onSave?: () => void; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [lossy, setLossy] = useState(false)
  const [, tick] = useState(0)
  const change = useRef(onChange)
  const save = useRef(onSave)
  change.current = onChange
  save.current = onSave

  useEffect(() => {
    const ed = new Editor({
      element: host.current!,
      injectNonce: document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? undefined,
      extensions: [StarterKit.configure({ link: { openOnClick: false } }), TableKit, TaskList, TaskItem.configure({ nested: true }), LiteralMarkdown],
      content: value,
      contentType: 'markdown',
      autofocus: autoFocus ? 'end' : false,
      editorProps: { attributes: { class: 'md rich-content' } },
      onUpdate: ({ editor }) => change.current(editor.getMarkdown().replace(/\n+$/, '\n')),
      onTransaction: () => tick((n) => n + 1),
    })
    // Markdown the editor can't represent (HTML, images, footnotes) would be lost on the first edit, so such text
    // stays read-only here and is edited as Markdown.
    if (!keeps(value, ed.getMarkdown())) {
      ed.setEditable(false)
      setLossy(true)
    }
    setEditor(ed)
    return () => ed.destroy()
  }, [])

  const link = () => {
    if (!editor) return
    const url = prompt(t('Link URL'), editor.getAttributes('link').href ?? '')
    if (url === null) return
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    else editor.chain().focus().unsetLink().run()
  }
  const tool = (title: string, Icon: typeof Bold, active: boolean, run: () => void) => (
    <button type="button" class={`icon-btn ${active ? 'on' : ''}`} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      <Icon size={15} />
    </button>
  )

  return (
    <div
      class="rich-editor"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          save.current?.()
        }
      }}
    >
      {lossy ? (
        <div class="rich-toolbar muted small">{t('This text holds markdown the Rich view can\'t keep. Switch to Markdown to edit it.')}</div>
      ) : editor && (
        <div class="rich-toolbar">
          {tool(t('Heading'), Heading1, editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run())}
          {tool(t('Subheading'), Heading2, editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
          {tool(t('Bold (Ctrl+B)'), Bold, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
          {tool(t('Italic (Ctrl+I)'), Italic, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
          {tool(t('Bullet list'), List, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
          {tool(t('Numbered list'), ListOrdered, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
          {tool(t('Quote'), Quote, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
          {tool(t('Code block'), Code, editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run())}
          {tool(t('Link'),
 LinkIcon, editor.isActive('link'), link)}
        </div>
      )}
      <div ref={host} />
    </div>
  )
}
