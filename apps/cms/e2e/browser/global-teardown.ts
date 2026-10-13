import { stopStack } from './support/stack'

/** Kills Next (whole process tree), PostgreSQL and the harness servers, and removes the temp dir. */
export default async function globalTeardown(): Promise<void> {
  await stopStack()
}
