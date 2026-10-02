// Plain words for the cron expressions the schedule presets and recipes use; anything else stays as is.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

export function describeCron(cron: string) {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/)
  if (!/^\d{1,2}$/.test(min ?? '') || mon !== '*') return cron
  if (hour === '*' && dom === '*' && dow === '*') return min === '0' ? 'Every hour' : `Every hour at :${min.padStart(2, '0')}`
  if (!/^\d{1,2}$/.test(hour ?? '')) return cron
  const at = `${hour}:${min.padStart(2, '0')}`
  if (dom === '*' && dow === '*') return `Every day at ${at}`
  if (dom === '*' && dow === '1-5') return `Every weekday at ${at}`
  if (dom === '*' && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${at}`
  if (/^\d{1,2}$/.test(dom) && dow === '*') return `Monthly on the ${ordinal(Number(dom))} at ${at}`
  return cron
}
