import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Secondary categories: `articles.categories` (relationship hasMany to categories) is stored in the articles_rels join
 * table (and _articles_v_rels for versions), cascading when a category is deleted. `articles.category` stays the required
 * primary. The hand-written part adds `article_search.category_ids` (primary + secondary, GIN) so the C8 `category=` filter
 * matches either; `category_id` stays the primary (displayed) category. The search table is not a Payload collection, so
 * the snapshot (.json) only covers the join-table columns. Re-runnable (IF NOT EXISTS / IF EXISTS).
 */
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles_rels" ADD COLUMN IF NOT EXISTS "categories_id" integer;
  ALTER TABLE "_articles_v_rels" ADD COLUMN IF NOT EXISTS "categories_id" integer;
  ALTER TABLE "articles_rels" DROP CONSTRAINT IF EXISTS "articles_rels_categories_fk";
  ALTER TABLE "_articles_v_rels" DROP CONSTRAINT IF EXISTS "_articles_v_rels_categories_fk";
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_categories_fk" FOREIGN KEY ("categories_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_categories_fk" FOREIGN KEY ("categories_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX IF NOT EXISTS "articles_rels_categories_id_idx" ON "articles_rels" USING btree ("categories_id");
  CREATE INDEX IF NOT EXISTS "_articles_v_rels_categories_id_idx" ON "_articles_v_rels" USING btree ("categories_id");
  ALTER TABLE "article_search" ADD COLUMN IF NOT EXISTS "category_ids" integer[] DEFAULT '{}'::integer[] NOT NULL;
  UPDATE "article_search" SET "category_ids" = ARRAY["category_id"] WHERE "category_ids" = '{}'::integer[];
  CREATE INDEX IF NOT EXISTS "article_search_category_ids_idx" ON "article_search" USING gin ("category_ids");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX IF EXISTS "article_search_category_ids_idx";
  ALTER TABLE "article_search" DROP COLUMN IF EXISTS "category_ids";
  ALTER TABLE "articles_rels" DROP CONSTRAINT IF EXISTS "articles_rels_categories_fk";
  ALTER TABLE "_articles_v_rels" DROP CONSTRAINT IF EXISTS "_articles_v_rels_categories_fk";
  DROP INDEX IF EXISTS "articles_rels_categories_id_idx";
  DROP INDEX IF EXISTS "_articles_v_rels_categories_id_idx";
  ALTER TABLE "articles_rels" DROP COLUMN IF EXISTS "categories_id";
  ALTER TABLE "_articles_v_rels" DROP COLUMN IF EXISTS "categories_id";`)
}
