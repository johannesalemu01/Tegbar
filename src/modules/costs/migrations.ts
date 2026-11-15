import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';

const init: Migration = {
  async up(db: Kysely<any>) {
    const users = (c: any) => c.notNull().references('users.id');
    await withStamps(withWorkspace(withId(db.schema.createTable('cost_categories')))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('slug', 'text', (c) => c.notNull())
      .addColumn('aliases', 'text', (c) => c.notNull())
      .addColumn('sort_order', 'integer', (c) => c.notNull())
      .addColumn('archived_at', 'text')
      .addUniqueConstraint('cost_categories_slug', ['workspace_id', 'slug'])).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('split_rules')))
      .addColumn('project_id', 'integer', (c) => c.notNull().unique().references('projects.id').onDelete('cascade'))
      .addColumn('mode', 'text', (c) => c.notNull())
      .addColumn('shares', 'text')
      .addColumn('owner_user_id', 'integer')).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('recurring_costs')))
      .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
      .addColumn('category_id', 'integer', (c) => c.notNull().references('cost_categories.id'))
      .addColumn('amount_minor', 'integer', (c) => c.notNull())
      .addColumn('currency', 'text', (c) => c.notNull())
      .addColumn('paid_by', 'integer', users)
      .addColumn('method', 'text', (c) => c.notNull())
      .addColumn('note', 'text', (c) => c.notNull())
      .addColumn('recurrence', 'text', (c) => c.notNull())
      .addColumn('next_date', 'text', (c) => c.notNull())
      .addColumn('action', 'text', (c) => c.notNull())
      .addColumn('alert_days', 'integer', (c) => c.notNull())
      .addColumn('active', 'integer', (c) => c.notNull())
      .addColumn('created_by', 'integer', users)).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('costs')))
      .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id'))
      .addColumn('category_id', 'integer', (c) => c.notNull().references('cost_categories.id'))
      .addColumn('amount_minor', 'integer', (c) => c.notNull())
      .addColumn('currency', 'text', (c) => c.notNull())
      .addColumn('rate_micro', 'integer')
      .addColumn('spent_on', 'text', (c) => c.notNull())
      .addColumn('paid_by', 'integer', users)
      .addColumn('method', 'text', (c) => c.notNull())
      .addColumn('founder_tag', 'text', (c) => c.notNull())
      .addColumn('split_mode', 'text', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('void_reason', 'text')
      .addColumn('voided_by', 'integer')
      .addColumn('voided_at', 'text')
      .addColumn('recurring_id', 'integer', (c) => c.references('recurring_costs.id').onDelete('set null'))
      .addColumn('occurrence_date', 'text')
      .addColumn('created_by', 'integer', users)
      .addUniqueConstraint('costs_recurring_once', ['recurring_id', 'occurrence_date'])).execute();
    await db.schema.createIndex('costs_ws_date').on('costs').columns(['workspace_id', 'spent_on']).execute();
    await db.schema.createIndex('costs_project').on('costs').columns(['project_id', 'status']).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('cost_splits')))
      .addColumn('cost_id', 'integer', (c) => c.notNull().references('costs.id').onDelete('cascade'))
      .addColumn('user_id', 'integer', users)
      .addColumn('share_bp', 'integer', (c) => c.notNull())
      .addColumn('amount_minor', 'integer', (c) => c.notNull())
      .addUniqueConstraint('cost_splits_once', ['cost_id', 'user_id'])).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('settlements')))
      .addColumn('project_id', 'integer', (c) => c.references('projects.id'))
      .addColumn('from_user_id', 'integer', users)
      .addColumn('to_user_id', 'integer', users)
      .addColumn('amount_minor', 'integer', (c) => c.notNull())
      .addColumn('currency', 'text', (c) => c.notNull())
      .addColumn('paid_on', 'text', (c) => c.notNull())
      .addColumn('method', 'text', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('decided_by', 'integer')
      .addColumn('decided_at', 'text')
      .addColumn('created_by', 'integer', users)).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('budgets')))
      .addColumn('project_id', 'integer', (c) => c.notNull().unique().references('projects.id').onDelete('cascade'))
      .addColumn('period', 'text', (c) => c.notNull())
      .addColumn('amount_minor', 'integer', (c) => c.notNull())
      .addColumn('currency', 'text', (c) => c.notNull())
      .addColumn('active', 'integer', (c) => c.notNull())).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('budget_alerts')))
      .addColumn('budget_id', 'integer', (c) => c.notNull().references('budgets.id').onDelete('cascade'))
      .addColumn('period_key', 'text', (c) => c.notNull())
      .addColumn('threshold', 'integer', (c) => c.notNull())
      .addUniqueConstraint('budget_alerts_once', ['budget_id', 'period_key', 'threshold'])).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('receipts')))
      .addColumn('cost_id', 'integer', (c) => c.notNull().references('costs.id').onDelete('cascade'))
      .addColumn('telegram_file_id', 'text', (c) => c.notNull())
      .addColumn('file_unique_id', 'text', (c) => c.notNull())
      .addColumn('path', 'text')
      .addColumn('mime', 'text')
      .addColumn('size', 'integer')
      .addColumn('created_by', 'integer', users)
      .addColumn('purged_at', 'text')
      .addUniqueConstraint('receipts_once', ['cost_id', 'file_unique_id'])).execute();

    await withStamps(withWorkspace(withId(db.schema.createTable('exchange_rates')))
      .addColumn('currency', 'text', (c) => c.notNull())
      .addColumn('reporting_currency', 'text', (c) => c.notNull())
      .addColumn('month', 'text', (c) => c.notNull())
      .addColumn('rate_micro', 'integer', (c) => c.notNull())
      .addColumn('created_by', 'integer', users)
      .addUniqueConstraint('exchange_rates_once', ['workspace_id', 'currency', 'reporting_currency', 'month'])).execute();
  },
  async down(db: Kysely<any>) {
    for (const t of ['exchange_rates', 'receipts', 'budget_alerts', 'budgets', 'settlements', 'cost_splits', 'costs', 'recurring_costs', 'split_rules', 'cost_categories']) {
      await db.schema.dropTable(t).ifExists().execute();
    }
  },
};

export const costMigrations: Record<string, Migration> = {
  '202611150500_costs_init': init,
};
