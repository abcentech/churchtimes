import type { Payload } from 'payload'

// TODO(phase2): publish scheduled articles whose scheduledFor <= now; write audit log; return count.
export async function publishDueArticles(_payload: Payload, _now: Date = new Date()): Promise<number> {
  return 0
}

// TODO(phase2): setInterval loop honouring SCHEDULER_ENABLED / SCHEDULER_INTERVAL_SECONDS; guard against double start.
export function startScheduler(_payload: Payload): void {}
