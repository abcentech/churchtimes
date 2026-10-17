import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "media" ADD COLUMN "legacy_path" varchar;
  CREATE INDEX "media_legacy_path_idx" ON "media" USING btree ("legacy_path");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "media_legacy_path_idx";
  ALTER TABLE "media" DROP COLUMN "legacy_path";`)
}
