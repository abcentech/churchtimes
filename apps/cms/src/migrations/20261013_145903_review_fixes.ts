import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "media" ADD COLUMN "uploaded_by_id" integer;
  ALTER TABLE "live_updates" ADD COLUMN "publish_sequence" numeric;
  -- Backfill: rows that are already approved keep their creation sequence as their publication
  -- sequence, so cursors held by pollers of the old (creation-ordered) feed stay valid. New approvals
  -- continue from max(publish_sequence) + 1. (event_id, sequence) is unique, so this is unique too.
  UPDATE "live_updates" SET "publish_sequence" = "sequence" WHERE "status" = 'approved' AND "publish_sequence" IS NULL;
  ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "media_uploaded_by_idx" ON "media" USING btree ("uploaded_by_id");
  CREATE INDEX "live_updates_publish_sequence_idx" ON "live_updates" USING btree ("publish_sequence");
  CREATE UNIQUE INDEX "event_publishSequence_idx" ON "live_updates" USING btree ("event_id","publish_sequence");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "media" DROP CONSTRAINT "media_uploaded_by_id_users_id_fk";
  
  DROP INDEX "media_uploaded_by_idx";
  DROP INDEX "live_updates_publish_sequence_idx";
  DROP INDEX "event_publishSequence_idx";
  ALTER TABLE "media" DROP COLUMN "uploaded_by_id";
  ALTER TABLE "live_updates" DROP COLUMN "publish_sequence";`)
}
