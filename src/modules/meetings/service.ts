import type { DateTime } from 'luxon';
import type { Db } from '../../core/db/database.js';
import { DomainError, ForbiddenError, NotFoundError } from '../../core/errors.js';
import type { Hooks } from '../../core/hooks.js';
import type { Actor } from '../../core/services/context.js';
import type { EventLog } from '../../core/services/events.js';
import type { Jobs } from '../../core/services/jobs.js';
import type { Members } from '../../core/services/members.js';
import type { Permissions } from '../../core/services/permissions.js';
import type { Projects } from '../../core/services/projects.js';
import type { Settings } from '../../core/services/settings.js';
import { atLocal, fromDb, getZone, localDate, toDb, type Clock } from '../../core/time.js';
import type { TaskService, TaskView } from '../tasks/service.js';
import { horizonWeeks, normalizeMeetLink, rotationHost, slotDate } from './schedule.js';
import type {
  AgendaRow, MeetingMode, MeetingRow, MeetingStatus, OutcomeKind, OutcomeRow, PlaceRow, ProposalRow, RsvpRow, RsvpStatus, SeriesRow,
} from './schema.js';
import { MEETING_HORIZON_WEEKS, S_MTG_EVENING, S_MTG_LINK_CHECK, S_MTG_OFFSETS, S_MTG_SEEDED } from './settings.js';

export interface MeetingView {
  id: number;
  workspaceId: number;
  projectId: number;
  seriesId: number | null;
  weekStart: string | null;
  title: string;
  start: DateTime;
  end: DateTime;
  startAt: string;
  durationMin: number;
  mode: MeetingMode;
  hostUserId: number | null;
  hostName: string | null;
  place: PlaceRow | null;
  link: string | null;
  linkFromRoom: boolean;
  status: MeetingStatus;
  moved: boolean;
  startedAt: string | null;
  endedAt: string | null;
  sequence: number;
  rsvps: RsvpRow[];
}

export interface AgendaCandidate {
  refType: string;
  refId: number;
  text: string;
  /** lower comes first */
  rank: number;
}
export type AgendaSource = (actor: Actor, m: MeetingView) => Promise<AgendaCandidate[]>;

export interface AgendaItemView extends AgendaRow {
  task: TaskView | null;
}

export interface MeetingSummary {
  meeting: MeetingView;
  decisions: OutcomeRow[];
  questions: OutcomeRow[];
  notes: OutcomeRow[];
  tasks: TaskView[];
  carriedTo: MeetingView | null;
}

export const MODES: readonly MeetingMode[] = ['virtual', 'in_person'];
export const DURATIONS = [30, 45, 60, 90, 120];

export class MeetingService {
  private readonly sources: AgendaSource[] = [];

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly permissions: Permissions,
    private readonly events: EventLog,
    private readonly hooks: Hooks,
    private readonly members: Members,
    private readonly settings: Settings,
    private readonly projects: Projects,
    private readonly tasks: TaskService,
  ) {
    this.sources.push((actor, m) => this.taskCandidates(actor, m));
  }

  /** Modules add agenda sources (e.g. pending decisions, unacknowledged notices in Phase 5). */
  addAgendaSource(source: AgendaSource): void {
    this.sources.push(source);
  }

  // ---------- seeding & generation ----------

  /** First start: default place and the two weekly slots (once; later edits are never overwritten). */
  async seed(workspaceId: number): Promise<void> {
    if (await this.settings.get(workspaceId, S_MTG_SEEDED, workspaceId)) return;
    const general = await this.projects.general(workspaceId);
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      const place = await trx
        .insertInto('places')
        .values({
          workspace_id: workspaceId, name: 'The Spot', address: 'Kazanchis, Addis Ababa', notes: null,
          latitude: null, longitude: null, is_default: 1, archived_at: null, created_at: now, updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const base = { workspace_id: workspaceId, project_id: general.id, room_url: null, active: 1, created_at: now, updated_at: now };
      await trx.insertInto('meeting_series').values([
        { ...base, title: 'Weekly sync', weekday: 2, time: '19:00', duration_min: 60, mode: 'virtual', place_id: null, ordinal: 0 },
        { ...base, title: 'Weekly sit-down', weekday: 6, time: '10:00', duration_min: 90, mode: 'in_person', place_id: place.id, ordinal: 1 },
      ]).execute();
      await this.settings.setSystem(workspaceId, S_MTG_SEEDED, workspaceId, true, trx);
    });
  }

  /**
   * Idempotent: makes sure every active slot has a meeting for each of the
   * next 8 weeks, re-times unmoved future meetings after a slot change, and
   * cancels future meetings of paused slots (restoring them if resumed).
   */
  async generate(workspaceId: number): Promise<number[]> {
    const now = this.clock.now();
    const changed: number[] = [];
    const series = await this.db.selectFrom('meeting_series').selectAll().where('workspace_id', '=', workspaceId).execute();
    for (const s of series) {
      const [h, m] = s.time.split(':').map(Number);
      for (const week of horizonWeeks(localDate(now), MEETING_HORIZON_WEEKS)) {
        const start = atLocal(slotDate(week, s.weekday), h!, m!);
        const existing = await this.db
          .selectFrom('meetings').selectAll()
          .where('series_id', '=', s.id).where('week_start', '=', week)
          .executeTakeFirst();
        const stamp = toDb(now);
        if (s.active) {
          if (!existing) {
            if (start.plus({ minutes: s.duration_min }) <= now) continue;
            const r = await this.db
              .insertInto('meetings')
              .values({
                workspace_id: workspaceId, project_id: s.project_id, series_id: s.id, week_start: week, title: null,
                start_at: toDb(start), moved: 0, duration_min: null, mode: null, host_user_id: null, place_id: null,
                meet_url: null, status: 'scheduled', started_at: null, ended_at: null, sequence: 0, created_by: null,
                created_at: stamp, updated_at: stamp,
              })
              .onConflict((oc) => oc.columns(['series_id', 'week_start']).doNothing())
              .returning('id')
              .executeTakeFirst();
            if (r) changed.push(r.id);
          } else if (existing.status === 'cancelled' && start > now) {
            await this.db.updateTable('meetings').set({ status: 'scheduled', sequence: existing.sequence + 1, updated_at: stamp }).where('id', '=', existing.id).execute();
            changed.push(existing.id);
          } else if (existing.status === 'scheduled' && !existing.moved && existing.start_at !== toDb(start) && start > now) {
            await this.db.updateTable('meetings').set({ start_at: toDb(start), sequence: existing.sequence + 1, updated_at: stamp }).where('id', '=', existing.id).execute();
            changed.push(existing.id);
          }
        } else if (existing && existing.status === 'scheduled' && fromDb(existing.start_at) > now) {
          await this.db.updateTable('meetings').set({ status: 'cancelled', sequence: existing.sequence + 1, updated_at: stamp }).where('id', '=', existing.id).execute();
          changed.push(existing.id);
        }
      }
    }
    for (const id of changed) await this.hooks.emit('meeting.changed', { workspaceId, meetingId: id });
    return changed;
  }

  // ---------- reading ----------

  async get(actor: Actor, id: number): Promise<MeetingView> {
    const row = await this.db.selectFrom('meetings').selectAll().where('id', '=', id).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundError();
    await this.permissions.authorize(actor, 'meeting.view', { projectId: row.project_id });
    return (await this.resolve(actor.workspaceId, [row]))[0]!;
  }

  /** Upcoming (including live and skipped ones, so the list shows what changed). */
  async upcoming(actor: Actor, limit = 6): Promise<MeetingView[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    const rows = await this.db
      .selectFrom('meetings').selectAll()
      .where('workspace_id', '=', actor.workspaceId).where('project_id', 'in', visible)
      .where('status', 'in', ['scheduled', 'live', 'skipped'])
      .where('start_at', '>=', toDb(this.clock.now().minus({ hours: 6 })))
      .orderBy('start_at').limit(limit + 4)
      .execute();
    const views = await this.resolve(actor.workspaceId, rows);
    return views.filter((m) => m.status === 'live' || m.end > this.clock.now()).slice(0, limit);
  }

  async next(actor: Actor): Promise<MeetingView | null> {
    return (await this.upcoming(actor, 10)).find((m) => m.status === 'scheduled' || m.status === 'live') ?? null;
  }

  async live(actor: Actor): Promise<MeetingView | null> {
    return (await this.upcoming(actor, 10)).find((m) => m.status === 'live') ?? null;
  }

  async history(actor: Actor, page = 0, pageSize = 8): Promise<{ items: MeetingView[]; total: number }> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return { items: [], total: 0 };
    const q = this.db
      .selectFrom('meetings')
      .where('workspace_id', '=', actor.workspaceId).where('project_id', 'in', visible)
      .where('status', 'in', ['done', 'skipped', 'scheduled'])
      .where('start_at', '<', toDb(this.clock.now()));
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await q.selectAll().orderBy('start_at', 'desc').limit(pageSize).offset(page * pageSize).execute();
    return { items: await this.resolve(actor.workspaceId, rows), total };
  }

  /** Members who may see the meeting — they get its reminders. */
  async attendees(workspaceId: number, projectId: number): Promise<Actor[]> {
    const out: Actor[] = [];
    for (const m of await this.members.list(workspaceId)) {
      const a = { userId: m.user_id, workspaceId };
      if (await this.permissions.can(a, 'meeting.view', { projectId })) out.push(a);
    }
    return out;
  }

  private async resolve(workspaceId: number, rows: MeetingRow[]): Promise<MeetingView[]> {
    if (rows.length === 0) return [];
    const [series, members, places, rsvps] = await Promise.all([
      this.db.selectFrom('meeting_series').selectAll().where('workspace_id', '=', workspaceId).execute(),
      this.members.list(workspaceId),
      this.db.selectFrom('places').selectAll().where('workspace_id', '=', workspaceId).execute(),
      this.db.selectFrom('rsvps').selectAll().where('meeting_id', 'in', rows.map((r) => r.id)).execute(),
    ]);
    const memberIds = members.map((m) => m.user_id); // ordered by seat
    const defaultPlace = places.find((p) => p.is_default && !p.archived_at) ?? null;
    return rows.map((r) => {
      const s = series.find((x) => x.id === r.series_id) ?? null;
      const durationMin = r.duration_min ?? s?.duration_min ?? 60;
      const hostUserId = r.host_user_id ?? (s && r.week_start ? rotationHost(r.week_start, s.ordinal, memberIds) : null);
      const placeId = r.place_id ?? s?.place_id ?? null;
      const start = fromDb(r.start_at);
      const link = r.meet_url ?? s?.room_url ?? null;
      return {
        id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, seriesId: r.series_id, weekStart: r.week_start,
        title: r.title ?? s?.title ?? 'Meeting', start, end: start.plus({ minutes: durationMin }), startAt: r.start_at, durationMin,
        mode: r.mode ?? s?.mode ?? 'virtual', hostUserId, hostName: members.find((m) => m.user_id === hostUserId)?.display_name ?? null,
        place: (placeId ? places.find((p) => p.id === placeId) : null) ?? defaultPlace, link, linkFromRoom: !r.meet_url && !!link,
        status: r.status, moved: r.moved === 1, startedAt: r.started_at, endedAt: r.ended_at, sequence: r.sequence,
        rsvps: rsvps.filter((x) => x.meeting_id === r.id),
      };
    });
  }

  // ---------- per-meeting overrides (never touch the slot) ----------

  private async override(actor: Actor, id: number, field: string, set: Partial<MeetingRow>, data: Record<string, unknown>, allowed: MeetingStatus[] = ['scheduled']): Promise<MeetingView> {
    const m = await this.get(actor, id);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    if (!allowed.includes(m.status)) throw new DomainError('meeting.not_editable');
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('meetings').set({ ...set, sequence: m.sequence + 1, updated_at: now }).where('id', '=', id).execute();
      await trx.insertInto('meeting_exceptions').values({
        workspace_id: actor.workspaceId, meeting_id: id, field, data: JSON.stringify(data), created_by: actor.userId, created_at: now, updated_at: now,
      }).execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: m.projectId, actorUserId: actor.userId,
        entityType: 'meeting', entityId: id, action: `meeting.${field}`, data,
      });
    });
    await this.hooks.emit('meeting.changed', { workspaceId: actor.workspaceId, meetingId: id });
    return this.get(actor, id);
  }

  async skip(actor: Actor, id: number) {
    const m = await this.get(actor, id);
    if (m.status === 'skipped') return { meeting: m, changed: false };
    return { meeting: await this.override(actor, id, 'skip', { status: 'skipped' }, {}), changed: true };
  }

  async unskip(actor: Actor, id: number) {
    const m = await this.get(actor, id);
    if (m.status !== 'skipped') return { meeting: m, changed: false };
    if (m.end <= this.clock.now()) throw new DomainError('meeting.in_past');
    return { meeting: await this.override(actor, id, 'unskip', { status: 'scheduled' }, {}, ['skipped']), changed: true };
  }

  async move(actor: Actor, id: number, start: DateTime) {
    const m = await this.get(actor, id);
    if (start <= this.clock.now()) throw new DomainError('meeting.in_past');
    if (toDb(start) === m.startAt) return { meeting: m, changed: false };
    await this.db.updateTable('meeting_proposals').set({ status: 'superseded', updated_at: toDb(this.clock.now()) })
      .where('meeting_id', '=', id).where('status', '=', 'pending').execute();
    // A new time needs fresh answers.
    await this.db.deleteFrom('rsvps').where('meeting_id', '=', id).execute();
    const meeting = await this.override(actor, id, 'move', { start_at: toDb(start), moved: 1, status: 'scheduled' }, { from: m.startAt, to: toDb(start) }, ['scheduled', 'skipped']);
    return { meeting, changed: true };
  }

  async setMode(actor: Actor, id: number, mode: MeetingMode) {
    if (!MODES.includes(mode)) throw new DomainError('meeting.bad_mode');
    const m = await this.get(actor, id);
    if (m.mode === mode) return { meeting: m, changed: false };
    return { meeting: await this.override(actor, id, 'mode', { mode }, { from: m.mode, to: mode }), changed: true };
  }

  async setHost(actor: Actor, id: number, userId: number) {
    const m = await this.get(actor, id);
    if (!(await this.permissions.can({ userId, workspaceId: actor.workspaceId }, 'meeting.view', { projectId: m.projectId }))) {
      throw new DomainError('task.owner_no_access');
    }
    if (m.hostUserId === userId) return { meeting: m, changed: false };
    return { meeting: await this.override(actor, id, 'host', { host_user_id: userId }, { from: m.hostUserId, to: userId }), changed: true };
  }

  async setPlace(actor: Actor, id: number, placeId: number) {
    const place = await this.placeById(actor.workspaceId, placeId);
    if (!place) throw new NotFoundError();
    const m = await this.get(actor, id);
    if (m.place?.id === placeId) return { meeting: m, changed: false };
    return { meeting: await this.override(actor, id, 'place', { place_id: placeId }, { to: placeId }), changed: true };
  }

  async setLink(actor: Actor, id: number, url: string | null) {
    const link = url === null ? null : normalizeMeetLink(url);
    if (url !== null && !link) throw new DomainError('meeting.bad_link');
    const m = await this.get(actor, id);
    if ((m.linkFromRoom ? null : m.link) === link) return { meeting: m, changed: false };
    return { meeting: await this.override(actor, id, 'link', { meet_url: link }, { set: link !== null }, ['scheduled', 'live']), changed: true };
  }

  async setDuration(actor: Actor, id: number, minutes: number) {
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) throw new DomainError('meeting.bad_length');
    const m = await this.get(actor, id);
    if (m.durationMin === minutes) return { meeting: m, changed: false };
    return { meeting: await this.override(actor, id, 'length', { duration_min: minutes }, { to: minutes }, ['scheduled', 'live']), changed: true };
  }

  /** An extra one-off meeting; slots are untouched. */
  async createExtra(actor: Actor, input: { start: DateTime; mode: MeetingMode; title?: string; durationMin?: number; projectId?: number }): Promise<MeetingView> {
    const projectId = input.projectId ?? (await this.projects.general(actor.workspaceId)).id;
    await this.permissions.authorize(actor, 'meeting.manage', { projectId });
    if (input.start <= this.clock.now()) throw new DomainError('meeting.in_past');
    if (!MODES.includes(input.mode)) throw new DomainError('meeting.bad_mode');
    const now = toDb(this.clock.now());
    const id = await this.db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('meetings').values({
        workspace_id: actor.workspaceId, project_id: projectId, series_id: null, week_start: null,
        title: input.title?.trim() || 'Extra meeting', start_at: toDb(input.start), moved: 0, duration_min: input.durationMin ?? 60,
        mode: input.mode, host_user_id: actor.userId, place_id: null, meet_url: null, status: 'scheduled',
        started_at: null, ended_at: null, sequence: 0, created_by: actor.userId, created_at: now, updated_at: now,
      }).returning('id').executeTakeFirstOrThrow();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId, actorUserId: actor.userId, entityType: 'meeting', entityId: r.id,
        action: 'meeting.created', data: { start: toDb(input.start), mode: input.mode },
      });
      return r.id;
    });
    await this.hooks.emit('meeting.changed', { workspaceId: actor.workspaceId, meetingId: id });
    return this.get(actor, id);
  }

  // ---------- RSVP & reschedule proposals ----------

  async rsvp(actor: Actor, id: number, status: RsvpStatus, lateMinutes: number | null = null) {
    const m = await this.get(actor, id);
    await this.permissions.authorize(actor, 'meeting.view', { projectId: m.projectId });
    if (!['scheduled', 'live'].includes(m.status)) throw new DomainError('meeting.not_editable');
    const late = status === 'late' ? (lateMinutes ?? 10) : null;
    const prev = m.rsvps.find((r) => r.user_id === actor.userId);
    if (prev && prev.status === status && prev.late_minutes === late) return { meeting: m, changed: false };
    const now = toDb(this.clock.now());
    await this.db.insertInto('rsvps')
      .values({ workspace_id: actor.workspaceId, meeting_id: id, user_id: actor.userId, status, late_minutes: late, created_at: now, updated_at: now })
      .onConflict((oc) => oc.columns(['meeting_id', 'user_id']).doUpdateSet({ status, late_minutes: late, updated_at: now }))
      .execute();
    await this.events.record(this.db, {
      workspaceId: actor.workspaceId, projectId: m.projectId, actorUserId: actor.userId, entityType: 'meeting', entityId: id,
      action: 'meeting.rsvp', data: { status, late },
    });
    return { meeting: await this.get(actor, id), changed: true };
  }

  /** Idempotent: the same pending proposal by the same person is returned, not repeated. */
  async propose(actor: Actor, meetingId: number, p: { kind: 'move'; start: DateTime } | { kind: 'skip' }): Promise<{ proposal: ProposalRow; created: boolean }> {
    const m = await this.get(actor, meetingId);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    if (m.status !== 'scheduled') throw new DomainError('meeting.not_editable');
    if (p.kind === 'move' && p.start <= this.clock.now()) throw new DomainError('meeting.in_past');
    const startAt = p.kind === 'move' ? toDb(p.start) : null;
    const same = await this.db.selectFrom('meeting_proposals').selectAll()
      .where('meeting_id', '=', meetingId).where('status', '=', 'pending').where('proposed_by', '=', actor.userId)
      .where('kind', '=', p.kind).where('start_at', startAt === null ? 'is' : '=', startAt)
      .executeTakeFirst();
    if (same) return { proposal: same, created: false };
    const now = toDb(this.clock.now());
    const proposal = await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('meeting_proposals').set({ status: 'superseded', updated_at: now })
        .where('meeting_id', '=', meetingId).where('status', '=', 'pending').execute();
      const row = await trx.insertInto('meeting_proposals').values({
        workspace_id: actor.workspaceId, meeting_id: meetingId, proposed_by: actor.userId, kind: p.kind,
        start_at: p.kind === 'move' ? toDb(p.start) : null, status: 'pending', decided_by: null, created_at: now, updated_at: now,
      }).returningAll().executeTakeFirstOrThrow();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: m.projectId, actorUserId: actor.userId, entityType: 'meeting', entityId: meetingId,
        action: 'meeting.proposed', data: { kind: p.kind, start: row.start_at },
      });
      return row;
    });
    return { proposal, created: true };
  }

  async proposal(workspaceId: number, id: number): Promise<ProposalRow | undefined> {
    return this.db.selectFrom('meeting_proposals').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst();
  }

  /** The other person accepts or declines — in one tap, exactly once. */
  async decide(actor: Actor, proposalId: number, accept: boolean): Promise<{ proposal: ProposalRow; changed: boolean; meeting: MeetingView }> {
    const p = await this.proposal(actor.workspaceId, proposalId);
    if (!p) throw new NotFoundError();
    const m = await this.get(actor, p.meeting_id);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    if (p.proposed_by === actor.userId) throw new DomainError('meeting.own_proposal');
    const now = toDb(this.clock.now());
    const r = await this.db.updateTable('meeting_proposals')
      .set({ status: accept ? 'accepted' : 'declined', decided_by: actor.userId, updated_at: now })
      .where('id', '=', proposalId).where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return { proposal: (await this.proposal(actor.workspaceId, proposalId))!, changed: false, meeting: m };
    let meeting = m;
    if (accept && p.kind === 'move' && p.start_at) {
      const start = fromDb(p.start_at);
      if (start <= this.clock.now()) throw new DomainError('meeting.in_past');
      await this.move(actor, m.id, start);
      // The proposer suggested this time, so they are going.
      const stamp = toDb(this.clock.now());
      await this.db.insertInto('rsvps')
        .values({ workspace_id: actor.workspaceId, meeting_id: m.id, user_id: p.proposed_by, status: 'going', late_minutes: null, created_at: stamp, updated_at: stamp })
        .onConflict((oc) => oc.columns(['meeting_id', 'user_id']).doUpdateSet({ status: 'going', late_minutes: null, updated_at: stamp }))
        .execute();
      meeting = await this.get(actor, m.id);
    } else if (accept && p.kind === 'skip') meeting = (await this.skip(actor, m.id)).meeting;
    await this.events.record(this.db, {
      workspaceId: actor.workspaceId, projectId: m.projectId, actorUserId: actor.userId, entityType: 'meeting', entityId: m.id,
      action: accept ? 'meeting.proposal_accepted' : 'meeting.proposal_declined', data: { proposalId },
    });
    return { proposal: (await this.proposal(actor.workspaceId, proposalId))!, changed: true, meeting };
  }

  // ---------- agenda ----------

  private async taskCandidates(actor: Actor, m: MeetingView): Promise<AgendaCandidate[]> {
    const project = await this.projects.get(actor, m.projectId);
    const projectId = project.is_general ? null : project.id; // company meetings look across projects
    const out: AgendaCandidate[] = [];
    const blocked = await this.tasks.list(actor, { owner: 'all', projectId, status: 'blocked', due: 'any' }, 0, 20);
    for (const t of blocked.items) out.push({ refType: 'task', refId: t.id, text: t.title, rank: 10 });
    const overdue = await this.tasks.list(actor, { owner: 'all', projectId, status: 'open', due: 'overdue' }, 0, 20);
    for (const t of overdue.items) out.push({ refType: 'task', refId: t.id, text: t.title, rank: t.priority === 'high' ? 20 : t.priority === 'normal' ? 30 : 40 });
    // Last meeting's action items that are still open.
    const prev = await this.previousMeeting(m);
    if (prev) {
      const outs = await this.db.selectFrom('meeting_outcomes').select(['task_id']).where('meeting_id', '=', prev.id).where('kind', '=', 'task').execute();
      for (const o of outs) {
        if (!o.task_id) continue;
        try {
          const t = await this.tasks.get(actor, o.task_id);
          if (t.status !== 'done') out.push({ refType: 'task', refId: t.id, text: t.title, rank: 25 });
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
        }
      }
    }
    return out;
  }

  private async previousMeeting(m: MeetingView): Promise<MeetingRow | undefined> {
    let q = this.db.selectFrom('meetings').selectAll()
      .where('workspace_id', '=', m.workspaceId).where('status', '=', 'done').where('start_at', '<', m.startAt);
    if (m.seriesId) q = q.where('series_id', '=', m.seriesId);
    return q.orderBy('start_at', 'desc').executeTakeFirst();
  }

  private async nextMeetingAfter(m: MeetingView): Promise<MeetingRow | undefined> {
    let q = this.db.selectFrom('meetings').selectAll()
      .where('workspace_id', '=', m.workspaceId).where('status', '=', 'scheduled').where('start_at', '>', m.startAt).where('id', '!=', m.id);
    if (m.seriesId) q = q.where('series_id', '=', m.seriesId);
    return q.orderBy('start_at').executeTakeFirst();
  }

  /** Adds new candidates (idempotent). Existing items, manual ones and their order are kept. */
  async ensureAgenda(actor: Actor, id: number): Promise<void> {
    const m = await this.get(actor, id);
    if (m.status !== 'scheduled' && m.status !== 'live') return;
    const candidates = (await Promise.all(this.sources.map((s) => s(actor, m)))).flat();
    const seen = new Set<string>();
    const now = toDb(this.clock.now());
    for (const [i, c] of candidates.sort((a, b) => a.rank - b.rank).entries()) {
      const key = `${c.refType}:${c.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.db.insertInto('agenda_items').values({
        workspace_id: actor.workspaceId, meeting_id: id, source: 'auto', ref_type: c.refType, ref_id: c.refId, text: c.text,
        position: c.rank * 1000 + i, status: 'open', created_by: null, created_at: now, updated_at: now,
      }).onConflict((oc) => oc.columns(['meeting_id', 'ref_type', 'ref_id']).doNothing()).execute();
    }
  }

  async agenda(actor: Actor, id: number): Promise<AgendaItemView[]> {
    await this.get(actor, id);
    const rows = await this.db.selectFrom('agenda_items').selectAll()
      .where('meeting_id', '=', id).where('status', '!=', 'dropped')
      .orderBy('position').orderBy('id').execute();
    const out: AgendaItemView[] = [];
    for (const r of rows) {
      let task: TaskView | null = null;
      if (r.ref_type === 'task' && r.ref_id) {
        try {
          task = await this.tasks.get(actor, r.ref_id);
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          continue; // deleted or no longer visible
        }
      }
      out.push({ ...r, task });
    }
    return out;
  }

  async addAgendaItem(actor: Actor, id: number, text: string): Promise<AgendaRow> {
    const m = await this.get(actor, id);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    const clean = text.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 300) throw new DomainError('meeting.bad_text');
    const max = await this.db.selectFrom('agenda_items').select((eb) => eb.fn.max('position').as('p')).where('meeting_id', '=', id).executeTakeFirst();
    const now = toDb(this.clock.now());
    return this.db.insertInto('agenda_items').values({
      workspace_id: actor.workspaceId, meeting_id: id, source: 'manual', ref_type: null, ref_id: null, text: clean,
      position: Number(max?.p ?? 0) + 1000, status: 'open', created_by: actor.userId, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async agendaItem(actor: Actor, itemId: number): Promise<AgendaRow> {
    const r = await this.db.selectFrom('agenda_items').selectAll().where('id', '=', itemId).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!r) throw new NotFoundError();
    await this.get(actor, r.meeting_id);
    return r;
  }

  /** done / open / drop are idempotent; up swaps with the previous item. */
  async updateAgendaItem(actor: Actor, itemId: number, action: 'done' | 'open' | 'drop' | 'up'): Promise<AgendaRow> {
    const item = await this.agendaItem(actor, itemId);
    const m = await this.get(actor, item.meeting_id);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    const now = toDb(this.clock.now());
    if (action === 'up') {
      const prev = await this.db.selectFrom('agenda_items').selectAll()
        .where('meeting_id', '=', item.meeting_id).where('status', '!=', 'dropped').where('position', '<', item.position)
        .orderBy('position', 'desc').executeTakeFirst();
      if (prev) {
        await this.db.transaction().execute(async (trx) => {
          await trx.updateTable('agenda_items').set({ position: prev.position, updated_at: now }).where('id', '=', item.id).execute();
          await trx.updateTable('agenda_items').set({ position: item.position, updated_at: now }).where('id', '=', prev.id).execute();
        });
      }
    } else {
      const status = action === 'drop' ? 'dropped' : action;
      await this.db.updateTable('agenda_items').set({ status, updated_at: now }).where('id', '=', itemId).execute();
    }
    return this.agendaItem(actor, itemId);
  }

  // ---------- outcomes, start / end, summary ----------

  async addOutcome(actor: Actor, meetingId: number, kind: OutcomeKind, text: string, taskId: number | null = null): Promise<OutcomeRow> {
    const m = await this.get(actor, meetingId);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    if (m.status === 'cancelled' || m.status === 'skipped') throw new DomainError('meeting.not_editable');
    const clean = text.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 500) throw new DomainError('meeting.bad_text');
    const now = toDb(this.clock.now());
    const row = await this.db.insertInto('meeting_outcomes').values({
      workspace_id: actor.workspaceId, meeting_id: meetingId, kind, text: clean, task_id: taskId, created_by: actor.userId, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    await this.events.record(this.db, {
      workspaceId: actor.workspaceId, projectId: m.projectId, actorUserId: actor.userId, entityType: 'meeting', entityId: meetingId,
      action: `meeting.outcome.${kind}`, data: { outcomeId: row.id, taskId },
    });
    const attendees = (await this.attendees(actor.workspaceId, m.projectId)).map((a) => a.userId);
    await this.hooks.emit('meeting.outcome', { workspaceId: actor.workspaceId, meetingId, projectId: m.projectId, kind, text: clean, actorUserId: actor.userId, attendees });
    return row;
  }

  async outcomes(actor: Actor, meetingId: number): Promise<OutcomeRow[]> {
    await this.get(actor, meetingId);
    return this.db.selectFrom('meeting_outcomes').selectAll().where('meeting_id', '=', meetingId).orderBy('id').execute();
  }

  async start(actor: Actor, id: number) {
    const m = await this.get(actor, id);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    if (m.status === 'live') return { meeting: m, changed: false };
    if (m.status !== 'scheduled') throw new DomainError('meeting.not_editable');
    const now = toDb(this.clock.now());
    await this.db.updateTable('meetings').set({ status: 'live', started_at: now, updated_at: now }).where('id', '=', id).where('status', '=', 'scheduled').execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: m.projectId, actorUserId: actor.userId, entityType: 'meeting', entityId: id, action: 'meeting.started' });
    await this.hooks.emit('meeting.changed', { workspaceId: actor.workspaceId, meetingId: id });
    return { meeting: await this.get(actor, id), changed: true };
  }

  /** End a meeting; open questions are carried to the next meeting's agenda. Safe to repeat. */
  async end(actor: Actor, id: number) {
    const m = await this.get(actor, id);
    await this.permissions.authorize(actor, 'meeting.manage', { projectId: m.projectId });
    if (m.status === 'done') return { meeting: m, changed: false };
    if (m.status !== 'live' && m.status !== 'scheduled') throw new DomainError('meeting.not_editable');
    const now = toDb(this.clock.now());
    const r = await this.db.updateTable('meetings')
      .set({ status: 'done', ended_at: now, started_at: m.startedAt ?? m.startAt, updated_at: now })
      .where('id', '=', id).where('status', 'in', ['live', 'scheduled']).executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return { meeting: await this.get(actor, id), changed: false };
    const next = await this.nextMeetingAfter(m);
    if (next) {
      const questions = await this.db.selectFrom('meeting_outcomes').selectAll().where('meeting_id', '=', id).where('kind', '=', 'question').execute();
      for (const [i, q] of questions.entries()) {
        await this.db.insertInto('agenda_items').values({
          workspace_id: actor.workspaceId, meeting_id: next.id, source: 'carry', ref_type: 'outcome', ref_id: q.id, text: q.text,
          position: 15_000 + i, status: 'open', created_by: actor.userId, created_at: now, updated_at: now,
        }).onConflict((oc) => oc.columns(['meeting_id', 'ref_type', 'ref_id']).doNothing()).execute();
      }
    }
    await this.events.record(this.db, { workspaceId: actor.workspaceId, projectId: m.projectId, actorUserId: actor.userId, entityType: 'meeting', entityId: id, action: 'meeting.ended' });
    await this.hooks.emit('meeting.changed', { workspaceId: actor.workspaceId, meetingId: id });
    return { meeting: await this.get(actor, id), changed: true };
  }

  async summary(actor: Actor, id: number): Promise<MeetingSummary> {
    const meeting = await this.get(actor, id);
    const outs = await this.outcomes(actor, id);
    const tasks: TaskView[] = [];
    for (const o of outs.filter((x) => x.kind === 'task' && x.task_id)) {
      try {
        tasks.push(await this.tasks.get(actor, o.task_id!));
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
      }
    }
    const next = await this.nextMeetingAfter(meeting);
    return {
      meeting, tasks,
      decisions: outs.filter((o) => o.kind === 'decision'),
      questions: outs.filter((o) => o.kind === 'question'),
      notes: outs.filter((o) => o.kind === 'note'),
      carriedTo: next ? (await this.resolve(actor.workspaceId, [next]))[0]! : null,
    };
  }

  // ---------- slots ----------

  async series(actor: Actor): Promise<SeriesRow[]> {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    return this.db.selectFrom('meeting_series').selectAll().where('workspace_id', '=', actor.workspaceId).where('project_id', 'in', visible).orderBy('weekday').orderBy('time').execute();
  }

  async seriesById(actor: Actor, id: number): Promise<SeriesRow> {
    const s = await this.db.selectFrom('meeting_series').selectAll().where('id', '=', id).where('workspace_id', '=', actor.workspaceId).executeTakeFirst();
    if (!s) throw new NotFoundError();
    await this.permissions.authorize(actor, 'meeting.view', { projectId: s.project_id });
    return s;
  }

  /** Change a slot. Future meetings follow, except fields overridden per meeting. */
  async updateSeries(actor: Actor, id: number, patch: Partial<Pick<SeriesRow, 'title' | 'weekday' | 'time' | 'duration_min' | 'mode' | 'place_id' | 'room_url' | 'active'>>): Promise<SeriesRow> {
    const s = await this.seriesById(actor, id);
    await this.permissions.authorize(actor, 'meeting.series', { projectId: s.project_id });
    if (patch.weekday !== undefined && !(Number.isInteger(patch.weekday) && patch.weekday >= 1 && patch.weekday <= 7)) throw new DomainError('meeting.bad_day');
    if (patch.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.time)) throw new DomainError('rs.bad_time');
    if (patch.duration_min !== undefined && !(patch.duration_min >= 15 && patch.duration_min <= 480)) throw new DomainError('meeting.bad_length');
    if (patch.mode !== undefined && !MODES.includes(patch.mode)) throw new DomainError('meeting.bad_mode');
    if (patch.room_url) {
      const link = normalizeMeetLink(patch.room_url);
      if (!link) throw new DomainError('meeting.bad_link');
      patch.room_url = link;
    }
    if (patch.place_id != null && !(await this.placeById(actor.workspaceId, patch.place_id))) throw new NotFoundError();
    const changes = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && v !== s[k as keyof SeriesRow]));
    if (Object.keys(changes).length === 0) return s;
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('meeting_series').set({ ...changes, updated_at: now }).where('id', '=', id).execute();
      await this.events.record(trx, {
        workspaceId: actor.workspaceId, projectId: s.project_id, actorUserId: actor.userId, entityType: 'meeting_series', entityId: id,
        action: 'meeting_series.updated', data: { changes },
      });
    });
    // Bump future meetings so calendars and reminders pick up resolved changes.
    await this.db.updateTable('meetings').set((eb) => ({ sequence: eb('sequence', '+', 1), updated_at: now }))
      .where('series_id', '=', id).where('status', '=', 'scheduled').where('start_at', '>', now).execute();
    const future = await this.db.selectFrom('meetings').select('id').where('series_id', '=', id).where('start_at', '>', now).execute();
    const retimed = new Set(await this.generate(actor.workspaceId));
    for (const f of future) if (!retimed.has(f.id)) await this.hooks.emit('meeting.changed', { workspaceId: actor.workspaceId, meetingId: f.id });
    return this.seriesById(actor, id);
  }

  // ---------- places ----------

  async places(actor: Actor): Promise<PlaceRow[]> {
    await this.permissions.authorize(actor, 'meeting.view');
    return this.db.selectFrom('places').selectAll().where('workspace_id', '=', actor.workspaceId).where('archived_at', 'is', null)
      .orderBy('is_default', 'desc').orderBy('name').execute();
  }

  async placeById(workspaceId: number, id: number): Promise<PlaceRow | undefined> {
    return this.db.selectFrom('places').selectAll().where('workspace_id', '=', workspaceId).where('id', '=', id).where('archived_at', 'is', null).executeTakeFirst();
  }

  async createPlace(actor: Actor, input: { name: string; address?: string | null }): Promise<PlaceRow> {
    await this.permissions.authorize(actor, 'meeting.manage');
    const name = input.name.trim();
    if (!name || name.length > 80) throw new DomainError('meeting.bad_text');
    const now = toDb(this.clock.now());
    return this.db.insertInto('places').values({
      workspace_id: actor.workspaceId, name, address: input.address?.trim() || null, notes: null, latitude: null, longitude: null,
      is_default: 0, archived_at: null, created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async updatePlace(actor: Actor, id: number, patch: Partial<Pick<PlaceRow, 'name' | 'address' | 'notes' | 'latitude' | 'longitude'>>): Promise<PlaceRow> {
    await this.permissions.authorize(actor, 'meeting.manage');
    const p = await this.placeById(actor.workspaceId, id);
    if (!p) throw new NotFoundError();
    if (patch.name !== undefined && (!patch.name?.trim() || patch.name.length > 80)) throw new DomainError('meeting.bad_text');
    if (patch.latitude != null && (patch.latitude < -90 || patch.latitude > 90)) throw new DomainError('meeting.bad_pin');
    if (patch.longitude != null && (patch.longitude < -180 || patch.longitude > 180)) throw new DomainError('meeting.bad_pin');
    await this.db.updateTable('places').set({ ...patch, updated_at: toDb(this.clock.now()) }).where('id', '=', id).execute();
    await this.events.record(this.db, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'place', entityId: id, action: 'place.updated', data: { fields: Object.keys(patch) } });
    return (await this.placeById(actor.workspaceId, id))!;
  }

  async setDefaultPlace(actor: Actor, id: number): Promise<void> {
    await this.permissions.authorize(actor, 'meeting.series');
    if (!(await this.placeById(actor.workspaceId, id))) throw new NotFoundError();
    const now = toDb(this.clock.now());
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('places').set({ is_default: 0, updated_at: now }).where('workspace_id', '=', actor.workspaceId).execute();
      await trx.updateTable('places').set({ is_default: 1, updated_at: now }).where('id', '=', id).execute();
    });
  }

  async search(actor: Actor, pattern: string, limit: number) {
    const visible = await this.permissions.visibleProjectIds(actor);
    if (!visible.length) return [];
    const byOutcome = await this.db.selectFrom('meeting_outcomes as o').innerJoin('meetings as m', 'm.id', 'o.meeting_id')
      .select(['m.id', 'o.text', 'o.kind', 'm.start_at'])
      .where('m.workspace_id', '=', actor.workspaceId).where('m.project_id', 'in', visible)
      .where((eb) => eb(eb.fn('lower', ['o.text']), 'like', pattern)).orderBy('m.start_at', 'desc').limit(limit).execute();
    const byTitle = await this.db.selectFrom('meetings as m').leftJoin('meeting_series as s', 's.id', 'm.series_id')
      .select(['m.id', 'm.start_at', 'm.title', 's.title as series_title'])
      .where('m.workspace_id', '=', actor.workspaceId).where('m.project_id', 'in', visible).where('m.status', '!=', 'cancelled')
      .where((eb) => eb.or([eb(eb.fn('lower', ['m.title']), 'like', pattern), eb(eb.fn('lower', ['s.title']), 'like', pattern)]))
      .where('m.start_at', '<=', toDb(this.clock.now().plus({ weeks: 2 })))
      .orderBy('m.start_at', 'desc').limit(limit).execute();
    const hits = [
      ...byOutcome.map((r) => ({ type: 'meeting', id: r.id, title: r.text, snippet: r.kind, date: r.start_at, projectCode: null })),
      ...byTitle.map((r) => ({ type: 'meeting', id: r.id, title: r.title ?? r.series_title ?? 'Meeting', snippet: null, date: r.start_at, projectCode: null })),
    ];
    return hits.slice(0, limit);
  }

  /**
   * System path for a Meet link created by the Google Calendar integration.
   * Only fills an empty link (a link typed by a person always wins). Logged.
   */
  async setGeneratedLink(workspaceId: number, meetingId: number, url: string): Promise<boolean> {
    const link = normalizeMeetLink(url);
    const row = await this.db.selectFrom('meetings').selectAll().where('id', '=', meetingId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!link || !row || row.meet_url) return false;
    const now = toDb(this.clock.now());
    const r = await this.db.updateTable('meetings').set({ meet_url: link, sequence: row.sequence + 1, updated_at: now })
      .where('id', '=', meetingId).where('meet_url', 'is', null).executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return false;
    await this.db.insertInto('meeting_exceptions').values({ workspace_id: workspaceId, meeting_id: meetingId, field: 'link', data: JSON.stringify({ auto: 'google' }), created_by: null, created_at: now, updated_at: now }).execute();
    await this.events.record(this.db, { workspaceId, projectId: row.project_id, entityType: 'meeting', entityId: meetingId, action: 'meeting.link_auto', data: { source: 'google' } });
    await this.hooks.emit('meeting.changed', { workspaceId, meetingId });
    return true;
  }

  /** Called on 'task.linked': record an action item created during a meeting. */
  async recordLinkedTask(actor: Actor, meetingId: number, taskId: number): Promise<void> {
    const t = await this.tasks.get(actor, taskId);
    await this.addOutcome(actor, meetingId, 'task', t.title, taskId);
  }
}

// ---------- reminder planning ----------

export const MTG_JOB = {
  remind: 'meeting.remind',
  link: 'meeting.link',
  wrap: 'meeting.wrap',
  generate: 'meetings.generate',
} as const;

export type ReminderSlot = 'eve' | `b${number}` | 'start';
export interface MeetingJobPayload {
  meetingId: number;
  slot: ReminderSlot | 'link' | 'wrap';
  /** start_at when planned; a mismatch at fire time means the meeting moved. */
  startKey: string;
}

/** Keeps meeting reminder jobs in step with meetings (idempotent). */
export class MeetingPlanner {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: Jobs,
    private readonly settings: Settings,
    private readonly meetings: MeetingService,
  ) {}

  async syncMeeting(workspaceId: number, meetingId: number): Promise<void> {
    const prefix = `mtg:${meetingId}:`;
    const row = await this.db.selectFrom('meetings').selectAll().where('id', '=', meetingId).executeTakeFirst();
    if (!row || !['scheduled', 'live'].includes(row.status)) {
      await this.jobs.cancelPrefix(workspaceId, prefix);
      return;
    }
    const attendees = await this.meetings.attendees(workspaceId, row.project_id);
    if (!attendees[0]) return this.jobs.cancelPrefix(workspaceId, prefix);
    const m = await this.meetings.get(attendees[0], meetingId);
    const now = this.clock.now();
    const keep: string[] = [];
    const put = async (slot: MeetingJobPayload['slot'], kind: string, at: DateTime) => {
      if (at <= now) return;
      const key = `${prefix}${slot}`;
      keep.push(key);
      await this.jobs.upsert(workspaceId, key, { kind, payload: { meetingId, slot, startKey: m.startAt } satisfies MeetingJobPayload, at });
    };
    if (m.status === 'scheduled') {
      const evening = await this.settings.get(workspaceId, S_MTG_EVENING, workspaceId);
      if (evening) {
        const [h, mi] = evening.split(':').map(Number);
        const eve = m.start.setZone(getZone()).minus({ days: 1 }).set({ hour: h!, minute: mi!, second: 0, millisecond: 0 });
        if (eve < m.start.minus({ hours: 3 })) await put('eve', MTG_JOB.remind, eve);
      }
      for (const off of await this.settings.get(workspaceId, S_MTG_OFFSETS, workspaceId)) {
        await put(off === 0 ? 'start' : `b${off}`, MTG_JOB.remind, m.start.minus({ minutes: off }));
      }
      if (m.mode === 'virtual') {
        await put('link', MTG_JOB.link, m.start.minus({ minutes: await this.settings.get(workspaceId, S_MTG_LINK_CHECK, workspaceId) }));
      }
    }
    await put('wrap', MTG_JOB.wrap, m.end);
    await this.jobs.cancelPrefix(workspaceId, prefix, keep);
  }

  async syncAll(workspaceId: number): Promise<void> {
    const rows = await this.db.selectFrom('meetings').select('id')
      .where('workspace_id', '=', workspaceId).where('status', 'in', ['scheduled', 'live'])
      .where('start_at', '>', toDb(this.clock.now().minus({ hours: 12 })))
      .execute();
    for (const r of rows) await this.syncMeeting(workspaceId, r.id);
    await this.ensureGenerateJob(workspaceId);
  }

  /** Daily 03:00 job that tops up the 8-week horizon. */
  async ensureGenerateJob(workspaceId: number): Promise<void> {
    const key = 'meetings:generate';
    const job = await this.jobs.get(workspaceId, key);
    if (job?.status === 'active') return;
    await this.jobs.upsert(workspaceId, key, { kind: MTG_JOB.generate, payload: { workspaceId }, at: nextThreeAm(this.clock.now()) });
  }
}

export function nextThreeAm(now: DateTime): DateTime {
  let t = now.setZone(getZone()).set({ hour: 3, minute: 0, second: 0, millisecond: 0 });
  if (t <= now) t = t.plus({ days: 1 });
  return t;
}

export function sameActorOrThrow(a: Actor, userId: number): void {
  if (a.userId !== userId) throw new ForbiddenError();
}
