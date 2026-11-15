import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { withId, withStamps, withWorkspace } from './migrations.js';

const init: Migration = {
  async up(db: Kysely<any>) {
    await withStamps(
      withId(db.schema.createTable('workspaces'))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('timezone', 'text', (c) => c.notNull()),
    ).execute();

    await withStamps(
      withId(db.schema.createTable('users'))
        .addColumn('telegram_id', 'integer', (c) => c.notNull().unique())
        .addColumn('first_name', 'text', (c) => c.notNull())
        .addColumn('last_name', 'text')
        .addColumn('username', 'text')
        .addColumn('locale', 'text')
        .addColumn('blocked_at', 'text'),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('workspace_members')))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('seat', 'text')
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('handle', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
        .addColumn('chat_id', 'integer', (c) => c.notNull())
        .addUniqueConstraint('wm_ws_user', ['workspace_id', 'user_id'])
        .addUniqueConstraint('wm_ws_handle', ['workspace_id', 'handle']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('projects')))
        .addColumn('code', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('repo_url', 'text')
        .addColumn('docs_url', 'text')
        .addColumn('is_general', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('archived_at', 'text')
        .addColumn('created_by', 'integer', (c) => c.references('users.id').onDelete('set null'))
        .addUniqueConstraint('projects_ws_code', ['workspace_id', 'code']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('project_members')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('role', 'text', (c) => c.notNull())
        .addUniqueConstraint('pm_project_user', ['project_id', 'user_id']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('areas')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('slug', 'text', (c) => c.notNull())
        .addColumn('owner_user_id', 'integer', (c) => c.references('users.id').onDelete('set null'))
        .addColumn('backup_user_id', 'integer', (c) => c.references('users.id').onDelete('set null'))
        .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('archived_at', 'text')
        .addUniqueConstraint('areas_project_slug', ['project_id', 'slug']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('settings')))
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('scope_id', 'integer', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('value', 'text', (c) => c.notNull())
        .addUniqueConstraint('settings_unique', ['workspace_id', 'scope', 'scope_id', 'key']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('feature_flags')))
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('scope_id', 'integer', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addUniqueConstraint('flags_unique', ['workspace_id', 'scope', 'scope_id', 'key']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('events')))
        .addColumn('project_id', 'integer')
        .addColumn('actor_user_id', 'integer')
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'integer')
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('data', 'text', (c) => c.notNull()),
    ).execute();
    await db.schema.createIndex('events_entity').on('events').columns(['entity_type', 'entity_id']).execute();
    await db.schema.createIndex('events_actor').on('events').columns(['actor_user_id', 'action', 'created_at']).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('drafts')))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('consumed_at', 'text'),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('pending_inputs')))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('pending_user', ['workspace_id', 'user_id']),
    ).execute();
  },
  async down(db: Kysely<any>) {
    for (const t of [
      'pending_inputs', 'drafts', 'events', 'feature_flags', 'settings', 'areas',
      'project_members', 'projects', 'workspace_members', 'users', 'workspaces',
    ]) {
      await db.schema.dropTable(t).ifExists().execute();
    }
  },
};

const jobs: Migration = {
  async up(db: Kysely<any>) {
    await withStamps(
      withWorkspace(withId(db.schema.createTable('jobs')))
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('user_id', 'integer', (c) => c.references('users.id').onDelete('cascade'))
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('next_fire_at', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('fire_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('last_fired_at', 'text')
        .addUniqueConstraint('jobs_ws_key', ['workspace_id', 'key']),
    ).execute();
    await db.schema.createIndex('jobs_due').on('jobs').columns(['status', 'next_fire_at']).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('job_fires')))
        .addColumn('job_id', 'integer', (c) => c.notNull().references('jobs.id').onDelete('cascade'))
        .addColumn('fire_at', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('detail', 'text')
        .addUniqueConstraint('job_fires_once', ['job_id', 'fire_at']),
    ).execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('job_fires').ifExists().execute();
    await db.schema.dropTable('jobs').ifExists().execute();
  },
};

const approvals: Migration = {
  async up(db: Kysely<any>) {
    await withStamps(
      withWorkspace(withId(db.schema.createTable('approvals')))
        .addColumn('project_id', 'integer', (c) => c.references('projects.id').onDelete('cascade'))
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('summary', 'text', (c) => c.notNull())
        .addColumn('requested_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('decided_by', 'integer')
        .addColumn('decided_at', 'text')
        .addColumn('result', 'text')
        .addColumn('expires_at', 'text', (c) => c.notNull()),
    ).execute();
    await db.schema.createIndex('approvals_pending').on('approvals').columns(['workspace_id', 'status']).execute();
    await withStamps(
      withWorkspace(withId(db.schema.createTable('invites')))
        .addColumn('code_hash', 'text', (c) => c.notNull().unique())
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('approval_id', 'integer', (c) => c.references('approvals.id'))
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('used_by', 'integer')
        .addColumn('used_at', 'text'),
    ).execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('invites').ifExists().execute();
    await db.schema.dropTable('approvals').ifExists().execute();
  },
};

export const coreMigrations: Record<string, Migration> = {
  '202611150002_core_approvals': approvals,
  '202611050001_core_init': init,
  '202611150001_core_jobs': jobs,
};
