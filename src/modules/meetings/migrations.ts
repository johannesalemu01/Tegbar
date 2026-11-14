import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';

const init: Migration = {
  async up(db: Kysely<any>) {
    await withStamps(
      withWorkspace(withId(db.schema.createTable('places')))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('address', 'text')
        .addColumn('notes', 'text')
        .addColumn('latitude', 'real')
        .addColumn('longitude', 'real')
        .addColumn('is_default', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('archived_at', 'text'),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('meeting_series')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('weekday', 'integer', (c) => c.notNull())
        .addColumn('time', 'text', (c) => c.notNull())
        .addColumn('duration_min', 'integer', (c) => c.notNull())
        .addColumn('mode', 'text', (c) => c.notNull())
        .addColumn('place_id', 'integer', (c) => c.references('places.id').onDelete('set null'))
        .addColumn('room_url', 'text')
        .addColumn('ordinal', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('active', 'integer', (c) => c.notNull().defaultTo(1)),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('meetings')))
        .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('series_id', 'integer', (c) => c.references('meeting_series.id').onDelete('set null'))
        .addColumn('week_start', 'text')
        .addColumn('title', 'text')
        .addColumn('start_at', 'text', (c) => c.notNull())
        .addColumn('moved', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('duration_min', 'integer')
        .addColumn('mode', 'text')
        .addColumn('host_user_id', 'integer', (c) => c.references('users.id').onDelete('set null'))
        .addColumn('place_id', 'integer', (c) => c.references('places.id').onDelete('set null'))
        .addColumn('meet_url', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('started_at', 'text')
        .addColumn('ended_at', 'text')
        .addColumn('sequence', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_by', 'integer', (c) => c.references('users.id').onDelete('set null'))
        .addUniqueConstraint('meetings_occurrence', ['series_id', 'week_start']),
    ).execute();
    await db.schema.createIndex('meetings_start').on('meetings').columns(['workspace_id', 'start_at']).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('meeting_exceptions')))
        .addColumn('meeting_id', 'integer', (c) => c.notNull().references('meetings.id').onDelete('cascade'))
        .addColumn('field', 'text', (c) => c.notNull())
        .addColumn('data', 'text', (c) => c.notNull())
        .addColumn('created_by', 'integer'),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('rsvps')))
        .addColumn('meeting_id', 'integer', (c) => c.notNull().references('meetings.id').onDelete('cascade'))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('late_minutes', 'integer')
        .addUniqueConstraint('rsvps_once', ['meeting_id', 'user_id']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('agenda_items')))
        .addColumn('meeting_id', 'integer', (c) => c.notNull().references('meetings.id').onDelete('cascade'))
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('ref_type', 'text')
        .addColumn('ref_id', 'integer')
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_by', 'integer')
        .addUniqueConstraint('agenda_ref_once', ['meeting_id', 'ref_type', 'ref_id']),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('meeting_outcomes')))
        .addColumn('meeting_id', 'integer', (c) => c.notNull().references('meetings.id').onDelete('cascade'))
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('task_id', 'integer', (c) => c.references('tasks.id').onDelete('set null'))
        .addColumn('created_by', 'integer'),
    ).execute();

    await withStamps(
      withWorkspace(withId(db.schema.createTable('meeting_proposals')))
        .addColumn('meeting_id', 'integer', (c) => c.notNull().references('meetings.id').onDelete('cascade'))
        .addColumn('proposed_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('start_at', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('decided_by', 'integer'),
    ).execute();
  },
  async down(db: Kysely<any>) {
    for (const t of ['meeting_proposals', 'meeting_outcomes', 'agenda_items', 'rsvps', 'meeting_exceptions', 'meetings', 'meeting_series', 'places']) {
      await db.schema.dropTable(t).ifExists().execute();
    }
  },
};

export const meetingMigrations: Record<string, Migration> = {
  '202611150400_meetings_init': init,
};
