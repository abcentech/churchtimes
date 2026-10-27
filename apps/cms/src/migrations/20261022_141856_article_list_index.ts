import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Public article list (status = published, newest first): a composite index lets Postgres read a page from the index
 * instead of sorting every article row (public list p50 244 ms to 45 ms at 4,160 articles; docs/performance.md).
 * The _articles_v index mirrors the collection `indexes` option, which Payload applies to the versions table too.
 */
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE INDEX IF NOT EXISTS "status_publishedAt_createdAt_idx" ON "articles" USING btree ("status","published_at","created_at");
  CREATE INDEX IF NOT EXISTS "version_status_version_publishedAt_version_createdAt_idx" ON "_articles_v" USING btree ("version_status","version_published_at","version_created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX IF EXISTS "status_publishedAt_createdAt_idx";
  DROP INDEX IF EXISTS "version_status_version_publishedAt_version_createdAt_idx";`)
}
