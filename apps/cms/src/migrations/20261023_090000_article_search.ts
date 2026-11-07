import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Public search projection (go-live contract C8): one row per published article, with a GENERATED weighted tsvector
 * ('english' configuration: title A, excerpt B, plain body C) and a GIN index. Maintained by Articles hooks and
 * `npm run search:reindex`. The table is hand-written SQL, not a Payload collection, so the schema snapshot is unchanged
 * (the .json beside this file only chains the snapshot id). Published articles are seeded here with title and excerpt
 * only; `npm run search:reindex` fills the body text (it needs the Lexical content).
 */
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE IF NOT EXISTS "article_search" (
    "article_id" integer PRIMARY KEY NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
    "category_id" integer NOT NULL,
    "published_at" timestamp(3) with time zone NOT NULL,
    "title" text NOT NULL,
    "excerpt" text DEFAULT '' NOT NULL,
    "body" text DEFAULT '' NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english'::regconfig, "title"), 'A') ||
      setweight(to_tsvector('english'::regconfig, "excerpt"), 'B') ||
      setweight(to_tsvector('english'::regconfig, "body"), 'C')
    ) STORED,
    "indexed_at" timestamp(3) with time zone DEFAULT now() NOT NULL
   );
   CREATE INDEX IF NOT EXISTS "article_search_tsv_idx" ON "article_search" USING gin ("tsv");
   CREATE INDEX IF NOT EXISTS "article_search_category_published_idx" ON "article_search" USING btree ("category_id","published_at");
   CREATE INDEX IF NOT EXISTS "article_search_published_idx" ON "article_search" USING btree ("published_at");
   INSERT INTO "article_search" ("article_id","category_id","published_at","title","excerpt")
     SELECT "id","category_id","published_at",left("title",500),left(coalesce("excerpt",''),1000) FROM "articles"
     WHERE "status"::text = 'published' AND "published_at" IS NOT NULL
     ON CONFLICT ("article_id") DO NOTHING;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE IF EXISTS "article_search" CASCADE;`)
}
