import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "submissions" ADD COLUMN "content_hash" varchar;
  CREATE INDEX "submissions_content_hash_idx" ON "submissions" USING btree ("content_hash");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "submissions_content_hash_idx";
  ALTER TABLE "submissions" DROP COLUMN "content_hash";`)
}
