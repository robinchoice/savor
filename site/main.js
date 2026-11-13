// The visitor's system names the hero button and preselects the install tab
document.documentElement.classList.add('js')

const de = document.documentElement.lang === 'de'
const NAMES = { linux: 'Linux', mac: 'macOS', win: 'Windows' }
const ua = navigator.userAgent
// Savor is a desktop app, so phones and tablets get the neutral wording from the markup
const os = /Android|iPhone|iPad|Mobile/i.test(ua)
  ? null
  : /Windows/i.test(ua)
    ? 'win'
    : /Mac/i.test(ua)
      ? 'mac'
      : /Linux|X11/i.test(ua)
        ? 'linux'
        : null

if (os) {
  const others = Object.keys(NAMES)
    .filter((key) => key !== os)
    .map((key) => NAMES[key])
    .join(de ? ' und ' : ' and ')
  document.querySelector('[data-os-cta]').textContent = de ? `Für ${NAMES[os]} laden` : `Download for ${NAMES[os]}`
  document.querySelector('[data-os-others]').textContent = de ? `auch für ${others}` : `also for ${others}`
}

const tabs = document.querySelectorAll('.os [role=tab]')
const panels = document.querySelectorAll('.os [role=tabpanel]')

function show(key) {
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.os === key))
  for (const panel of panels) panel.hidden = panel.dataset.os !== key
}

for (const tab of tabs) tab.addEventListener('click', () => show(tab.dataset.os))
show(os ?? 'linux')

// The step in the middle of the viewport lights its numeral and its tick on the rail, which shows only
// while the steps are on screen
const steps = [...document.querySelectorAll('.step')]
const rail = document.querySelector('.rail')
const ticks = [...rail.querySelectorAll('a')]
const middle = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const i = steps.indexOf(entry.target)
      steps.forEach((step, j) => step.classList.toggle('on', j === i))
      ticks.forEach((tick, j) => tick.classList.toggle('on', j === i))
    }
  },
  { rootMargin: '-45% 0px -45% 0px' },
)
for (const step of steps) middle.observe(step)
new IntersectionObserver(([entry]) => rail.classList.toggle('show', entry.isIntersecting), {
  rootMargin: '-40% 0px -40% 0px',
}).observe(document.querySelector('.steps'))
