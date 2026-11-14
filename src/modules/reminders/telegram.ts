import type { DateTime } from 'luxon';
import type { App } from '../../app.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { JobHandler } from '../../core/scheduler/runner.js';
import { S_DND_UNTIL, S_FOCUS_UNTIL, S_QUIET_ENABLED, S_QUIET_END, S_QUIET_START } from '../../core/services/availability.js';
import type { Actor } from '../../core/services/context.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import { show } from '../../core/telegram/render.js';
import { atLocal, fmtDateTime, fromDb, toDb } from '../../core/time.js';
import { b, esc, i } from '../../core/ui/html.js';
import { cb, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { extractDue } from '../tasks/quickadd.js';
import { dailyDigest, oneOffView, planDigest, reviewDigest, taskReminderView } from './digests.js';
import {
  JOB, dueKeyOf, recipientsOf, type DigestKind, type DigestPayload, type OverduePayload, type ReminderPayload, type TaskJobPayload,
} from './service.js';
import { S_DATEONLY_TIME, S_DIGEST_DAILY, S_DIGEST_PLAN, S_DIGEST_REVIEW, S_OVERDUE_MAX, S_REMIND_BEFORE, type WeeklySlot } from './settings.js';

const H = 3_600_000;
const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };

// ---------- job handlers ----------

/** When overdue nudges start for a task (must match ReminderPlanner.syncTask). */
async function overdueStart(app: App, owner: Actor, task: { due_at: string | null; due_date: string | null }): Promise<DateTime> {
  if (task.due_at) return fromDb(task.due_at).plus({ hours: 1 });
  const [h, m] = (await app.settings.get(owner.workspaceId, S_DATEONLY_TIME, owner.userId)).split(':').map(Number);
  return atLocal(task.due_date!, h!, m!).plus({ days: 1 });
}

function taskHandlers(app: App, notifier: Notifier): JobHandler[] {
  const remind: JobHandler<TaskJobPayload, View> = {
    kind: JOB.taskRemind,
    maxLateMs: 12 * H,
    nextAfter: () => null,
    async plan(job, p, { now, lateMs }) {
      const found = await app.planner.taskForOwner(job.workspace_id, p.taskId);
      if (!found || found.task.status === 'done' || dueKeyOf(found.task) !== p.dueKey) return { action: 'skip', reason: 'obsolete', next: null };
      const { task, owner } = found;
      const dueAt = task.due_at ? fromDb(task.due_at) : null;
      // "1 hour before" is pointless once the task is due; the at-due reminder covers it.
      if (p.offset > 0 && (!dueAt || dueAt <= now || lateMs > 2 * H)) return { action: 'skip', reason: 'passed', next: null };
      if (p.offset === 0 && now >= (await overdueStart(app, owner, task))) {
        // Late enough that the overdue nudge is due too: send one message (the nudge), not two.
        return { action: 'skip', reason: 'superseded by overdue nudge', next: null };
      }
      const held = await app.availability.blockedUntil(owner.workspaceId, owner.userId, 'nudge', now);
      if (held) {
        if (p.offset > 0 && dueAt && held >= dueAt) return { action: 'skip', reason: 'held past due', next: null };
        return { action: 'skip', reason: 'held', next: held };
      }
      const kind = p.offset > 0 ? { type: 'before' as const, minutes: p.offset } : { type: 'due' as const };
      return { action: 'send', next: null, data: await taskReminderView(app, owner, task, kind, lateMs > 15 * 60_000) };
    },
    async execute(job, _p, plan) {
      return (await notifier.sendNow(job.workspace_id, job.user_id!, plan.data!)) ? 'sent' : 'failed';
    },
  };

  const overdue: JobHandler<OverduePayload, { userId: number; view: View }> = {
    kind: JOB.taskOverdue,
    maxLateMs: 7 * 24 * H,
    nextAfter: () => null,
    async plan(job, p, { now }) {
      const found = await app.planner.taskForOwner(job.workspace_id, p.taskId);
      if (!found || found.task.status === 'done' || dueKeyOf(found.task) !== p.dueKey) return { action: 'skip', reason: 'obsolete', next: null };
      const { task, owner } = found;
      const max = await app.settings.get(owner.workspaceId, S_OVERDUE_MAX, owner.userId);
      if (p.count >= max) return { action: 'skip', reason: 'cap reached', next: null };
      const held = await app.availability.blockedUntil(owner.workspaceId, owner.userId, 'nudge', now);
      if (held) return { action: 'skip', reason: 'held', next: held };
      const n = p.count + 1;
      return {
        action: 'send',
        // Capped: never more than `max` nudges for one due date.
        next: n < max ? now.plus({ hours: 24 }) : null,
        payload: { ...p, count: n },
        data: { userId: owner.userId, view: await taskReminderView(app, owner, task, { type: 'overdue', n, max }, false) },
      };
    },
    async execute(job, _p, plan) {
      return (await notifier.sendNow(job.workspace_id, plan.data!.userId, plan.data!.view)) ? 'sent' : 'failed';
    },
  };
  return [remind, overdue];
}

function digestHandler(app: App, notifier: Notifier, kind: DigestKind, name: string): JobHandler<DigestPayload, View> {
  const build = kind === 'daily' ? dailyDigest : kind === 'plan' ? planDigest : reviewDigest;
  return {
    kind: name,
    maxLateMs: 2 * H,
    nextAfter: (job, p, now) => app.planner.nextDigest(job.workspace_id, p.userId, kind, now),
    async plan(job, p, { now, fireAt }) {
      const actor: Actor = { userId: p.userId, workspaceId: job.workspace_id };
      if (!(await app.permissions.can(actor, 'workspace.view'))) return { action: 'skip', reason: 'not a member', next: null };
      const next = await app.planner.nextDigest(job.workspace_id, p.userId, kind, now);
      const held = await app.availability.blockedUntil(job.workspace_id, p.userId, 'nudge', now);
      if (held) {
        // Hold for a while, but never past the next regular digest.
        if (held.diff(fireAt).as('hours') > 12 || (next && held >= next)) return { action: 'skip', reason: 'held too long', next };
        return { action: 'skip', reason: 'held', next: held };
      }
      return { action: 'send', next, data: await build(app, actor) };
    },
    async execute(job, p, plan) {
      return (await notifier.sendNow(job.workspace_id, p.userId, plan.data!)) ? 'sent' : 'failed';
    },
  };
}

function oneOffHandler(app: App, notifier: Notifier): JobHandler<ReminderPayload, { recipients: number[]; from: string; text: string; at: string; late: boolean }> {
  return {
    kind: JOB.reminder,
    maxLateMs: 7 * 24 * H,
    nextAfter: () => null,
    async plan(job, p, { lateMs }) {
      const r = await app.reminders.get(job.workspace_id, p.reminderId);
      if (!r || r.status !== 'scheduled') return { action: 'skip', reason: 'not scheduled', next: null };
      const members = await app.members.list(job.workspace_id);
      const recipients = recipientsOf(r).filter((id) => members.some((m) => m.user_id === id));
      if (recipients.length === 0) return { action: 'skip', reason: 'no recipients', next: null };
      const from = members.find((m) => m.user_id === r.created_by)?.display_name ?? '?';
      return { action: 'send', next: null, data: { recipients, from, text: r.text, at: r.remind_at, late: lateMs > 15 * 60_000 } };
    },
    async execute(job, p, plan) {
      const d = plan.data!;
      const r = await app.reminders.get(job.workspace_id, p.reminderId);
      let ok = false;
      for (const userId of d.recipients) {
        const view = oneOffView(d.from, d.text, p.reminderId, userId === r?.created_by, d.late, d.at);
        // Each person's quiet hours / DND are respected individually.
        const res = await notifier.deliver(job.workspace_id, userId, view, 'direct');
        ok = ok || res !== 'failed';
      }
      await app.reminders.markSent(job.workspace_id, p.reminderId);
      return ok ? 'sent' : 'failed';
    },
  };
}

// ---------- /remind ----------

async function parseRemind(ctx: MemberCtx, args: string): Promise<{ recipients: number[]; at: DateTime; text: string }> {
  const { app, actor } = ctx;
  const words = args.trim().split(/\s+/);
  const members = await app.members.list(actor.workspaceId);
  let recipients = [actor.userId];
  const who = words[0]?.toLowerCase().replace(/^@/, '');
  if (who === 'me') words.shift();
  else if (who === 'us' || who === 'both') {
    recipients = members.map((m) => m.user_id);
    words.shift();
  } else if (words[0]?.startsWith('@')) {
    const m = who === 'partner' ? members.find((x) => x.user_id !== actor.userId) : members.find((x) => x.handle === who || x.display_name.toLowerCase() === who);
    if (!m) throw new DomainError('task.unknown_person', { value: words[0] });
    recipients = [m.user_id];
    words.shift();
  }
  const rest = words.join(' ').replace(/^to\s+/i, '');
  const { due, rest: text } = extractDue(rest, app.clock.now());
  if (!due) throw new DomainError('rem.usage');
  let at: DateTime;
  if (due.time) {
    const [h, m] = due.time.split(':').map(Number);
    at = atLocal(due.date, h!, m!);
  } else {
    const [h, m] = (await app.settings.get(actor.workspaceId, S_DATEONLY_TIME, actor.userId)).split(':').map(Number);
    at = atLocal(due.date, h!, m!);
  }
  return { recipients, at, text: text.replace(/^\s*(to|that)\s+/i, '') };
}

async function remindersView(ctx: MemberCtx): Promise<View> {
  const { app, actor } = ctx;
  const rows = await app.reminders.upcoming(actor);
  const names = new Map((await app.members.list(actor.workspaceId)).map((m) => [m.user_id, m.display_name]));
  const now = app.clock.now();
  const lines = rows.map((r, idx) => {
    const to = recipientsOf(r);
    const who = to.length > 1 ? t('rem.to_us') : to[0] === actor.userId ? t('rem.to_me') : esc(names.get(to[0]!) ?? '?');
    return `${b(String(idx + 1))}  ${esc(r.text)}\n      ${i(fmtDateTime(fromDb(r.remind_at), now))} ${G.dot} ${who}`;
  });
  return {
    text: `🔔 ${b(t('rem.list_title'))}\n${RULE}\n${lines.join('\n') || i(t('rem.list_empty'))}\n\n${t('rem.list_hint')}`,
    keyboard: [
      ...rows.map((r, idx) => [{ text: t('rem.btn_cancel_n', { n: idx + 1 }), data: cb('rm', 'x', enc(r.id)) }]),
      [menuBtn],
    ],
  };
}

// ---------- /focus ----------

async function focusView(ctx: MemberCtx, banner?: string): Promise<View> {
  const { app, actor } = ctx;
  const p = await app.availability.prefs(actor.workspaceId, actor.userId);
  const now = app.clock.now();
  const active = (iso: string | null) => (iso && fromDb(iso) > now ? fromDb(iso) : null);
  const focus = active(p.focusUntil);
  const dnd = active(p.dndUntil);
  const status = dnd
    ? t('focus.dnd_on', { until: fmtDateTime(dnd, now) })
    : focus ? t('focus.focus_on', { until: fmtDateTime(focus, now) })
    : t('focus.off');
  return {
    text: [
      banner ? `${i(banner)}\n` : '',
      `◎ ${b(t('focus.title'))}`,
      RULE,
      status,
      t('focus.quiet', { range: p.quietEnabled ? `${p.quietStart}–${p.quietEnd}` : t('common.off') }),
      '',
      i(t('focus.explain')),
    ].filter((x) => x !== '').join('\n'),
    keyboard: [
      [
        { text: t('focus.btn_1h'), data: cb('fo', 'f', '60') },
        { text: t('focus.btn_2h'), data: cb('fo', 'f', '120') },
        { text: t('focus.btn_4h'), data: cb('fo', 'f', '240') },
      ],
      [{ text: t('focus.btn_dnd_1h'), data: cb('fo', 'd', '60') }, { text: t('focus.btn_dnd_morning'), data: cb('fo', 'd', 'am') }],
      ...(focus || dnd ? [[{ text: t('focus.btn_off'), data: cb('fo', 'off'), style: 'primary' as const }]] : []),
      [menuBtn],
    ],
  };
}

function untilFrom(app: App, arg: string): DateTime | null {
  const now = app.clock.now();
  if (arg === 'am') {
    const t8 = now.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
    return t8 > now ? t8 : t8.plus({ days: 1 });
  }
  // "90", "90m", "90 min", "2h", "2 hours" (a bare number means minutes)
  const m = /^(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?)?$/i.exec(arg.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mins = m[2] && /^h/i.test(m[2]) ? n * 60 : n;
  if (mins < 1 || mins > 7 * 24 * 60) return null;
  return now.plus({ minutes: mins });
}

// ---------- settings section ----------

const fmtWeekly = (s: WeeklySlot | null) => (s ? `${WEEKDAYS[s.day]} ${s.time}` : t('common.off'));
const fmtBefore = (mins: number[]) =>
  mins.length ? [...mins].sort((a, z) => z - a).map((m) => (m % 1440 === 0 ? t('rem.n_days', { n: m / 1440 }) : m % 60 === 0 ? t('rem.n_hours', { n: m / 60 }) : t('rem.n_min', { n: m }))).join(', ') : t('common.off');

const BEFORE_OPTIONS = [1440, 180, 60, 15];

async function beforeView(ctx: MemberCtx): Promise<View> {
  const cur = await ctx.app.settings.get(ctx.actor.workspaceId, S_REMIND_BEFORE, ctx.actor.userId);
  return {
    text: `${b(t('rs.before_title'))}\n${i(t('rs.before_hint'))}`,
    keyboard: [
      BEFORE_OPTIONS.map((m) => ({
        text: `${cur.includes(m) ? `${G.done} ` : ''}${fmtBefore([m])}`,
        data: cb('rs', 'bt', String(m), cur.includes(m) ? '0' : '1'),
        ...(cur.includes(m) ? { style: 'primary' as const } : {}),
      })),
      [{ text: G.back, data: cb('m', 'settings') }],
    ],
  };
}

// ---------- module ----------

export const remindersModule: TegbarModule = {
  name: 'reminders',
  telegram({ app, reg, notifier }) {
    for (const h of taskHandlers(app, notifier)) reg.job(h);
    reg.job(digestHandler(app, notifier, 'daily', JOB.digestDaily));
    reg.job(digestHandler(app, notifier, 'plan', JOB.digestPlan));
    reg.job(digestHandler(app, notifier, 'review', JOB.digestReview));
    reg.job(oneOffHandler(app, notifier));

    reg.command({
      name: 'remind', group: 'other', description: 'cmd.remind',
      handler: async (ctx, args) => {
        if (!args) return show(ctx, await remindersView(ctx));
        const r = await parseRemind(ctx, args);
        const row = await ctx.app.reminders.create(ctx.actor, r);
        const names = (await ctx.app.members.list(ctx.actor.workspaceId)).filter((m) => r.recipients.includes(m.user_id)).map((m) => m.display_name);
        await show(ctx, {
          text: t('rem.created', { text: row.text, when: fmtDateTime(r.at, ctx.app.clock.now()), who: r.recipients.length > 1 ? t('rem.to_us') : r.recipients[0] === ctx.actor.userId ? t('rem.to_me') : names.join(', ') }),
          keyboard: [[{ text: t('rem.btn_cancel'), data: cb('rm', 'x', enc(row.id)) }, { text: t('rem.btn_list'), data: cb('m', 'remind') }]],
        });
      },
    });
    reg.command({
      name: 'focus', group: 'other', description: 'cmd.focus',
      handler: async (ctx, args) => {
        const a = args.trim().toLowerCase();
        if (!a) return show(ctx, await focusView(ctx));
        if (a === 'off') {
          await ctx.app.settings.setAs(ctx.actor, S_FOCUS_UNTIL, ctx.actor.userId, null);
          await ctx.app.settings.setAs(ctx.actor, S_DND_UNTIL, ctx.actor.userId, null);
          return show(ctx, await focusView(ctx, t('focus.ended')));
        }
        const dnd = a.startsWith('dnd');
        const until = untilFrom(ctx.app, a.replace(/^dnd\s*/, '') || '60');
        if (!until) throw new DomainError('focus.usage');
        await ctx.app.settings.setAs(ctx.actor, dnd ? S_DND_UNTIL : S_FOCUS_UNTIL, ctx.actor.userId, toDb(until));
        await show(ctx, await focusView(ctx));
      },
    });
    reg.command({
      name: 'digest', group: 'other', description: 'cmd.digest',
      handler: async (ctx) => {
        const v = await dailyDigest(ctx.app, ctx.actor);
        v.keyboard = [
          [{ text: t('digest.btn_plan'), data: cb('dg', 'p') }, { text: t('digest.btn_review'), data: cb('dg', 'r') }],
          ...(v.keyboard ?? []),
        ];
        await show(ctx, v);
      },
    });
    reg.menuEntry({ label: 'menu.focus', command: 'focus', order: 70 });
    reg.menuEntry({ label: 'menu.remind', command: 'remind', order: 75 });

    reg.callback('dg', async (ctx, [which], answer) => {
      if (which === 'p') return show(ctx, await planDigest(ctx.app, ctx.actor), 'new');
      if (which === 'r') return show(ctx, await reviewDigest(ctx.app, ctx.actor), 'new');
      return answer(t('common.stale'), true);
    });

    reg.callback('rm', async (ctx, [action, rawId, opt], answer) => {
      const { app, actor } = ctx;
      const id = dec(rawId);
      if (!id) return answer(t('common.stale'), true);
      if (action === 'x') {
        const { changed } = await app.reminders.cancel(actor, id);
        await answer(changed ? t('rem.cancelled') : t('qa.already_handled'));
        return show(ctx, await remindersView(ctx));
      }
      if (action === 'ok') {
        await answer(t('rem.ok'));
        const r = await app.reminders.get(actor.workspaceId, id);
        return show(ctx, { text: `${G.done} ${i(esc(r?.text ?? ''))}` });
      }
      if (action === 'z') {
        if (opt !== '1h' && opt !== 'tom') return answer(t('common.stale'), true);
        const now = app.clock.now();
        const at = opt === 'tom' ? now.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }) : now.plus({ hours: 1 });
        // A personal follow-up; tapping again moves it rather than adding another.
        const r = await app.reminders.snooze(actor, id, at);
        await answer(t('rem.snoozed'));
        return show(ctx, { text: `⏰ ${i(t('rem.snoozed_until', { text: r.text, when: fmtDateTime(at, now) }))}` });
      }
      return answer(t('common.stale'), true);
    });

    reg.callback('fo', async (ctx, [action, arg], answer) => {
      const { app, actor } = ctx;
      if (action === 'off') {
        await app.settings.setAs(actor, S_FOCUS_UNTIL, actor.userId, null);
        await app.settings.setAs(actor, S_DND_UNTIL, actor.userId, null);
        return show(ctx, await focusView(ctx, t('focus.ended')));
      }
      const until = untilFrom(app, arg ?? '');
      if (!until || (action !== 'f' && action !== 'd')) return answer(t('common.stale'), true);
      await app.settings.setAs(actor, action === 'd' ? S_DND_UNTIL : S_FOCUS_UNTIL, actor.userId, toDb(until));
      await answer(t('common.saved'));
      return show(ctx, await focusView(ctx));
    });

    // Settings: digest times, quiet hours, reminder offsets
    reg.settingsSection({
      order: 20,
      render: async (ctx) => {
        const { app, actor } = ctx;
        const g = <T>(d: Parameters<typeof app.settings.get>[1]) => app.settings.get(actor.workspaceId, d, actor.userId) as Promise<T>;
        const daily = await g<string | null>(S_DIGEST_DAILY);
        const quietOn = await g<boolean>(S_QUIET_ENABLED);
        return {
          lines: [
            t('rs.daily', { v: daily ?? t('common.off') }),
            t('rs.plan', { v: fmtWeekly(await g<WeeklySlot | null>(S_DIGEST_PLAN)) }),
            t('rs.review', { v: fmtWeekly(await g<WeeklySlot | null>(S_DIGEST_REVIEW)) }),
            t('rs.quiet', { v: quietOn ? `${await g<string>(S_QUIET_START)}–${await g<string>(S_QUIET_END)}` : t('common.off') }),
            t('rs.before', { v: fmtBefore(await g<number[]>(S_REMIND_BEFORE)) }),
          ],
          buttons: [
            [
              { text: t('rs.btn_daily'), data: cb('rs', 'e', 'daily') },
              { text: t('rs.btn_plan'), data: cb('rs', 'e', 'plan') },
              { text: t('rs.btn_review'), data: cb('rs', 'e', 'review') },
            ],
            [
              { text: t('rs.btn_quiet'), data: cb('rs', 'e', 'quiet') },
              { text: t('rs.btn_before'), data: cb('rs', 'b') },
            ],
          ],
        };
      },
    });

    reg.callback('rs', async (ctx, [action, arg, on], answer) => {
      const { app, actor } = ctx;
      if (action === 'b') return show(ctx, await beforeView(ctx));
      if (action === 'bt') {
        const m = Number(arg);
        if (!BEFORE_OPTIONS.includes(m)) return answer(t('common.stale'), true);
        const cur = await app.settings.get(actor.workspaceId, S_REMIND_BEFORE, actor.userId);
        if (on !== '0' && on !== '1') return answer(t('common.stale'), true);
        const next = on === '1' ? [...new Set([...cur, m])] : cur.filter((x) => x !== m);
        await app.settings.setAs(actor, S_REMIND_BEFORE, actor.userId, next);
        return show(ctx, await beforeView(ctx));
      }
      if (action === 'e' && ['daily', 'plan', 'review', 'quiet'].includes(arg ?? '')) {
        await app.pending.set(actor.workspaceId, actor.userId, 'rs.edit', { what: arg });
        return show(ctx, { text: t(`rs.prompt_${arg as 'daily' | 'plan' | 'review' | 'quiet'}`), keyboard: [[{ text: t('common.cancel'), data: cb('m', 'settings') }]] }, 'new');
      }
      return answer(t('common.stale'), true);
    });

    reg.input('rs.edit', async (ctx, text, p: { what: 'daily' | 'plan' | 'review' | 'quiet' }) => {
      const { app, actor } = ctx;
      const v = text.trim().toLowerCase();
      const off = v === 'off' || v === '-';
      const retry = async (key: 'rs.bad_time' | 'rs.bad_weekly' | 'rs.bad_quiet') => {
        await app.pending.set(actor.workspaceId, actor.userId, 'rs.edit', p);
        throw new DomainError(key);
      };
      const hhmm = (s: string) => {
        const m = /^(\d{1,2})[:.](\d{2})$/.exec(s);
        return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
      };
      if (p.what === 'daily') {
        const time = off ? null : hhmm(v);
        if (!off && !time) return retry('rs.bad_time');
        await app.settings.setAs(actor, S_DIGEST_DAILY, actor.userId, time);
      } else if (p.what === 'quiet') {
        if (off) await app.settings.setAs(actor, S_QUIET_ENABLED, actor.userId, false);
        else {
          const [a, z] = v.split(/\s*[-–to]+\s*/).map(hhmm);
          if (!a || !z || a === z) return retry('rs.bad_quiet');
          await app.settings.setAs(actor, S_QUIET_START, actor.userId, a);
          await app.settings.setAs(actor, S_QUIET_END, actor.userId, z);
          await app.settings.setAs(actor, S_QUIET_ENABLED, actor.userId, true);
        }
      } else {
        let slot: WeeklySlot | null = null;
        if (!off) {
          const m = /^([a-z]{3})[a-z]*\s+(\S+)$/.exec(v);
          const day = m ? WEEKDAYS.findIndex((d) => d.toLowerCase() === m[1]) : -1;
          const time = m ? hhmm(m[2]!) : null;
          if (day < 1 || !time) return retry('rs.bad_weekly');
          slot = { day, time };
        }
        await app.settings.setAs(actor, p.what === 'plan' ? S_DIGEST_PLAN : S_DIGEST_REVIEW, actor.userId, slot);
      }
      const def = reg.commands.get('settings');
      if (def) await def.handler(ctx, '');
    });
  },
};
