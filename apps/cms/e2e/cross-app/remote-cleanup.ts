/**
 * Manual sweep of a remote run that crashed before its teardown (or was killed): deletes / archives ONLY records whose title or
 * filename contains the given run prefix (same code as the automatic teardown).
 *
 *   XAPP_CMS_URL=https://cms.staging... XAPP_REMOTE_CREDENTIALS=<file> npx tsx e2e/cross-app/remote-cleanup.ts E2E-20261014-1530
 */
import { assertSweepablePrefix, cleanupByPrefix, readCredentialsFile } from './support/remote'

const prefix = process.argv[2]
if (!prefix) throw new Error('usage: tsx e2e/cross-app/remote-cleanup.ts E2E-yyyymmdd-hhmm')
assertSweepablePrefix(prefix)
const cms = process.env.XAPP_CMS_URL
if (!cms || !cms.startsWith('https://')) throw new Error('XAPP_CMS_URL must be set to the https CMS origin')
await cleanupByPrefix(new URL(cms).origin, readCredentialsFile().credentials, prefix)
