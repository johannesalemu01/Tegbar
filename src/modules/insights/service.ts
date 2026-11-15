import { DateTime } from 'luxon';
import type { Generated, Kysely, Selectable } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { App } from '../../app.js';
import type { Db } from '../../core/db/database.js';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';
import { DomainError, NotFoundError } from '../../core/errors.js';
import { defineFlag } from '../../core/services/flags.js';
import type { Actor } from '../../core/services/context.js';
import { fromDb, getZone, localDate, toDb } from '../../core/time.js';
import type { TaskView } from '../tasks/service.js';
import { meetingStreak, priorityCandidates, rebalanceHint, topPriorities, weekOf, type PriorityCandidate, type WeekRecord } from './logic.js';

export const FLAG_BRIEF = defineFlag('brief', false, 'Friday founder brief (replaces “Week in review”)');
export const FLAG_WORKLOAD = defineFlag('workload', false, 'Workload view per person and project, with facts-only hints');
export const FLAG_WINS = defineFlag('wins', false, 'Wins log and meeting streak');

export interface WinsTable {
  id: Generated<number>;
  workspace_id: number;
  project_id: number | null;
  text: string;
  created_by: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export type WinRow = Selectable<WinsTable>;
declare module '../../core/db/schema.js' {
  interface DB {
    wins: WinsTable;
  }
}

export const insightMigrations: Record<string, Migration> = {
  '202611151000_insights_wins': {
    async up(db: Kysely<any>) {
      await withStamps(withWorkspace(withId(db.schema.createTable('wins')))
        .addColumn('project_id', 'integer', (c) => c.references('projects.id').onDelete('set null'))
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('deleted_at', 'text')).execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('wins').ifExists().execute();
    },
  },
};

export const WIN_NOTIFY = 'win.notify';

export interface BriefData {
  weekStart: string;
  today: string;
  done: TaskView[];
  doneByPerson: { userId: number; name: string; count: number }[];
  stuck: TaskView[];
  meetingsNext: Awaited<ReturnType<App['meetings']['upcoming']>>;
  dueNextWeek: number;
  money: {
    weekTotals: { currency: string; amount: number }[];
    monthTotals: { currency: string; amount: number }[];
    budgets: { code: string; pct: number; spent: number; budget: number; currency: string }[];
    renewals: { amount: number; currency: string; note: string; date: string }[];
    balance: Awaited<ReturnType<App['costs']['balances']>>;
  };
  wins: WinRow[] | null; // null when the wins feature is off
  streak: number | null;
  priorities: PriorityCandidate[];
}

export interface WorkloadData {
  weeks: string[]; // Mondays, oldest first
  people: { userId: number; name: string; open: number; overdue: number; doneByWeek: number[]; openByProject: { code: string; count: number }[] }[];
  hint: ReturnType<typeof rebalanceHint>;
}

/**
 * Reads across modules through their services (each call is permission-checked
 * for the actor), so a brief only ever contains what that person may see.
 */
export class InsightService {
  constructor(private readonly app: App) {}
  private get db(): Db {
    return this.app.db;
  }

  // ---------- wins ----------

  async addWin(actor: Actor, text: string, projectId: number | null): Promise<WinRow> {
    await this.app.permissions.authorize(actor, 'note.create', { projectId });
    const clean = text.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 300) throw new DomainError('win.bad_text');
    const now = this.app.clock.now();
    const row = await this.db.insertInto('wins').values({
      workspace_id: actor.workspaceId, project_id: projectId, text: clean, created_by: actor.userId, deleted_at: null, created_at: toDb(now), updated_at: toDb(now),
    }).returningAll().executeTakeFirstOrThrow();
    await this.app.events.record(this.db, { workspaceId: actor.workspaceId, projectId, actorUserId: actor.userId, entityType: 'win', entityId: row.id, action: 'win.logged' });
    await this.app.jobs.upsert(actor.workspaceId, `win:${row.id}`, { kind: WIN_NOTIFY, payload: { winId: row.id }, at: now });
    return row;
  }

  async wins(actor: Actor, sinceIso: string | null = null, limit = 30): Promise<WinRow[]> {
    await this.app.permissions.authorize(actor, 'workspace.view');
    const visible = await this.app.permissions.visibleProjectIds(actor);
    let q = this.db.selectFrom('wins').selectAll().where('workspace_id', '=', actor.workspaceId).where('deleted_at', 'is', null);
    if (sinceIso) q = q.where('created_at', '>=', sinceIso);
    return (await q.orderBy('id', 'desc').limit(limit).execute()).filter((w) => w.project_id === null || visible.includes(w.project_id));
  }

  async winById(workspaceId: number, id: number): Promise<WinRow | undefined> {
    return this.db.selectFrom('wins').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
  }

  async deleteWin(actor: Actor, id: number): Promise<{ changed: boolean }> {
    const w = await this.winById(actor.workspaceId, id);
    if (!w) throw new NotFoundError();
    if (w.created_by !== actor.userId) await this.app.permissions.authorize(actor, 'workspace.manage');
    if (w.deleted_at) return { changed: false };
    await this.db.updateTable('wins').set({ deleted_at: toDb(this.app.clock.now()), updated_at: toDb(this.app.clock.now()) }).where('id', '=', id).execute();
    return { changed: true };
  }

  // ---------- meeting streak ----------

  async weekRecords(actor: Actor, weeks = 26): Promise<WeekRecord[]> {
    const { items } = await this.app.meetings.history(actor, 0, weeks * 4);
    const by = new Map<string, WeekRecord>();
    for (const m of items) {
      const week = weekOf(localDate(m.start));
      const r = by.get(week) ?? { week, held: 0, missed: 0 };
      if (m.status === 'done') r.held++;
      else if (m.status === 'scheduled' || m.status === 'live') r.missed++; // past and never ended
      by.set(week, r);
    }
    return [...by.values()];
  }

  async streak(actor: Actor): Promise<number> {
    return meetingStreak(await this.weekRecords(actor), weekOf(localDate(this.app.clock.now())));
  }

  // ---------- brief ----------

  private async allOpen(actor: Actor): Promise<TaskView[]> {
    return (await this.app.tasks.list(actor, { owner: 'all', projectId: null, status: 'open', due: 'any' }, 0, 1000)).items;
  }

  async brief(actor: Actor): Promise<BriefData> {
    const { app } = this;
    const now = app.clock.now();
    const today = localDate(now);
    const weekStart = weekOf(today);
    const weekStartIso = toDb(fromDbLocalStart(weekStart));
    const members = await app.members.list(actor.workspaceId);

    const done = (await app.tasks.list(actor, { owner: 'all', projectId: null, status: 'done', due: 'any', completedSince: weekStartIso }, 0, 500)).items;
    const open = await this.allOpen(actor);
    const stuck = open.filter((t) => t.status === 'blocked' || (t.due_date !== null && t.due_date <= addDays(today, -3) && !t.due_at) || (t.due_at !== null && t.due_at <= toDb(now.minus({ days: 3 }))));
    const nextWeekEnd = addDays(today, 7);
    const meetingsNext = (await app.meetings.upcoming(actor, 10)).filter((m) => m.status !== 'skipped' && localDate(m.start) <= nextWeekEnd);
    const dueNextWeek = open.filter((t) => t.due_date !== null && t.due_date > today && t.due_date <= nextWeekEnd).length;

    // money
    const month = today.slice(0, 7);
    const st = await app.costs.statement(actor, month);
    const prevSt = weekStart.slice(0, 7) !== month ? await app.costs.statement(actor, weekStart.slice(0, 7)) : null;
    const weekCosts = [...st.costs, ...(prevSt?.costs ?? [])].filter((c) => c.spent_on >= weekStart);
    const totals = (cs: { currency: string; amount_minor: number }[]) => {
      const m = new Map<string, number>();
      for (const c of cs) m.set(c.currency, (m.get(c.currency) ?? 0) + c.amount_minor);
      return [...m].map(([currency, amount]) => ({ currency, amount }));
    };
    const budgets = [];
    for (const p of await app.projects.list(actor)) {
      const b = await app.costs.budgetStatus(actor.workspaceId, p.id, month);
      if (b) budgets.push({ code: p.code, pct: b.pct, spent: b.spent, budget: b.budget.amount_minor, currency: b.budget.currency });
    }
    const renewals = (await app.costs.recurringList(actor))
      .filter((r) => r.active && r.next_date >= today && r.next_date <= nextWeekEnd)
      .map((r) => ({ amount: r.amount_minor, currency: r.currency, note: r.note, date: r.next_date }));

    const winsOn = await app.flags.isEnabled(actor.workspaceId, FLAG_WINS);
    const decisions = (await app.decisions.list(actor, { status: 'proposed' }, 0, 50)).items;
    const approvals = (await app.approvals.pending(actor)).filter((a) => a.requested_by !== actor.userId);

    const priorities = topPriorities(priorityCandidates({
      today,
      tasks: open.map((t) => ({
        id: t.id, title: t.title, status: t.status as 'todo' | 'doing' | 'blocked', priority: t.priority, dueDate: t.due_date,
        overdue: t.due_at ? t.due_at < toDb(now) : t.due_date !== null && t.due_date < today, ownerName: t.owner_name,
      })),
      decisions: decisions.map((d) => ({ id: d.id, title: d.title, createdOn: localDate(fromDb(d.created_at)) })),
      budgets: budgets.map((b) => ({ code: b.code, pct: b.pct })),
      approvals: approvals.map((a) => ({ id: a.id, summary: a.summary })),
    }));

    return {
      weekStart, today, done, stuck, meetingsNext, dueNextWeek, priorities,
      doneByPerson: members.map((m) => ({ userId: m.user_id, name: m.display_name, count: done.filter((t) => t.owner_user_id === m.user_id).length })),
      money: { weekTotals: totals(weekCosts), monthTotals: totals(st.costs), budgets, renewals, balance: await app.costs.balances(actor, null) },
      wins: winsOn ? await this.wins(actor, weekStartIso) : null,
      streak: winsOn ? await this.streak(actor) : null,
    };
  }

  // ---------- workload ----------

  async workload(actor: Actor, weeksBack = 4): Promise<WorkloadData> {
    const { app } = this;
    const now = app.clock.now();
    const today = localDate(now);
    const weeks = Array.from({ length: weeksBack }, (_, i) => addDays(weekOf(today), -7 * (weeksBack - 1 - i)));
    const since = toDb(fromDbLocalStart(weeks[0]!));
    const [members, open, done] = await Promise.all([
      app.members.list(actor.workspaceId),
      this.allOpen(actor),
      app.tasks.list(actor, { owner: 'all', projectId: null, status: 'done', due: 'any', completedSince: since }, 0, 5000),
    ]);
    const areaOwners = new Map<number, number | null>();
    for (const p of await app.projects.list(actor)) for (const a of await app.projects.areas(actor, p.id)) areaOwners.set(a.id, a.owner_user_id);

    const people = members.map((m) => {
      const mine = open.filter((t) => t.owner_user_id === m.user_id);
      const byProject = new Map<string, number>();
      for (const t of mine) byProject.set(t.project_code, (byProject.get(t.project_code) ?? 0) + 1);
      return {
        userId: m.user_id,
        name: m.display_name,
        open: mine.length,
        overdue: mine.filter((t) => (t.due_at ? t.due_at < toDb(now) : t.due_date !== null && t.due_date < today)).length,
        doneByWeek: weeks.map((w) => done.items.filter((t) => t.owner_user_id === m.user_id && t.completed_at && weekOf(localDate(fromDb(t.completed_at))) === w).length),
        openByProject: [...byProject].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      };
    });
    const hint = rebalanceHint(
      people.map((p) => ({ userId: p.userId, name: p.name, open: p.open })),
      open.map((t) => ({ id: t.id, title: t.title, ownerUserId: t.owner_user_id, areaOwnerUserId: t.area_id ? (areaOwners.get(t.area_id) ?? null) : null })),
    );
    return { weeks, people, hint };
  }
}

function fromDbLocalStart(day: string) {
  return DateTime.fromISO(day, { zone: getZone() }).startOf('day');
}
function addDays(day: string, n: number): string {
  return DateTime.fromISO(day, { zone: 'utc' }).plus({ days: n }).toFormat('yyyy-MM-dd');
}
