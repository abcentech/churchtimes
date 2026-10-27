import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "live_updates" ADD COLUMN "image_id" integer;
  ALTER TABLE "live_updates" ADD CONSTRAINT "live_updates_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "live_updates_image_idx" ON "live_updates" USING btree ("image_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "live_updates" DROP CONSTRAINT "live_updates_image_id_media_id_fk";
  
  DROP INDEX "live_updates_image_idx";
  ALTER TABLE "live_updates" DROP COLUMN "image_id";`)
}
