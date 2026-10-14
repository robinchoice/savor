import { lang, t } from './i18n'

// Plain words for the cron expressions the schedule presets and recipes use; anything else stays as is.
const DAYS = () => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')]
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

export function describeCron(cron: string) {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/)
  if (!/^\d{1,2}$/.test(min ?? '') || mon !== '*') return cron
  if (hour === '*' && dom === '*' && dow === '*') return min === '0' ? t('Every hour') : t('Every hour at :{min}', { min: min.padStart(2, '0') })
  if (!/^\d{1,2}$/.test(hour ?? '')) return cron
  const at = `${hour}:${min.padStart(2, '0')}`
  if (dom === '*' && dow === '*') return t('Every day at {at}', { at })
  if (dom === '*' && dow === '1-5') return t('Every weekday at {at}', { at })
  if (dom === '*' && /^\d$/.test(dow)) return t('Every {day} at {at}', { day: DAYS()[Number(dow)], at })
  if (/^\d{1,2}$/.test(dom) && dow === '*') return t('Monthly on the {nth} at {at}', { nth: lang === 'de' ? `${Number(dom)}.` : ordinal(Number(dom)), at })
  return cron
}
