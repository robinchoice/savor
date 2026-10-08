// Project types besides plain code: templates/*.md with a title, blurb, what gets created and the
// recipes that become the project's workflows in the front matter. Below it the project's ROLE.md,
// then after <!-- setup --> the prompt of the conversation that sets the project up. Read at build time.
const files = import.meta.glob('../templates/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export interface Template { slug: string; title: string; blurb: string; creates: string; workflows: string[]; role: string; setup: string }

export const TEMPLATES: Template[] = Object.entries(files).map(([file, raw]) => {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*?)\n<!-- setup -->\n([\s\S]*)$/)!
  const meta = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]))
  return {
    slug: file.replace(/^.*\//, '').replace(/\.md$/, ''),
    title: meta.title,
    blurb: meta.blurb,
    creates: meta.creates,
    workflows: meta.workflows.split(',').map((s) => s.trim()),
    role: m[2].trim() + '\n',
    setup: m[3].trim(),
  }
})
