import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/** Public submissions: consent timestamp (server time) and the version of the consent wording. Both nullable. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "consent_at" timestamp(3) with time zone;
  ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "consent_text_version" varchar;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "submissions" DROP COLUMN IF EXISTS "consent_at";
  ALTER TABLE "submissions" DROP COLUMN IF EXISTS "consent_text_version";`)
}
