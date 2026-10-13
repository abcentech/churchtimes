import type { Payload } from 'payload'

/** Publish every `scheduled` article whose `scheduledFor <= now`. Returns the number published. */
export async function publishDueArticles(payload: Payload, now: Date = new Date()): Promise<number> {
  const due = await payload.find({
    collection: 'articles',
    where: {
      and: [{ status: { equals: 'scheduled' } }, { scheduledFor: { less_than_equal: now.toISOString() } }],
    },
    limit: 100,
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })

  let published = 0
  for (const doc of due.docs) {
    try {
      await payload.update({
        collection: 'articles',
        id: doc.id,
        data: { status: 'published' } as never,
        overrideAccess: true,
        // Server-side only: REST clients cannot set req.context.
        context: { systemTransition: true, systemNow: now.toISOString() },
      })
      published += 1
    } catch (err) {
      payload.logger.error({ err, articleId: doc.id }, 'scheduler: failed to publish article')
    }
  }
  return published
}

type SchedulerGlobal = typeof globalThis & { __ctSchedulerTimer?: ReturnType<typeof setInterval> }

export function startScheduler(payload: Payload): void {
  if (process.env.SCHEDULER_ENABLED === 'false' || process.env.NODE_ENV === 'test') return
  const g = globalThis as SchedulerGlobal
  if (g.__ctSchedulerTimer) return

  const parsed = Number(process.env.SCHEDULER_INTERVAL_SECONDS)
  const seconds = Number.isFinite(parsed) && parsed >= 1 ? parsed : 60

  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const n = await publishDueArticles(payload)
      if (n > 0) payload.logger.info(`scheduler: published ${n} scheduled article(s)`)
    } catch (err) {
      payload.logger.error({ err }, 'scheduler: run failed')
    } finally {
      running = false
    }
  }

  g.__ctSchedulerTimer = setInterval(() => void tick(), seconds * 1000)
  g.__ctSchedulerTimer.unref?.()
}
