import type { Generated, Selectable } from 'kysely';
import type { FounderTag, Method, SplitMode } from './parse.js';

interface Stamps {
  created_at: string;
  updated_at: string;
}

export interface CostCategoriesTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  name: string;
  slug: string;
  aliases: string; // JSON string[]
  sort_order: number;
  archived_at: string | null;
}

export type SplitRuleMode = 'equal' | 'custom' | 'owner_pays';
export interface SplitRulesTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  mode: SplitRuleMode;
  /** JSON Share[] (basis points) for 'custom' */
  shares: string | null;
  owner_user_id: number | null;
}

export type CostStatus = 'active' | 'voided' | 'pending_approval';

/** One spend. Never deleted: corrections are edits (logged) or a void with a reason. */
export interface CostsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  category_id: number;
  /** smallest currency unit (santim for ETB) */
  amount_minor: number;
  currency: string;
  /** person-entered rate to the project's reporting currency, ×1e6 */
  rate_micro: number | null;
  spent_on: string; // YYYY-MM-DD local
  paid_by: number;
  method: Method;
  founder_tag: FounderTag;
  split_mode: SplitMode;
  note: string | null;
  status: CostStatus;
  void_reason: string | null;
  voided_by: number | null;
  voided_at: string | null;
  recurring_id: number | null;
  occurrence_date: string | null;
  created_by: number;
}

/** The split of one cost, frozen when the cost is saved (later rule changes never rewrite history). */
export interface CostSplitsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  cost_id: number;
  user_id: number;
  share_bp: number;
  amount_minor: number;
}

export type SettlementStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled';
/** "I paid you X" — a record only; the receiver confirms it. */
export interface SettlementsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number | null;
  from_user_id: number;
  to_user_id: number;
  amount_minor: number;
  currency: string;
  paid_on: string;
  method: Method;
  note: string | null;
  status: SettlementStatus;
  decided_by: number | null;
  decided_at: string | null;
  created_by: number;
}

export interface BudgetsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  period: 'monthly' | 'total';
  amount_minor: number;
  currency: string;
  active: number;
}

/** Idempotency for 80 % / 100 % warnings: one row per budget, period and threshold. */
export interface BudgetAlertsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  budget_id: number;
  period_key: string;
  threshold: number;
}

export interface RecurringCostsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  category_id: number;
  amount_minor: number;
  currency: string;
  paid_by: number;
  method: Method;
  note: string;
  recurrence: string; // JSON Recurrence
  next_date: string;
  /** create = record the cost automatically; remind = ask to record it */
  action: 'create' | 'remind';
  alert_days: number;
  active: number;
  created_by: number;
}

/** Receipt files live on disk (DATA_DIR/receipts, mode 0600), not in the database. */
export interface ReceiptsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  cost_id: number;
  telegram_file_id: string;
  file_unique_id: string;
  path: string | null;
  mime: string | null;
  size: number | null;
  created_by: number;
  purged_at: string | null;
}

/** Person-entered monthly exchange rates (never fetched). */
export interface ExchangeRatesTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  currency: string;
  reporting_currency: string;
  month: string; // YYYY-MM
  rate_micro: number;
  created_by: number;
}

export type CostRow = Selectable<CostsTable>;
export type CategoryRow = Selectable<CostCategoriesTable>;
export type SettlementRow = Selectable<SettlementsTable>;
export type BudgetRow = Selectable<BudgetsTable>;
export type RecurringCostRow = Selectable<RecurringCostsTable>;
export type ReceiptRow = Selectable<ReceiptsTable>;
export type SplitRuleRow = Selectable<SplitRulesTable>;

declare module '../../core/db/schema.js' {
  interface DB {
    cost_categories: CostCategoriesTable;
    split_rules: SplitRulesTable;
    costs: CostsTable;
    cost_splits: CostSplitsTable;
    settlements: SettlementsTable;
    budgets: BudgetsTable;
    budget_alerts: BudgetAlertsTable;
    recurring_costs: RecurringCostsTable;
    receipts: ReceiptsTable;
    exchange_rates: ExchangeRatesTable;
  }
}
