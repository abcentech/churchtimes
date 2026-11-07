/**
 * Logging that cannot leak personal data. drizzle wraps database failures in a `DrizzleQueryError` whose `message`
 * is `Failed query: <sql> params: <values>`, so logging or printing the error (or its message) would write a sender's
 * name, address and message, or a subscriber's address, into the logs. Everything that touches contact or subscriber
 * data logs ONLY the error class name and a short code (for PostgreSQL the SQLSTATE such as `23505`), never the message,
 * the stack, the cause chain or the query.
 */

const CODE_RE = /^[A-Za-z0-9_]{1,20}$/

export function safeErrorFields(err: unknown): { errName: string; errCode?: string } {
  const errName = err instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(err.name) ? err.name : 'Error'
  const candidates = [(err as { code?: unknown } | null)?.code, ((err as { cause?: unknown } | null)?.cause as { code?: unknown } | undefined)?.code]
  const code = candidates.find((c): c is string => typeof c === 'string' && CODE_RE.test(c))
  return code ? { errName, errCode: code } : { errName }
}

/** `DrizzleQueryError (23505)`: for CLI output and one-line messages. */
export function safeErrorSummary(err: unknown): string {
  const { errName, errCode } = safeErrorFields(err)
  return errCode ? `${errName} (${errCode})` : errName
}

/** Thrown by our own CLI for usage mistakes; its message is a fixed string and safe to print. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

/** What a CLI may print for any failure: our own fixed messages, or only the class and code of anything else. */
export function cliFailureMessage(err: unknown): string {
  return err instanceof CliUsageError ? err.message : `import failed: ${safeErrorSummary(err)} (details withheld: they may contain addresses)`
}
