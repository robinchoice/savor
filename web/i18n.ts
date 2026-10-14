import de, { patterns } from './de'

// Savor speaks English and German. Texts are keyed by their English wording, so a missing German
// entry falls back to English; test/i18n.test.mjs checks that every t('…') has one.
export type Lang = 'en' | 'de'
export type LangPref = 'system' | Lang

const KEY = 'savor-lang'
// The service worker has no localStorage and no document; it follows the system language.
export const langPref = ((typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)) as LangPref | null) ?? 'system'
export const lang: Lang = langPref === 'system' ? (navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en') : langPref
if (typeof document !== 'undefined') document.documentElement.lang = lang

// Every text is translated once, at render, so switching reloads the page.
export function setLang(pref: LangPref) {
  localStorage.setItem(KEY, pref)
  location.reload()
}

// t('{n} files', { n: 3 }) fills the placeholders after translating.
export function t(en: string, vars?: Record<string, string | number>) {
  const text = lang === 'de' ? (de[en] ?? en) : en
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text
}

// Texts the daemon sends with values in them, matched by the patterns in de.ts.
export function tx(text: string) {
  if (lang !== 'de') return text
  for (const [re, german] of patterns) {
    const m = text.match(re)
    if (m) return german.replace(/\$(\d)/g, (_, i: string) => m[+i] ?? '')
  }
  return t(text)
}

// English plural: one form for 1, the other for the rest.
export const plural = (n: number, one: string, other: string) => t(n === 1 ? one : other, { n })
