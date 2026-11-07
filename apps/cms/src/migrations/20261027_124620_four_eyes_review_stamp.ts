import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" ADD COLUMN "provenance_reviewed_by_id" integer;
  ALTER TABLE "articles" ADD COLUMN "provenance_reviewed_by_name" varchar;
  ALTER TABLE "articles" ADD COLUMN "provenance_reviewed_at" timestamp(3) with time zone;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_reviewed_by_id" integer;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_reviewed_by_name" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_reviewed_at" timestamp(3) with time zone;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_provenance_reviewed_by_id_users_id_fk" FOREIGN KEY ("provenance_reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_provenance_reviewed_by_id_users_id_fk" FOREIGN KEY ("version_provenance_reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "articles_provenance_provenance_reviewed_by_idx" ON "articles" USING btree ("provenance_reviewed_by_id");
  CREATE INDEX "_articles_v_version_provenance_version_provenance_review_idx" ON "_articles_v" USING btree ("version_provenance_reviewed_by_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" DROP CONSTRAINT IF EXISTS "articles_provenance_reviewed_by_id_users_id_fk";
  
  ALTER TABLE "_articles_v" DROP CONSTRAINT IF EXISTS "_articles_v_version_provenance_reviewed_by_id_users_id_fk";
  
  DROP INDEX IF EXISTS "articles_provenance_provenance_reviewed_by_idx";
  DROP INDEX IF EXISTS "_articles_v_version_provenance_version_provenance_review_idx";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_reviewed_by_id";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_reviewed_by_name";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_reviewed_at";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_reviewed_by_id";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_reviewed_by_name";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_reviewed_at";`)
}
