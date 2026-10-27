import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Data-only migration (no schema change, so no .json snapshot: the previous snapshot is still the current schema).
 *
 * The public discovery list sorts live events by -startedAt and Postgres sorts NULL first in a descending order, so
 * a non-draft event without startedAt (created directly as 'ended', or moved to 'ended' without ever being 'live')
 * pushed live events off the list. The LiveEvents beforeChange hook now stamps startedAt for new writes; this fills
 * the rows that already exist with their creation time, which is the earliest moment they could have started.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   UPDATE "live_events" SET "started_at" = "created_at" WHERE "status" <> 'draft' AND "started_at" IS NULL;
   UPDATE "live_events" SET "ended_at" = "updated_at" WHERE "status" = 'ended' AND "ended_at" IS NULL;`)
}

export async function down({}: MigrateDownArgs): Promise<void> {
  // Not reversible: backfilled rows cannot be told apart from rows that had a real startedAt. Harmless to keep.
}
