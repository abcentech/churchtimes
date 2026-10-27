import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Import loader: `articles.legacy_id` (the WordPress post id) becomes unique, so a re-run or a second importer can never
 * create two articles for one post. NULLs stay allowed (articles written in the CMS have no legacy id).
 * Fails with a clear message when duplicates already exist: fix them by hand first.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM "articles" WHERE "legacy_id" IS NOT NULL GROUP BY "legacy_id" HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'articles.legacy_id has duplicates; resolve them before this migration';
    END IF;
  END $$;
  DROP INDEX IF EXISTS "articles_legacy_id_idx";
  CREATE UNIQUE INDEX "articles_legacy_id_idx" ON "articles" USING btree ("legacy_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP INDEX IF EXISTS "articles_legacy_id_idx";
  CREATE INDEX "articles_legacy_id_idx" ON "articles" USING btree ("legacy_id");`)
}
