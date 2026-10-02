import { useEffect, useRef, useState } from 'preact/hooks'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Bold, Code, Heading1, Heading2, Italic, Link as LinkIcon, List, ListOrdered, Quote } from 'lucide-preact'

// Rich markdown editing for documents and .md files: TipTap with markdown in and out, styled like
// rendered messages. Loaded as its own chunk (see Files.tsx).
export default function RichEditor({ value, onChange, onSave, autoFocus }: { value: string; onChange: (md: string) => void; onSave?: () => void; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [, tick] = useState(0)
  const change = useRef(onChange)
  const save = useRef(onSave)
  change.current = onChange
  save.current = onSave

  useEffect(() => {
    const ed = new Editor({
      element: host.current!,
      injectNonce: document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? undefined,
      extensions: [StarterKit.configure({ link: { openOnClick: false } }), Markdown],
      content: value,
      contentType: 'markdown',
      autofocus: autoFocus ? 'end' : false,
      editorProps: { attributes: { class: 'md rich-content' } },
      onUpdate: ({ editor }) => change.current(editor.getMarkdown().replace(/\n+$/, '\n')),
      onTransaction: () => tick((n) => n + 1),
    })
    setEditor(ed)
    return () => ed.destroy()
  }, [])

  const link = () => {
    if (!editor) return
    const url = prompt('Link URL', editor.getAttributes('link').href ?? '')
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
      {editor && (
        <div class="rich-toolbar">
          {tool('Heading', Heading1, editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run())}
          {tool('Subheading', Heading2, editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
          {tool('Bold (Ctrl+B)', Bold, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
          {tool('Italic (Ctrl+I)', Italic, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
          {tool('Bullet list', List, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
          {tool('Numbered list', ListOrdered, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
          {tool('Quote', Quote, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
          {tool('Code block', Code, editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run())}
          {tool('Link', LinkIcon, editor.isActive('link'), link)}
        </div>
      )}
      <div ref={host} />
    </div>
  )
}
