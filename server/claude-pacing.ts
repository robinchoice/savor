export interface ClaudeUsageSample { percent: number; resetsAt: number; observedAt: number }

const HOUR = 3600_000
const WINDOW = 5 * HOUR
export const PACING_INTERVAL = Number(process.env.SAVOR_CLAUDE_PACING_INTERVAL_MS ?? 60_000)

// One queue for this daemon's Claude subscription work, across projects and conversations.
export class ClaudePacing {
  private queue = new Set<string>()
  private active = new Set<string>()
  private lastStart = -Infinity

  constructor(private sample: () => Promise<ClaudeUsageSample | null>, private now = Date.now) {}

  running(id: string) {
    this.queue.delete(id)
    this.active.add(id)
  }

  release(id: string) { this.active.delete(id) }
  cancel(id: string) { this.queue.delete(id) }

  async admit(id: string) {
    this.queue.add(id)
    const sample = await this.sample()
    const now = this.now()
    const retryAt = now + PACING_INTERVAL
    // Cancellation can happen while get_usage is in flight. It must never start the old input.
    if (!this.queue.has(id)) return { at: retryAt }
    if (!sample || !Number.isFinite(sample.percent) || sample.percent < 0 || sample.percent > 100 ||
      !Number.isFinite(sample.resetsAt) || !Number.isFinite(sample.observedAt) || sample.observedAt > now ||
      now - sample.observedAt > 90_000 || sample.resetsAt <= now || sample.resetsAt > now + WINDOW) return { at: retryAt }
    const elapsed = now - (sample.resetsAt - WINDOW)
    const allowance = Math.min(90, 18 * elapsed / HOUR)
    if (sample.percent >= 90 || sample.percent > allowance) return { at: retryAt }
    if (this.active.size || this.queue.values().next().value !== id || now - this.lastStart < PACING_INTERVAL) return { at: retryAt }
    this.lastStart = now
    this.running(id)
    return null
  }
}
