import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';

const init: Migration = {
  async up(db: Kysely<any>) {
    await withStamps(
      withWorkspace(withId(db.schema.createTable('tasks')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('area_id', 'integer', (c) => c.references('areas.id').onDelete('set null'))
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('notes', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('priority', 'text', (c) => c.notNull())
        .addColumn('owner_user_id', 'integer', (c) => c.references('users.id').onDelete('set null'))
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('due_date', 'text')
        .addColumn('due_at', 'text')
        .addColumn('completed_at', 'text')
        .addColumn('deleted_at', 'text')
        .addColumn('deleted_by', 'integer'),
    ).execute();
    await db.schema.createIndex('tasks_ws_status').on('tasks').columns(['workspace_id', 'deleted_at', 'status']).execute();
    await db.schema.createIndex('tasks_owner').on('tasks').columns(['owner_user_id', 'status']).execute();
    await db.schema.createIndex('tasks_project').on('tasks').columns(['project_id', 'status']).execute();
    await db.schema.createIndex('tasks_due').on('tasks').columns(['due_date', 'due_at']).execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('tasks').ifExists().execute();
  },
};

export const taskMigrations: Record<string, Migration> = {
  '202611050100_tasks_init': init,
};
