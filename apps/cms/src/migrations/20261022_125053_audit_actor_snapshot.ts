import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actor_id_snapshot" varchar;
  CREATE INDEX IF NOT EXISTS "audit_logs_actor_id_snapshot_idx" ON "audit_logs" USING btree ("actor_id_snapshot");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX IF EXISTS "audit_logs_actor_id_snapshot_idx";
  ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "actor_id_snapshot";`)
}
