import type { DateTime } from 'luxon';
import { extractDue } from '../tasks/quickadd.js';
import { parseAmount, parseRate } from './money.js';

/**
 * Pure parser for "/spend 1500 ETB hosting #ridehome paid-by me telebirr".
 *
 *   amount     first number (1,500 / 1500.50)
 *   currency   ETB | birr | br | other ISO code (only if allowed)
 *   #code      project
 *   category   first word that matches a category slug, name or alias
 *   paid-by X  me | @handle | partner   (also "paid by")
 *   method     cash | bank | telebirr | card
 *   tag        capital | loan  (default: company expense)
 *   split      only-mine / mine | equal / 50-50
 *   date       2026-11-10 | yesterday | friday …  (default today)
 *   rate 125.5 / @125.5   per-entry exchange rate (non-reporting currency)
 *   rest       note
 */
export type Method = 'cash' | 'bank' | 'telebirr' | 'card' | 'other';
export type FounderTag = 'expense' | 'capital' | 'loan';
export type SplitMode = 'rule' | 'mine' | 'equal';
export const METHODS: readonly Method[] = ['cash', 'bank', 'telebirr', 'card', 'other'];
export const TAGS: readonly FounderTag[] = ['expense', 'capital', 'loan'];
export const SPLITS: readonly SplitMode[] = ['rule', 'equal', 'mine'];

export interface SpendContext {
  now: DateTime;
  meUserId: number;
  members: { userId: number; handles: string[] }[];
  projects: { id: number; code: string }[];
  categories: { id: number; slug: string; name: string; aliases: string[] }[];
  allowedCurrencies: string[];
  defaultCurrency: string;
}

export type SpendIssue =
  | { kind: 'no_amount' }
  | { kind: 'bad_amount'; value: string }
  | { kind: 'currency_not_allowed'; value: string }
  | { kind: 'unknown_person'; value: string }
  | { kind: 'unknown_project'; value: string }
  | { kind: 'no_category' }
  | { kind: 'future_date' };

export interface SpendDraft {
  amount: number | null;
  currency: string;
  projectId: number | null;
  categoryId: number | null;
  paidBy: number;
  method: Method;
  tag: FounderTag;
  split: SplitMode;
  date: string;
  rateMicro: number | null;
  note: string;
  issues: SpendIssue[];
}

const KNOWN_CODES = ['etb', 'usd', 'eur', 'gbp', 'kes', 'aed', 'cny', 'jpy'];
const CURRENCY_WORDS: Record<string, string> = { etb: 'ETB', birr: 'ETB', br: 'ETB', usd: 'USD', $: 'USD', eur: 'EUR', '€': 'EUR' };

export function parseSpend(input: string, ctx: SpendContext): SpendDraft {
  const issues: SpendIssue[] = [];
  let text = ` ${input.normalize('NFC')} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(text);
    if (m) text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
    return m;
  };

  // paid-by first (its argument must not be mistaken for anything else)
  let paidBy = ctx.meUserId;
  const pb = take(/\spaid[- ]by\s+@?([\p{L}\p{N}_]+)(?=\s)/iu);
  if (pb) {
    const who = pb[1]!.toLowerCase();
    const others = ctx.members.filter((m) => m.userId !== ctx.meUserId);
    const id = who === 'me' ? ctx.meUserId
      : ['partner', 'friend', 'other'].includes(who) && others.length === 1 ? others[0]!.userId
      : ctx.members.find((m) => m.handles.includes(who))?.userId;
    if (id === undefined) issues.push({ kind: 'unknown_person', value: pb[1]! });
    else paidBy = id;
  }

  const rateM = take(/\s(?:rate\s+|@)(\d[\d,]*(?:\.\d+)?)(?=\s)/i);
  const rateMicro = rateM ? parseRate(rateM[1]!) : null;

  // amount (+ optional attached or following currency)
  let amount: number | null = null;
  let currency = ctx.defaultCurrency;
  // Only known currency words/codes count — "400 sms" is SMS the category, not a currency.
  const codes = [...new Set([...Object.keys(CURRENCY_WORDS).filter((k) => /^[a-z]+$/.test(k)), ...KNOWN_CODES, ...ctx.allowedCurrencies.map((c) => c.toLowerCase())])];
  const am = take(new RegExp(`\\s(\\$|€)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${codes.join('|')})?(?=\\s)`, 'i'));
  if (!am) issues.push({ kind: 'no_amount' });
  else {
    const curWord = (am[1] ?? am[3] ?? '').toLowerCase();
    if (curWord) currency = CURRENCY_WORDS[curWord] ?? curWord.toUpperCase();
    amount = parseAmount(am[2]!, currency);
    if (amount === null) issues.push({ kind: 'bad_amount', value: am[2]! });
  }
  if (!ctx.allowedCurrencies.includes(currency)) issues.push({ kind: 'currency_not_allowed', value: currency });

  let projectId: number | null = null;
  const pj = take(/\s#([\p{L}\p{N}_]+)(?=\s)/u);
  if (pj) {
    const p = ctx.projects.find((x) => x.code.toLowerCase() === pj[1]!.toLowerCase());
    if (p) projectId = p.id;
    else issues.push({ kind: 'unknown_project', value: pj[1]! });
  }

  const method = (take(/\s(cash|bank|telebirr|card)(?=\s)/i)?.[1]?.toLowerCase() as Method | undefined) ?? 'bank';
  const tagM = take(/\s(capital|loan)(?=\s)/i);
  const tag: FounderTag = (tagM?.[1]?.toLowerCase() as FounderTag | undefined) ?? 'expense';
  const split: SplitMode = take(/\s(only[- ]mine|mine[- ]only|only[- ]me)(?=\s)/i) ? 'mine' : take(/\s(equal|50[-/]50)(?=\s)/i) ? 'equal' : 'rule';

  // date (date only); default today
  let date = ctx.now.toFormat('yyyy-MM-dd');
  const due = extractDue(text, ctx.now);
  // A bare month ("for November") is part of the note, not the date of the spend.
  if (due.due && !due.issues.some((x) => x.kind === 'vague_date')) {
    // extractDue moves weekdays forward; a spend is in the past, so step back a week if needed
    // A weekday name ("friday") is read forward by the date parser; a spend is in the past.
    const explicit = /\d{4}-\d{2}-\d{2}/.test(text);
    date = !explicit && due.due.date > date ? shiftBackWeek(due.due.date) : due.due.date;
    text = due.rest;
    if (date > ctx.now.toFormat('yyyy-MM-dd')) issues.push({ kind: 'future_date' });
  }

  // category: first matching word
  let categoryId: number | null = null;
  const words = text.split(/\s+/).filter(Boolean);
  const used = new Set<number>();
  for (const [idx, w] of words.entries()) {
    const lw = w.toLowerCase().replace(/[.,;:]$/, '');
    const c = ctx.categories.find((x) => x.slug === lw || x.aliases.includes(lw) || x.name.toLowerCase() === lw);
    if (c) {
      categoryId = c.id;
      used.add(idx);
      break;
    }
  }
  if (categoryId === null) issues.push({ kind: 'no_category' });

  const note = words.filter((_, i) => !used.has(i)).join(' ').replace(/^(for|on)\s+/i, '').trim().slice(0, 300);
  return { amount, currency, projectId, categoryId, paidBy, method, tag, split, date, rateMicro, note, issues };
}

function shiftBackWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! - 7));
  return t.toISOString().slice(0, 10);
}
