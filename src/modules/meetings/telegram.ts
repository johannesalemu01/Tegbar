import { InputFile } from 'grammy';
import type { DateTime } from 'luxon';
import type { App } from '../../app.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { JobHandler } from '../../core/scheduler/runner.js';
import type { Actor } from '../../core/services/context.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { timeFormat } from '../../core/telegram/helpers.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import type { Registry } from '../../core/telegram/registry.js';
import { show } from '../../core/telegram/render.js';
import { atLocal, getZone } from '../../core/time.js';
import { DateTime as LuxonDateTime } from 'luxon';
const fromMillis = (ms: number) => LuxonDateTime.fromMillis(ms, { zone: getZone() });
import { b, esc, i } from '../../core/ui/html.js';
import { cb, type Btn } from '../../core/ui/keyboard.js';
import { G } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { buildLookup } from '../tasks/lookup.js';
import { extractDue } from '../tasks/quickadd.js';
import { cardView as taskCardView, NO_STATE } from '../tasks/views.js';
import { buildIcs, type IcsEvent } from './ics.js';
import type { MeetingMode, OutcomeKind } from './schema.js';
import { shortMeet } from './schedule.js';
import { MTG_JOB, nextThreeAm, type MeetingJobPayload, type MeetingView } from './service.js';
import { S_MTG_EVENING, S_MTG_LINK_CHECK, S_MTG_OFFSETS } from './settings.js';
import {
  agendaItemView, agendaView, cardView, changeView, choices, dayChoices, historyView, lengthChoices, linkNagView, listView,
  moveView, placeView, placesView, proposalView, proposeOptionsView, reminderView, seriesListView, seriesView, summaryView, when, wrapView,
  type MLookup,
} from './views.js';

const H = 3_600_000;
const MIN = 60_000;

async function mlookup(app: App, actor: Actor, projectId?: number): Promise<MLookup> {
  const members = await app.members.list(actor.workspaceId);
  const attendees = projectId ? (await app.meetings.attendees(actor.workspaceId, projectId)).map((a) => a.userId) : members.map((m) => m.user_id);
  return {
    now: app.clock.now(),
    fmt: await timeFormat(app, actor),
    meUserId: actor.userId,
    names: new Map(members.map((m) => [m.user_id, m.display_name])),
    attendees,
  };
}

async function showCard(ctx: MemberCtx, id: number, banner?: string, mode: 'auto' | 'new' = 'auto'): Promise<void> {
  const { app, actor } = ctx;
  const m = await app.meetings.get(actor, id);
  await app.meetings.ensureAgenda(actor, id);
  const [agenda, outs] = await Promise.all([app.meetings.agenda(actor, id), app.meetings.outcomes(actor, id)]);
  await show(ctx, cardView(m, await mlookup(app, actor, m.projectId), { agendaCount: agenda.filter((a) => a.status === 'open').length, outcomes: outs.length }, banner), mode);
}

async function showAgenda(ctx: MemberCtx, id: number, mode: 'auto' | 'new' = 'auto'): Promise<void> {
  const { app, actor } = ctx;
  await app.meetings.ensureAgenda(actor, id);
  const m = await app.meetings.get(actor, id);
  await show(ctx, agendaView(m, await app.meetings.agenda(actor, id), await mlookup(app, actor, m.projectId)), mode);
}

async function showList(ctx: MemberCtx): Promise<void> {
  await show(ctx, listView(await ctx.app.meetings.upcoming(ctx.actor, 6), await mlookup(ctx.app, ctx.actor)));
}

/** Tell the other attendees (direct class: respects quiet hours / DND, not focus). */
async function tellOthers(app: App, notifier: Notifier, actor: Actor, m: MeetingView, build: (l: MLookup) => View): Promise<void> {
  for (const a of await app.meetings.attendees(actor.workspaceId, m.projectId)) {
    if (a.userId === actor.userId) continue;
    await notifier.deliver(actor.workspaceId, a.userId, build(await mlookup(app, a, m.projectId)), 'direct');
  }
}

function icsEvents(ms: MeetingView[]): IcsEvent[] {
  return ms.map((m) => ({
    uid: `meeting-${m.id}@tegbar`,
    sequence: m.sequence,
    start: m.start,
    end: m.end,
    summary: m.title,
    description: [m.mode === 'virtual' ? (m.link ? `Join: ${m.link}` : 'Virtual — link will be added in Tegbar') : 'In person', m.hostName ? `Host: ${m.hostName}` : ''].filter(Boolean).join('\n'),
    ...(m.mode === 'in_person' && m.place ? { location: [m.place.name, m.place.address].filter(Boolean).join(', ') } : {}),
    ...(m.mode === 'virtual' && m.link ? { url: m.link, location: m.link } : {}),
    cancelled: m.status === 'skipped' || m.status === 'cancelled',
    alarms: [60, 10],
  }));
}

async function sendIcs(ctx: MemberCtx, ms: MeetingView[], name: string): Promise<void> {
  const ics = buildIcs(icsEvents(ms), ctx.app.clock.now());
  await ctx.replyWithDocument(new InputFile(Buffer.from(ics, 'utf8'), name), { caption: t('mtg.ics_caption') });
}

/** "wed 19:00", "tomorrow 6pm", "2026-11-20 18:00" → instant; keeps `fallbackTime` if no time given. */
function parseWhen(app: App, text: string, fallbackTime?: string): { at: DateTime; rest: string } | null {
  const { due, rest } = extractDue(text, app.clock.now());
  if (!due) return null;
  const time = due.time ?? fallbackTime;
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  return { at: atLocal(due.date, h!, m!), rest };
}

function parseMode(text: string): MeetingMode | null {
  if (/\b(in[ -]?person|offline|face to face)\b|📍/i.test(text)) return 'in_person';
  if (/\b(virtual|online|meet|call)\b|💻/i.test(text)) return 'virtual';
  return null;
}

// ---------- job handlers ----------

function jobHandlers(app: App, notifier: Notifier): JobHandler[] {
  const load = async (workspaceId: number, p: MeetingJobPayload) => {
    const row = await app.db.selectFrom('meetings').select(['project_id']).where('id', '=', p.meetingId).executeTakeFirst();
    if (!row) return null;
    const attendees = await app.meetings.attendees(workspaceId, row.project_id);
    if (!attendees[0]) return null;
    const m = await app.meetings.get(attendees[0], p.meetingId); // permission-checked
    return { m, attendees };
  };

  const remind: JobHandler<MeetingJobPayload, { attendees: Actor[] }> = {
    kind: MTG_JOB.remind,
    maxLateMs: 15 * MIN,
    nextAfter: () => null,
    async plan(job, p, { lateMs }) {
      const found = await load(job.workspace_id, p);
      if (!found || found.m.status !== 'scheduled' || found.m.startAt !== p.startKey) return { action: 'skip', reason: 'obsolete', next: null };
      // the evening-before reminder may run a little late; "in 10 min" may not
      if (p.slot !== 'eve' && lateMs > 10 * MIN) return { action: 'skip', reason: 'too late', next: null };
      return { action: 'send', next: null, data: { attendees: found.attendees } };
    },
    async execute(job, p, plan) {
      let ok = false;
      for (const a of plan.data!.attendees) {
        await app.meetings.ensureAgenda(a, p.meetingId);
        const m = await app.meetings.get(a, p.meetingId);
        const view = reminderView(m, p.slot, await app.meetings.agenda(a, p.meetingId), await mlookup(app, a, m.projectId));
        ok = (await notifier.deliver(job.workspace_id, a.userId, view, 'direct')) !== 'failed' || ok;
      }
      return ok ? 'sent' : 'failed';
    },
  };

  const link: JobHandler<MeetingJobPayload, { to: Actor }> = {
    kind: MTG_JOB.link,
    maxLateMs: H,
    nextAfter: () => null,
    async plan(job, p) {
      const found = await load(job.workspace_id, p);
      if (!found || found.m.status !== 'scheduled' || found.m.startAt !== p.startKey) return { action: 'skip', reason: 'obsolete', next: null };
      if (found.m.mode !== 'virtual' || found.m.link) return { action: 'skip', reason: 'has link', next: null };
      const to = found.attendees.find((a) => a.userId === found.m.hostUserId) ?? found.attendees[0]!;
      return { action: 'send', next: null, data: { to } };
    },
    async execute(job, p, plan) {
      const to = plan.data!.to;
      const m = await app.meetings.get(to, p.meetingId);
      return (await notifier.deliver(job.workspace_id, to.userId, linkNagView(m, await mlookup(app, to, m.projectId)), 'direct')) === 'failed' ? 'failed' : 'sent';
    },
  };

  const wrap: JobHandler<MeetingJobPayload, { to: Actor }> = {
    kind: MTG_JOB.wrap,
    maxLateMs: 2 * H,
    nextAfter: () => null,
    async plan(job, p) {
      const found = await load(job.workspace_id, p);
      if (!found || found.m.status !== 'live') return { action: 'skip', reason: 'not live', next: null };
      const to = found.attendees.find((a) => a.userId === found.m.hostUserId) ?? found.attendees[0]!;
      return { action: 'send', next: null, data: { to } };
    },
    async execute(job, p, plan) {
      const to = plan.data!.to;
      return (await notifier.deliver(job.workspace_id, to.userId, wrapView(await app.meetings.get(to, p.meetingId)), 'direct')) === 'failed' ? 'failed' : 'sent';
    },
  };

  const generate: JobHandler<{ workspaceId: number }> = {
    kind: MTG_JOB.generate,
    maxLateMs: 24 * H,
    nextAfter: (_j, _p, now) => nextThreeAm(now),
    async plan(_job, _p, { now }) {
      return { action: 'send', next: nextThreeAm(now) };
    },
    async execute(job) {
      await app.meetings.generate(job.workspace_id);
      return 'sent';
    },
  };
  return [remind, link, wrap, generate];
}

// ---------- module ----------

export const meetingsModule: TegbarModule = {
  name: 'meetings',
  telegram({ app, reg, notifier }) {
    for (const h of jobHandlers(app, notifier)) reg.job(h);
    registerCommands(app, reg);
    registerCallbacks(app, reg, notifier);
    registerInputs(app, reg, notifier);

    // A task typed while a meeting is live becomes its action item.
    reg.draftLinker(async (ctx) => {
      const live = await ctx.app.meetings.live(ctx.actor);
      return live ? { type: 'meeting', id: live.id, label: live.title } : null;
    });

    reg.menuEntry({ label: 'menu.meetings', command: 'meetings', order: 45 });
    reg.dashboardSection({
      order: 20,
      render: async (ctx) => {
        const next = await ctx.app.meetings.next(ctx.actor);
        if (!next) return null;
        const l = await mlookup(ctx.app, ctx.actor, next.projectId);
        return `${b(t('mtg.next_title'))}\n◉ ${esc(next.title)} ${G.dot} ${when(next, l)}${next.mode === 'virtual' && !next.link ? ` ${G.dot} ${G.warn} ${t('mtg.no_link')}` : ''}`;
      },
    });

    reg.settingsSection({
      order: 30,
      render: async (ctx) => {
        const ws = ctx.actor.workspaceId;
        const eve = await ctx.app.settings.get(ws, S_MTG_EVENING, ws);
        const offs = await ctx.app.settings.get(ws, S_MTG_OFFSETS, ws);
        const check = await ctx.app.settings.get(ws, S_MTG_LINK_CHECK, ws);
        const fmt = (m: number) => (m === 0 ? t('mtg.at_start') : m % 60 === 0 ? t('rem.n_hours', { n: m / 60 }) : t('rem.n_min', { n: m }));
        return {
          lines: [
            t('mtg.set_reminders', { eve: eve ?? t('common.off'), list: [...offs].sort((a, z) => z - a).map(fmt).join(', ') || t('common.off') }),
            t('mtg.set_linkcheck', { v: fmt(check) }),
          ],
          buttons: [[
            { text: t('mtg.btn_set_eve'), data: cb('mt', 'cfe', '0') },
            { text: t('mtg.btn_set_offsets'), data: cb('mt', 'cfo', '0') },
          ]],
        };
      },
    });
  },
};

function registerCommands(app: App, reg: Registry): void {
  reg.command({ name: 'meetings', group: 'other', description: 'cmd.meetings', handler: async (ctx) => showList(ctx) });
  reg.command({
    name: 'meeting', group: 'other', description: 'cmd.meeting',
    handler: async (ctx, args) => {
      const next = await ctx.app.meetings.next(ctx.actor);
      if (!next) return show(ctx, { text: t('mtg.none'), keyboard: [[{ text: t('mtg.btn_extra'), data: cb('mt', 'x', '0') }]] });
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      if (sub === 'link') {
        const upcoming = (await ctx.app.meetings.upcoming(ctx.actor, 10)).find((m) => m.mode === 'virtual' && ['scheduled', 'live'].includes(m.status));
        if (!upcoming) throw new DomainError('mtg.no_virtual');
        if (!rest[0]) throw new DomainError('meeting.bad_link');
        await ctx.app.meetings.setLink(ctx.actor, upcoming.id, rest[0]);
        return showCard(ctx, upcoming.id, t('mtg.link_saved'));
      }
      if (sub === 'ics') return sendIcs(ctx, [next], `tegbar-${next.start.toFormat('yyyy-MM-dd')}.ics`);
      await showCard(ctx, next.id);
    },
  });
  reg.command({
    name: 'agenda', group: 'other', description: 'cmd.agenda',
    handler: async (ctx) => {
      const next = await ctx.app.meetings.next(ctx.actor);
      if (!next) return show(ctx, { text: t('mtg.none') });
      await showAgenda(ctx, next.id);
    },
  });
  void app;
}

function registerCallbacks(app: App, reg: Registry, notifier: Notifier): void {
  reg.callback('mt', async (ctx, [action, raw, extra], answer) => {
    const { actor } = ctx;
    const id = dec(raw);
    const need = (): number => {
      if (!id) throw new DomainError('common.stale');
      return id;
    };
    const pend = (kind: string, payload: unknown) => app.pending.set(actor.workspaceId, actor.userId, kind, payload);

    switch (action) {
      // ----- lists -----
      case 'l': return showList(ctx);
      case 'h': {
        const page = Math.max(0, Number(raw) || 0);
        const { items, total } = await app.meetings.history(actor, page, 8);
        return show(ctx, historyView(items, total, page, 8, await mlookup(app, actor)));
      }
      case 'o': return showCard(ctx, need());
      case 'icsall': {
        const ms = (await app.meetings.upcoming(actor, 30)).filter((m) => m.status !== 'live');
        await answer(t('mtg.ics_sending'));
        return sendIcs(ctx, ms, 'tegbar-meetings.ics');
      }
      case 'ics': {
        await answer(t('mtg.ics_sending'));
        const m = await app.meetings.get(actor, need());
        return sendIcs(ctx, [m], `tegbar-${m.start.toFormat('yyyy-MM-dd')}.ics`);
      }

      // ----- RSVP -----
      case 'r': {
        const map = { g: ['going', null], l10: ['late', 10], l20: ['late', 20], n: ['no', null] } as const;
        const choice = map[extra as keyof typeof map];
        if (!choice) return answer(t('common.stale'), true);
        const { meeting, changed } = await app.meetings.rsvp(actor, need(), choice[0], choice[1]);
        await answer(changed ? t('mtg.rsvp_saved') : t('common.nothing_changed'));
        if (changed && choice[0] === 'late') {
          await tellOthers(app, notifier, actor, meeting, () => ({ text: t('mtg.late_notice', { name: ctx.member.display_name, n: choice[1]!, title: meeting.title }) }));
        }
        if (choice[0] === 'no') return show(ctx, proposeOptionsView(meeting));
        return showCard(ctx, meeting.id);
      }

      // ----- agenda -----
      case 'ag': return showAgenda(ctx, need());
      case 'aadd':
        await pend('mt.agenda', { id: need() });
        return show(ctx, { text: t('mtg.add_item_prompt') }, 'new');
      case 'ai': return show(ctx, agendaItemView(await app.meetings.agendaItem(actor, need())));
      case 'aid': case 'aio': case 'aiu': case 'aix': {
        const op = ({ aid: 'done', aio: 'open', aiu: 'up', aix: 'drop' } as const)[action];
        const item = await app.meetings.updateAgendaItem(actor, need(), op);
        return showAgenda(ctx, item.meeting_id);
      }
      case 'aia': {
        const item = await app.meetings.agendaItem(actor, need());
        await pend('mt.out', { id: item.meeting_id, kind: 'task', itemId: item.id });
        return show(ctx, { text: t('mtg.action_prompt', { text: item.text }) }, 'new');
      }

      // ----- outcomes / start / end -----
      case 'out': {
        if (!['task', 'decision', 'question', 'note'].includes(extra ?? '')) return answer(t('common.stale'), true);
        await pend('mt.out', { id: need(), kind: extra });
        return show(ctx, { text: t(`mtg.out_prompt_${extra as OutcomeKind}`) }, 'new');
      }
      case 'go': {
        const { meeting, changed } = await app.meetings.start(actor, need());
        await answer(changed ? t('mtg.started') : t('common.nothing_changed'));
        return showCard(ctx, meeting.id, changed ? t('mtg.started_banner') : undefined);
      }
      case 'end': {
        const { meeting, changed } = await app.meetings.end(actor, need());
        if (!changed) {
          await answer(t('mtg.already_ended'));
          return showCard(ctx, meeting.id);
        }
        await answer(t('mtg.ended'));
        const summary = await app.meetings.summary(actor, meeting.id);
        await show(ctx, summaryView(summary, await mlookup(app, actor, meeting.projectId)));
        for (const a of await app.meetings.attendees(actor.workspaceId, meeting.projectId)) {
          if (a.userId === actor.userId) continue;
          await notifier.deliver(actor.workspaceId, a.userId, summaryView(await app.meetings.summary(a, meeting.id), await mlookup(app, a, meeting.projectId)), 'direct');
        }
        return;
      }
      case 'sum': {
        const s = await app.meetings.summary(actor, need());
        return show(ctx, summaryView(s, await mlookup(app, actor, s.meeting.projectId)));
      }

      // ----- per-meeting changes -----
      case 'c': {
        const m = await app.meetings.get(actor, need());
        return show(ctx, changeView(m, await mlookup(app, actor, m.projectId)));
      }
      case 'mv': {
        const m = await app.meetings.get(actor, need());
        await pend('mt.move', { id: m.id });
        return show(ctx, moveView(m, await mlookup(app, actor, m.projectId)));
      }
      case 'mvq': {
        const m = await app.meetings.get(actor, need());
        const minutes = extra && /^[0-9a-z]{1,10}$/.test(extra) ? Number.parseInt(extra, 36) : NaN;
        if (!Number.isFinite(minutes)) return answer(t('common.stale'), true);
        const target = fromMillis(minutes * 60_000);
        const { meeting, changed } = await app.meetings.move(actor, m.id, target);
        if (changed) await notifyChange(app, notifier, ctx, meeting, t('mtg.chg_moved', { when: when(meeting, await mlookup(app, actor)) }));
        return showCard(ctx, meeting.id, changed ? t('mtg.moved_banner') : undefined);
      }
      case 'mode': {
        if (extra !== 'virtual' && extra !== 'in_person') return answer(t('common.stale'), true);
        const { meeting, changed } = await app.meetings.setMode(actor, need(), extra);
        if (changed) await notifyChange(app, notifier, ctx, meeting, t(extra === 'virtual' ? 'mtg.chg_virtual' : 'mtg.chg_in_person'));
        return showCard(ctx, meeting.id);
      }
      case 'host': {
        const m = await app.meetings.get(actor, need());
        if (extra) {
          const uid = dec(extra);
          if (!uid) return answer(t('common.stale'), true);
          const { meeting, changed } = await app.meetings.setHost(actor, m.id, uid);
          if (changed) await notifyChange(app, notifier, ctx, meeting, t('mtg.chg_host', { name: meeting.hostName ?? '?' }));
          return showCard(ctx, meeting.id);
        }
        const l = await mlookup(app, actor, m.projectId);
        return show(ctx, choices(`<b>${t('mtg.host_title')}</b>`, l.attendees.map((u) => ({ label: l.names.get(u) ?? '?', data: cb('mt', 'host', enc(m.id), enc(u)), selected: u === m.hostUserId })), cb('mt', 'c', enc(m.id))));
      }
      case 'place': {
        const m = await app.meetings.get(actor, need());
        if (extra) {
          const pid = dec(extra);
          if (!pid) return answer(t('common.stale'), true);
          const { meeting, changed } = await app.meetings.setPlace(actor, m.id, pid);
          if (changed) await notifyChange(app, notifier, ctx, meeting, t('mtg.chg_place', { name: meeting.place?.name ?? '?' }));
          return showCard(ctx, meeting.id);
        }
        const places = await app.meetings.places(actor);
        return show(ctx, choices(`<b>${t('mtg.place_title')}</b>`, places.map((p) => ({ label: p.name, data: cb('mt', 'place', enc(m.id), enc(p.id)), selected: p.id === m.place?.id })), cb('mt', 'c', enc(m.id))));
      }
      case 'len': {
        const m = await app.meetings.get(actor, need());
        if (extra) {
          const { meeting } = await app.meetings.setDuration(actor, m.id, Number(extra));
          return showCard(ctx, meeting.id);
        }
        return show(ctx, lengthChoices(m.durationMin, (d) => cb('mt', 'len', enc(m.id), String(d)), cb('mt', 'c', enc(m.id))));
      }
      case 'lk': {
        const m = await app.meetings.get(actor, need());
        await pend('mt.link', { id: m.id });
        return show(ctx, { text: t('mtg.link_prompt', { title: m.title }) }, 'new');
      }
      case 'lkx': {
        const { meeting } = await app.meetings.setLink(actor, need(), null);
        return showCard(ctx, meeting.id);
      }
      case 'skip': {
        const m = await app.meetings.get(actor, need());
        return show(ctx, {
          text: t('mtg.skip_confirm', { title: m.title, when: when(m, await mlookup(app, actor)) }),
          keyboard: [[{ text: t('mtg.btn_skip_yes'), data: cb('mt', 'skipx', enc(m.id)), style: 'danger' }, { text: t('common.cancel'), data: cb('mt', 'o', enc(m.id)) }]],
        });
      }
      case 'skipx': {
        const { meeting, changed } = await app.meetings.skip(actor, need());
        if (changed) await notifyChange(app, notifier, ctx, meeting, t('mtg.chg_skipped'));
        return showCard(ctx, meeting.id);
      }
      case 'unskip': {
        const { meeting, changed } = await app.meetings.unskip(actor, need());
        if (changed) await notifyChange(app, notifier, ctx, meeting, t('mtg.chg_unskipped'));
        return showCard(ctx, meeting.id);
      }
      case 'x':
        await pend('mt.extra', {});
        return show(ctx, { text: t('mtg.extra_prompt') }, 'new');

      // ----- slots -----
      case 's': return show(ctx, seriesListView(await app.meetings.series(actor), await app.meetings.places(actor), await mlookup(app, actor)));
      case 'se': return show(ctx, seriesView(await app.meetings.seriesById(actor, need()), await app.meetings.places(actor)));
      case 'sday': {
        const s = await app.meetings.seriesById(actor, need());
        if (!extra) return show(ctx, dayChoices(s));
        return show(ctx, seriesView(await app.meetings.updateSeries(actor, s.id, { weekday: Number(extra) }), await app.meetings.places(actor)));
      }
      case 'slen': {
        const s = await app.meetings.seriesById(actor, need());
        if (!extra) return show(ctx, lengthChoices(s.duration_min, (d) => cb('mt', 'slen', enc(s.id), String(d)), cb('mt', 'se', enc(s.id))));
        return show(ctx, seriesView(await app.meetings.updateSeries(actor, s.id, { duration_min: Number(extra) }), await app.meetings.places(actor)));
      }
      case 'smode': {
        if (extra !== 'virtual' && extra !== 'in_person') return answer(t('common.stale'), true);
        return show(ctx, seriesView(await app.meetings.updateSeries(actor, need(), { mode: extra }), await app.meetings.places(actor)));
      }
      case 'splace': {
        const s = await app.meetings.seriesById(actor, need());
        const places = await app.meetings.places(actor);
        if (!extra) return show(ctx, choices(`<b>${t('mtg.place_title')}</b>`, places.map((p) => ({ label: p.name, data: cb('mt', 'splace', enc(s.id), enc(p.id)), selected: p.id === s.place_id })), cb('mt', 'se', enc(s.id))));
        return show(ctx, seriesView(await app.meetings.updateSeries(actor, s.id, { place_id: dec(extra) }), places));
      }
      case 'sact': {
        if (extra !== '0' && extra !== '1') return answer(t('common.stale'), true);
        return show(ctx, seriesView(await app.meetings.updateSeries(actor, need(), { active: Number(extra) }), await app.meetings.places(actor)));
      }
      case 'stime':
        await app.meetings.seriesById(actor, need());
        await pend('mt.stime', { sid: id });
        return show(ctx, { text: t('mtg.stime_prompt') }, 'new');
      case 'sroom':
        await app.meetings.seriesById(actor, need());
        await pend('mt.sroom', { sid: id });
        return show(ctx, { text: t('mtg.sroom_prompt') }, 'new');

      // ----- places -----
      case 'pl': return show(ctx, placesView(await app.meetings.places(actor)));
      case 'po': {
        const p = await app.meetings.placeById(actor.workspaceId, need());
        if (!p) return answer(t('common.stale'), true);
        return show(ctx, placeView(p));
      }
      case 'pdef': {
        await app.meetings.setDefaultPlace(actor, need());
        await answer(t('common.saved'));
        return show(ctx, placesView(await app.meetings.places(actor)));
      }
      case 'pe': {
        if (!['name', 'address', 'notes'].includes(extra ?? '')) return answer(t('common.stale'), true);
        await pend('mt.pe', { pid: need(), field: extra });
        return show(ctx, { text: t('mtg.pe_prompt') }, 'new');
      }
      case 'ppin':
        await pend('mt.ppin', { pid: need() });
        return show(ctx, { text: t('mtg.pin_prompt') }, 'new');
      case 'pn':
        await pend('mt.pnew', {});
        return show(ctx, { text: t('mtg.pnew_prompt') }, 'new');

      // ----- meeting settings -----
      case 'cfe':
        await pend('mt.cfe', {});
        return show(ctx, { text: t('mtg.cfe_prompt') }, 'new');
      case 'cfo': {
        const ws = actor.workspaceId;
        const cur = await app.settings.get(ws, S_MTG_OFFSETS, ws);
        if (extra) {
          const [mins, on] = extra.split('.');
          const n = Number(mins);
          if (![60, 30, 10, 0].includes(n) || (on !== '0' && on !== '1')) return answer(t('common.stale'), true);
          const next = on === '1' ? [...new Set([...cur, n])] : cur.filter((x) => x !== n);
          await app.settings.setAs(actor, S_MTG_OFFSETS, ws, next); // hook re-plans meeting reminders
        }
        const now = extra ? await app.settings.get(ws, S_MTG_OFFSETS, ws) : cur;
        const label = (m: number) => (m === 0 ? t('mtg.at_start') : t('rem.n_min', { n: m }));
        return show(ctx, {
          text: `<b>${t('mtg.offsets_title')}</b>\n${i(t('mtg.offsets_hint'))}`,
          keyboard: [
            [60, 30, 10, 0].map((m) => ({ text: `${now.includes(m) ? `${G.done} ` : ''}${label(m)}`, data: cb('mt', 'cfo', '0', `${m}.${now.includes(m) ? 0 : 1}`), ...(now.includes(m) ? { style: 'primary' as const } : {}) })),
            [{ text: G.back, data: cb('m', 'settings') }],
          ],
        });
      }
      default:
        return answer(t('common.stale'), true);
    }
  });

  // Reschedule proposals: mp:n:<meetingId>:<opt> (propose), mp:a|d:<proposalId>
  reg.callback('mp', async (ctx, [action, raw, opt], answer) => {
    const { actor } = ctx;
    const id = dec(raw);
    if (!id) return answer(t('common.stale'), true);
    if (action === 'n') {
      const m = await app.meetings.get(actor, id);
      if (opt === 'none') return showCard(ctx, m.id, t('mtg.rsvp_saved'));
      if (opt === 'custom') {
        await app.pending.set(actor.workspaceId, actor.userId, 'mt.propose', { id: m.id });
        return show(ctx, { text: t('mtg.propose_prompt') }, 'new');
      }
      const r = opt === 'skip' ? await app.meetings.propose(actor, m.id, { kind: 'skip' })
        : opt === 'tom' || opt === '2d' ? await app.meetings.propose(actor, m.id, { kind: 'move', start: m.start.plus({ days: opt === 'tom' ? 1 : 2 }) })
        : null;
      if (!r) return answer(t('common.stale'), true);
      if (r.created) await sendProposal(app, notifier, ctx, m, r.proposal.id);
      return showCard(ctx, m.id, t('mtg.proposal_sent'));
    }
    if (action === 'a' || action === 'd') {
      const { proposal, changed, meeting } = await app.meetings.decide(actor, id, action === 'a');
      if (!changed) {
        await answer(t('mtg.proposal_done', { status: proposal.status }), true);
        return showCard(ctx, meeting.id);
      }
      await answer(action === 'a' ? t('mtg.accepted') : t('mtg.declined'));
      const l = await mlookup(app, actor, meeting.projectId);
      const outcome = action === 'a'
        ? (proposal.kind === 'skip' ? t('mtg.chg_skipped') : t('mtg.chg_moved', { when: when(meeting, l) }))
        : t('mtg.prop_declined_note');
      await tellOthers(app, notifier, actor, meeting, () => ({
        text: `${action === 'a' ? G.ok : '✕'} ${b(t(action === 'a' ? 'mtg.prop_accepted_by' : 'mtg.prop_declined_by', { name: ctx.member.display_name }))}\n${esc(meeting.title)}: ${esc(outcome)}`,
        keyboard: [[{ text: t('rem.btn_open'), data: cb('mt', 'o', enc(meeting.id)) }]],
      }));
      return showCard(ctx, meeting.id, outcome);
    }
    return answer(t('common.stale'), true);
  });
}

async function sendProposal(app: App, notifier: Notifier, ctx: MemberCtx, m: MeetingView, proposalId: number): Promise<void> {
  const p = (await app.meetings.proposal(ctx.actor.workspaceId, proposalId))!;
  await tellOthers(app, notifier, ctx.actor, m, (l) => proposalView(m, p, l, ctx.member.display_name));
}

async function notifyChange(app: App, notifier: Notifier, ctx: MemberCtx, m: MeetingView, what: string): Promise<void> {
  await tellOthers(app, notifier, ctx.actor, m, (l) => ({
    text: `◉ ${b(t('mtg.chg_title', { name: ctx.member.display_name }))}\n${esc(m.title)} ${G.dot} ${when(m, l)}\n${esc(what)}`,
    keyboard: [[{ text: t('rem.btn_open'), data: cb('mt', 'o', enc(m.id)) }]],
  }));
}

function registerInputs(app: App, reg: Registry, notifier: Notifier): void {
  /** Ask again: keep the question pending and explain what went wrong. Only parameter-less messages. */
  type PlainKey = 'mtg.when_unparsed' | 'meeting.bad_link' | 'qa.issue.empty_title' | 'rs.bad_time' | 'meeting.bad_text' | 'mtg.pin_needs_location';
  const retry = async (ctx: MemberCtx, kind: string, payload: unknown, key: PlainKey): Promise<never> => {
    await app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, kind, payload);
    throw new DomainError(key);
  };

  reg.input('mt.move', async (ctx, text, p: { id: number }) => {
    const m = await app.meetings.get(ctx.actor, p.id);
    const w = parseWhen(app, text, m.start.toFormat('HH:mm'));
    if (!w) return retry(ctx, 'mt.move', p, 'mtg.when_unparsed');
    const { meeting, changed } = await app.meetings.move(ctx.actor, p.id, w.at);
    if (changed) await notifyChange(app, notifier, ctx, meeting, t('mtg.chg_moved', { when: when(meeting, await mlookup(app, ctx.actor)) }));
    await showCard(ctx, meeting.id, t('mtg.moved_banner'));
  });

  reg.input('mt.link', async (ctx, text, p: { id: number }) => {
    try {
      const { meeting } = await app.meetings.setLink(ctx.actor, p.id, text);
      await tellOthers(app, notifier, ctx.actor, meeting, (l) => ({
        text: `🔗 ${b(t('mtg.link_added_by', { name: ctx.member.display_name }))}\n${esc(meeting.title)} ${G.dot} ${when(meeting, l)}\n${esc(shortMeet(meeting.link!))}`,
        keyboard: [[{ text: t('mtg.btn_join'), url: meeting.link!, style: 'success' }]],
      }));
      await showCard(ctx, meeting.id, t('mtg.link_saved'));
    } catch (err) {
      if (err instanceof DomainError && err.key === 'meeting.bad_link') return retry(ctx, 'mt.link', p, 'meeting.bad_link');
      throw err;
    }
  });

  reg.input('mt.agenda', async (ctx, text, p: { id: number }) => {
    await app.meetings.addAgendaItem(ctx.actor, p.id, text);
    await showAgenda(ctx, p.id, 'new');
  });

  reg.input('mt.out', async (ctx, text, p: { id: number; kind: OutcomeKind; itemId?: number }) => {
    const m = await app.meetings.get(ctx.actor, p.id);
    if (p.kind === 'task') {
      const parsed = await app.tasks.parse(ctx.actor, text);
      if (!parsed.title) return retry(ctx, 'mt.out', p, 'qa.issue.empty_title');
      const task = await app.tasks.create(ctx.actor, {
        projectId: parsed.projectId, title: parsed.title, ownerUserId: parsed.ownerUserId, priority: parsed.priority,
        areaId: parsed.areaId, due: parsed.due, recurrence: parsed.recurrence,
      });
      await app.meetings.addOutcome(ctx.actor, m.id, 'task', task.title, task.id);
      if (p.itemId) await app.meetings.updateAgendaItem(ctx.actor, p.itemId, 'done');
      const l = await buildLookup(app, ctx.actor);
      await show(ctx, taskCardView(task, l, NO_STATE, `${G.ok} ${t('task.added_linked', { label: m.title })}`), 'new');
      if (task.owner_user_id && task.owner_user_id !== ctx.actor.userId) {
        const ownerActor = { userId: task.owner_user_id, workspaceId: ctx.actor.workspaceId };
        await notifier.deliver(ctx.actor.workspaceId, task.owner_user_id, taskCardView(task, await buildLookup(app, ownerActor), NO_STATE, t('task.assigned_to_you', { name: ctx.member.display_name })), 'direct');
      }
      return;
    }
    await app.meetings.addOutcome(ctx.actor, m.id, p.kind, text);
    await showCard(ctx, m.id, t(`mtg.out_saved_${p.kind}`), 'new');
  });

  reg.input('mt.extra', async (ctx, text) => {
    const w = parseWhen(app, text);
    if (!w) return retry(ctx, 'mt.extra', {}, 'mtg.when_unparsed');
    const mode = parseMode(text) ?? 'virtual';
    const title = w.rest.replace(/\b(in[ -]?person|offline|virtual|online|meet)\b/gi, '').replace(/\s+/g, ' ').trim();
    const m = await app.meetings.createExtra(ctx.actor, { start: w.at, mode, title: title || undefined });
    await notifyChange(app, notifier, ctx, m, t('mtg.chg_extra'));
    await showCard(ctx, m.id, t('mtg.extra_created'), 'new');
  });

  reg.input('mt.propose', async (ctx, text, p: { id: number }) => {
    const m = await app.meetings.get(ctx.actor, p.id);
    const w = parseWhen(app, text, m.start.toFormat('HH:mm'));
    if (!w) return retry(ctx, 'mt.propose', p, 'mtg.when_unparsed');
    const prop = await app.meetings.propose(ctx.actor, p.id, { kind: 'move', start: w.at });
    if (prop.created) await sendProposal(app, notifier, ctx, m, prop.proposal.id);
    await showCard(ctx, m.id, t('mtg.proposal_sent'), 'new');
  });

  reg.input('mt.stime', async (ctx, text, p: { sid: number }) => {
    const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(text);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return retry(ctx, 'mt.stime', p, 'rs.bad_time');
    const s = await app.meetings.updateSeries(ctx.actor, p.sid, { time: `${m[1]!.padStart(2, '0')}:${m[2]}` });
    await show(ctx, seriesView(s, await app.meetings.places(ctx.actor)), 'new');
  });

  reg.input('mt.sroom', async (ctx, text, p: { sid: number }) => {
    const v = text.trim();
    try {
      const s = await app.meetings.updateSeries(ctx.actor, p.sid, { room_url: v === '-' || v.toLowerCase() === 'off' ? null : v });
      await show(ctx, seriesView(s, await app.meetings.places(ctx.actor)), 'new');
    } catch (err) {
      if (err instanceof DomainError && err.key === 'meeting.bad_link') return retry(ctx, 'mt.sroom', p, 'meeting.bad_link');
      throw err;
    }
  });

  reg.input('mt.pe', async (ctx, text, p: { pid: number; field: 'name' | 'address' | 'notes' }) => {
    const v = text.trim() === '-' ? null : text.trim();
    if (p.field === 'name' && !v) return retry(ctx, 'mt.pe', p, 'meeting.bad_text');
    const place = await app.meetings.updatePlace(ctx.actor, p.pid, { [p.field]: v });
    await show(ctx, placeView(place), 'new');
  });

  reg.input('mt.pnew', async (ctx, text) => {
    const [name, ...rest] = text.split(/\s+[—–-]\s+/);
    const place = await app.meetings.createPlace(ctx.actor, { name: name ?? '', address: rest.join(' - ') || null });
    await show(ctx, placeView(place), 'new');
  });

  reg.input('mt.ppin', async (ctx, _text, p: { pid: number }) => retry(ctx, 'mt.ppin', p, 'mtg.pin_needs_location'));
  reg.location('mt.ppin', async (ctx, loc, p: { pid: number }) => {
    const place = await app.meetings.updatePlace(ctx.actor, p.pid, { latitude: loc.latitude, longitude: loc.longitude });
    await show(ctx, placeView(place), 'new');
  });

  reg.input('mt.cfe', async (ctx, text) => {
    const v = text.trim().toLowerCase();
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(v);
    if (v !== 'off' && (!m || Number(m[1]) > 23 || Number(m[2]) > 59)) return retry(ctx, 'mt.cfe', {}, 'rs.bad_time');
    const ws = ctx.actor.workspaceId;
    await app.settings.setAs(ctx.actor, S_MTG_EVENING, ws, v === 'off' ? null : `${m![1]!.padStart(2, '0')}:${m![2]}`);
    const def = reg.commands.get('settings');
    if (def) await def.handler(ctx, '');
  });
}

