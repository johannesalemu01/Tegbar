import type { App } from '../../app.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { Actor } from '../../core/services/context.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { memberNames, projectOverride } from '../../core/telegram/helpers.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import { show } from '../../core/telegram/render.js';
import { fmtDay, fmtTime, fromDb as fromIso, fromLocalDate, localDate } from '../../core/time.js';
import { b, code, esc, i } from '../../core/ui/html.js';
import { cb, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { formatMoney } from '../costs/money.js';
import { balanceLines } from '../costs/views.js';
import { MODE_GLYPH } from '../meetings/views.js';
import { FLAG_BRIEF, FLAG_WINS, FLAG_WORKLOAD, WIN_NOTIFY, type BriefData, type WorkloadData } from './service.js';

const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };
const BARS = '▁▂▃▄▅▆▇█';

async function requireFlag(ctx: MemberCtx, flag: string): Promise<boolean> {
  if (await ctx.app.flags.isEnabled(ctx.actor.workspaceId, flag)) return true;
  await show(ctx, { text: t('features.off', { key: flag }) });
  return false;
}

function range(weekStart: string, today: string): string {
  const s = fromLocalDate(weekStart);
  const e = fromLocalDate(today);
  return s.month === e.month ? `${s.toFormat('d')}–${e.toFormat('d LLL')}` : `${s.toFormat('d LLL')} – ${e.toFormat('d LLL')}`;
}

export function briefView(d: BriefData, names: Map<number, string>, now: import('luxon').DateTime): View {
  const money = (xs: { currency: string; amount: number }[]) => xs.map((x) => formatMoney(x.amount, x.currency)).join(' + ') || formatMoney(0, 'ETB');
  const sections: string[] = [];

  const doneTop = [...d.done].sort((a, z) => (a.priority === 'high' ? 0 : 1) - (z.priority === 'high' ? 0 : 1)).slice(0, 5);
  sections.push(
    `${b(t('brief.done', { n: d.done.length }))} ${i(d.doneByPerson.map((p) => `${esc(p.name)} ${p.count}`).join(' · '))}` +
      (doneTop.length ? `\n${doneTop.map((x) => `   ${G.done} ${esc(x.title)}`).join('\n')}${d.done.length > doneTop.length ? `\n   ${i(t('digest.more', { n: d.done.length - doneTop.length }))}` : ''}` : `\n   ${i(t('brief.nothing_done'))}`),
  );
  if (d.stuck.length) {
    sections.push(`${b(t('brief.stuck', { n: d.stuck.length }))}\n${d.stuck.slice(0, 5).map((x) => `   ${x.status === 'blocked' ? G.blocked : '⚑'} ${esc(x.title)} ${i(`· ${esc(x.owner_name ?? t('task.unassigned'))}`)}`).join('\n')}`);
  }
  sections.push(
    `${b(t('brief.next_week'))}\n${d.meetingsNext.map((m) => `   ${MODE_GLYPH[m.mode]} ${esc(m.title)} ${i(`· ${fmtDay(localDate(m.start), now)} ${fmtTime(m.start)}${m.hostName ? ` · ${t('mtg.host', { name: m.hostName })}` : ''}`)}`).join('\n') || `   ${i(t('brief.no_meetings'))}`}` +
      `\n   ${t('brief.due_next_week', { n: d.dueNextWeek })}`,
  );
  const m = d.money;
  sections.push(
    `${b(t('brief.money'))}\n   ${t('brief.spent', { week: money(m.weekTotals), month: money(m.monthTotals) })}` +
      m.budgets.map((x) => `\n   🎯 ${code(x.code)} ${t('brief.budget', { pct: x.pct, spent: formatMoney(x.spent, x.currency), budget: formatMoney(x.budget, x.currency) })}`).join('') +
      m.renewals.map((x) => `\n   🔁 ${esc(x.note || '—')} ${formatMoney(x.amount, x.currency)} ${i(`· ${fmtDay(x.date, now)}`)}`).join('') +
      `\n   ⚖ ${balanceLines(m.balance, { now, meUserId: 0, names, projects: [], categories: [] }).join('; ')}`,
  );
  if (d.wins) {
    sections.push(`${b(t('brief.wins', { n: d.wins.length }))}${d.wins.length ? `\n${d.wins.slice(0, 5).map((w) => `   🏆 ${esc(w.text)}`).join('\n')}` : ` ${i(t('brief.no_wins'))}`}${d.streak !== null ? `\n   🔥 ${t('brief.streak', { n: d.streak })}` : ''}`);
  }
  sections.push(
    `${b(t('brief.priorities'))}\n${d.priorities.map((p, k) => `   ${b(String(k + 1))}. ${esc(p.text)} ${i(`— ${esc(p.reason)}`)}`).join('\n') || `   ${i(t('brief.no_priorities'))}`}`,
  );
  return {
    text: `🗞 ${b(t('brief.title'))}  ${i(range(d.weekStart, d.today))}\n${RULE}\n${sections.join('\n\n')}\n\n${i(t('brief.footer'))}`,
    keyboard: [[{ text: t('menu.overdue'), data: cb('m', 'overdue') }, { text: t('cost.btn_costs'), data: cb('m', 'costs') }], [menuBtn]],
  };
}

export function workloadView(d: WorkloadData): View {
  const weekLabels = d.weeks.map((w) => fromLocalDate(w).toFormat('d LLL'));
  const max = Math.max(1, ...d.people.flatMap((p) => p.doneByWeek));
  const lines = d.people.map((p) => [
    `${G.owner} ${b(esc(p.name))}  ${t('wl.open', { n: p.open })}${p.overdue ? ` ${G.dot} ${t('dash.overdue', { n: p.overdue })}` : ''}`,
    `   ${t('wl.done_weeks')} ${p.doneByWeek.map((n) => BARS[Math.min(7, Math.round((n / max) * 7))]).join('')} ${i(p.doneByWeek.join(' · '))}`,
    p.openByProject.length ? `   ${p.openByProject.map((x) => `${code(x.code)} ${x.count}`).join('  ')}` : '',
  ].filter(Boolean).join('\n'));
  const rows: Btn[][] = [];
  let hint = '';
  if (d.hint) {
    hint = `\n\n💡 ${t('wl.hint', { from: d.hint.from.name, fromN: d.hint.from.open, to: d.hint.to.name, toN: d.hint.to.open })}\n${d.hint.tasks.map((x) => `   ○ ${esc(x.title)}`).join('\n')}`;
    for (const x of d.hint.tasks) rows.push([{ text: t('wl.btn_reassign', { title: x.title.slice(0, 28) }), data: cb('t', 'a', enc(x.id), '-') }]);
  }
  return {
    text: `⚖ ${b(t('wl.title'))}  ${i(`${weekLabels[0]} – ${weekLabels.at(-1)}`)}\n${RULE}\n${lines.join('\n\n')}${hint}\n\n${i(t('wl.facts_only'))}`,
    keyboard: [...rows, [menuBtn]],
  };
}

function winsView(wins: Awaited<ReturnType<App['insights']['wins']>>, names: Map<number, string>, streak: number, now: import('luxon').DateTime, me: number): View {
  return {
    text: `🏆 ${b(t('win.title'))}\n${RULE}\n${wins.map((w, k) => `${b(String(k + 1))}  ${esc(w.text)}\n      ${i(`${esc(names.get(w.created_by) ?? '?')} · ${fmtDay(localDate(fromIso(w.created_at)), now)}`)}`).join('\n') || i(t('win.empty'))}\n\n🔥 ${t('brief.streak', { n: streak })}\n\n${i(t('win.hint'))}`,
    keyboard: [
      ...wins.filter((w) => w.created_by === me).slice(0, 5).map((w) => [{ text: t('win.btn_delete', { text: w.text.slice(0, 24) }), data: cb('wn', 'x', enc(w.id)) }]),
      [menuBtn],
    ],
  };
}


export const insightsModule: TegbarModule = {
  name: 'insights',
  telegram({ app, reg, notifier }) {
    reg.job(winNotify(app, notifier));

    // When the brief is on, it replaces the Friday "Week in review" message (no double message).
    reg.digestOverrides.set('review', async (actor: Actor) => {
      if (!(await app.flags.isEnabled(actor.workspaceId, FLAG_BRIEF))) return null;
      return briefView(await app.insights.brief(actor), await memberNames(app, actor.workspaceId), app.clock.now());
    });

    reg.command({
      name: 'brief', group: 'other', description: 'cmd.brief',
      handler: async (ctx) => {
        if (!(await requireFlag(ctx, FLAG_BRIEF))) return;
        await show(ctx, briefView(await ctx.app.insights.brief(ctx.actor), await memberNames(ctx.app, ctx.actor.workspaceId), ctx.app.clock.now()));
      },
    });
    reg.command({
      name: 'workload', group: 'other', description: 'cmd.workload',
      handler: async (ctx) => {
        if (!(await requireFlag(ctx, FLAG_WORKLOAD))) return;
        await show(ctx, workloadView(await ctx.app.insights.workload(ctx.actor)));
      },
    });
    reg.command({
      name: 'win', group: 'other', description: 'cmd.win',
      handler: async (ctx, args) => {
        if (!(await requireFlag(ctx, FLAG_WINS))) return;
        const { project, rest } = await projectOverride(ctx.app, ctx.actor, args);
        if (!rest.trim()) throw new DomainError('win.usage');
        await ctx.app.insights.addWin(ctx.actor, rest, project?.id ?? null);
        await show(ctx, { text: t('win.logged', { text: rest.trim() }) });
        await ctx.kick();
      },
    });
    reg.command({
      name: 'wins', group: 'other', description: 'cmd.wins',
      handler: async (ctx) => {
        if (!(await requireFlag(ctx, FLAG_WINS))) return;
        await showWins(ctx);
      },
    });
    reg.callback('wn', async (ctx, [action, raw], answer) => {
      const id = dec(raw);
      if (action !== 'x' || !id) return answer(t('common.stale'), true);
      const { changed } = await ctx.app.insights.deleteWin(ctx.actor, id);
      await answer(changed ? t('task.deleted_toast') : t('qa.already_handled'));
      await showWins(ctx);
    });
  },
};

async function showWins(ctx: MemberCtx): Promise<void> {
  const since = ctx.app.clock.now().minus({ days: 30 });
  await show(ctx, winsView(await ctx.app.insights.wins(ctx.actor, since.toUTC().toISO()), await memberNames(ctx.app, ctx.actor.workspaceId), await ctx.app.insights.streak(ctx.actor), ctx.app.clock.now(), ctx.actor.userId));
}

function winNotify(app: App, notifier: Notifier) {
  return {
    kind: WIN_NOTIFY, maxLateMs: 3 * 86_400_000, nextAfter: () => null,
    plan: async () => ({ action: 'send' as const, next: null }),
    async execute(job: { workspace_id: number }, p: { winId: number }): Promise<'sent' | 'failed'> {
      const w = await app.insights.winById(job.workspace_id, p.winId);
      if (!w || w.deleted_at) return 'sent';
      const names = await memberNames(app, job.workspace_id);
      for (const [userId] of names) {
        if (userId === w.created_by) continue;
        await notifier.deliver(job.workspace_id, userId, { text: t('win.notify', { name: names.get(w.created_by) ?? '?', text: w.text }) }, 'nudge');
      }
      return 'sent';
    },
  };
}
