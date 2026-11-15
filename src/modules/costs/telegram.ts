import { InputFile } from 'grammy';
import { readFile } from 'node:fs/promises';
import type { App } from '../../app.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { JobHandler } from '../../core/scheduler/runner.js';
import type { Actor } from '../../core/services/context.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { projectOverride } from '../../core/telegram/helpers.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import type { IncomingFile, Registry } from '../../core/telegram/registry.js';
import { show } from '../../core/telegram/render.js';
import { atLocal, fmtStamp, localDate } from '../../core/time.js';
import { b, esc, i } from '../../core/ui/html.js';
import { cb } from '../../core/ui/keyboard.js';
import { G } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { extractDue } from '../tasks/quickadd.js';
import { describeRecurrence, isRecurrence, nextOccurrence, parseRecurrence, withAnchor } from '../tasks/recurrence.js';
import { statementCsv, statementPdf } from './exports.js';
import { formatMoney, parseAmount, parseRate } from './money.js';
import { METHODS, SPLITS, TAGS, parseSpend, type FounderTag, type Method, type SplitMode } from './parse.js';
import { COST_JOB, type CostView } from './service.js';
import {
  balanceView, categoriesView, categoryPicker, costCard, dashView, draftView, editView, historyView, monthLabel, recurringView,
  settlementRequestView, statementView, type CLookup, type CostDraft, type DashData,
} from './views.js';

const DRAFT = 'cost.new';

async function clookup(app: App, actor: Actor): Promise<CLookup> {
  const [members, projects, categories] = await Promise.all([
    app.members.list(actor.workspaceId),
    app.projects.list(actor),
    app.costs.categories(actor),
  ]);
  return {
    now: app.clock.now(),
    meUserId: actor.userId,
    names: new Map(members.map((m) => [m.user_id, m.display_name])),
    projects: projects.map((p) => ({ id: p.id, code: p.code })),
    categories,
  };
}

async function splitText(app: App, actor: Actor, d: Pick<CostDraft, 'projectId' | 'split' | 'paidBy'>, names: Map<number, string>): Promise<string> {
  const shares = await app.costs.sharesFor(actor.workspaceId, d.projectId, d.split, d.paidBy);
  return shares.filter((s) => s.bp > 0).map((s) => `${names.get(s.userId) ?? '?'} ${s.bp / 100}%`).join(' / ');
}

async function showDraft(ctx: MemberCtx, id: number, d: CostDraft, mode: 'auto' | 'new' = 'auto'): Promise<void> {
  const l = await clookup(ctx.app, ctx.actor);
  await show(ctx, draftView(id, d, l, await splitText(ctx.app, ctx.actor, d, l.names)), mode);
}

async function showCost(ctx: MemberCtx, id: number, banner?: string, mode: 'auto' | 'new' = 'auto'): Promise<void> {
  await show(ctx, costCard(await ctx.app.costs.get(ctx.actor, id), await clookup(ctx.app, ctx.actor), banner), mode);
}

/** Parse "/spend …" text into a draft (always confirmed with one tap — it is money). */
async function startSpend(ctx: MemberCtx, text: string, receipt: CostDraft['receipt'] = null): Promise<void> {
  const { app, actor } = ctx;
  const [members, projects, cats, current] = await Promise.all([
    app.members.list(actor.workspaceId), app.projects.list(actor), app.costs.categories(actor), app.projects.current(actor),
  ]);
  const users = await app.db.selectFrom('users').select(['id', 'username']).execute();
  const r = parseSpend(text, {
    now: app.clock.now(), meUserId: actor.userId,
    members: members.map((m) => ({ userId: m.user_id, handles: [m.handle, m.display_name.toLowerCase(), users.find((u) => u.id === m.user_id)?.username?.toLowerCase()].filter((x): x is string => !!x) })),
    projects: projects.map((p) => ({ id: p.id, code: p.code })),
    categories: cats.map((c) => ({ id: c.id, slug: c.slug, name: c.name, aliases: c.aliasList })),
    allowedCurrencies: await app.costs.allowedCurrencies(actor.workspaceId),
    defaultCurrency: (await app.costs.allowedCurrencies(actor.workspaceId))[0] ?? 'ETB',
  });
  const d: CostDraft = { ...r, projectId: r.projectId ?? current.id, receipt };
  const id = await app.drafts.create(actor.workspaceId, actor.userId, DRAFT, d);
  await showDraft(ctx, id, d, 'new');
}

async function storeReceipt(ctx: MemberCtx, file: IncomingFile): Promise<NonNullable<CostDraft['receipt']>> {
  const data = await ctx.fetchFile(file.fileId, file.size);
  const path = data ? await ctx.app.costs.saveReceiptFile(ctx.actor.workspaceId, data, file.ext) : null;
  return { fileId: file.fileId, uniqueId: file.uniqueId, path, mime: file.mime, size: file.size };
}

async function dashboard(ctx: MemberCtx, month: string, projectId: number | null, page: number): Promise<View> {
  const { app, actor } = ctx;
  const l = await clookup(app, actor);
  const st = await app.costs.statement(actor, month);
  const scoped = projectId ? st.costs.filter((c) => c.project_id === projectId) : st.costs;
  const sum = new Map<string, number>();
  for (const c of scoped) sum.set(c.currency, (sum.get(c.currency) ?? 0) + c.amount_minor);
  const cats = new Map<string, { name: string; currency: string; amount: number }>();
  for (const c of scoped) {
    const k = `${c.category_name}|${c.currency}`;
    const prev = cats.get(k) ?? { name: c.category_name, currency: c.currency, amount: 0 };
    prev.amount += c.amount_minor;
    cats.set(k, prev);
  }
  const trendCurrency = [...sum.keys()][0] ?? 'ETB';
  const monthly = await app.costs.monthlyTotals(actor, projectId, 6);
  const months = Array.from({ length: 6 }, (_, k) => app.clock.now().startOf('month').minus({ months: 5 - k }).toFormat('yyyy-MM'));
  const list = await app.costs.list(actor, { projectId, month, includeVoided: true }, page, 6);
  const budget = projectId ? await app.costs.budgetStatus(actor.workspaceId, projectId, month) : null;
  const data: DashData = {
    month, projectId, page, total: list.total, recent: list.items,
    totals: [...sum].map(([currency, amount]) => ({ currency, amount })),
    byCategory: [...cats.values()].sort((a, z) => z.amount - a.amount),
    trend: months.map((m) => ({ month: m, amount: monthly.filter((x) => x.month === m && x.currency === trendCurrency).reduce((a, x) => a + x.amount, 0) })),
    trendCurrency,
    budget: budget ? { pct: budget.pct, spent: budget.spent, budget: budget.budget } : null,
  };
  return dashView(data, l);
}

async function balance(ctx: MemberCtx): Promise<View> {
  const { app, actor } = ctx;
  const projects = await app.projects.list(actor);
  const perProject = [];
  for (const p of projects) perProject.push({ code: p.code, views: await app.costs.balances(actor, p.id) });
  return balanceView(await app.costs.balances(actor, null), perProject, await app.costs.pendingSettlements(actor), await clookup(app, actor));
}

const ymToMonth = (ym: string) => (/^\d{6}$/.test(ym) ? `${ym.slice(0, 4)}-${ym.slice(4)}` : null);

// ---------- jobs ----------

function jobs(app: App, notifier: Notifier): JobHandler[] {
  const all = async (ws: number, projectId: number) => app.costs.participants(ws, projectId);
  return [
    {
      kind: COST_JOB.settlementNotify,
      maxLateMs: 7 * 86_400_000,
      nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      execute: async (job, p: { settlementId: number; event: 'requested' | 'decided' }) => {
        const s = await app.db.selectFrom('settlements').selectAll().where('id', '=', p.settlementId).executeTakeFirst();
        if (!s) return 'failed';
        const to = { userId: s.to_user_id, workspaceId: s.workspace_id };
        const from = { userId: s.from_user_id, workspaceId: s.workspace_id };
        if (p.event === 'requested') {
          if (s.status !== 'pending') return 'sent';
          await notifier.deliver(s.workspace_id, s.to_user_id, settlementRequestView(s, await clookup(app, to)), 'direct');
        } else {
          const l = await clookup(app, from);
          const key = s.status === 'confirmed' ? 'cost.settle_confirmed' : 'cost.settle_rejected';
          await notifier.deliver(s.workspace_id, s.from_user_id, { text: t(key, { name: l.names.get(s.to_user_id) ?? '?', amount: formatMoney(s.amount_minor, s.currency) }) }, 'direct');
        }
        return 'sent';
      },
    },
    {
      kind: COST_JOB.budgetAlert,
      maxLateMs: 3 * 86_400_000,
      nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      execute: async (job, p: { projectId: number; threshold: number; spent: number; budget: number; currency: string; period: 'monthly' | 'total' }) => {
        const project = await app.db.selectFrom('projects').select(['code']).where('id', '=', p.projectId).executeTakeFirst();
        for (const who of await all(job.workspace_id, p.projectId)) {
          await notifier.deliver(job.workspace_id, who.userId, {
            text: t(p.threshold >= 100 ? 'cost.budget_over' : 'cost.budget_warn', {
              code: project?.code ?? '?', spent: formatMoney(p.spent, p.currency), budget: formatMoney(p.budget, p.currency), period: t(`cost.period.${p.period}`),
            }),
            keyboard: [[{ text: t('cost.btn_costs'), data: cb('cd', 'now', enc(p.projectId), '0') }]],
          }, 'direct');
        }
        return 'sent';
      },
    },
    {
      kind: COST_JOB.recurringDue,
      maxLateMs: 7 * 86_400_000,
      nextAfter: () => null,
      async plan(job, p: { recurringId: number; occurrence: string }) {
        const r = await app.costs.recurringById(job.workspace_id, p.recurringId);
        if (!r || !r.active || r.next_date !== p.occurrence) return { action: 'skip', reason: 'obsolete', next: null };
        const rule: unknown = JSON.parse(r.recurrence);
        if (!isRecurrence(rule)) return { action: 'skip', reason: 'bad rule', next: null };
        const following = nextOccurrence(rule, p.occurrence);
        return { action: 'send', next: atLocal(following, 9, 0), payload: { recurringId: r.id, occurrence: following } };
      },
      async execute(job, p: { recurringId: number; occurrence: string }) {
        const r = (await app.costs.recurringById(job.workspace_id, p.recurringId))!;
        const payer: Actor = { userId: r.paid_by, workspaceId: job.workspace_id };
        const l = await clookup(app, payer);
        const cat = l.categories.find((c) => c.id === r.category_id)?.name ?? '?';
        const label = `${formatMoney(r.amount_minor, r.currency)} · ${cat}${r.note ? ` · ${r.note}` : ''}`;
        if (r.action === 'create') {
          const cost = await app.costs.recordRecurring(payer, r.id, p.occurrence);
          for (const who of await all(job.workspace_id, r.project_id)) {
            await notifier.deliver(job.workspace_id, who.userId, {
              text: `🔁 ${b(t('cost.rc_recorded'))}\n${esc(label)}`,
              keyboard: [[{ text: t('rem.btn_open'), data: cb('co', 'o', enc(cost.id)) }]],
            }, 'nudge');
          }
        } else {
          const ymd = p.occurrence.replace(/-/g, '');
          await notifier.deliver(job.workspace_id, r.paid_by, {
            text: `🔁 ${b(t('cost.rc_due'))}\n${esc(label)}`,
            keyboard: [[{ text: t('cost.btn_record_now'), data: cb('cs', 'rcr', enc(r.id), ymd), style: 'primary' }]],
          }, 'nudge');
        }
        await app.costs.advanceRecurring(job.workspace_id, r.id, p.occurrence);
        await app.costs.syncRecurring(job.workspace_id, r.id);
        return 'sent';
      },
    },
    {
      kind: COST_JOB.recurringRenew,
      maxLateMs: 2 * 86_400_000,
      nextAfter: () => null,
      async plan(job, p: { recurringId: number; occurrence: string }) {
        const r = await app.costs.recurringById(job.workspace_id, p.recurringId);
        if (!r || !r.active || r.next_date !== p.occurrence) return { action: 'skip', reason: 'obsolete', next: null };
        return { action: 'send', next: null };
      },
      async execute(job, p: { recurringId: number; occurrence: string }) {
        const r = (await app.costs.recurringById(job.workspace_id, p.recurringId))!;
        const l = await clookup(app, { userId: r.paid_by, workspaceId: job.workspace_id });
        const cat = l.categories.find((c) => c.id === r.category_id)?.name ?? '?';
        for (const who of await all(job.workspace_id, r.project_id)) {
          await notifier.deliver(job.workspace_id, who.userId, {
            text: `⏳ ${b(t('cost.rc_renews', { days: r.alert_days }))}\n${esc(formatMoney(r.amount_minor, r.currency))} ${G.dot} ${esc(cat)}${r.note ? ` ${G.dot} ${esc(r.note)}` : ''} ${G.dot} ${p.occurrence}`,
          }, 'nudge');
        }
        return 'sent';
      },
    },
    {
      kind: COST_JOB.statement,
      maxLateMs: 3 * 86_400_000,
      nextAfter: (job, _p, now) => app.costs.nextStatementAt(job.workspace_id, now),
      plan: async (job, _p, { now }) => ({ action: 'send', next: await app.costs.nextStatementAt(job.workspace_id, now) }),
      async execute(job) {
        const month = app.clock.now().minus({ months: 1 }).toFormat('yyyy-MM');
        for (const m of await app.members.list(job.workspace_id)) {
          const actor = { userId: m.user_id, workspaceId: job.workspace_id };
          if (!(await app.permissions.can(actor, 'cost.view'))) continue;
          await notifier.deliver(job.workspace_id, m.user_id, statementView(await app.costs.statement(actor, month), await clookup(app, actor)), 'nudge');
        }
        return 'sent';
      },
    },
  ];
}

// ---------- module ----------

export const costsModule: TegbarModule = {
  name: 'costs',
  telegram({ app, reg, notifier }) {
    for (const h of jobs(app, notifier)) reg.job(h);
    commands(reg);
    callbacks(app, reg);
    inputs(app, reg);
    reg.menuEntry({ label: 'menu.costs', command: 'costs', order: 48 });

    // A photo or file with a "/spend …" caption becomes a cost with its receipt.
    reg.mediaFallback(async (ctx, file, caption) => {
      const m = /^\/?spend\b\s*(.*)$/is.exec(caption.trim());
      if (!m) return false;
      await startSpend(ctx, m[1] ?? '', await storeReceipt(ctx, file));
      return true;
    });

    reg.dashboardSection({
      order: 30,
      render: async (ctx) => {
        const month = localDate(ctx.app.clock.now()).slice(0, 7);
        const st = await ctx.app.costs.statement(ctx.actor, month);
        if (!st.costs.length) return null;
        const l = await clookup(ctx.app, ctx.actor);
        const totals = st.currencies.map((c) => formatMoney(st.costs.filter((x) => x.currency === c).reduce((a, x) => a + x.amount_minor, 0), c)).join(' + ');
        const { balanceLines } = await import('./views.js');
        return `${b(t('cost.dash_title'))} ${i(monthLabel(month))}\n💰 ${totals}\n⚖ ${balanceLines(await ctx.app.costs.balances(ctx.actor, null), l).join('; ')}`;
      },
    });
  },
};

function commands(reg: Registry): void {
  reg.command({
    name: 'spend', group: 'costs', description: 'cmd.spend',
    handler: async (ctx, args) => {
      if (!args) {
        await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'cost.start', {});
        return show(ctx, { text: t('cost.spend_prompt') });
      }
      await startSpend(ctx, args);
    },
  });
  reg.command({
    name: 'costs', group: 'costs', description: 'cmd.costs',
    handler: async (ctx, args) => {
      const { project, unknown } = await projectOverride(ctx.app, ctx.actor, args);
      if (unknown) throw new DomainError('project.unknown_code', { code: unknown });
      await show(ctx, await dashboard(ctx, localDate(ctx.app.clock.now()).slice(0, 7), project?.id ?? null, 0));
    },
  });
  reg.command({ name: 'balance', group: 'costs', description: 'cmd.balance', handler: async (ctx) => show(ctx, await balance(ctx)) });
  reg.command({
    name: 'settle', group: 'costs', description: 'cmd.settle',
    handler: async (ctx, args) => {
      if (!args) return show(ctx, await balance(ctx));
      const { app, actor } = ctx;
      const members = await app.members.list(actor.workspaceId);
      const who = /@([\p{L}\p{N}_]+)/u.exec(args)?.[1]?.toLowerCase();
      const others = members.filter((m) => m.user_id !== actor.userId);
      const to = who ? members.find((m) => m.handle === who || m.display_name.toLowerCase() === who) : others.length === 1 ? others[0] : undefined;
      if (!to) throw new DomainError('cost.settle_usage');
      const amountText = /(\d[\d,]*(?:\.\d+)?)/.exec(args)?.[1];
      const currency = (await app.costs.allowedCurrencies(actor.workspaceId))[0] ?? 'ETB';
      const amount = amountText ? parseAmount(amountText, currency) : null;
      if (!amount) throw new DomainError('cost.settle_usage');
      const method = (/\b(cash|bank|telebirr|card)\b/i.exec(args)?.[1]?.toLowerCase() as Method | undefined) ?? 'bank';
      const { project } = await projectOverride(app, actor, args);
      const { settlement, created } = await app.costs.recordSettlement(actor, { toUserId: to.user_id, amount, currency, method, projectId: project?.id ?? null });
      await show(ctx, { text: t(created ? 'cost.settle_recorded' : 'cost.settle_exists', { name: to.display_name, amount: formatMoney(settlement.amount_minor, settlement.currency) }) });
      await ctx.kick();
    },
  });
  reg.command({
    name: 'statement', group: 'costs', description: 'cmd.statement',
    handler: async (ctx, args) => {
      const month = /^\d{4}-\d{2}$/.test(args.trim()) ? args.trim() : ctx.app.clock.now().minus({ months: 1 }).toFormat('yyyy-MM');
      await show(ctx, statementView(await ctx.app.costs.statement(ctx.actor, month), await clookup(ctx.app, ctx.actor)));
    },
  });
  reg.command({
    name: 'budget', group: 'costs', description: 'cmd.budget',
    handler: async (ctx, args) => {
      const { app, actor } = ctx;
      const { project, rest } = await projectOverride(app, actor, args);
      const p = project ?? (await app.projects.current(actor));
      if (!rest.trim()) return show(ctx, await budgetView(ctx, p.id));
      if (/^\s*off\s*$/i.test(rest)) {
        await app.costs.setBudget(actor, p.id, null);
        return show(ctx, await budgetView(ctx, p.id));
      }
      const m = /^\s*(\d[\d,]*(?:\.\d+)?)\s*(monthly|month|total)?\s*$/i.exec(rest);
      const amount = m ? parseAmount(m[1]!, await app.costs.reportingCurrency(actor.workspaceId, p.id)) : null;
      if (!amount) throw new DomainError('cost.budget_usage');
      await app.costs.setBudget(actor, p.id, { amount, period: m![2]?.toLowerCase() === 'total' ? 'total' : 'monthly' });
      await show(ctx, await budgetView(ctx, p.id));
      await ctx.kick();
    },
  });
  reg.command({
    name: 'recurring_costs', group: 'costs', description: 'cmd.recurring_costs',
    handler: async (ctx, args) => {
      const { app, actor } = ctx;
      const m = /^\s*add\s+(.+)$/is.exec(args);
      if (!m) return show(ctx, recurringView(await app.costs.recurringList(actor), await clookup(app, actor)));
      const text = m[1]!;
      const found = parseRecurrence(text, app.clock.now().weekday);
      if (!found) throw new DomainError('cost.rc_usage');
      const stripped = text.replace(found.match, ' ');
      const action = /\bauto\b|\bcreate\b/i.test(stripped) ? 'create' : 'remind';
      const alert = /\balert\s+(\d{1,2})\s*d/i.exec(stripped);
      const cleaned = stripped.replace(/\b(auto|create|remind)\b/gi, ' ').replace(/\balert\s+\d{1,2}\s*d(ays?)?\b/gi, ' ');
      const [members, projects, cats, current] = await Promise.all([
        app.members.list(actor.workspaceId), app.projects.list(actor), app.costs.categories(actor), app.projects.current(actor),
      ]);
      const d = parseSpend(cleaned, {
        now: app.clock.now(), meUserId: actor.userId,
        members: members.map((x) => ({ userId: x.user_id, handles: [x.handle, x.display_name.toLowerCase()] })),
        projects: projects.map((p) => ({ id: p.id, code: p.code })),
        categories: cats.map((c) => ({ id: c.id, slug: c.slug, name: c.name, aliases: c.aliasList })),
        allowedCurrencies: await app.costs.allowedCurrencies(actor.workspaceId), defaultCurrency: 'ETB',
      });
      const blocking = d.issues.filter((x) => x.kind !== 'future_date');
      if (!d.amount || !d.categoryId || blocking.length) throw new DomainError('cost.rc_usage');
      const today = localDate(app.clock.now());
      const r = await app.costs.createRecurring(actor, {
        projectId: d.projectId ?? current.id, categoryId: d.categoryId, amount: d.amount, currency: d.currency, paidBy: d.paidBy,
        method: d.method, note: d.note, recurrence: withAnchor(found.rule, today), action, alertDays: alert ? Number(alert[1]) : 7,
      });
      await show(ctx, {
        text: t('cost.rc_created', { label: `${formatMoney(r.amount_minor, r.currency)} · ${describeRecurrence(JSON.parse(r.recurrence))}`, next: r.next_date }),
        keyboard: [[{ text: t('cost.btn_recurring'), data: cb('cs', 'rec', '0') }]],
      });
    },
  });
  reg.command({
    name: 'rate', group: 'costs', description: 'cmd.rate',
    handler: async (ctx, args) => {
      const m = /^\s*([A-Za-z]{3})\s+(\d[\d,]*(?:\.\d+)?)\s*(\d{4}-\d{2})?\s*$/.exec(args);
      const rate = m ? parseRate(m[2]!) : null;
      if (!m || !rate) throw new DomainError('cost.rate_usage');
      const month = m[3] ?? localDate(ctx.app.clock.now()).slice(0, 7);
      await ctx.app.costs.setRate(ctx.actor, m[1]!.toUpperCase(), 'ETB', month, rate);
      await show(ctx, { text: t('cost.rate_saved', { currency: m[1]!.toUpperCase(), rate: m[2]!, month }) });
    },
  });
}

async function budgetView(ctx: MemberCtx, projectId: number): Promise<View> {
  const p = await ctx.app.projects.get(ctx.actor, projectId);
  const st = await ctx.app.costs.budgetStatus(ctx.actor.workspaceId, projectId);
  const text = st
    ? t('cost.budget_status', { code: p.code, pct: st.pct, spent: formatMoney(st.spent, st.budget.currency), budget: formatMoney(st.budget.amount_minor, st.budget.currency), period: t(`cost.period.${st.budget.period}`) })
    : t('cost.budget_none', { code: p.code });
  return { text: `🎯 ${text}\n\n${i(t('cost.budget_hint', { code: p.code.toLowerCase() }))}`, keyboard: [[{ text: t('cost.btn_costs'), data: cb('cd', 'now', enc(projectId), '0') }]] };
}

function callbacks(app: App, reg: Registry): void {
  // Draft card: cn:<action>:<draftId>[:<target>]
  reg.callback('cn', async (ctx, [action, raw, target], answer) => {
    const { actor } = ctx;
    const id = dec(raw);
    if (!id) return answer(t('common.stale'), true);
    const draft = await app.drafts.get<CostDraft>(id, actor.userId, DRAFT);
    if (!draft) return answer(t('qa.expired'), true);
    if (draft.consumed) return answer(t('qa.already_handled'));
    const d = draft.payload;
    const pend = (kind: string, prompt: Parameters<typeof t>[0]) =>
      app.pending.set(actor.workspaceId, actor.userId, kind, { draftId: id }).then(() => show(ctx, { text: t(prompt as 'cost.amount_prompt') }, 'new'));
    switch (action) {
      case 's': {
        const blocking = d.issues.filter((x) => ['currency_not_allowed', 'unknown_project'].includes(x.kind));
        if (!d.amount) return answer(t('cost.issue.no_amount'), true);
        if (!d.categoryId) return answer(t('cost.issue.no_category'), true);
        if (blocking.length) return answer(t('cost.fix_first'), true);
        if (!(await app.drafts.consume(id, actor.userId))) return answer(t('qa.already_handled'));
        const { cost, needsApproval } = await app.costs.create(actor, {
          projectId: d.projectId, categoryId: d.categoryId, amount: d.amount, currency: d.currency, rateMicro: d.rateMicro, date: d.date,
          paidBy: d.paidBy, method: d.method, tag: d.tag, split: d.split, note: d.note,
        });
        if (d.receipt) await app.costs.addReceipt(actor, cost.id, d.receipt);
        await answer(t('common.saved'));
        await showCost(ctx, cost.id, needsApproval ? t('cost.saved_pending') : t('cost.saved'));
        await ctx.kick();
        return;
      }
      case 'c':
        if (!(await app.drafts.consume(id, actor.userId))) return answer(t('qa.already_handled'));
        return show(ctx, { text: i(t('common.cancelled')) });
      case 'p': { const v = dec(target); if (!v) return answer(t('common.stale'), true); d.projectId = v; break; }
      case 'pb': { const v = dec(target); if (!v) return answer(t('common.stale'), true); d.paidBy = v; d.issues = d.issues.filter((x) => x.kind !== 'unknown_person'); break; }
      case 'm': if (!METHODS.includes(target as Method)) return answer(t('common.stale'), true); d.method = target as Method; break;
      case 'sp': if (!SPLITS.includes(target as SplitMode)) return answer(t('common.stale'), true); d.split = target as SplitMode; break;
      case 'tg': if (!TAGS.includes(target as FounderTag)) return answer(t('common.stale'), true); d.tag = target as FounderTag; break;
      case 'cat': {
        if (!target) return show(ctx, categoryPicker(cb('cn', 'cat', raw!), await app.costs.categories(actor), d.categoryId, cb('cn', 'v', raw!)));
        const v = dec(target);
        if (!v) return answer(t('common.stale'), true);
        d.categoryId = v;
        d.issues = d.issues.filter((x) => x.kind !== 'no_category');
        break;
      }
      case 'v': return showDraft(ctx, id, d);
      case 'am': return pend('cost.draft_amount', 'cost.amount_prompt');
      case 'dt': return pend('cost.draft_date', 'cost.date_prompt');
      case 'nt': return pend('cost.draft_note', 'cost.note_prompt');
      default: return answer(t('common.stale'), true);
    }
    if (!(await app.drafts.update(id, actor.userId, d))) return answer(t('qa.already_handled'));
    await showDraft(ctx, id, d);
  });

  // Cost card: co:<action>:<costId>[:<target>]
  reg.callback('co', async (ctx, [action, raw, target], answer) => {
    const { actor } = ctx;
    const id = dec(raw);
    if (!id) return answer(t('common.stale'), true);
    const pend = async (kind: string, prompt: 'cost.amount_prompt' | 'cost.date_prompt' | 'cost.note_prompt' | 'cost.void_prompt' | 'cost.receipt_prompt') => {
      await app.pending.set(actor.workspaceId, actor.userId, kind, { costId: id });
      return show(ctx, { text: t(prompt) }, 'new');
    };
    const editTo = async (patch: Parameters<typeof app.costs.edit>[2]) => {
      const { changed } = await app.costs.edit(actor, id, patch);
      await answer(changed ? t('common.saved') : t('common.nothing_changed'));
      return show(ctx, editView(await app.costs.get(actor, id)));
    };
    switch (action) {
      case 'o': return showCost(ctx, id);
      case 'h': {
        const c = await app.costs.get(actor, id);
        return show(ctx, historyView(c, await app.costs.history(actor, id), await clookup(app, actor)));
      }
      case 'e': return show(ctx, editView(await app.costs.get(actor, id)));
      case 'ea': return pend('cost.edit_amount', 'cost.amount_prompt');
      case 'ed': return pend('cost.edit_date', 'cost.date_prompt');
      case 'en': return pend('cost.edit_note', 'cost.note_prompt');
      case 'v': return pend('cost.void', 'cost.void_prompt');
      case 'rc': return pend('cost.receipt', 'cost.receipt_prompt');
      case 'rv': {
        await answer(t('cost.sending_receipts'));
        for (const r of await app.costs.receipts(actor, id)) {
          try {
            if (r.mime?.startsWith('image/')) await ctx.replyWithPhoto(r.telegram_file_id, { caption: `C${id}` });
            else await ctx.replyWithDocument(r.telegram_file_id, { caption: `C${id}` });
          } catch {
            if (r.path) await ctx.replyWithDocument(new InputFile(await readFile(app.costs.receiptPath(r.path)), `receipt-C${id}${r.path.slice(r.path.lastIndexOf('.'))}`));
          }
        }
        return;
      }
      case 'ec': {
        const c = await app.costs.get(actor, id);
        if (!target) return show(ctx, categoryPicker(cb('co', 'ec', raw!), await app.costs.categories(actor), c.category_id, cb('co', 'e', raw!)));
        const v = dec(target);
        return v ? editTo({ categoryId: v }) : answer(t('common.stale'), true);
      }
      case 'ep': {
        const c = await app.costs.get(actor, id);
        if (target) {
          const uid = dec(target);
          return uid ? editTo({ paidBy: uid }) : answer(t('common.stale'), true);
        }
        // A list with explicit targets (not a cycle), so a double tap is harmless.
        const people = await app.costs.participants(actor.workspaceId, c.project_id);
        return show(ctx, {
          text: `<b>${t('cost.payer')}</b>`,
          keyboard: [
            people.map((p) => ({ text: p.userId === c.paid_by ? `${G.done} ${p.name}` : p.name, data: cb('co', 'ep', raw!, enc(p.userId)), ...(p.userId === c.paid_by ? { style: 'primary' as const } : {}) })),
            [{ text: G.back, data: cb('co', 'e', raw!) }],
          ],
        });
      }
      case 'em': return METHODS.includes(target as Method) ? editTo({ method: target as Method }) : answer(t('common.stale'), true);
      case 'es': return SPLITS.includes(target as SplitMode) ? editTo({ split: target as SplitMode }) : answer(t('common.stale'), true);
      case 'et': return TAGS.includes(target as FounderTag) ? editTo({ tag: target as FounderTag }) : answer(t('common.stale'), true);
      default: return answer(t('common.stale'), true);
    }
  });

  // Dashboard: cd:<yyyymm|now>:<project b36|a>:<page>
  reg.callback('cd', async (ctx, [ym, pj, page]) => {
    const month = ym === 'now' ? localDate(ctx.app.clock.now()).slice(0, 7) : ymToMonth(ym ?? '') ?? localDate(ctx.app.clock.now()).slice(0, 7);
    await show(ctx, await dashboard(ctx, month, pj && pj !== 'a' ? dec(pj) : null, Math.max(0, Number(page) || 0)));
  });

  // Settlements: se:new:<to>:<amount b36>:<cur> · se:amt:<to> · se:c|r|x:<id>
  reg.callback('se', async (ctx, [action, raw, a2, a3], answer) => {
    const { actor } = ctx;
    const id = dec(raw);
    if (!id) return answer(t('common.stale'), true);
    if (action === 'new') {
      const amount = Number.parseInt(a2 ?? '', 36);
      if (!Number.isSafeInteger(amount) || amount <= 0 || !a3) return answer(t('common.stale'), true);
      const { settlement, created } = await app.costs.recordSettlement(actor, { toUserId: id, amount, currency: a3, method: 'bank' });
      await answer(created ? t('cost.settle_sent') : t('qa.already_handled'));
      await ctx.kick();
      const names = (await clookup(app, actor)).names;
      return show(ctx, { text: t(created ? 'cost.settle_recorded' : 'cost.settle_exists', { name: names.get(id) ?? '?', amount: formatMoney(settlement.amount_minor, settlement.currency) }) });
    }
    if (action === 'amt') {
      await app.pending.set(actor.workspaceId, actor.userId, 'cost.settle_amount', { toUserId: id });
      return show(ctx, { text: t('cost.settle_amount_prompt') }, 'new');
    }
    if (action === 'x') {
      const { changed } = await app.costs.cancelSettlement(actor, id);
      await answer(changed ? t('common.cancelled') : t('qa.already_handled'));
      return show(ctx, await balance(ctx));
    }
    if (action === 'c' || action === 'r') {
      const { settlement, changed } = await app.costs.decideSettlement(actor, id, action === 'c');
      await answer(changed ? t(action === 'c' ? 'cost.settle_thanks' : 'cost.settle_marked_not') : t('qa.already_handled'), !changed);
      await ctx.kick();
      return show(ctx, { text: t(settlement.status === 'confirmed' ? 'cost.settle_confirmed_you' : 'cost.settle_rejected_you', { amount: formatMoney(settlement.amount_minor, settlement.currency) }) });
    }
    return answer(t('common.stale'), true);
  });

  // Costs settings & reports: cs:<action>:<arg>[:<arg2>]
  reg.callback('cs', async (ctx, [action, arg, arg2], answer) => {
    const { actor } = ctx;
    switch (action) {
      case 'spend':
        await app.pending.set(actor.workspaceId, actor.userId, 'cost.start', {});
        return show(ctx, { text: t('cost.spend_prompt') }, 'new');
      case 'bal': return show(ctx, await balance(ctx));
      case 'stm': {
        const month = ymToMonth(arg ?? '') ?? localDate(app.clock.now()).slice(0, 7);
        return show(ctx, statementView(await app.costs.statement(actor, month), await clookup(app, actor)));
      }
      case 'csv': case 'pdf': {
        const month = ymToMonth(arg ?? '');
        if (!month) return answer(t('common.stale'), true);
        await answer(t('cost.preparing'));
        const st = await app.costs.statement(actor, month);
        const names = (await clookup(app, actor)).names;
        if (action === 'csv') {
          return void (await ctx.replyWithDocument(new InputFile(Buffer.from(statementCsv(st, names), 'utf8'), `tegbar-${month}.csv`)));
        }
        const pdf = await statementPdf(st, names, { workspace: app.workspace.name, generatedAt: fmtStamp(app.clock.now()), monthLabel: monthLabel(month) });
        return void (await ctx.replyWithDocument(new InputFile(pdf, `tegbar-${month}.pdf`)));
      }
      case 'bud': {
        const pid = arg && arg !== 'a' ? dec(arg) : (await app.projects.current(actor)).id;
        return show(ctx, await budgetView(ctx, pid!));
      }
      case 'split': {
        const pid = arg && arg !== 'a' ? dec(arg)! : (await app.projects.current(actor)).id;
        const p = await app.projects.get(actor, pid);
        const rule = await app.costs.splitRule(actor.workspaceId, pid);
        const l = await clookup(app, actor);
        const people = await app.costs.participants(actor.workspaceId, pid);
        if (arg2) {
          const rule2 = arg2 === 'eq' ? { mode: 'equal' as const, shares: null, ownerUserId: null }
            : arg2.startsWith('own') ? { mode: 'owner_pays' as const, shares: null, ownerUserId: dec(arg2.slice(3)) }
            : null;
          if (arg2 === 'custom') {
            await app.pending.set(actor.workspaceId, actor.userId, 'cost.split_custom', { projectId: pid });
            return show(ctx, { text: t('cost.split_custom_prompt', { names: people.map((x) => x.name).join(' / ') }) }, 'new');
          }
          if (!rule2) return answer(t('common.stale'), true);
          await app.costs.requestSplitRule(actor, pid, rule2);
          await answer(t('cost.split_requested'));
          await ctx.kick();
          return show(ctx, { text: t('cost.split_requested_long', { code: p.code }) });
        }
        return show(ctx, {
          text: t('cost.split_title', { code: p.code, rule: app.costs.describeRule(rule, l.names) }),
          keyboard: [
            [{ text: t('cost.split_equal'), data: cb('cs', 'split', enc(pid), 'eq') }, { text: t('cost.split_custom'), data: cb('cs', 'split', enc(pid), 'custom') }],
            people.map((x) => ({ text: t('cost.split_owner', { name: x.name }), data: cb('cs', 'split', enc(pid), `own${enc(x.userId)}`) })),
            [{ text: t('cost.btn_costs'), data: cb('cd', 'now', enc(pid), '0') }],
          ],
        });
      }
      case 'rec': return show(ctx, recurringView(await app.costs.recurringList(actor), await clookup(app, actor)));
      case 'rca': case 'rcm': {
        const id = dec(arg);
        if (!id) return answer(t('common.stale'), true);
        if (action === 'rca') await app.costs.updateRecurring(actor, id, { active: arg2 === '1' });
        else if (arg2 === 'create' || arg2 === 'remind') await app.costs.updateRecurring(actor, id, { action: arg2 });
        else return answer(t('common.stale'), true);
        return show(ctx, recurringView(await app.costs.recurringList(actor), await clookup(app, actor)));
      }
      case 'rcr': {
        const id = dec(arg);
        const occ = arg2 && /^\d{8}$/.test(arg2) ? `${arg2.slice(0, 4)}-${arg2.slice(4, 6)}-${arg2.slice(6)}` : null;
        if (!id || !occ) return answer(t('common.stale'), true);
        const cost = await app.costs.recordRecurring(actor, id, occ); // idempotent per occurrence
        return showCost(ctx, cost.id, t('cost.saved'));
      }
      case 'cats': return show(ctx, categoriesView(await app.costs.categories(actor, true)));
      case 'cata': {
        const id = dec(arg);
        if (!id || (arg2 !== '0' && arg2 !== '1')) return answer(t('common.stale'), true);
        await app.costs.updateCategory(actor, id, { archived: arg2 === '1' });
        return show(ctx, categoriesView(await app.costs.categories(actor, true)));
      }
      case 'catn':
        await app.pending.set(actor.workspaceId, actor.userId, 'cost.category_new', {});
        return show(ctx, { text: t('cost.category_prompt') }, 'new');
      default: return answer(t('common.stale'), true);
    }
  });
}

function inputs(app: App, reg: Registry): void {
  const again = async (ctx: MemberCtx, kind: string, payload: unknown, key: 'cost.issue.no_amount' | 'cost.bad_date' | 'cost.void_reason' | 'cost.bad_shares' | 'cost.receipt_prompt'): Promise<never> => {
    await app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, kind, payload);
    throw new DomainError(key);
  };
  const draftOf = async (ctx: MemberCtx, id: number) => {
    const d = await app.drafts.get<CostDraft>(id, ctx.actor.userId, DRAFT);
    if (!d || d.consumed) throw new DomainError('qa.expired');
    return d.payload;
  };
  const parseDate = (ctx: MemberCtx, text: string): string | null => {
    const r = extractDue(text, app.clock.now());
    if (!r.due) return null;
    // "friday" is read forward by the date parser; a spend is in the past.
    const explicit = /\d{4}-\d{2}-\d{2}/.test(text);
    return !explicit && r.due.date > localDate(app.clock.now()) ? localDate(atLocal(r.due.date, 12, 0).minus({ days: 7 })) : r.due.date;
  };

  reg.input('cost.start', async (ctx, text) => startSpend(ctx, text));
  reg.input('cost.draft_amount', async (ctx, text, p: { draftId: number }) => {
    const d = await draftOf(ctx, p.draftId);
    const amount = parseAmount(text, d.currency);
    if (!amount) return again(ctx, 'cost.draft_amount', p, 'cost.issue.no_amount');
    d.amount = amount;
    d.issues = d.issues.filter((x) => x.kind !== 'no_amount' && x.kind !== 'bad_amount');
    await app.drafts.update(p.draftId, ctx.actor.userId, d);
    await showDraft(ctx, p.draftId, d, 'new');
  });
  reg.input('cost.draft_date', async (ctx, text, p: { draftId: number }) => {
    const d = await draftOf(ctx, p.draftId);
    const date = parseDate(ctx, text);
    if (!date || date > localDate(app.clock.now())) return again(ctx, 'cost.draft_date', p, 'cost.bad_date');
    d.date = date;
    d.issues = d.issues.filter((x) => x.kind !== 'future_date');
    await app.drafts.update(p.draftId, ctx.actor.userId, d);
    await showDraft(ctx, p.draftId, d, 'new');
  });
  reg.input('cost.draft_note', async (ctx, text, p: { draftId: number }) => {
    const d = await draftOf(ctx, p.draftId);
    d.note = text.trim() === '-' ? '' : text.trim().slice(0, 300);
    await app.drafts.update(p.draftId, ctx.actor.userId, d);
    await showDraft(ctx, p.draftId, d, 'new');
  });

  reg.input('cost.edit_amount', async (ctx, text, p: { costId: number }) => {
    const c = await app.costs.get(ctx.actor, p.costId);
    const amount = parseAmount(text, c.currency);
    if (!amount) return again(ctx, 'cost.edit_amount', p, 'cost.issue.no_amount');
    await app.costs.edit(ctx.actor, p.costId, { amount });
    await showCost(ctx, p.costId, t('common.saved'), 'new');
    await ctx.kick();
  });
  reg.input('cost.edit_date', async (ctx, text, p: { costId: number }) => {
    const date = parseDate(ctx, text);
    if (!date) return again(ctx, 'cost.edit_date', p, 'cost.bad_date');
    await app.costs.edit(ctx.actor, p.costId, { date });
    await showCost(ctx, p.costId, t('common.saved'), 'new');
  });
  reg.input('cost.edit_note', async (ctx, text, p: { costId: number }) => {
    await app.costs.edit(ctx.actor, p.costId, { note: text.trim() === '-' ? null : text });
    await showCost(ctx, p.costId, t('common.saved'), 'new');
  });
  reg.input('cost.void', async (ctx, text, p: { costId: number }) => {
    if (text.trim().length < 3) return again(ctx, 'cost.void', p, 'cost.void_reason');
    const { changed } = await app.costs.void(ctx.actor, p.costId, text);
    await showCost(ctx, p.costId, changed ? t('cost.voided_banner') : t('common.nothing_changed'), 'new');
  });
  reg.input('cost.receipt', async (ctx, _text, p: { costId: number }) => again(ctx, 'cost.receipt', p, 'cost.receipt_prompt'));
  reg.mediaInput('cost.receipt', async (ctx, file, p: { costId: number }) => {
    const { changed } = await app.costs.addReceipt(ctx.actor, p.costId, await storeReceipt(ctx, file));
    await showCost(ctx, p.costId, changed ? t('cost.receipt_saved') : t('common.nothing_changed'), 'new');
  });
  reg.input('cost.settle_amount', async (ctx, text, p: { toUserId: number }) => {
    const currency = (await app.costs.allowedCurrencies(ctx.actor.workspaceId))[0] ?? 'ETB';
    const amount = parseAmount(text.replace(/[a-z]+/gi, ''), currency);
    if (!amount) return again(ctx, 'cost.settle_amount', p, 'cost.issue.no_amount');
    const method = (/\b(cash|bank|telebirr|card)\b/i.exec(text)?.[1]?.toLowerCase() as Method | undefined) ?? 'bank';
    const { settlement, created } = await app.costs.recordSettlement(ctx.actor, { toUserId: p.toUserId, amount, currency, method });
    const names = (await clookup(app, ctx.actor)).names;
    await show(ctx, { text: t(created ? 'cost.settle_recorded' : 'cost.settle_exists', { name: names.get(p.toUserId) ?? '?', amount: formatMoney(settlement.amount_minor, settlement.currency) }) });
    await ctx.kick();
  });
  reg.input('cost.split_custom', async (ctx, text, p: { projectId: number }) => {
    const people = await app.costs.participants(ctx.actor.workspaceId, p.projectId);
    // Percentages → basis points with string maths ("33.33" → 3333), no floats.
    const parts = text.split(/[^\d.]+/).filter(Boolean);
    const bps = parts.map((s) => {
      const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
      return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
    });
    if (bps.length !== people.length || bps.some((n) => !Number.isInteger(n))) return again(ctx, 'cost.split_custom', p, 'cost.bad_shares');
    const shares = people.map((x, k) => ({ userId: x.userId, bp: bps[k]! }));
    if (shares.reduce((a, s) => a + s.bp, 0) !== 10_000) return again(ctx, 'cost.split_custom', p, 'cost.bad_shares');
    await app.costs.requestSplitRule(ctx.actor, p.projectId, { mode: 'custom', shares, ownerUserId: null });
    const proj = await app.projects.get(ctx.actor, p.projectId);
    await show(ctx, { text: t('cost.split_requested_long', { code: proj.code }) });
    await ctx.kick();
  });
  reg.input('cost.category_new', async (ctx, text) => {
    await app.costs.addCategory(ctx.actor, text);
    await show(ctx, categoriesView(await app.costs.categories(ctx.actor, true)), 'new');
  });
}

export type { CostView };
