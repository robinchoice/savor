// Branch names for a fan-out, one per agent: the start of the prompt, then the agent and its model.
// The daemon adds a number to a name whose branch exists already.
export function fanoutBranches(prompt: string, agents: { provider: string; model: string }[]) {
  const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9.\s-]+/g, '').trim().split(/[\s.]+/).filter(Boolean)
  const topic = clean(prompt).slice(0, 4).join('-').slice(0, 40).replace(/-+$/, '') || 'fan-out'
  const names = agents.map((a) => `${topic}/${[a.provider, ...clean(a.model)].join('-')}`)
  return names.map((n, i) => (names.indexOf(n) === names.lastIndexOf(n) ? n : `${n}-${names.slice(0, i + 1).filter((x) => x === n).length}`))
}
