// Project types: templates/*.md with a title, blurb, what gets created and the recipes that become the
// project's workflows in the front matter, with `paused: true` when they start paused. Below it the
// project's ROLE.md, if any, then, for a type that starts with a conversation, after <!-- setup --> its
// prompt, and after an optional <!-- setup de --> the same prompt in German; change both together. The
// other types are set up from the new-project form. Read at build time. Code is the plain project, the other types are what a project's type can be set to.
const files = import.meta.glob('../templates/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export interface Template { slug: string; title: string; blurb: string; creates: string; workflows: string[]; paused: boolean; role: string; setup: string; setupDe: string | null }

const all: Template[] = Object.entries(files).map(([file, raw]) => {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*?)(?:\n?<!-- setup -->\n([\s\S]*))?$/)!
  const meta = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]))
  return {
    slug: file.replace(/^.*\//, '').replace(/\.md$/, ''),
    title: meta.title,
    blurb: meta.blurb,
    creates: meta.creates,
    workflows: meta.workflows.split(',').map((s) => s.trim()),
    paused: meta.paused === 'true',
    role: m[2].trim() && m[2].trim() + '\n',
    setup: m[3]?.split('<!-- setup de -->')[0].trim() ?? '',
    setupDe: m[3]?.split('<!-- setup de -->')[1]?.trim() ?? null,
  }
})

export const CODE = all.find((t) => t.slug === 'code')!
export const TEMPLATES = all.filter((t) => t !== CODE)
