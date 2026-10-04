// Bundled workflow recipes: recipes/*.md with a title, blurb, category and suggested schedule in the
// front matter, the instructions below it. They are read at build time.
const files = import.meta.glob('../recipes/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export interface Recipe { slug: string; title: string; blurb: string; category: string; schedule: string; prompt: string }

export const CATEGORIES = ['Daily routine', 'Maintenance', 'Review and release', 'Write', 'Look back']

export const RECIPES: Recipe[] = Object.entries(files)
  .map(([file, raw]) => {
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!
    const meta = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]))
    return { slug: file.replace(/^.*\//, '').replace(/\.md$/, ''), title: meta.title, blurb: meta.blurb, category: meta.category, schedule: meta.schedule ?? '', prompt: m[2].trim() }
  })
  .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.title.localeCompare(b.title))

export const recipe = (slug: string) => RECIPES.find((r) => r.slug === slug)
