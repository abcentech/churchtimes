import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_articles_provenance_confidence" AS ENUM('partial', 'citation-only', 'missing');
  CREATE TYPE "public"."enum_articles_provenance_review_status" AS ENUM('pending', 'reviewed', 'rejected');
  CREATE TYPE "public"."enum__articles_v_version_provenance_confidence" AS ENUM('partial', 'citation-only', 'missing');
  CREATE TYPE "public"."enum__articles_v_version_provenance_review_status" AS ENUM('pending', 'reviewed', 'rejected');
  ALTER TABLE "articles" ADD COLUMN "provenance_source_url" varchar;
  ALTER TABLE "articles" ADD COLUMN "provenance_source_host" varchar;
  ALTER TABLE "articles" ADD COLUMN "provenance_capture_timestamp" timestamp(3) with time zone;
  ALTER TABLE "articles" ADD COLUMN "provenance_original_date" timestamp(3) with time zone;
  ALTER TABLE "articles" ADD COLUMN "provenance_source_sha256" varchar;
  ALTER TABLE "articles" ADD COLUMN "provenance_confidence" "enum_articles_provenance_confidence";
  ALTER TABLE "articles" ADD COLUMN "provenance_import_batch" varchar;
  ALTER TABLE "articles" ADD COLUMN "provenance_review_status" "enum_articles_provenance_review_status";
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_source_url" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_source_host" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_capture_timestamp" timestamp(3) with time zone;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_original_date" timestamp(3) with time zone;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_source_sha256" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_confidence" "enum__articles_v_version_provenance_confidence";
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_import_batch" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_provenance_review_status" "enum__articles_v_version_provenance_review_status";
  CREATE INDEX "articles_provenance_provenance_source_url_idx" ON "articles" USING btree ("provenance_source_url");
  CREATE INDEX "articles_provenance_provenance_source_sha256_idx" ON "articles" USING btree ("provenance_source_sha256");
  CREATE INDEX "articles_provenance_provenance_import_batch_idx" ON "articles" USING btree ("provenance_import_batch");
  CREATE INDEX "_articles_v_version_provenance_version_provenance_source_idx" ON "_articles_v" USING btree ("version_provenance_source_url");
  CREATE INDEX "_articles_v_version_provenance_version_provenance_sour_1_idx" ON "_articles_v" USING btree ("version_provenance_source_sha256");
  CREATE INDEX "_articles_v_version_provenance_version_provenance_import_idx" ON "_articles_v" USING btree ("version_provenance_import_batch");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX IF EXISTS "articles_provenance_provenance_source_url_idx";
  DROP INDEX IF EXISTS "articles_provenance_provenance_source_sha256_idx";
  DROP INDEX IF EXISTS "articles_provenance_provenance_import_batch_idx";
  DROP INDEX IF EXISTS "_articles_v_version_provenance_version_provenance_source_idx";
  DROP INDEX IF EXISTS "_articles_v_version_provenance_version_provenance_sour_1_idx";
  DROP INDEX IF EXISTS "_articles_v_version_provenance_version_provenance_import_idx";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_source_url";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_source_host";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_capture_timestamp";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_original_date";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_source_sha256";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_confidence";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_import_batch";
  ALTER TABLE "articles" DROP COLUMN IF EXISTS "provenance_review_status";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_source_url";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_source_host";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_capture_timestamp";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_original_date";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_source_sha256";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_confidence";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_import_batch";
  ALTER TABLE "_articles_v" DROP COLUMN IF EXISTS "version_provenance_review_status";
  DROP TYPE IF EXISTS "public"."enum_articles_provenance_confidence";
  DROP TYPE IF EXISTS "public"."enum_articles_provenance_review_status";
  DROP TYPE IF EXISTS "public"."enum__articles_v_version_provenance_confidence";
  DROP TYPE IF EXISTS "public"."enum__articles_v_version_provenance_review_status";`)
}
