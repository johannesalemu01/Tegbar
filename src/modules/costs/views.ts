import type { DateTime } from 'luxon';
import { t } from '../../core/i18n/index.js';
import { enc } from '../../core/ids.js';
import { fmtDay, fmtStamp, fromDb, fromLocalDate } from '../../core/time.js';
import { b, clip, code, esc, i, quote } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import type { EventRow } from '../../core/services/events.js';
import { formatMoney, formatRate } from './money.js';
import { METHODS, SPLITS, TAGS, type FounderTag, type Method, type SplitMode, type SpendIssue } from './parse.js';
import type { BudgetRow, CategoryRow, RecurringCostRow, SettlementRow } from './schema.js';
import type { BalanceView, CostView, StatementData } from './service.js';
import { describeRecurrence } from '../tasks/recurrence.js';

export interface CLookup {
  now: DateTime;
  meUserId: number;
  names: Map<number, string>;
  projects: { id: number; code: string }[];
  categories: CategoryRow[];
}

const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };
const next = <T>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length]!;
export const methodLabel = (m: Method) => t(`cost.method.${m}`);
export const tagLabel = (x: FounderTag) => t(`cost.tag.${x}`);
export const splitLabel = (x: SplitMode) => t(`cost.split.${x}`);
const day = (d: string, l: CLookup) => fmtDay(d, l.now);
export const monthLabel = (month: string) => fromLocalDate(`${month}-01`).toFormat('LLLL yyyy');

// ---------- draft ----------

export interface CostDraft {
  amount: number | null;
  currency: string;
  projectId: number;
  categoryId: number | null;
  paidBy: number;
  method: Method;
  tag: FounderTag;
  split: SplitMode;
  date: string;
  rateMicro: number | null;
  note: string;
  issues: SpendIssue[];
  receipt?: { fileId: string; uniqueId: string; path: string | null; mime: string | null; size: number | null } | null;
}

export function issueText(x: SpendIssue): string {
  switch (x.kind) {
    case 'no_amount': return t('cost.issue.no_amount');
    case 'bad_amount': return t('cost.issue.bad_amount', { value: x.value });
    case 'currency_not_allowed': return t('cost.issue.currency', { value: x.value });
    case 'unknown_person': return t('cost.issue.person', { value: x.value });
    case 'unknown_project': return t('cost.issue.project', { value: x.value });
    case 'no_category': return t('cost.issue.no_category');
    case 'future_date': return t('cost.issue.future_date');
  }
}

export function draftView(id: number, d: CostDraft, l: CLookup, splitText: string): View {
  const e = enc(id);
  const project = l.projects.find((p) => p.id === d.projectId);
  const cat = l.categories.find((c) => c.id === d.categoryId);
  const owners = [...l.names.keys()];
  const nextProject = l.projects[(l.projects.findIndex((p) => p.id === d.projectId) + 1) % l.projects.length]!;
  const text = [
    `${G.sparkle} ${b(t('cost.draft_title'))}`,
    RULE,
    `${b(d.amount ? formatMoney(d.amount, d.currency) : t('cost.no_amount_yet'))}${cat ? ` ${G.dot} ${esc(cat.name)}` : ''}`,
    `${code(project?.code ?? '?')} ${G.dot} ${G.due} ${day(d.date, l)}${d.rateMicro ? ` ${G.dot} ${t('cost.rate_line', { rate: formatRate(d.rateMicro) })}` : ''}`,
    `${G.owner} ${t('cost.paid_by', { name: l.names.get(d.paidBy) ?? '?' })} ${G.dot} ${methodLabel(d.method)} ${G.dot} ${esc(splitText)}`,
    d.tag !== 'expense' ? `🏷 ${tagLabel(d.tag)}` : '',
    d.note ? `✎ ${esc(d.note)}` : '',
    d.receipt ? `📎 ${t('cost.receipt_attached')}` : '',
    d.issues.length ? `\n${quote(d.issues.map((x) => `${G.warn} ${issueText(x)}`).join('\n'))}` : '',
  ].filter(Boolean).join('\n');
  return {
    text,
    keyboard: [
      [{ text: t('qa.btn_save'), data: cb('cn', 's', e), style: 'success' }, { text: t('common.cancel'), data: cb('cn', 'c', e) }],
      [
        { text: `${G.project} ${project?.code ?? '?'} ›`, data: cb('cn', 'p', e, enc(nextProject.id)) },
        { text: `▤ ${cat ? clip(cat.name, 14) : t('cost.pick_category')}`, data: cb('cn', 'cat', e) },
      ],
      [
        { text: `${G.owner} ${l.names.get(d.paidBy) ?? '?'} ›`, data: cb('cn', 'pb', e, enc(next(owners, d.paidBy))) },
        { text: `${methodLabel(d.method)} ›`, data: cb('cn', 'm', e, next(METHODS, d.method)) },
      ],
      [
        { text: `⚖ ${splitLabel(d.split)} ›`, data: cb('cn', 'sp', e, next(SPLITS, d.split)) },
        { text: `🏷 ${tagLabel(d.tag)} ›`, data: cb('cn', 'tg', e, next(TAGS, d.tag)) },
      ],
      [
        { text: t('cost.btn_amount'), data: cb('cn', 'am', e) },
        { text: t('cost.btn_date'), data: cb('cn', 'dt', e) },
        { text: t('cost.btn_note'), data: cb('cn', 'nt', e) },
      ],
    ],
  };
}

export function categoryPicker(prefix: string, cats: CategoryRow[], selected: number | null, backData: string): View {
  return {
    text: `<b>${t('cost.pick_category')}</b>`,
    keyboard: [
      ...grid(cats.map((c) => ({ text: c.id === selected ? `${G.done} ${c.name}` : c.name, data: `${prefix}:${enc(c.id)}`, ...(c.id === selected ? { style: 'primary' as const } : {}) })), 2),
      [{ text: G.back, data: backData }],
    ],
  };
}

// ---------- cost card ----------

const statusTag = (c: CostView) =>
  c.status === 'voided' ? ` ${b(t('cost.voided'))}` : c.status === 'pending_approval' ? ` ${i(t('cost.pending_approval'))}` : '';

export function costLine(c: CostView, n: number | null, l: CLookup, showProject = true): string {
  const struck = c.status === 'voided' ? (s: string) => `<s>${s}</s>` : (s: string) => s;
  return `${n !== null ? `${b(String(n))}  ` : ''}${struck(b(formatMoney(c.amount_minor, c.currency)))} ${G.dot} ${esc(c.category_name)}${statusTag(c)}\n      ${[
    day(c.spent_on, l), showProject ? code(c.project_code) : null, esc(c.payer_name), c.note ? esc(clip(c.note, 40)) : null, c.receipt_count ? '📎' : null,
  ].filter(Boolean).join(` ${G.dot} `)}`;
}

export function costCard(c: CostView, l: CLookup, banner?: string): View {
  const id = enc(c.id);
  const split = c.splits.filter((s) => s.amount > 0 || s.bp > 0).map((s) => `${esc(s.name)} ${formatMoney(s.amount, c.currency)}`).join(' · ');
  const text = [
    banner ? `${i(esc(banner))}\n` : '',
    `${b(formatMoney(c.amount_minor, c.currency))}${statusTag(c)}`,
    `${esc(c.category_name)} ${G.dot} ${code(c.project_code)} ${G.dot} ${i(`C${c.id}`)}`,
    '',
    `${G.due} ${day(c.spent_on, l)} ${G.dot} ${methodLabel(c.method)}`,
    `${G.owner} ${t('cost.paid_by', { name: c.payer_name })}`,
    `⚖ ${split} ${i(`(${splitLabel(c.split_mode)})`)}`,
    c.founder_tag !== 'expense' ? `🏷 ${tagLabel(c.founder_tag)}` : '',
    c.rate_micro ? t('cost.rate_line', { rate: formatRate(c.rate_micro) }) : '',
    c.note ? `\n${quote(esc(c.note))}` : '',
    c.receipt_count ? `📎 ${t('cost.receipts_n', { n: c.receipt_count })}` : '',
    c.status === 'voided' ? `\n${i(t('cost.voided_because', { reason: c.void_reason ?? '' }))}` : '',
  ].filter((x) => x !== '').join('\n');
  const rows: Btn[][] = [];
  if (c.status !== 'voided') {
    rows.push([
      { text: t('cost.btn_receipt'), data: cb('co', 'rc', id) },
      ...(c.receipt_count ? [{ text: t('cost.btn_view_receipts'), data: cb('co', 'rv', id) }] : []),
    ]);
    rows.push([{ text: t('task.btn_edit'), data: cb('co', 'e', id) }, { text: t('task.btn_history'), data: cb('co', 'h', id) }, { text: t('cost.btn_void'), data: cb('co', 'v', id) }]);
  } else {
    rows.push([{ text: t('task.btn_history'), data: cb('co', 'h', id) }]);
  }
  rows.push([{ text: t('cost.btn_costs'), data: cb('cd', 'now', 'a', '0') }]);
  return { text: text.replace(/^\n+/, ''), keyboard: rows };
}

export function editView(c: CostView): View {
  const id = enc(c.id);
  return {
    text: `${b(t('cost.edit_title'))}\n${formatMoney(c.amount_minor, c.currency)} ${G.dot} ${esc(c.category_name)}\n\n${i(t('cost.edit_hint'))}`,
    keyboard: [
      [{ text: t('cost.btn_amount'), data: cb('co', 'ea', id) }, { text: t('cost.btn_date'), data: cb('co', 'ed', id) }, { text: t('cost.btn_note'), data: cb('co', 'en', id) }],
      [{ text: `▤ ${t('cost.pick_category')}`, data: cb('co', 'ec', id) }, { text: `${G.owner} ${t('cost.payer')}`, data: cb('co', 'ep', id) }],
      [
        { text: `${methodLabel(c.method)} ›`, data: cb('co', 'em', id, next(METHODS, c.method)) },
        { text: `⚖ ${splitLabel(c.split_mode)} ›`, data: cb('co', 'es', id, next(SPLITS, c.split_mode)) },
        { text: `🏷 ${tagLabel(c.founder_tag)} ›`, data: cb('co', 'et', id, next(TAGS, c.founder_tag)) },
      ],
      [{ text: G.back, data: cb('co', 'o', id) }],
    ],
  };
}

export function historyView(c: CostView, events: EventRow[], l: CLookup): View {
  const lines = events.map((e) => {
    const who = esc(l.names.get(e.actor_user_id ?? 0) ?? '?');
    const data = JSON.parse(e.data) as { changes?: Record<string, { from: unknown; to: unknown }>; reason?: string };
    let what = t(`cost.hist.${e.action.replace('cost.', '')}` as 'cost.hist.created');
    if (e.action === 'cost.updated' && data.changes) {
      what = Object.entries(data.changes).map(([k, v]) => k === 'amount_minor' ? `amount ${formatMoney(Number(v.from), c.currency)} → ${formatMoney(Number(v.to), c.currency)}` : k.replace(/_/g, ' ')).join(', ');
    }
    if (e.action === 'cost.voided') what += `: ${esc(data.reason ?? '')}`;
    return `${i(fmtStamp(fromDb(e.created_at)))} ${G.dot} ${who} ${G.dot} ${what}`;
  });
  return { text: `${b(t('cost.history_title', { ref: `C${c.id}` }))}\n${RULE}\n${lines.join('\n')}`, keyboard: [[{ text: G.back, data: cb('co', 'o', enc(c.id)) }]] };
}

// ---------- dashboard ----------

const BARS = '▁▂▃▄▅▆▇█';
export function sparkline(values: number[]): string {
  const max = Math.max(...values, 0);
  if (max === 0) return values.map(() => BARS[0]).join('');
  return values.map((v) => BARS[Math.min(7, Math.round((v / max) * 7))]).join('');
}

export interface DashData {
  month: string;
  projectId: number | null;
  totals: { currency: string; amount: number }[];
  byCategory: { name: string; currency: string; amount: number }[];
  trend: { month: string; amount: number }[];
  trendCurrency: string;
  budget: { pct: number; spent: number; budget: BudgetRow } | null;
  recent: CostView[];
  total: number;
  page: number;
}

export function dashView(d: DashData, l: CLookup): View {
  const ym = d.month.replace('-', '');
  const pj = d.projectId ? enc(d.projectId) : 'a';
  const prev = fromLocalDate(`${d.month}-01`).minus({ months: 1 }).toFormat('yyyyMM');
  const nxt = fromLocalDate(`${d.month}-01`).plus({ months: 1 }).toFormat('yyyyMM');
  const projectCycle = ['a', ...l.projects.map((p) => enc(p.id))];
  const nextPj = projectCycle[(projectCycle.indexOf(pj) + 1) % projectCycle.length]!;
  const scope = d.projectId ? l.projects.find((p) => p.id === d.projectId)?.code ?? '?' : t('task.filter.all_projects');
  const totals = d.totals.map((x) => b(formatMoney(x.amount, x.currency))).join(' + ') || b(formatMoney(0, 'ETB'));
  const cats = d.byCategory.slice(0, 5).map((c) => `▤ ${esc(c.name)} ${G.dot} ${formatMoney(c.amount, c.currency)}`).join('\n');
  const trend = `${sparkline(d.trend.map((x) => x.amount))}  ${i(`${monthLabel(d.trend[0]!.month).slice(0, 3)}–${monthLabel(d.trend.at(-1)!.month).slice(0, 3)} · ${d.trendCurrency}`)}`;
  const budget = d.budget ? `🎯 ${t('cost.budget_line', { pct: d.budget.pct, spent: formatMoney(d.budget.spent, d.budget.budget.currency), budget: formatMoney(d.budget.budget.amount_minor, d.budget.budget.currency), period: t(`cost.period.${d.budget.budget.period}`) })}` : '';
  const pages = Math.max(1, Math.ceil(d.total / 6));
  return {
    text: [
      `💰 ${b(t('cost.dash_title'))} ${G.dot} ${monthLabel(d.month)} ${G.dot} ${code(scope)}`,
      RULE,
      `${t('cost.total')} ${totals}`,
      trend,
      budget,
      cats ? `\n${cats}` : '',
      `\n${d.recent.map((c, idx) => costLine(c, d.page * 6 + idx + 1, l, !d.projectId)).join('\n') || i(t('cost.none_month'))}`,
    ].filter(Boolean).join('\n'),
    keyboard: [
      ...grid(d.recent.map((c, idx) => ({ text: String(d.page * 6 + idx + 1), data: cb('co', 'o', enc(c.id)) })), 6),
      [
        { text: G.prev, data: cb('cd', prev, pj, '0') },
        ...(pages > 1 ? [{ text: `${d.page + 1}/${pages}`, data: cb('cd', ym, pj, String((d.page + 1) % pages)) }] : []),
        { text: `${G.project} ${scope} ›`, data: cb('cd', ym, nextPj, '0') },
        { text: G.next, data: cb('cd', nxt, pj, '0') },
      ],
      [{ text: t('cost.btn_spend'), data: cb('cs', 'spend', '0'), style: 'primary' }, { text: t('cost.btn_balance'), data: cb('cs', 'bal', '0') }, { text: t('cost.btn_statement'), data: cb('cs', 'stm', ym) }],
      [{ text: t('cost.btn_budget'), data: cb('cs', 'bud', pj) }, { text: t('cost.btn_split'), data: cb('cs', 'split', pj) }],
      [{ text: t('cost.btn_recurring'), data: cb('cs', 'rec', '0') }, { text: t('cost.btn_categories'), data: cb('cs', 'cats', '0') }],
      [menuBtn],
    ],
  };
}

// ---------- balance & settlements ----------

export function balanceLines(views: BalanceView[], l: CLookup): string[] {
  const out: string[] = [];
  for (const v of views) {
    if (!v.transfers.length) out.push(t('cost.square', { currency: v.currency }));
    for (const tr of v.transfers) out.push(t('cost.owes', { from: l.names.get(tr.from) ?? '?', to: l.names.get(tr.to) ?? '?', amount: formatMoney(tr.amount, v.currency) }));
  }
  return out.length ? out : [t('cost.square', { currency: 'ETB' })];
}

export function balanceView(overall: BalanceView[], perProject: { code: string; views: BalanceView[] }[], pending: SettlementRow[], l: CLookup): View {
  const mine = overall.flatMap((v) => v.transfers.filter((tr) => tr.from === l.meUserId).map((tr) => ({ ...tr, currency: v.currency })));
  const text = [
    `⚖ ${b(t('cost.balance_title'))}\n${RULE}\n${b(t('cost.overall'))}\n${balanceLines(overall, l).map((x) => `   ${x}`).join('\n')}`,
    ...perProject.filter((p) => p.views.some((v) => v.transfers.length)).map((p) => `${code(p.code)}\n${balanceLines(p.views, l).map((x) => `   ${x}`).join('\n')}`),
    pending.length ? `${b(t('cost.pending_settlements'))}\n${pending.map((s) => `   ⏳ ${t('cost.settle_line', { from: l.names.get(s.from_user_id) ?? '?', to: l.names.get(s.to_user_id) ?? '?', amount: formatMoney(s.amount_minor, s.currency) })}`).join('\n')}` : '',
    `\n${i(t('cost.balance_note'))}`,
  ].filter(Boolean).join('\n\n');
  return {
    text,
    keyboard: [
      ...mine.map((tr) => [{ text: t('cost.btn_i_paid', { name: l.names.get(tr.to) ?? '?', amount: formatMoney(tr.amount, tr.currency) }), data: cb('se', 'new', enc(tr.to), tr.amount.toString(36), tr.currency), style: 'primary' as const }]),
      ...[...l.names.keys()].filter((u) => u !== l.meUserId).map((u) => [{ text: t('cost.btn_other_amount', { name: l.names.get(u) ?? '?' }), data: cb('se', 'amt', enc(u)) }]),
      ...pending.filter((s) => s.from_user_id === l.meUserId).map((s) => [{ text: t('cost.btn_cancel_settle', { amount: formatMoney(s.amount_minor, s.currency) }), data: cb('se', 'x', enc(s.id)) }]),
      [{ text: t('cost.btn_costs'), data: cb('cd', 'now', 'a', '0') }, menuBtn],
    ],
  };
}

export function settlementRequestView(s: SettlementRow, l: CLookup): View {
  const id = enc(s.id);
  return {
    text: `💸 ${b(t('cost.settle_req', { name: l.names.get(s.from_user_id) ?? '?', amount: formatMoney(s.amount_minor, s.currency) }))}\n${methodLabel(s.method)} ${G.dot} ${day(s.paid_on, l)}${s.note ? `\n${quote(esc(s.note))}` : ''}\n\n${i(t('cost.settle_verify'))}`,
    keyboard: [[{ text: t('cost.btn_received'), data: cb('se', 'c', id), style: 'success' }, { text: t('cost.btn_not_received'), data: cb('se', 'r', id) }]],
  };
}

// ---------- statement ----------

export function statementView(s: StatementData, l: CLookup): View {
  const ym = s.month.replace('-', '');
  const totals = s.currencies.map((c) => formatMoney(s.costs.filter((x) => x.currency === c).reduce((a, x) => a + x.amount_minor, 0), c));
  const per = s.perPerson.map((p) => `${G.owner} ${esc(p.name)} ${G.dot} ${t('cost.paid_share', { paid: formatMoney(p.paid, p.currency), share: formatMoney(p.share, p.currency) })}`);
  const tags = s.byTag.filter((x) => x.tag !== 'expense').map((x) => `🏷 ${esc(x.name)} ${G.dot} ${tagLabel(x.tag)} ${formatMoney(x.amount, x.currency)}`);
  return {
    text: [
      `📄 ${b(t('cost.statement_title'))} ${G.dot} ${monthLabel(s.month)}\n${RULE}\n${t('cost.total')} ${b(totals.join(' + ') || formatMoney(0, 'ETB'))} ${i(t('cost.entries_n', { n: s.costs.length, voided: s.voidedCount }))}`,
      s.byProject.length ? s.byProject.map((p) => `${code(p.code)} ${formatMoney(p.amount, p.currency)}`).join(` ${G.dot} `) : '',
      s.byCategory.length ? s.byCategory.slice(0, 6).map((c) => `▤ ${esc(c.name)} ${formatMoney(c.amount, c.currency)}`).join('\n') : '',
      per.join('\n'),
      tags.join('\n'),
      s.converted ? `≈ ${formatMoney(s.converted.total, s.converted.reporting)} ${i(s.converted.rates.map((r) => `1 ${r.currency} = ${formatRate(r.rateMicro)}`).join(', '))}${s.converted.missing.length ? ` ${G.warn} ${t('cost.no_rate_for', { list: s.converted.missing.join(', ') })}` : ''}` : '',
      `⚖ ${t('cost.at_month_end')} ${balanceLines(s.balanceAtEnd, l).join('; ')}`,
    ].filter(Boolean).join('\n\n'),
    keyboard: [[{ text: t('cost.btn_csv'), data: cb('cs', 'csv', ym) }, { text: t('cost.btn_pdf'), data: cb('cs', 'pdf', ym) }], [{ text: t('cost.btn_costs'), data: cb('cd', ym, 'a', '0') }]],
  };
}

// ---------- recurring, categories, budget ----------

export function recurringView(list: RecurringCostRow[], l: CLookup): View {
  const lines = list.map((r, idx) => {
    const rule = describeRecurrence(JSON.parse(r.recurrence));
    const cat = l.categories.find((c) => c.id === r.category_id)?.name ?? '?';
    return `${b(String(idx + 1))}  ${b(formatMoney(r.amount_minor, r.currency))} ${G.dot} ${esc(cat)}${r.note ? ` ${G.dot} ${esc(r.note)}` : ''}${r.active ? '' : ` ${i(t('mtg.paused'))}`}\n      ${esc(rule)} ${G.dot} ${t('cost.next_on', { date: day(r.next_date, l) })} ${G.dot} ${r.action === 'create' ? t('cost.rc_auto') : t('cost.rc_remind')}`;
  });
  return {
    text: `🔁 ${b(t('cost.rc_title'))}\n${RULE}\n${lines.join('\n') || i(t('cost.rc_none'))}\n\n${t('cost.rc_hint')}`,
    keyboard: [
      ...list.map((r, idx) => [
        { text: `${idx + 1}: ${r.active ? t('cost.btn_pause') : t('cost.btn_resume')}`, data: cb('cs', 'rca', enc(r.id), r.active ? '0' : '1') },
        { text: r.action === 'create' ? t('cost.btn_make_remind') : t('cost.btn_make_auto'), data: cb('cs', 'rcm', enc(r.id), r.action === 'create' ? 'remind' : 'create') },
      ]),
      [{ text: t('cost.btn_costs'), data: cb('cd', 'now', 'a', '0') }],
    ],
  };
}

export function categoriesView(cats: (CategoryRow & { aliasList: string[] })[]): View {
  return {
    text: `▤ ${b(t('cost.cats_title'))}\n${RULE}\n${cats.map((c) => `${c.archived_at ? i(esc(c.name)) : esc(c.name)} ${i(c.aliasList.slice(0, 4).join(', '))}`).join('\n')}\n\n${t('cost.cats_hint')}`,
    keyboard: [
      ...grid(cats.map((c) => ({ text: c.archived_at ? `↺ ${c.name}` : `🗄 ${c.name}`, data: cb('cs', 'cata', enc(c.id), c.archived_at ? '0' : '1') })), 2),
      [{ text: t('cost.btn_new_cat'), data: cb('cs', 'catn', '0'), style: 'primary' }],
      [{ text: t('cost.btn_costs'), data: cb('cd', 'now', 'a', '0') }],
    ],
  };
}

