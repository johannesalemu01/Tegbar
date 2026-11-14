import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { CreateTableBuilder } from 'kysely';

/**
 * Migration names must be globally unique and sortable:
 *   YYYYMMDDHHmm_<module>_<description>
 * Each module exports its own record of migrations; the app merges them.
 * `allowUnorderedMigrations` lets a module added later ship a migration whose
 * timestamp sorts before migrations that already ran.
 */
export function createMigrator(db: Kysely<any>, migrations: Record<string, Migration>): Migrator {
  const provider: MigrationProvider = { getMigrations: async () => migrations };
  return new Migrator({ db, provider, allowUnorderedMigrations: true });
}

export async function migrateToLatest(db: Kysely<any>, migrations: Record<string, Migration>): Promise<string[]> {
  const { error, results } = await createMigrator(db, migrations).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/*
 * Column helpers — the ONLY place that knows dialect-specific column syntax.
 * Moving to PostgreSQL means changing `withId` (identity column) here, not
 * every migration.
 */
export function withId<T extends string>(t: CreateTableBuilder<T, never>) {
  return t.addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement());
}

export function withStamps<T extends string, C extends string>(t: CreateTableBuilder<T, C>) {
  return t
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull());
}

export function withWorkspace<T extends string, C extends string>(t: CreateTableBuilder<T, C>) {
  return t.addColumn('workspace_id', 'integer', (c) => c.notNull().references('workspaces.id').onDelete('cascade'));
}
