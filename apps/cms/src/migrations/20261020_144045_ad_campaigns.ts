import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_ad_campaigns_placements" AS ENUM('homepage-billboard', 'article-inline', 'mobile-banner');
  CREATE TYPE "public"."enum_ad_campaigns_status" AS ENUM('draft', 'pending_approval', 'approved', 'paused', 'cancelled');
  CREATE TYPE "public"."enum_ad_campaigns_payment_status" AS ENUM('unpaid', 'invoiced', 'paid', 'waived');
  CREATE TABLE "advertisers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"contact_name" varchar,
  	"contact_email" varchar,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "ad_campaigns_placements" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_ad_campaigns_placements",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "ad_campaigns" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"advertiser_id" integer NOT NULL,
  	"sponsor" varchar NOT NULL,
  	"alt" varchar NOT NULL,
  	"destination_url" varchar NOT NULL,
  	"creatives_homepage_billboard_desktop_id" integer,
  	"creatives_homepage_billboard_mobile_id" integer,
  	"creatives_article_inline_desktop_id" integer,
  	"creatives_article_inline_mobile_id" integer,
  	"creatives_mobile_banner_mobile_id" integer,
  	"starts_at" timestamp(3) with time zone NOT NULL,
  	"ends_at" timestamp(3) with time zone NOT NULL,
  	"priority" numeric DEFAULT 0 NOT NULL,
  	"status" "enum_ad_campaigns_status" DEFAULT 'draft' NOT NULL,
  	"rights_confirmed" boolean DEFAULT false,
  	"payment_status" "enum_ad_campaigns_payment_status" DEFAULT 'unpaid' NOT NULL,
  	"approved_by_id" integer,
  	"approved_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "ad_campaigns_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"media_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "advertisers_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "ad_campaigns_id" integer;
  ALTER TABLE "ad_campaigns_placements" ADD CONSTRAINT "ad_campaigns_placements_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_advertiser_id_advertisers_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."advertisers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_creatives_homepage_billboard_desktop_id_media_id_fk" FOREIGN KEY ("creatives_homepage_billboard_desktop_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_creatives_homepage_billboard_mobile_id_media_id_fk" FOREIGN KEY ("creatives_homepage_billboard_mobile_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_creatives_article_inline_desktop_id_media_id_fk" FOREIGN KEY ("creatives_article_inline_desktop_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_creatives_article_inline_mobile_id_media_id_fk" FOREIGN KEY ("creatives_article_inline_mobile_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_creatives_mobile_banner_mobile_id_media_id_fk" FOREIGN KEY ("creatives_mobile_banner_mobile_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_campaigns_rels" ADD CONSTRAINT "ad_campaigns_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "ad_campaigns_rels" ADD CONSTRAINT "ad_campaigns_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "advertisers_updated_at_idx" ON "advertisers" USING btree ("updated_at");
  CREATE INDEX "advertisers_created_at_idx" ON "advertisers" USING btree ("created_at");
  CREATE INDEX "ad_campaigns_placements_order_idx" ON "ad_campaigns_placements" USING btree ("order");
  CREATE INDEX "ad_campaigns_placements_parent_idx" ON "ad_campaigns_placements" USING btree ("parent_id");
  CREATE INDEX "ad_campaigns_advertiser_idx" ON "ad_campaigns" USING btree ("advertiser_id");
  CREATE INDEX "ad_campaigns_creatives_homepage_billboard_creatives_home_idx" ON "ad_campaigns" USING btree ("creatives_homepage_billboard_desktop_id");
  CREATE INDEX "ad_campaigns_creatives_homepage_billboard_creatives_ho_1_idx" ON "ad_campaigns" USING btree ("creatives_homepage_billboard_mobile_id");
  CREATE INDEX "ad_campaigns_creatives_article_inline_creatives_article__idx" ON "ad_campaigns" USING btree ("creatives_article_inline_desktop_id");
  CREATE INDEX "ad_campaigns_creatives_article_inline_creatives_articl_1_idx" ON "ad_campaigns" USING btree ("creatives_article_inline_mobile_id");
  CREATE INDEX "ad_campaigns_creatives_mobile_banner_creatives_mobile_ba_idx" ON "ad_campaigns" USING btree ("creatives_mobile_banner_mobile_id");
  CREATE INDEX "ad_campaigns_starts_at_idx" ON "ad_campaigns" USING btree ("starts_at");
  CREATE INDEX "ad_campaigns_ends_at_idx" ON "ad_campaigns" USING btree ("ends_at");
  CREATE INDEX "ad_campaigns_status_idx" ON "ad_campaigns" USING btree ("status");
  CREATE INDEX "ad_campaigns_payment_status_idx" ON "ad_campaigns" USING btree ("payment_status");
  CREATE INDEX "ad_campaigns_approved_by_idx" ON "ad_campaigns" USING btree ("approved_by_id");
  CREATE INDEX "ad_campaigns_updated_at_idx" ON "ad_campaigns" USING btree ("updated_at");
  CREATE INDEX "ad_campaigns_created_at_idx" ON "ad_campaigns" USING btree ("created_at");
  CREATE INDEX "ad_campaigns_rels_order_idx" ON "ad_campaigns_rels" USING btree ("order");
  CREATE INDEX "ad_campaigns_rels_parent_idx" ON "ad_campaigns_rels" USING btree ("parent_id");
  CREATE INDEX "ad_campaigns_rels_path_idx" ON "ad_campaigns_rels" USING btree ("path");
  CREATE INDEX "ad_campaigns_rels_media_id_idx" ON "ad_campaigns_rels" USING btree ("media_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_advertisers_fk" FOREIGN KEY ("advertisers_id") REFERENCES "public"."advertisers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ad_campaigns_fk" FOREIGN KEY ("ad_campaigns_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_advertisers_id_idx" ON "payload_locked_documents_rels" USING btree ("advertisers_id");
  CREATE INDEX "payload_locked_documents_rels_ad_campaigns_id_idx" ON "payload_locked_documents_rels" USING btree ("ad_campaigns_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Hand-edited: the generated version dropped constraints after DROP TABLE ... CASCADE and was not repeatable.
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_advertisers_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_ad_campaigns_fk";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_advertisers_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_ad_campaigns_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "advertisers_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "ad_campaigns_id";
  DROP TABLE IF EXISTS "ad_campaigns_rels" CASCADE;
  DROP TABLE IF EXISTS "ad_campaigns_placements" CASCADE;
  DROP TABLE IF EXISTS "ad_campaigns" CASCADE;
  DROP TABLE IF EXISTS "advertisers" CASCADE;
  DROP TYPE IF EXISTS "public"."enum_ad_campaigns_placements";
  DROP TYPE IF EXISTS "public"."enum_ad_campaigns_status";
  DROP TYPE IF EXISTS "public"."enum_ad_campaigns_payment_status";`)
}
