import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" ADD COLUMN "seo_title" varchar;
  ALTER TABLE "articles" ADD COLUMN "seo_description" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_seo_title" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_seo_description" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" DROP COLUMN "seo_title";
  ALTER TABLE "articles" DROP COLUMN "seo_description";
  ALTER TABLE "_articles_v" DROP COLUMN "version_seo_title";
  ALTER TABLE "_articles_v" DROP COLUMN "version_seo_description";`)
}
