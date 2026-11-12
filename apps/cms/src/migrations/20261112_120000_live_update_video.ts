import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/** Add the optional, validated YouTube fields without changing existing live updates. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "live_updates" ADD COLUMN IF NOT EXISTS "video_video_id" varchar;
    ALTER TABLE "live_updates" ADD COLUMN IF NOT EXISTS "video_title" varchar;
    ALTER TABLE "live_updates" ADD COLUMN IF NOT EXISTS "video_start_seconds" numeric;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "live_updates" DROP COLUMN IF EXISTS "video_start_seconds";
    ALTER TABLE "live_updates" DROP COLUMN IF EXISTS "video_title";
    ALTER TABLE "live_updates" DROP COLUMN IF EXISTS "video_video_id";
  `)
}
