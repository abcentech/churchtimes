import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "articles_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"media_id" integer
  );
  
  CREATE TABLE "_articles_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"media_id" integer
  );
  
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "articles_rels_order_idx" ON "articles_rels" USING btree ("order");
  CREATE INDEX "articles_rels_parent_idx" ON "articles_rels" USING btree ("parent_id");
  CREATE INDEX "articles_rels_path_idx" ON "articles_rels" USING btree ("path");
  CREATE INDEX "articles_rels_media_id_idx" ON "articles_rels" USING btree ("media_id");
  CREATE INDEX "_articles_v_rels_order_idx" ON "_articles_v_rels" USING btree ("order");
  CREATE INDEX "_articles_v_rels_parent_idx" ON "_articles_v_rels" USING btree ("parent_id");
  CREATE INDEX "_articles_v_rels_path_idx" ON "_articles_v_rels" USING btree ("path");
  CREATE INDEX "_articles_v_rels_media_id_idx" ON "_articles_v_rels" USING btree ("media_id");
  -- Backfill articles_rels.bodyMedia from the existing Lexical bodies: every upload node of relationTo media
  -- whose value is a plain integer id (or a populated object with one) that still exists in media.
  INSERT INTO "articles_rels" ("order", "parent_id", "path", "media_id")
  SELECT row_number() OVER (PARTITION BY ids.article_id ORDER BY ids.media_id), ids.article_id, 'bodyMedia', ids.media_id
  FROM (
    SELECT DISTINCT a."id" AS article_id, m."id" AS media_id
    FROM "articles" a
    CROSS JOIN LATERAL jsonb_path_query(a."content", 'strict $.**') AS node
    JOIN "media" m ON m."id" = CASE
      WHEN jsonb_typeof(node -> 'value') = 'number' AND (node ->> 'value') ~ '^[0-9]{1,9}$' THEN (node ->> 'value')::integer
      WHEN jsonb_typeof(node -> 'value') = 'object' AND (node -> 'value' ->> 'id') ~ '^[0-9]{1,9}$' THEN (node -> 'value' ->> 'id')::integer
    END
    WHERE jsonb_typeof(node) = 'object' AND node ->> 'type' = 'upload' AND node ->> 'relationTo' = 'media'
  ) ids;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "articles_rels" CASCADE;
  DROP TABLE "_articles_v_rels" CASCADE;`)
}
