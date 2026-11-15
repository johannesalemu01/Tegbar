import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DateTime } from 'luxon';
import type { Db, DbOrTx } from '../../core/db/database.js';
import { DomainError, ForbiddenError, NotFoundError } from '../../core/errors.js';
import type { Approvals } from '../../core/services/approvals.js';
import type { Actor } from '../../core/services/context.js';
import type { EventLog } from '../../core/services/events.js';
import type { Jobs } from '../../core/services/jobs.js';
import type { Members } from '../../core/services/members.js';
import type { Permissions } from '../../core/services/permissions.js';
import type { Projects } from '../../core/services/projects.js';
import { slugify } from '../../core/services/projects.js';
import type { Settings } from '../../core/services/settings.js';
import { atLocal, fromLocalDate, localDate, toDb, type Clock } from '../../core/time.js';
import { firstOnOrAfter, isRecurrence, nextOccurrence, type Recurrence } from '../tasks/recurrence.js';
import {
  allocate, convert, equalShares, formatMoney, MAX_AMOUNT, netPositions, suggestTransfers, validShares, type Share,
} from './money.js';
import { METHODS, SPLITS, TAGS, type FounderTag, type Method, type SplitMode } from './parse.js';
import type {
  BudgetRow, CategoryRow, CostRow, ReceiptRow, RecurringCostRow, SettlementRow, SplitRuleMode, SplitRuleRow,
} from './schema.js';
import { DEFAULT_CATEGORIES, S_CURRENCIES, S_REPORTING_CURRENCY, S_SPEND_THRESHOLD, S_STATEMENT_DAY } from './settings.js';

export const COST_JOB = {
  settlementNotify: 'cost.settlement_notify',
  budgetAlert: 'cost.budget_alert',
  recurringDue: 'cost.recurring_due',
  recurringRenew: 'cost.recurring_renew',
  statement: 'cost.statement',
} as const;

export interface CostInput {
  projectId: number;
  categoryId: number;
  amount: number;
  currency: string;
  rateMicro?: number | null;
  date: string;
  paidBy: number;
  method: Method;
  tag: FounderTag;
  split: SplitMode;
  note?: string | null;
}

export interface CostView extends CostRow {
  project_code: string;
  category_name: string;
  payer_name: string;
  splits: { userId: number; name: string; bp: number; amount: number }[];
  receipt_count: number;
}

export interface SplitRule {
  mode: SplitRuleMode;
  shares: Share[] | null;
  ownerUserId: number | null;
}

export interface Converted {
  amount: number;
  rateMicro: number | null;
  source: 'same' | 'entry' | 'month';
}

export interface BalanceView {
  currency: string;
  nets: { userId: number; net: number }[];
  transfers: { from: number; to: number; amount: number }[];
}

export interface StatementData {
  month: string;
  currencies: string[];
  /** active costs (counted) */
  costs: CostView[];
  /** every entry of the month, including voided ones (for the CSV) */
  entries: CostView[];
  voidedCount: number;
  byProject: { code: string; currency: string; amount: number }[];
  byCategory: { name: string; currency: string; amount: number }[];
  perPerson: { userId: number; name: string; currency: string; paid: number; share: number }[];
  byTag: { userId: number; name: string; tag: FounderTag; currency: string; amount: number }[];
  settlements: SettlementRow[];
  balanceAtEnd: BalanceView[];
  converted: { reporting: string; total: number; rates: { currency: string; rateMicro: number; source: string }[]; missing: string[] } | null;
  budgets: { code: string; period: string; budget: number; spent: number; currency: string }[];
}

const monthOf = (date: string) => date.slice(0, 7);
const monthEnd = (month: string) => fromLocalDate(`${month}-01`).endOf('month').toFormat('yyyy-MM-dd');

export class CostService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly jobs: Jobs,
    private readonly members: Members,
    private readonly settings: Settings,
    private readonly projects: Projects,
    private readonly approvals: Approvals,
    private readonly opts: { receiptsDir: string },
  ) {
    approvals.register<{ projectId: number; rule: SplitRule; label: string }>({
      kind: 'costs.split_rule',
      action: 'cost.manage',
      describe: (p) => `Change the split rule of ${p.label}`,
      execute: async (decider, p, requester, approvalId) => this.applySplitRule(decider, requester, p.projectId, p.rule, approvalId),
    });
    approvals.register<{ costId: number; label: string }>({
      kind: 'costs.spend',
      action: 'cost.create',
      describe: (p) => `Approve spend: ${p.label}`,
      execute: async (decider, p) => this.activatePending(decider, p.costId),
    });
  }

  // ---------- setup & categories ----------

  async seed(workspaceId: number): Promise<void> {
    const any = await this.db.selectFrom('cost_categories').select('id').where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (any) return;
    const now = toDb(this.clock.now());
    await this.db.insertInto('cost_categories').values(DEFAULT_CATEGORIES.map((c, i) => ({
      workspace_id: workspaceId, name: c.name, slug: c.slug, aliases: JSON.stringify(c.aliases), sort_order: i, archived_at: null, created_at: now, updated_at: now,
    }))).execute();
  }

  async categories(actor: Actor, includeArchived = false): Promise<(CategoryRow & { aliasList: string[] })[]> {
    await this.permissions.authorize(actor, 'cost.view');
    let q = this.db.selectFrom('cost_categories').selectAll().where('workspace_id', '=', actor.workspaceId);
    if (!includeArchived) q = q.where('archived_at', 'is', null);
    return (await q.orderBy('sort_order').orderBy('name').execute()).map((c) => ({ ...c, aliasList: JSON.parse(c.aliases) as string[] }));
  }

  async addCategory(actor: Actor, name: string): Promise<CategoryRow> {
    await this.permissions.authorize(actor, 'cost.manage');
    const clean = name.trim();
    if (!clean || clean.length > 40) throw new DomainError('cost.bad_category');
    const slug = slugify(clean);
    const now = toDb(this.clock.now());
    const max = await this.db.selectFrom('cost_categories').select((eb) => eb.fn.max('sort_order').as('m')).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    const existing = await this.db.selectFrom('cost_categories').selectAll().where('workspace_id', '=', actor.workspaceId).where('slug', '=', slug).executeTakeFirst();
    if (existing) {
      if (!existing.archived_at) throw new DomainError('cost.category_exists');
      await this.db.updateTable('cost_categories').set({ archived_at: null, name: clean, updated_at: now }).where('id', '=', existing.id).execute();
      return { ...existing, archived_at: null, name: clean };
    }
    const row = await this.db.insertInto('cost_categories').values({
      workspace_id: actor.workspaceId, name: clean, slug, aliases: JSON.stringify([slug]), sort_order: Number(max?.m ?? 0) + 1,
      archived_at: null, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'cost_category', entityId: row.id, action: 'cost_category.created', data: { name: clean } });
    return row;
  }

  async updateCategory(actor: Actor, id: number, patch: { name?: string; archived?: boolean }): Promise<void> {
    await this.permissions.authorize(actor, 'cost.manage');
    const c = await this.db.selectFrom('cost_categories').selectAll().where('id', '=', id).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!c) throw new NotFoundError();
    const set: Record<string, unknown> = { updated_at: toDb(this.clock.now()) };
    if (patch.name !== undefined) {
      if (!patch.name.trim() || patch.name.length > 40) throw new DomainError('cost.bad_category');
      set.name = patch.name.trim();
    }
    if (patch.archived !== undefined) set.archived_at = patch.archived ? toDb(this.clock.now()) : null;
    await this.db.updateTable('cost_categories').set(set).where('id', '=', id).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'cost_category', entityId: id, action: 'cost_category.updated', data: patch });
  }

  async allowedCurrencies(workspaceId: number): Promise<string[]> {
    return this.settings.get(workspaceId, S_CURRENCIES, workspaceId);
  }

  async reportingCurrency(workspaceId: number, projectId: number): Promise<string> {
    return this.settings.get(workspaceId, S_REPORTING_CURRENCY, projectId);
  }

  // ---------- participants & split rules ----------

  /** Members who share costs of a project, in seat order. */
  async participants(workspaceId: number, projectId: number, exec: DbOrTx = this.db): Promise<{ userId: number; name: string }[]> {
    const out = [];
    for (const m of await this.members.list(workspaceId, exec)) {
      if (await this.permissions.can({ userId: m.user_id, workspaceId }, 'cost.view', { projectId }, exec)) out.push({ userId: m.user_id, name: m.display_name });
    }
    return out;
  }

  async splitRule(workspaceId: number, projectId: number): Promise<SplitRule> {
    const r = await this.db.selectFrom('split_rules').selectAll().where('project_id', '=', projectId).executeTakeFirst();
    if (!r) return { mode: 'equal', shares: null, ownerUserId: null };
    return { mode: r.mode, shares: r.shares ? (JSON.parse(r.shares) as Share[]) : null, ownerUserId: r.owner_user_id };
  }

  async sharesFor(workspaceId: number, projectId: number, mode: SplitMode, payer: number): Promise<Share[]> {
    const people = (await this.participants(workspaceId, projectId)).map((p) => p.userId);
    if (!people.includes(payer)) people.push(payer);
    const zeroes = (keep: number) => people.map((u) => ({ userId: u, bp: u === keep ? 10_000 : 0 }));
    if (mode === 'mine') return zeroes(payer);
    if (mode === 'equal') return equalShares(people);
    const rule = await this.splitRule(workspaceId, projectId);
    if (rule.mode === 'owner_pays' && rule.ownerUserId && people.includes(rule.ownerUserId)) return zeroes(rule.ownerUserId);
    if (rule.mode === 'custom' && rule.shares) {
      const shares = people.map((u) => ({ userId: u, bp: rule.shares!.find((s) => s.userId === u)?.bp ?? 0 }));
      if (validShares(shares)) return shares;
    }
    return equalShares(people);
  }

  describeRule(rule: SplitRule, names: Map<number, string>): string {
    if (rule.mode === 'owner_pays') return `${names.get(rule.ownerUserId ?? 0) ?? '?'} pays all`;
    if (rule.mode === 'custom' && rule.shares) return rule.shares.map((s) => `${names.get(s.userId) ?? '?'} ${s.bp / 100}%`).join(' / ');
    return 'equal';
  }

  /** Changing a split rule needs the other person's approval (two-key rule). */
  async requestSplitRule(actor: Actor, projectId: number, rule: SplitRule) {
    const project = await this.projects.get(actor, projectId);
    if (rule.mode === 'custom' && (!rule.shares || !validShares(rule.shares))) throw new DomainError('cost.bad_shares');
    if (rule.mode === 'owner_pays' && !rule.ownerUserId) throw new DomainError('cost.bad_shares');
    const names = new Map((await this.participants(actor.workspaceId, projectId)).map((p) => [p.userId, p.name]));
    return this.approvals.request(actor, 'costs.split_rule', { projectId, rule, label: `${project.code} → ${this.describeRule(rule, names)}` }, projectId);
  }

  private async applySplitRule(decider: Actor, requester: Actor, projectId: number, rule: SplitRule, approvalId: number): Promise<void> {
    const now = toDb(this.clock.now());
    await this.db.insertInto('split_rules').values({
      workspace_id: decider.workspaceId, project_id: projectId, mode: rule.mode, shares: rule.shares ? JSON.stringify(rule.shares) : null,
      owner_user_id: rule.ownerUserId, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.column('project_id').doUpdateSet({ mode: rule.mode, shares: rule.shares ? JSON.stringify(rule.shares) : null, owner_user_id: rule.ownerUserId, updated_at: now }))
      .execute();
    await this.events.record(this.db, {
      workspaceId: decider.workspaceId, projectId, actorUserId: decider.userId, entityType: 'split_rule', entityId: projectId,
      action: 'split_rule.changed', data: { rule, requestedBy: requester.userId, approvalId },
    });
  }

  // ---------- rates & conversion ----------

  async setRate(actor: Actor, currency: string, reporting: string, month: string, rateMicro: number): Promise<void> {
    await this.permissions.authorize(actor, 'cost.manage');
    if (!/^\d{4}-\d{2}$/.test(month) || currency === reporting || rateMicro <= 0) throw new DomainError('cost.bad_rate');
    const now = toDb(this.clock.now());
    await this.db.insertInto('exchange_rates').values({
      workspace_id: actor.workspaceId, currency, reporting_currency: reporting, month, rate_micro: rateMicro, created_by: actor.userId, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.columns(['workspace_id', 'currency', 'reporting_currency', 'month']).doUpdateSet({ rate_micro: rateMicro, created_by: actor.userId, updated_at: now }))
      .execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'exchange_rate', action: 'exchange_rate.set', data: { currency, reporting, month, rateMicro } });
  }

  /** Converted amount using the entry's own rate, else the month's rate. Null if no rate was entered. */
  async toReporting(c: Pick<CostRow, 'workspace_id' | 'amount_minor' | 'currency' | 'rate_micro' | 'spent_on'>, reporting: string): Promise<Converted | null> {
    if (c.currency === reporting) return { amount: c.amount_minor, rateMicro: null, source: 'same' };
    if (c.rate_micro) return { amount: convert(c.amount_minor, c.currency, reporting, c.rate_micro), rateMicro: c.rate_micro, source: 'entry' };
    const r = await this.db.selectFrom('exchange_rates').select('rate_micro')
      .where('workspace_id', '=', c.workspace_id).where('currency', '=', c.currency).where('reporting_currency', '=', reporting).where('month', '=', monthOf(c.spent_on))
      .executeTakeFirst();
    return r ? { amount: convert(c.amount_minor, c.currency, reporting, r.rate_micro), rateMicro: r.rate_micro, source: 'month' } : null;
  }

  // ---------- costs ----------

  private async validate(actor: Actor, i: CostInput): Promise<void> {
    await this.permissions.authorize(actor, 'cost.create', { projectId: i.projectId });
    if (!Number.isSafeInteger(i.amount) || i.amount <= 0 || i.amount > MAX_AMOUNT) throw new DomainError('cost.bad_amount');
    if (!(await this.allowedCurrencies(actor.workspaceId)).includes(i.currency)) throw new DomainError('cost.currency_not_allowed', { currency: i.currency });
    if (!METHODS.includes(i.method) || !TAGS.includes(i.tag) || !SPLITS.includes(i.split)) throw new DomainError('cost.bad_field');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date) || !fromLocalDate(i.date).isValid) throw new DomainError('cost.bad_date');
    if (i.date > localDate(this.clock.now())) throw new DomainError('cost.future_date');
    if (i.date < '2000-01-01') throw new DomainError('cost.bad_date');
    const cat = await this.db.selectFrom('cost_categories').select(['id', 'archived_at']).where('id', '=', i.categoryId).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!cat) throw new DomainError('cost.bad_category');
    if (!(await this.participants(actor.workspaceId, i.projectId)).some((p) => p.userId === i.paidBy)) throw new DomainError('cost.bad_payer');
    if ((i.note ?? '').length > 300) throw new DomainError('cost.note_too_long');
    const reporting = await this.reportingCurrency(actor.workspaceId, i.projectId);
    if (i.currency !== reporting && !i.rateMicro) {
      const conv = await this.toReporting({ workspace_id: actor.workspaceId, amount_minor: i.amount, currency: i.currency, rate_micro: null, spent_on: i.date }, reporting);
      if (!conv) throw new DomainError('cost.need_rate', { currency: i.currency, reporting, month: monthOf(i.date) });
    }
  }

  private async writeSplits(exec: DbOrTx, workspaceId: number, costId: number, amount: number, shares: Share[], payer: number): Promise<void> {
    const seat = (await this.members.list(workspaceId, exec)).map((m) => m.user_id);
    const parts = allocate(amount, shares, [payer, ...seat]);
    const now = toDb(this.clock.now());
    await exec.deleteFrom('cost_splits').where('cost_id', '=', costId).execute();
    await exec.insertInto('cost_splits').values(parts.map((p) => ({
      workspace_id: workspaceId, cost_id: costId, user_id: p.userId, share_bp: shares.find((s) => s.userId === p.userId)!.bp,
      amount_minor: p.amount, created_at: now, updated_at: now,
    }))).execute();
  }

  async create(actor: Actor, i: CostInput, extra: { recurringId?: number; occurrenceDate?: string } = {}): Promise<{ cost: CostView; needsApproval: boolean }> {
    await this.validate(actor, i);
    const shares = await this.sharesFor(actor.workspaceId, i.projectId, i.split, i.paidBy);
    const reporting = await this.reportingCurrency(actor.workspaceId, i.projectId);
    const threshold = await this.settings.get(actor.workspaceId, S_SPEND_THRESHOLD, actor.workspaceId);
    const conv = await this.toReporting({ workspace_id: actor.workspaceId, amount_minor: i.amount, currency: i.currency, rate_micro: i.rateMicro ?? null, spent_on: i.date }, reporting);
    const needsApproval = threshold !== null && conv !== null && conv.amount > threshold;
    const now = toDb(this.clock.now());

    const id = await this.db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('costs').values({
        workspace_id: actor.workspaceId, project_id: i.projectId, category_id: i.categoryId, amount_minor: i.amount, currency: i.currency,
        rate_micro: i.rateMicro ?? null, spent_on: i.date, paid_by: i.paidBy, method: i.method, founder_tag: i.tag, split_mode: i.split,
        note: i.note?.trim() || null, status: needsApproval ? 'pending_approval' : 'active', void_reason: null, voided_by: null, voided_at: null,
        recurring_id: extra.recurringId ?? null, occurrence_date: extra.occurrenceDate ?? null, created_by: actor.userId, created_at: now, updated_at: now,
      }).onConflict((oc) => oc.columns(['recurring_id', 'occurrence_date']).doNothing()).returning('id').executeTakeFirst();
      if (!r) return null; // recurring occurrence already recorded
      await this.writeSplits(trx, actor.workspaceId, r.id, i.amount, shares, i.paidBy);
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: i.projectId, actorUserId: actor.userId, entityType: 'cost', entityId: r.id, action: 'cost.created',
        data: { amount: i.amount, currency: i.currency, paidBy: i.paidBy, split: i.split, shares, recurringId: extra.recurringId ?? null },
      });
      return r.id;
    });
    if (id === null) {
      const existing = await this.db.selectFrom('costs').select('id').where('recurring_id', '=', extra.recurringId!).where('occurrence_date', '=', extra.occurrenceDate!).executeTakeFirstOrThrow();
      return { cost: await this.get(actor, existing.id), needsApproval: false };
    }
    if (needsApproval) {
      const project = await this.projects.get(actor, i.projectId);
      await this.approvals.request(actor, 'costs.spend', { costId: id, label: `${formatMoney(i.amount, i.currency)} · ${project.code}` }, i.projectId);
    } else {
      await this.checkBudget(actor.workspaceId, i.projectId);
    }
    return { cost: await this.get(actor, id), needsApproval };
  }

  private async activatePending(decider: Actor, costId: number): Promise<void> {
    const c = await this.db.selectFrom('costs').selectAll().where('id', '=', costId).executeTakeFirst();
    if (!c || c.status !== 'pending_approval') throw new DomainError('cost.not_pending');
    await this.db.updateTable('costs').set({ status: 'active', updated_at: toDb(this.clock.now()) }).where('id', '=', costId).where('status', '=', 'pending_approval').execute();
    await this.events.record(this.db, { workspaceId: decider.workspaceId, projectId: c.project_id, actorUserId: decider.userId, entityType: 'cost', entityId: costId, action: 'cost.approved' });
    await this.checkBudget(decider.workspaceId, c.project_id);
  }

  async get(actor: Actor, id: number): Promise<CostView> {
    const row = await this.db.selectFrom('costs').selectAll().where('id', '=', id).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundError();
    await this.permissions.authorize(actor, 'cost.view', { projectId: row.project_id });
    return (await this.decorate(actor.workspaceId, [row]))[0]!;
  }

  private async decorate(workspaceId: number, rows: CostRow[]): Promise<CostView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [projects, cats, members, splits, receipts] = await Promise.all([
      this.db.selectFrom('projects').select(['id', 'code']).where('workspace_id', '=', workspaceId).execute(),
      this.db.selectFrom('cost_categories').select(['id', 'name']).where('workspace_id', '=', workspaceId).execute(),
      this.members.list(workspaceId),
      this.db.selectFrom('cost_splits').selectAll().where('cost_id', 'in', ids).execute(),
      this.db.selectFrom('receipts').select(['cost_id']).where('cost_id', 'in', ids).where('purged_at', 'is', null).execute(),
    ]);
    const name = (u: number) => members.find((m) => m.user_id === u)?.display_name ?? '?';
    return rows.map((r) => ({
      ...r,
      project_code: projects.find((p) => p.id === r.project_id)?.code ?? '?',
      category_name: cats.find((c) => c.id === r.category_id)?.name ?? '?',
      payer_name: name(r.paid_by),
      splits: splits.filter((s) => s.cost_id === r.id).map((s) => ({ userId: s.user_id, name: name(s.user_id), bp: s.share_bp, amount: s.amount_minor })),
      receipt_count: receipts.filter((x) => x.cost_id === r.id).length,
    }));
  }

  async list(actor: Actor, f: { projectId?: number | null; month?: string | null; includeVoided?: boolean }, page = 0, pageSize = 8): Promise<{ items: CostView[]; total: number }> {
    const visible = await this.permissions.visibleProjectIds(actor);
    const ids = f.projectId ? visible.filter((v) => v === f.projectId) : visible;
    if (!ids.length) return { items: [], total: 0 };
    let q = this.db.selectFrom('costs').where('workspace_id', '=', actor.workspaceId).where('project_id', 'in', ids);
    if (f.month) q = q.where('spent_on', '>=', `${f.month}-01`).where('spent_on', '<=', monthEnd(f.month));
    if (!f.includeVoided) q = q.where('status', '!=', 'voided');
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await q.selectAll().orderBy('spent_on', 'desc').orderBy('id', 'desc').limit(pageSize).offset(page * pageSize).execute();
    return { items: await this.decorate(actor.workspaceId, rows), total };
  }

  /** Edit with a full change log. Amount, payer, split or project changes recompute the frozen split. */
  async edit(actor: Actor, id: number, patch: Partial<Omit<CostInput, 'currency'>>): Promise<{ cost: CostView; changed: boolean }> {
    const before = await this.get(actor, id);
    await this.permissions.authorize(actor, 'cost.edit', { projectId: before.project_id });
    if (before.status === 'voided') throw new DomainError('cost.is_voided');
    const next: CostInput = {
      projectId: patch.projectId ?? before.project_id, categoryId: patch.categoryId ?? before.category_id, amount: patch.amount ?? before.amount_minor,
      currency: before.currency, rateMicro: patch.rateMicro === undefined ? before.rate_micro : patch.rateMicro, date: patch.date ?? before.spent_on,
      paidBy: patch.paidBy ?? before.paid_by, method: patch.method ?? before.method, tag: patch.tag ?? before.founder_tag,
      split: patch.split ?? before.split_mode, note: patch.note === undefined ? before.note : patch.note,
    };
    const map: [keyof CostInput, keyof CostRow][] = [
      ['projectId', 'project_id'], ['categoryId', 'category_id'], ['amount', 'amount_minor'], ['rateMicro', 'rate_micro'], ['date', 'spent_on'],
      ['paidBy', 'paid_by'], ['method', 'method'], ['tag', 'founder_tag'], ['split', 'split_mode'], ['note', 'note'],
    ];
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, col] of map) if ((next[k] ?? null) !== (before[col] ?? null)) changes[col] = { from: before[col], to: next[k] ?? null };
    if (Object.keys(changes).length === 0) return { cost: before, changed: false };
    await this.validate(actor, next);
    const resplit = ['amount_minor', 'paid_by', 'split_mode', 'project_id'].some((k) => k in changes);
    const shares = resplit ? await this.sharesFor(actor.workspaceId, next.projectId, next.split, next.paidBy) : null;
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('costs').set({
        project_id: next.projectId, category_id: next.categoryId, amount_minor: next.amount, rate_micro: next.rateMicro ?? null, spent_on: next.date,
        paid_by: next.paidBy, method: next.method, founder_tag: next.tag, split_mode: next.split, note: next.note?.trim() || null, updated_at: toDb(this.clock.now()),
      }).where('id', '=', id).execute();
      if (shares) await this.writeSplits(trx, actor.workspaceId, id, next.amount, shares, next.paidBy);
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: next.projectId, actorUserId: actor.userId, entityType: 'cost', entityId: id, action: 'cost.updated',
        data: { changes, ...(shares ? { shares } : {}) },
      });
    });
    if (before.status === 'active') {
      await this.checkBudget(actor.workspaceId, next.projectId);
      if (next.projectId !== before.project_id) await this.checkBudget(actor.workspaceId, before.project_id);
    }
    return { cost: await this.get(actor, id), changed: true };
  }

  /** Costs are never deleted. A void keeps the row (and reason) and removes it from totals. */
  async void(actor: Actor, id: number, reason: string): Promise<{ cost: CostView; changed: boolean }> {
    const c = await this.get(actor, id);
    await this.permissions.authorize(actor, 'cost.edit', { projectId: c.project_id });
    const why = reason.normalize('NFC').trim();
    if (why.length < 3 || why.length > 300) throw new DomainError('cost.void_reason');
    if (c.status === 'voided') return { cost: c, changed: false };
    const now = toDb(this.clock.now());
    const r = await this.db.updateTable('costs').set({ status: 'voided', void_reason: why, voided_by: actor.userId, voided_at: now, updated_at: now })
      .where('id', '=', id).where('status', '!=', 'voided').executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return { cost: await this.get(actor, id), changed: false };
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: c.project_id, actorUserId: actor.userId, entityType: 'cost', entityId: id, action: 'cost.voided', data: { reason: why } });
    return { cost: await this.get(actor, id), changed: true };
  }

  async history(actor: Actor, id: number) {
    await this.get(actor, id);
    return this.events.forEntity(this.db, actor.workspaceId, 'cost', id, 20);
  }

  // ---------- receipts ----------

  async saveReceiptFile(workspaceId: number, data: Buffer, ext: string): Promise<string> {
    const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : '.bin';
    const rel = join(String(workspaceId), monthOf(localDate(this.clock.now())), `${randomUUID()}${safeExt}`);
    const abs = join(this.opts.receiptsDir, rel);
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    await writeFile(abs, data, { mode: 0o600 });
    return rel;
  }

  async addReceipt(actor: Actor, costId: number, file: { fileId: string; uniqueId: string; path: string | null; mime: string | null; size: number | null }): Promise<{ receipt: ReceiptRow; changed: boolean }> {
    const c = await this.get(actor, costId);
    await this.permissions.authorize(actor, 'cost.edit', { projectId: c.project_id });
    const now = toDb(this.clock.now());
    const r = await this.db.insertInto('receipts').values({
      workspace_id: actor.workspaceId, cost_id: costId, telegram_file_id: file.fileId, file_unique_id: file.uniqueId, path: file.path,
      mime: file.mime, size: file.size, created_by: actor.userId, purged_at: null, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.columns(['cost_id', 'file_unique_id']).doNothing()).returningAll().executeTakeFirst();
    if (!r) {
      const existing = await this.db.selectFrom('receipts').selectAll().where('cost_id', '=', costId).where('file_unique_id', '=', file.uniqueId).executeTakeFirstOrThrow();
      return { receipt: existing, changed: false };
    }
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: c.project_id, actorUserId: actor.userId, entityType: 'cost', entityId: costId, action: 'cost.receipt_added', data: { receiptId: r.id } });
    return { receipt: r, changed: true };
  }

  async receipts(actor: Actor, costId: number): Promise<ReceiptRow[]> {
    await this.get(actor, costId);
    return this.db.selectFrom('receipts').selectAll().where('cost_id', '=', costId).where('purged_at', 'is', null).orderBy('id').execute();
  }

  receiptPath(rel: string): string {
    return join(this.opts.receiptsDir, rel);
  }

  /** /purge: voided costs and their receipt files (money → second key). */
  purger() {
    return {
      type: 'costs', label: 'voided costs (with receipts)', twoKey: true,
      candidates: async (actor: Actor) => {
        const visible = await this.permissions.visibleProjectIds(actor);
        if (!visible.length) return [];
        return (await this.db.selectFrom('costs').select(['id', 'amount_minor', 'currency', 'note']).where('workspace_id', '=', actor.workspaceId)
          .where('project_id', 'in', visible).where('status', '=', 'voided').execute())
          .map((c) => ({ id: c.id, label: `C${c.id} ${formatMoney(c.amount_minor, c.currency)}${c.note ? ` ${c.note.slice(0, 30)}` : ''}` }));
      },
      purge: async (actor: Actor, ids: number[]) => {
        const voided = (await this.db.selectFrom('costs').select('id').where('workspace_id', '=', actor.workspaceId).where('id', 'in', ids).where('status', '=', 'voided').execute()).map((r) => r.id);
        if (!voided.length) return { rows: 0, files: 0 };
        const receipts = await this.db.selectFrom('receipts').select(['path']).where('cost_id', 'in', voided).execute();
        const rows = await this.db.transaction().execute(async (trx) => {
          await trx.deleteFrom('receipts').where('cost_id', 'in', voided).execute();
          await trx.deleteFrom('cost_splits').where('cost_id', 'in', voided).execute();
          const r = await trx.deleteFrom('costs').where('id', 'in', voided).executeTakeFirst();
          await this.events.redact(trx, actor.workspaceId, 'cost', voided);
          await this.events.record(trx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'purge', action: 'purge.costs', data: { count: Number(r.numDeletedRows), receipts: receipts.length } });
          return Number(r.numDeletedRows);
        });
        let files = 0;
        for (const r of receipts) {
          if (!r.path) continue;
          await rm(this.receiptPath(r.path), { force: true });
          files++;
        }
        return { rows, files };
      },
    };
  }

  // ---------- ledger ----------

  private async ledgerRows(workspaceId: number, projectIds: number[], upTo?: string, onlyProject: number | null = null) {
    if (!projectIds.length) return { costs: [], settlements: [] };
    let cq = this.db.selectFrom('costs').select(['id', 'currency', 'paid_by', 'amount_minor'])
      .where('workspace_id', '=', workspaceId).where('status', '=', 'active').where('project_id', 'in', projectIds);
    if (upTo) cq = cq.where('spent_on', '<=', upTo);
    const costs = await cq.execute();
    const splits = costs.length ? await this.db.selectFrom('cost_splits').select(['cost_id', 'user_id', 'amount_minor']).where('cost_id', 'in', costs.map((c) => c.id)).execute() : [];
    let sq = this.db.selectFrom('settlements').selectAll().where('workspace_id', '=', workspaceId).where('status', '=', 'confirmed');
    if (upTo) sq = sq.where('paid_on', '<=', upTo);
    // Overall: every settlement. Per project: only settlements recorded for that project.
    const settlements = (await sq.execute()).filter((s) => (onlyProject === null ? s.project_id === null || projectIds.includes(s.project_id) : s.project_id === onlyProject));
    return {
      costs: costs.map((c) => ({ currency: c.currency, paidBy: c.paid_by, amount: c.amount_minor, splits: splits.filter((s) => s.cost_id === c.id).map((s) => ({ userId: s.user_id, amount: s.amount_minor })) })),
      settlements: settlements.map((s) => ({ currency: s.currency, from: s.from_user_id, to: s.to_user_id, amount: s.amount_minor })),
    };
  }

  /**
   * Who owes whom, per currency. Overall (projectId null) includes every
   * confirmed settlement; per project only settlements recorded for it.
   */
  async balances(actor: Actor, projectId: number | null = null, upTo?: string): Promise<BalanceView[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (projectId !== null) await this.permissions.authorize(actor, 'cost.view', { projectId });
    const ids = projectId === null ? visible : [projectId];
    const { costs, settlements } = await this.ledgerRows(actor.workspaceId, ids, upTo, projectId);
    const nets = netPositions(costs, settlements);
    return [...nets].map(([currency, m]) => ({
      currency,
      nets: [...m].map(([userId, net]) => ({ userId, net })).sort((a, b) => a.userId - b.userId),
      transfers: suggestTransfers(m),
    }));
  }

  // ---------- settlements ----------

  /** Idempotent: the same pending record (same people, amount and day) is returned instead of duplicated. */
  async recordSettlement(actor: Actor, i: { toUserId: number; amount: number; currency: string; method: Method; note?: string | null; projectId?: number | null; date?: string }): Promise<{ settlement: SettlementRow; created: boolean }> {
    await this.permissions.authorize(actor, 'cost.create', { projectId: i.projectId ?? null });
    if (i.toUserId === actor.userId) throw new DomainError('cost.settle_self');
    if (!(await this.members.get(actor.workspaceId, i.toUserId))) throw new DomainError('cost.bad_payer');
    if (!Number.isSafeInteger(i.amount) || i.amount <= 0 || i.amount > MAX_AMOUNT) throw new DomainError('cost.bad_amount');
    if (!(await this.allowedCurrencies(actor.workspaceId)).includes(i.currency)) throw new DomainError('cost.currency_not_allowed', { currency: i.currency });
    const date = i.date ?? localDate(this.clock.now());
    if (date > localDate(this.clock.now())) throw new DomainError('cost.future_date');
    const same = await this.db.selectFrom('settlements').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('status', '=', 'pending').where('from_user_id', '=', actor.userId)
      .where('to_user_id', '=', i.toUserId).where('amount_minor', '=', i.amount).where('currency', '=', i.currency).where('paid_on', '=', date)
      .executeTakeFirst();
    if (same) return { settlement: same, created: false };
    const now = this.clock.now();
    const row = await this.db.insertInto('settlements').values({
      workspace_id: actor.workspaceId, project_id: i.projectId ?? null, from_user_id: actor.userId, to_user_id: i.toUserId, amount_minor: i.amount,
      currency: i.currency, paid_on: date, method: i.method, note: i.note?.trim() || null, status: 'pending', decided_by: null, decided_at: null,
      created_by: actor.userId, created_at: toDb(now), updated_at: toDb(now),
    }).returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: i.projectId ?? null, actorUserId: actor.userId, entityType: 'settlement', entityId: row.id, action: 'settlement.recorded', data: { to: i.toUserId, amount: i.amount, currency: i.currency } });
    await this.jobs.upsert(actor.workspaceId, `settle:${row.id}:requested`, { kind: COST_JOB.settlementNotify, payload: { settlementId: row.id, event: 'requested' }, at: now });
    return { settlement: row, created: true };
  }

  async settlement(actor: Actor, id: number): Promise<SettlementRow> {
    const s = await this.db.selectFrom('settlements').selectAll().where('id', '=', id).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!s) throw new NotFoundError();
    if (![s.from_user_id, s.to_user_id].includes(actor.userId)) await this.permissions.authorize(actor, 'cost.manage');
    return s;
  }

  /** Only the receiver confirms (or rejects) — once. */
  async decideSettlement(actor: Actor, id: number, confirm: boolean): Promise<{ settlement: SettlementRow; changed: boolean }> {
    const s = await this.settlement(actor, id);
    if (s.to_user_id !== actor.userId) throw new DomainError('cost.settle_not_receiver');
    const now = this.clock.now();
    const r = await this.db.updateTable('settlements').set({ status: confirm ? 'confirmed' : 'rejected', decided_by: actor.userId, decided_at: toDb(now), updated_at: toDb(now) })
      .where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return { settlement: await this.settlement(actor, id), changed: false };
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: s.project_id, actorUserId: actor.userId, entityType: 'settlement', entityId: id, action: confirm ? 'settlement.confirmed' : 'settlement.rejected' });
    await this.jobs.upsert(actor.workspaceId, `settle:${id}:decided`, { kind: COST_JOB.settlementNotify, payload: { settlementId: id, event: 'decided' }, at: now });
    return { settlement: await this.settlement(actor, id), changed: true };
  }

  async cancelSettlement(actor: Actor, id: number): Promise<{ changed: boolean }> {
    const s = await this.settlement(actor, id);
    if (s.from_user_id !== actor.userId) throw new ForbiddenError();
    const r = await this.db.updateTable('settlements').set({ status: 'cancelled', updated_at: toDb(this.clock.now()) }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    return { changed: Number(r.numUpdatedRows) === 1 };
  }

  async settlementsFor(actor: Actor): Promise<SettlementRow[]> {
    await this.permissions.authorize(actor, 'cost.view');
    const visible = await this.permissions.visibleProjectIds(actor);
    return (await this.db.selectFrom('settlements').selectAll().where('workspace_id', '=', actor.workspaceId).orderBy('id').execute())
      .filter((s) => s.project_id === null || visible.includes(s.project_id));
  }

  async pendingSettlements(actor: Actor): Promise<SettlementRow[]> {
    return (await this.db.selectFrom('settlements').selectAll().where('workspace_id', '=', actor.workspaceId).where('status', '=', 'pending').orderBy('id').execute())
      .filter((s) => s.from_user_id === actor.userId || s.to_user_id === actor.userId);
  }

  // ---------- budgets ----------

  async setBudget(actor: Actor, projectId: number, b: { period: 'monthly' | 'total'; amount: number } | null): Promise<BudgetRow | null> {
    await this.permissions.authorize(actor, 'cost.manage', { projectId });
    const now = toDb(this.clock.now());
    if (!b) {
      await this.db.updateTable('budgets').set({ active: 0, updated_at: now }).where('project_id', '=', projectId).execute();
      await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId, actorUserId: actor.userId, entityType: 'budget', entityId: projectId, action: 'budget.removed' });
      return null;
    }
    if (!Number.isSafeInteger(b.amount) || b.amount <= 0 || b.amount > MAX_AMOUNT) throw new DomainError('cost.bad_amount');
    const currency = await this.reportingCurrency(actor.workspaceId, projectId);
    const row = await this.db.insertInto('budgets').values({
      workspace_id: actor.workspaceId, project_id: projectId, period: b.period, amount_minor: b.amount, currency, active: 1, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.column('project_id').doUpdateSet({ period: b.period, amount_minor: b.amount, currency, active: 1, updated_at: now }))
      .returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId, actorUserId: actor.userId, entityType: 'budget', entityId: row.id, action: 'budget.set', data: b });
    await this.checkBudget(actor.workspaceId, projectId);
    return row;
  }

  async budgetStatus(workspaceId: number, projectId: number, month = monthOf(localDate(this.clock.now()))): Promise<{ budget: BudgetRow; spent: number; pct: number; periodKey: string; unconverted: number } | null> {
    const budget = await this.db.selectFrom('budgets').selectAll().where('project_id', '=', projectId).where('active', '=', 1).executeTakeFirst();
    if (!budget) return null;
    let q = this.db.selectFrom('costs').selectAll().where('project_id', '=', projectId).where('status', '=', 'active');
    if (budget.period === 'monthly') q = q.where('spent_on', '>=', `${month}-01`).where('spent_on', '<=', monthEnd(month));
    let spent = 0;
    let unconverted = 0;
    for (const c of await q.execute()) {
      const conv = await this.toReporting(c, budget.currency);
      if (conv) spent += conv.amount;
      else unconverted++;
    }
    return { budget, spent, pct: Math.floor((spent * 100) / budget.amount_minor), periodKey: budget.period === 'monthly' ? month : 'total', unconverted };
  }

  /** Sends at most one 80 % and one 100 % warning per budget period (idempotent). */
  async checkBudget(workspaceId: number, projectId: number): Promise<void> {
    const st = await this.budgetStatus(workspaceId, projectId);
    if (!st) return;
    const now = this.clock.now();
    for (const threshold of [80, 100]) {
      if (st.pct < threshold) continue;
      const r = await this.db.insertInto('budget_alerts').values({
        workspace_id: workspaceId, budget_id: st.budget.id, period_key: st.periodKey, threshold, created_at: toDb(now), updated_at: toDb(now),
      }).onConflict((oc) => oc.columns(['budget_id', 'period_key', 'threshold']).doNothing()).returning('id').executeTakeFirst();
      if (r) {
        await this.jobs.upsert(workspaceId, `budget:${st.budget.id}:${st.periodKey}:${threshold}`, {
          kind: COST_JOB.budgetAlert, payload: { projectId, threshold, spent: st.spent, budget: st.budget.amount_minor, currency: st.budget.currency, period: st.budget.period }, at: now,
        });
      }
    }
  }

  // ---------- recurring costs ----------

  async createRecurring(actor: Actor, i: { projectId: number; categoryId: number; amount: number; currency: string; paidBy: number; method: Method; note: string; recurrence: Recurrence; action: 'create' | 'remind'; alertDays: number }): Promise<RecurringCostRow> {
    await this.permissions.authorize(actor, 'cost.manage', { projectId: i.projectId });
    await this.validate(actor, { ...i, date: localDate(this.clock.now()), tag: 'expense', split: 'rule' });
    if (!isRecurrence(i.recurrence)) throw new DomainError('task.bad_recurrence');
    if (!Number.isInteger(i.alertDays) || i.alertDays < 0 || i.alertDays > 60) throw new DomainError('cost.bad_alert_days');
    const now = toDb(this.clock.now());
    const next = firstOnOrAfter(i.recurrence, localDate(this.clock.now()));
    const row = await this.db.insertInto('recurring_costs').values({
      workspace_id: actor.workspaceId, project_id: i.projectId, category_id: i.categoryId, amount_minor: i.amount, currency: i.currency, paid_by: i.paidBy,
      method: i.method, note: i.note.trim().slice(0, 120), recurrence: JSON.stringify(i.recurrence), next_date: next, action: i.action, alert_days: i.alertDays,
      active: 1, created_by: actor.userId, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: i.projectId, actorUserId: actor.userId, entityType: 'recurring_cost', entityId: row.id, action: 'recurring_cost.created', data: { amount: i.amount, next } });
    await this.syncRecurring(actor.workspaceId, row.id);
    return row;
  }

  async recurringList(actor: Actor): Promise<RecurringCostRow[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    return this.db.selectFrom('recurring_costs').selectAll().where('workspace_id', '=', actor.workspaceId).where('project_id', 'in', visible).orderBy('active', 'desc').orderBy('next_date').execute();
  }

  async recurringById(workspaceId: number, id: number): Promise<RecurringCostRow | undefined> {
    return this.db.selectFrom('recurring_costs').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
  }

  async updateRecurring(actor: Actor, id: number, patch: { active?: boolean; action?: 'create' | 'remind' }): Promise<RecurringCostRow> {
    const r = await this.recurringById(actor.workspaceId, id);
    if (!r) throw new NotFoundError();
    await this.permissions.authorize(actor, 'cost.manage', { projectId: r.project_id });
    const set: Record<string, unknown> = { updated_at: toDb(this.clock.now()) };
    if (patch.active !== undefined) {
      set.active = patch.active ? 1 : 0;
      if (patch.active && !r.active) {
        const rule = JSON.parse(r.recurrence) as Recurrence;
        set.next_date = firstOnOrAfter(rule, localDate(this.clock.now()));
      }
    }
    if (patch.action) set.action = patch.action;
    await this.db.updateTable('recurring_costs').set(set).where('id', '=', id).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: r.project_id, actorUserId: actor.userId, entityType: 'recurring_cost', entityId: id, action: 'recurring_cost.updated', data: patch });
    await this.syncRecurring(actor.workspaceId, id);
    return (await this.recurringById(actor.workspaceId, id))!;
  }

  /** Record the cost for one occurrence (idempotent per occurrence). */
  async recordRecurring(actor: Actor, id: number, occurrence: string): Promise<CostView> {
    const r = await this.recurringById(actor.workspaceId, id);
    if (!r) throw new NotFoundError();
    const date = occurrence > localDate(this.clock.now()) ? localDate(this.clock.now()) : occurrence;
    const { cost } = await this.create(actor, {
      projectId: r.project_id, categoryId: r.category_id, amount: r.amount_minor, currency: r.currency, date, paidBy: r.paid_by,
      method: r.method, tag: 'expense', split: 'rule', note: r.note,
    }, { recurringId: r.id, occurrenceDate: occurrence });
    return cost;
  }

  /** Advance after an occurrence fired (idempotent: never moves backwards). */
  async advanceRecurring(workspaceId: number, id: number, fired: string): Promise<void> {
    const r = await this.recurringById(workspaceId, id);
    if (!r || r.next_date > fired) return;
    const rule = JSON.parse(r.recurrence) as Recurrence;
    await this.db.updateTable('recurring_costs').set({ next_date: nextOccurrence(rule, fired), updated_at: toDb(this.clock.now()) }).where('id', '=', id).where('next_date', '=', r.next_date).execute();
  }

  async syncRecurring(workspaceId: number, id: number): Promise<void> {
    const r = await this.recurringById(workspaceId, id);
    const prefix = `rc:${id}:`;
    if (!r || !r.active) return this.jobs.cancelPrefix(workspaceId, prefix);
    const now = this.clock.now();
    const due = atLocal(r.next_date, 9, 0);
    await this.jobs.upsert(workspaceId, `${prefix}due`, { kind: COST_JOB.recurringDue, userId: r.paid_by, payload: { recurringId: id, occurrence: r.next_date }, at: due > now ? due : now });
    const renew = due.minus({ days: r.alert_days });
    if (r.alert_days > 0 && renew > now) {
      await this.jobs.upsert(workspaceId, `${prefix}renew`, { kind: COST_JOB.recurringRenew, userId: r.paid_by, payload: { recurringId: id, occurrence: r.next_date }, at: renew });
    } else await this.jobs.cancel(workspaceId, `${prefix}renew`);
  }

  async syncAll(workspaceId: number): Promise<void> {
    for (const r of await this.db.selectFrom('recurring_costs').select('id').where('workspace_id', '=', workspaceId).execute()) await this.syncRecurring(workspaceId, r.id);
    const key = 'costs:statement';
    const job = await this.jobs.get(workspaceId, key);
    if (job?.status !== 'active') await this.jobs.upsert(workspaceId, key, { kind: COST_JOB.statement, payload: {}, at: await this.nextStatementAt(workspaceId, this.clock.now()) });
  }

  async nextStatementAt(workspaceId: number, after: DateTime): Promise<DateTime> {
    const day = await this.settings.get(workspaceId, S_STATEMENT_DAY, workspaceId);
    let t = after.startOf('month').set({ day, hour: 9 });
    if (t <= after) t = t.plus({ months: 1 }).set({ day });
    return t;
  }

  // ---------- reports ----------

  /** Totals per month (by currency) for the last `months` months, for the trend line. */
  async monthlyTotals(actor: Actor, projectId: number | null, months = 6): Promise<{ month: string; currency: string; amount: number }[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    const ids = projectId ? visible.filter((v) => v === projectId) : visible;
    if (!ids.length) return [];
    const start = this.clock.now().startOf('month').minus({ months: months - 1 }).toFormat('yyyy-MM-dd');
    const rows = await this.db.selectFrom('costs').select(['spent_on', 'currency', 'amount_minor'])
      .where('workspace_id', '=', actor.workspaceId).where('status', '=', 'active').where('project_id', 'in', ids).where('spent_on', '>=', start).execute();
    const out = new Map<string, number>();
    for (const r of rows) out.set(`${monthOf(r.spent_on)}|${r.currency}`, (out.get(`${monthOf(r.spent_on)}|${r.currency}`) ?? 0) + r.amount_minor);
    return [...out].map(([k, amount]) => ({ month: k.split('|')[0]!, currency: k.split('|')[1]!, amount }));
  }

  async statement(actor: Actor, month: string): Promise<StatementData> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new DomainError('cost.bad_month');
    const visible = await this.permissions.visibleProjectIds(actor);
    const end = monthEnd(month);
    const rows = visible.length ? await this.db.selectFrom('costs').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('project_id', 'in', visible)
      .where('spent_on', '>=', `${month}-01`).where('spent_on', '<=', end).orderBy('spent_on').orderBy('id').execute() : [];
    const all = await this.decorate(actor.workspaceId, rows);
    const costs = all.filter((c) => c.status === 'active');
    const sum = <K extends string>(items: { key: K; currency: string; amount: number }[]) => {
      const m = new Map<string, number>();
      for (const it of items) m.set(`${it.key}\u0000${it.currency}`, (m.get(`${it.key}\u0000${it.currency}`) ?? 0) + it.amount);
      return [...m].map(([k, amount]) => ({ key: k.split('\u0000')[0]!, currency: k.split('\u0000')[1]!, amount })).sort((a, b) => b.amount - a.amount);
    };
    const members = await this.members.list(actor.workspaceId);
    const perPerson: StatementData['perPerson'] = [];
    const currencies = [...new Set(costs.map((c) => c.currency))].sort();
    for (const m of members) {
      for (const cur of currencies) {
        const paid = costs.filter((c) => c.paid_by === m.user_id && c.currency === cur).reduce((a, c) => a + c.amount_minor, 0);
        const share = costs.filter((c) => c.currency === cur).reduce((a, c) => a + (c.splits.find((s) => s.userId === m.user_id)?.amount ?? 0), 0);
        perPerson.push({ userId: m.user_id, name: m.display_name, currency: cur, paid, share });
      }
    }
    const byTag: StatementData['byTag'] = [];
    for (const m of members) for (const tag of TAGS) for (const cur of currencies) {
      const amount = costs.filter((c) => c.paid_by === m.user_id && c.founder_tag === tag && c.currency === cur).reduce((a, c) => a + c.amount_minor, 0);
      if (amount) byTag.push({ userId: m.user_id, name: m.display_name, tag, currency: cur, amount });
    }
    const settlements = (await this.db.selectFrom('settlements').selectAll().where('workspace_id', '=', actor.workspaceId)
      .where('paid_on', '>=', `${month}-01`).where('paid_on', '<=', end).where('status', '=', 'confirmed').execute())
      .filter((s) => s.project_id === null || visible.includes(s.project_id));

    // Converted total (only when more than one currency): person-entered rates, shown with their source.
    let converted: StatementData['converted'] = null;
    if (currencies.length > 1) {
      const reporting = 'ETB';
      let total = 0;
      const rates = new Map<string, { rateMicro: number; source: string }>();
      const missing = new Set<string>();
      for (const c of costs) {
        const conv = await this.toReporting(c, reporting);
        if (!conv) missing.add(c.currency);
        else {
          total += conv.amount;
          if (conv.rateMicro) rates.set(`${c.currency}:${conv.source}:${conv.rateMicro}`, { rateMicro: conv.rateMicro, source: conv.source });
        }
      }
      converted = { reporting, total, rates: [...rates].map(([k, v]) => ({ currency: k.split(':')[0]!, ...v })), missing: [...missing] };
    }

    const budgets: StatementData['budgets'] = [];
    for (const pid of visible) {
      const st = await this.budgetStatus(actor.workspaceId, pid, month);
      if (st) {
        const p = await this.projects.get(actor, pid);
        budgets.push({ code: p.code, period: st.budget.period, budget: st.budget.amount_minor, spent: st.spent, currency: st.budget.currency });
      }
    }

    return {
      month, currencies, costs, entries: all, voidedCount: all.filter((c) => c.status === 'voided').length,
      byProject: sum(costs.map((c) => ({ key: c.project_code, currency: c.currency, amount: c.amount_minor }))).map((x) => ({ code: x.key, currency: x.currency, amount: x.amount })),
      byCategory: sum(costs.map((c) => ({ key: c.category_name, currency: c.currency, amount: c.amount_minor }))).map((x) => ({ name: x.key, currency: x.currency, amount: x.amount })),
      perPerson, byTag, settlements,
      balanceAtEnd: await this.balances(actor, null, end),
      converted, budgets,
    };
  }
}

export type { SplitRuleRow };
