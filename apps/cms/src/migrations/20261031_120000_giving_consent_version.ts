import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Giving: store which consent wording a giver accepted next to `consent_at` (docs/w12/giving.md section 4).
 * Additive only: one nullable column; rows created before it read as null (they were all `giving-v1`, the only wording
 * shipped before this migration, so it is backfilled for rows that have a consent time). Written by hand from the
 * previous snapshot; the .json next to this file is that snapshot plus this column.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "donations" ADD COLUMN IF NOT EXISTS "consent_version" varchar;
  UPDATE "donations" SET "consent_version" = 'giving-v1' WHERE "consent_version" IS NULL AND "consent_at" IS NOT NULL;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "donations" DROP COLUMN IF EXISTS "consent_version";`)
}
