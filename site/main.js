// The visitor's system names the hero button and preselects the install tab
document.documentElement.classList.add('js')

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
  const others = Object.keys(NAMES).filter((key) => key !== os)
  document.querySelector('[data-os-cta]').textContent = `Download for ${NAMES[os]}`
  document.querySelector('[data-os-others]').textContent = `also for ${others.map((key) => NAMES[key]).join(' and ')}`
}

const tabs = document.querySelectorAll('.os [role=tab]')
const panels = document.querySelectorAll('.os [role=tabpanel]')

function show(key) {
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.os === key))
  for (const panel of panels) panel.hidden = panel.dataset.os !== key
}

for (const tab of tabs) tab.addEventListener('click', () => show(tab.dataset.os))
show(os ?? 'linux')
