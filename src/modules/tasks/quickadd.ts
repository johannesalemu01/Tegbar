import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { Priority } from './schema.js';
import { firstOnOrAfter, matches, parseRecurrence, withAnchor, type Recurrence } from './recurrence.js';

/**
 * Pure quick-add parser. No database, no Telegram — fully unit-tested.
 *
 *   "Call MMCY tomorrow 10am @sami !high #ridehome #sales"
 *
 *  @handle   owner (also @me, @partner)
 *  !level    priority: !high !h !low !l !normal !n
 *  #tag      project code first, then an area of the chosen project
 *  dates     ISO "2026-11-20 15:00" or natural English ("friday 5pm", "in 2 days")
 */

export interface QuickAddMember {
  userId: number;
  handles: string[]; // lower-case, without '@'
}
export interface QuickAddProject {
  id: number;
  code: string; // upper-case
}
export interface QuickAddArea {
  id: number;
  slug: string;
}
export interface QuickAddContext {
  now: DateTime; // in the workspace zone
  meUserId: number;
  members: QuickAddMember[];
  projects: QuickAddProject[];
  areasByProject: Map<number, QuickAddArea[]>;
  defaultProjectId: number;
}

export type Issue =
  | { kind: 'unknown_owner'; value: string }
  | { kind: 'unknown_tag'; value: string }
  | { kind: 'unknown_priority'; value: string }
  | { kind: 'multiple_projects' }
  | { kind: 'multiple_dates' }
  | { kind: 'vague_date'; value: string }
  | { kind: 'past_date' }
  | { kind: 'empty_title' };

export interface Due {
  date: string; // YYYY-MM-DD (workspace zone)
  time: string | null; // HH:mm or null for date-only
}

export interface QuickAddResult {
  title: string;
  ownerUserId: number;
  priority: Priority;
  projectId: number;
  areaId: number | null;
  due: Due | null;
  recurrence: Recurrence | null;
  issues: Issue[];
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  high: 'high', h: 'high', hi: 'high', urgent: 'high', '!': 'high',
  normal: 'normal', n: 'normal', med: 'normal', medium: 'normal',
  low: 'low', l: 'low', lo: 'low',
};

const TOKEN = /(^|\s)([@!#])([\p{L}\p{N}_\-!]*)(?=\s|$)/gu;

export function parseQuickAdd(input: string, ctx: QuickAddContext): QuickAddResult {
  const issues: Issue[] = [];
  let ownerUserId = ctx.meUserId;
  let ownerSet = false;
  let priority: Priority = 'normal';
  const projectTags: QuickAddProject[] = [];
  const otherTags: string[] = [];
  const keptTokens: string[] = [];

  // 1. Pull out @owner, !priority and #tags.
  let rest = input.normalize('NFC').replace(TOKEN, (_m, lead: string, sigil: string, word: string) => {
    const w = word.toLowerCase();
    if (!w) return `${lead}${sigil}`;
    if (sigil === '@') {
      const id = resolveOwner(w, ctx);
      if (id === null) issues.push({ kind: 'unknown_owner', value: word });
      else if (!ownerSet) {
        ownerUserId = id;
        ownerSet = true;
      }
      return lead;
    }
    if (sigil === '!') {
      const p = PRIORITY_ALIASES[w];
      if (p) priority = p;
      else issues.push({ kind: 'unknown_priority', value: word });
      return lead;
    }
    const project = ctx.projects.find((p) => p.code.toLowerCase() === w);
    if (project) projectTags.push(project);
    else otherTags.push(w);
    return lead;
  });

  // 2. Project then area.
  if (projectTags.length > 1 && new Set(projectTags.map((p) => p.id)).size > 1) issues.push({ kind: 'multiple_projects' });
  const projectId = projectTags[0]?.id ?? ctx.defaultProjectId;
  const areas = ctx.areasByProject.get(projectId) ?? [];
  let areaId: number | null = null;
  for (const tag of otherTags) {
    const area = areas.find((a) => a.slug === tag) ?? areas.find((a) => a.slug.startsWith(tag) && tag.length >= 3);
    if (area && areaId === null) areaId = area.id;
    else if (!area) {
      issues.push({ kind: 'unknown_tag', value: tag });
      keptTokens.push(`#${tag}`);
    }
  }

  // 3. Recurrence ("every monday", "monthly on the 1st") — removed before date parsing.
  const recFound = parseRecurrence(rest, ctx.now.weekday);
  if (recFound) rest = rest.replace(recFound.match, ' ');

  // 4. Dates.
  const dueParse = extractDue(rest, ctx.now);
  rest = dueParse.rest;
  issues.push(...dueParse.issues);
  let due = dueParse.due;
  let recurrence: Recurrence | null = null;
  if (recFound) {
    const today = ctx.now.toFormat('yyyy-MM-dd');
    // plain "weekly" repeats on the due date's weekday
    const dueWeekday = due ? DateTimeFromDate(due.date).weekday : ctx.now.weekday;
    const rule = parseRecurrence(recFound.match, dueWeekday)!.rule;
    const start = due?.date ?? today;
    const probe = withAnchor(rule, start);
    const first = matches(probe, start) ? start : firstOnOrAfter(probe, start);
    recurrence = withAnchor(rule, first);
    due = { date: first, time: due?.time ?? null };
    // a date that only existed to anchor the rule is not "in the past"
    if (first >= today) {
      const i = issues.findIndex((x) => x.kind === 'past_date');
      if (i >= 0) issues.splice(i, 1);
    }
  }

  // 5. Title.
  let title = `${rest} ${keptTokens.join(' ')}`.replace(/\s+/g, ' ').trim();
  title = title.replace(/^[,;:\-–—\s]+|[,;:\-–—\s]+$/g, '').trim();
  if (!title) issues.push({ kind: 'empty_title' });
  if (title.length > 200) title = `${title.slice(0, 199)}…`;

  return { title, ownerUserId, priority, projectId, areaId, due, recurrence, issues };
}

function DateTimeFromDate(date: string) {
  return DateTime.fromISO(date, { zone: 'utc' });
}

function resolveOwner(handle: string, ctx: QuickAddContext): number | null {
  if (handle === 'me') return ctx.meUserId;
  if (handle === 'partner' || handle === 'friend' || handle === 'other') {
    const others = ctx.members.filter((m) => m.userId !== ctx.meUserId);
    return others.length === 1 ? others[0]!.userId : null;
  }
  const hit = ctx.members.find((m) => m.handles.includes(handle));
  return hit?.userId ?? null;
}

/**
 * A few Amharic relative-day words, mapped to English before chrono runs.
 * Whole words only. Best effort; extend as you see real usage.
 */
const AMHARIC_DAYS: [RegExp, string][] = [
  [/(^|\s)ከነገ\s+ወዲያ(?=\s|$)/gu, '$1in 2 days'],
  [/(^|\s)ዛሬ(?=\s|$)/gu, '$1today'],
  [/(^|\s)ነገ(?=\s|$)/gu, '$1tomorrow'],
];

const ISO = /(?:^|\s)(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?(?=\s|$)/;

/**
 * Finds one due date in free text. Exported for "/due T12 friday 5pm" and the
 * edit-due flow. Returns the text with the date phrase removed.
 */
export function extractDue(text: string, now: DateTime): { due: Due | null; rest: string; issues: Issue[] } {
  const issues: Issue[] = [];
  const iso = ISO.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    const date = `${y}-${mo}-${d}`;
    const valid = now.set({ year: Number(y), month: Number(mo), day: Number(d) }).toFormat('yyyy-MM-dd') === date;
    if (valid && (h === undefined || (Number(h) < 24 && Number(mi) < 60))) {
      const time = h !== undefined ? `${h.padStart(2, '0')}:${mi}` : null;
      const due = { date, time };
      if (isPast(due, now)) issues.push({ kind: 'past_date' });
      const idx = text.indexOf(iso[0]);
      const before = text.slice(0, idx).replace(/(^|\s)(on|by|due|before|until)\s*$/i, '$1');
      return { due, rest: `${before} ${text.slice(idx + iso[0].length)}`, issues };
    }
  }

  // chrono reads relative phrases against the *system* local clock, so give it
  // a Date whose local wall-clock equals the workspace wall-clock, then read
  // the components back. This keeps parsing independent of the server TZ.
  const ref = new Date(now.year, now.month - 1, now.day, now.hour, now.minute, now.second);
  // Amharic day words become English first. (If one also appears outside the
  // date phrase it stays translated in the title — rare and harmless.)
  let source = text;
  for (const [re, rep] of AMHARIC_DAYS) source = source.replace(re, rep);
  const results = chrono.parse(source, ref, { forwardDate: true });
  const r = results[0];
  if (!r) return { due: null, rest: text, issues };
  if (results.length > 1) issues.push({ kind: 'multiple_dates' });
  const parsed = extractDueResult(r, now);
  issues.push(...parsed.issues);
  // Drop a preposition left dangling by the date phrase: "deck in december" → "deck".
  const before = source.slice(0, r.index).replace(/(^|\s)(in|on|at|by|due|before|until|for)\s*$/i, '$1');
  const rest = before + ' ' + source.slice(r.index + r.text.length);
  return { due: parsed.due, rest, issues };
}

function extractDueResult(r: chrono.ParsedResult, now: DateTime): { due: Due; issues: Issue[] } {
  const issues: Issue[] = [];
  const s = r.start;
  if (!s.isCertain('day') && !s.isCertain('weekday') && !s.isCertain('hour')) {
    issues.push({ kind: 'vague_date', value: r.text.trim() });
  }
  const pad = (n: number | null) => String(n ?? 0).padStart(2, '0');
  const date = `${s.get('year')}-${pad(s.get('month'))}-${pad(s.get('day'))}`;
  const time = s.isCertain('hour') ? `${pad(s.get('hour'))}:${pad(s.get('minute'))}` : null;
  const due = { date, time };
  if (isPast(due, now)) issues.push({ kind: 'past_date' });
  return { due, issues };
}

function isPast(due: Due, now: DateTime): boolean {
  const today = now.toFormat('yyyy-MM-dd');
  if (due.date < today) return true;
  if (due.date === today && due.time && due.time < now.toFormat('HH:mm')) return true;
  return false;
}

export function isAmbiguous(r: QuickAddResult): boolean {
  return r.issues.length > 0;
}
