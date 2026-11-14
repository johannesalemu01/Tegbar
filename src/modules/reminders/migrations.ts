import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';

const init: Migration = {
  async up(db: Kysely<any>) {
    await withStamps(
      withWorkspace(withId(db.schema.createTable('reminders')))
        .addColumn('project_id', 'integer', (c) => c.references('projects.id').onDelete('set null'))
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('remind_at', 'text', (c) => c.notNull())
        .addColumn('recipients', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('source_id', 'integer'),
    ).execute();
    await db.schema.createIndex('reminders_status').on('reminders').columns(['workspace_id', 'status', 'remind_at']).execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('reminders').ifExists().execute();
  },
};

export const reminderMigrations: Record<string, Migration> = {
  '202611150300_reminders_init': init,
};
