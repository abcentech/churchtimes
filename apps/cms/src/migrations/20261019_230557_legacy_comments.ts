import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_legacy_comments_status" AS ENUM('approved', 'hidden');
  CREATE TABLE "legacy_comments" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"article_id" integer NOT NULL,
  	"author_name" varchar NOT NULL,
  	"content" varchar NOT NULL,
  	"commented_at" timestamp(3) with time zone NOT NULL,
  	"legacy_id" numeric NOT NULL,
  	"parent_legacy_id" numeric,
  	"status" "enum_legacy_comments_status" DEFAULT 'approved' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "legacy_comments_id" integer;
  ALTER TABLE "legacy_comments" ADD CONSTRAINT "legacy_comments_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "legacy_comments_article_idx" ON "legacy_comments" USING btree ("article_id");
  CREATE INDEX "legacy_comments_commented_at_idx" ON "legacy_comments" USING btree ("commented_at");
  CREATE UNIQUE INDEX "legacy_comments_legacy_id_idx" ON "legacy_comments" USING btree ("legacy_id");
  CREATE INDEX "legacy_comments_parent_legacy_id_idx" ON "legacy_comments" USING btree ("parent_legacy_id");
  CREATE INDEX "legacy_comments_status_idx" ON "legacy_comments" USING btree ("status");
  CREATE INDEX "legacy_comments_updated_at_idx" ON "legacy_comments" USING btree ("updated_at");
  CREATE INDEX "legacy_comments_created_at_idx" ON "legacy_comments" USING btree ("created_at");
  CREATE INDEX "article_status_commentedAt_legacyId_idx" ON "legacy_comments" USING btree ("article_id","status","commented_at","legacy_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_legacy_comments_fk" FOREIGN KEY ("legacy_comments_id") REFERENCES "public"."legacy_comments"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_legacy_comments_id_idx" ON "payload_locked_documents_rels" USING btree ("legacy_comments_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_legacy_comments_fk";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_legacy_comments_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "legacy_comments_id";
  DROP TABLE IF EXISTS "legacy_comments" CASCADE;
  DROP TYPE IF EXISTS "public"."enum_legacy_comments_status";`)
}
