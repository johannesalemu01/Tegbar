import { createHash, randomBytes } from 'node:crypto';
import type { Generated, Kysely, Selectable } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { App } from '../../app.js';
import { open, seal } from '../../core/crypto/secretbox.js';
import { withId, withStamps, withWorkspace } from '../../core/db/migrations.js';
import { DomainError } from '../../core/errors.js';
import type { Actor } from '../../core/services/context.js';
import { defineFlag } from '../../core/services/flags.js';
import { defineSetting } from '../../core/services/settings.js';
import { getZone, toDb } from '../../core/time.js';
import type { MeetingView } from '../meetings/service.js';
import { GoogleError, eventIdFor, meetUrlOf, type GoogleClient, type GoogleEvent } from './google.js';

export const FLAG_GCAL = defineFlag('gcal', false, 'Google Calendar sync with automatic Meet links');
const isEmail = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(v));
/** Each member's Google address, added as an attendee so the event lands in their own calendar. */
export const S_GOOGLE_EMAIL = defineSetting<string | null>({ key: 'google_email', scope: 'user', default: null, validate: isEmail });

export interface IntegrationsTable {
  id: Generated<number>;
  workspace_id: number;
  provider: string;
  account: string;
  /** sealed refresh token (see core/crypto/secretbox) — never plain text */
  secret: string;
  status: 'active' | 'needs_reconnect';
  last_error: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
}
export interface OAuthStatesTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  state_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface GcalEventsTable {
  id: Generated<number>;
  workspace_id: number;
  meeting_id: number;
  event_id: string;
  synced_hash: string;
  created_at: string;
  updated_at: string;
}
declare module '../../core/db/schema.js' {
  interface DB {
    integrations: IntegrationsTable;
    oauth_states: OAuthStatesTable;
    gcal_events: GcalEventsTable;
  }
}
export type Integration = Selectable<IntegrationsTable>;

export const gcalMigrations: Record<string, Migration> = {
  '202611151100_gcal_init': {
    async up(db: Kysely<any>) {
      await withStamps(withWorkspace(withId(db.schema.createTable('integrations')))
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('account', 'text', (c) => c.notNull())
        .addColumn('secret', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('last_error', 'text')
        .addColumn('created_by', 'integer', (c) => c.notNull().references('users.id'))
        .addUniqueConstraint('integrations_one', ['workspace_id', 'provider'])).execute();
      await withStamps(withWorkspace(withId(db.schema.createTable('oauth_states')))
        .addColumn('user_id', 'integer', (c) => c.notNull().references('users.id'))
        .addColumn('state_hash', 'text', (c) => c.notNull().unique())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('used_at', 'text')).execute();
      await withStamps(withWorkspace(withId(db.schema.createTable('gcal_events')))
        .addColumn('meeting_id', 'integer', (c) => c.notNull().unique().references('meetings.id').onDelete('cascade'))
        .addColumn('event_id', 'text', (c) => c.notNull())
        .addColumn('synced_hash', 'text', (c) => c.notNull())).execute();
    },
    async down(db: Kysely<any>) {
      for (const t of ['gcal_events', 'oauth_states', 'integrations']) await db.schema.dropTable(t).ifExists().execute();
    },
  },
};

export const GCAL_JOB = { sync: 'gcal.sync', link: 'gcal.link', alert: 'gcal.alert' } as const;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class GcalService {
  private tokens = new Map<number, { token: string; exp: number }>();

  constructor(private readonly app: App, private readonly google: GoogleClient | null, private readonly key: Buffer | null) {}

  get configured(): boolean {
    return !!this.google && !!this.key;
  }

  async integration(workspaceId: number): Promise<Integration | undefined> {
    return this.app.db.selectFrom('integrations').selectAll().where('workspace_id', '=', workspaceId).where('provider', '=', 'google').executeTakeFirst();
  }

  /** Active = feature on + connected + grant still valid. */
  async active(workspaceId: number): Promise<boolean> {
    if (!this.configured || !(await this.app.flags.isEnabled(workspaceId, FLAG_GCAL))) return false;
    return (await this.integration(workspaceId))?.status === 'active';
  }

  // ---------- connect / disconnect ----------

  async startConnect(actor: Actor): Promise<string> {
    await this.app.permissions.authorize(actor, 'workspace.manage');
    if (!this.configured) throw new DomainError('gcal.not_configured');
    const state = randomBytes(24).toString('base64url');
    const now = this.app.clock.now();
    await this.app.db.insertInto('oauth_states').values({
      workspace_id: actor.workspaceId, user_id: actor.userId, state_hash: sha(state), expires_at: toDb(now.plus({ minutes: 10 })), used_at: null,
      created_at: toDb(now), updated_at: toDb(now),
    }).execute();
    return this.google!.authUrl(state);
  }

  /** OAuth callback. The state is single-use, expires in 10 minutes and is bound to the owner who started it. */
  async finishConnect(state: string, code: string): Promise<{ workspaceId: number; userId: number; account: string }> {
    if (!this.configured) throw new DomainError('gcal.not_configured');
    const now = toDb(this.app.clock.now());
    const row = await this.app.db.selectFrom('oauth_states').selectAll().where('state_hash', '=', sha(state)).executeTakeFirst();
    if (!row || row.used_at || row.expires_at < now) throw new DomainError('gcal.bad_state');
    const used = await this.app.db.updateTable('oauth_states').set({ used_at: now, updated_at: now }).where('id', '=', row.id).where('used_at', 'is', null).executeTakeFirst();
    if (Number(used.numUpdatedRows) !== 1) throw new DomainError('gcal.bad_state');
    const actor = { userId: row.user_id, workspaceId: row.workspace_id };
    await this.app.permissions.authorize(actor, 'workspace.manage');

    const t = await this.google!.exchangeCode(code);
    if (!t.refreshToken) throw new DomainError('gcal.no_refresh');
    const account = await this.google!.primaryCalendarId(t.accessToken);
    const sealed = seal(t.refreshToken, this.key!);
    await this.app.db.insertInto('integrations').values({
      workspace_id: row.workspace_id, provider: 'google', account, secret: sealed, status: 'active', last_error: null, created_by: row.user_id, created_at: now, updated_at: now,
    }).onConflict((oc) => oc.columns(['workspace_id', 'provider']).doUpdateSet({ account, secret: sealed, status: 'active', last_error: null, created_by: row.user_id, updated_at: now })).execute();
    this.tokens.set(row.workspace_id, { token: t.accessToken, exp: Date.now() + (t.expiresIn - 60) * 1000 });
    await this.app.events.record(this.app.db, { workspaceId: row.workspace_id, actorUserId: row.user_id, entityType: 'integration', action: 'gcal.connected', data: { account } });
    await this.syncAll(row.workspace_id);
    return { ...actor, account };
  }

  async disconnect(actor: Actor): Promise<{ changed: boolean }> {
    await this.app.permissions.authorize(actor, 'workspace.manage');
    const i = await this.integration(actor.workspaceId);
    if (!i) return { changed: false };
    if (this.key && this.google) await this.google.revoke(open(i.secret, this.key)).catch(() => undefined);
    await this.app.db.deleteFrom('integrations').where('id', '=', i.id).execute();
    this.tokens.delete(actor.workspaceId);
    await this.app.jobs.cancelPrefix(actor.workspaceId, 'gcal:');
    await this.app.events.record(this.app.db, { workspaceId: actor.workspaceId, actorUserId: actor.userId, entityType: 'integration', action: 'gcal.disconnected' });
    return { changed: true };
  }

  private async accessToken(workspaceId: number): Promise<string> {
    const cached = this.tokens.get(workspaceId);
    if (cached && cached.exp > Date.now()) return cached.token;
    const i = await this.integration(workspaceId);
    if (!i || i.status !== 'active') throw new DomainError('gcal.not_connected');
    try {
      const r = await this.google!.refresh(open(i.secret, this.key!));
      this.tokens.set(workspaceId, { token: r.accessToken, exp: Date.now() + (r.expiresIn - 60) * 1000 });
      return r.accessToken;
    } catch (err) {
      if (err instanceof GoogleError && err.needsReconnect) await this.markBroken(workspaceId, err.message);
      throw err;
    }
  }

  private async markBroken(workspaceId: number, reason: string): Promise<void> {
    const now = this.app.clock.now();
    const r = await this.app.db.updateTable('integrations').set({ status: 'needs_reconnect', last_error: reason.slice(0, 200), updated_at: toDb(now) })
      .where('workspace_id', '=', workspaceId).where('provider', '=', 'google').where('status', '=', 'active').executeTakeFirst();
    this.tokens.delete(workspaceId);
    if (Number(r.numUpdatedRows) === 1) {
      await this.app.jobs.upsert(workspaceId, `gcal-alert:${toDb(now)}`, { kind: GCAL_JOB.alert, payload: { reason: reason.slice(0, 200) }, at: now });
    }
  }

  // ---------- sync ----------

  /** Queue a sync of every upcoming meeting (coalesced per meeting). */
  async syncAll(workspaceId: number): Promise<number> {
    const rows = await this.app.db.selectFrom('meetings').select('id').where('workspace_id', '=', workspaceId)
      .where('start_at', '>', toDb(this.app.clock.now().minus({ hours: 2 }))).execute();
    for (const r of rows) await this.queue(workspaceId, r.id);
    return rows.length;
  }

  async queue(workspaceId: number, meetingId: number, delaySec = 0, attempt = 0): Promise<void> {
    await this.app.jobs.upsert(workspaceId, `gcal:${meetingId}`, { kind: GCAL_JOB.sync, payload: { meetingId, attempt }, at: this.app.clock.now().plus({ seconds: delaySec }) });
  }

  private async emails(workspaceId: number, attendees: Actor[]): Promise<string[]> {
    const out: string[] = [];
    for (const a of attendees) {
      const e = await this.app.settings.get(workspaceId, S_GOOGLE_EMAIL, a.userId);
      if (e) out.push(e.toLowerCase());
    }
    return [...new Set(out)];
  }

  desired(m: MeetingView, emails: string[]): Record<string, unknown> {
    const cancelled = m.status === 'skipped' || m.status === 'cancelled';
    const where = m.mode === 'in_person' && m.place ? [m.place.name, m.place.address].filter(Boolean).join(', ') : undefined;
    return {
      summary: m.title,
      description: [
        m.mode === 'virtual' ? 'Virtual meeting' : 'In person',
        m.hostName ? `Host: ${m.hostName}` : '',
        'Agenda, RSVP and notes are in Tegbar (Telegram).',
      ].filter(Boolean).join('\n'),
      start: { dateTime: m.start.toUTC().toISO(), timeZone: getZone() },
      end: { dateTime: m.end.toUTC().toISO(), timeZone: getZone() },
      ...(where ? { location: where } : {}),
      status: cancelled ? 'cancelled' : 'confirmed',
      attendees: emails.map((email) => ({ email })),
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    };
  }

  /**
   * Make the Google event match the meeting. Returns what happened.
   * Idempotent: deterministic event id (409 on insert → patch) and a hash of
   * the last synced body (unchanged → no API call).
   */
  async syncMeeting(workspaceId: number, meetingId: number): Promise<'off' | 'unchanged' | 'created' | 'updated' | 'gone'> {
    if (!(await this.active(workspaceId))) return 'off';
    const row = await this.app.db.selectFrom('meetings').select(['project_id']).where('id', '=', meetingId).executeTakeFirst();
    if (!row) return 'gone';
    const attendees = await this.app.meetings.attendees(workspaceId, row.project_id);
    if (!attendees[0]) return 'gone';
    const m = await this.app.meetings.get(attendees[0], meetingId);
    const i = (await this.integration(workspaceId))!;
    const emails = await this.emails(workspaceId, attendees);
    const body = this.desired(m, emails);
    const wantsConference = m.mode === 'virtual' && !m.link && m.status !== 'skipped' && m.status !== 'cancelled';
    const hash = sha(JSON.stringify({ body, wantsConference }));
    const record = await this.app.db.selectFrom('gcal_events').selectAll().where('meeting_id', '=', meetingId).executeTakeFirst();
    if (record?.synced_hash === hash) return 'unchanged';
    if (!record && body.status === 'cancelled') return 'unchanged'; // nothing to cancel

    const token = await this.accessToken(workspaceId);
    const eventId = eventIdFor(workspaceId, meetingId);
    const send = emails.length ? 'all' : 'none';
    const conference = wantsConference ? { conferenceData: { createRequest: { requestId: `tegbar-${workspaceId}-${meetingId}-${m.sequence}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {};
    let event: GoogleEvent;
    let created = false;
    try {
      if (record) event = await this.google!.patchEvent(token, i.account, eventId, { ...body, ...conference }, send);
      else {
        try {
          event = await this.google!.insertEvent(token, i.account, { id: eventId, ...body, ...conference }, send);
          created = true;
        } catch (err) {
          if (!(err instanceof GoogleError && err.status === 409)) throw err;
          event = await this.google!.patchEvent(token, i.account, eventId, { ...body, ...conference }, send); // created earlier, record lost
        }
      }
    } catch (err) {
      if (err instanceof GoogleError && err.needsReconnect) await this.markBroken(workspaceId, err.message);
      throw err;
    }
    const now = toDb(this.app.clock.now());
    await this.app.db.insertInto('gcal_events').values({ workspace_id: workspaceId, meeting_id: meetingId, event_id: eventId, synced_hash: hash, created_at: now, updated_at: now })
      .onConflict((oc) => oc.column('meeting_id').doUpdateSet({ synced_hash: hash, updated_at: now })).execute();
    if (wantsConference) await this.takeLink(workspaceId, meetingId, event);
    return created ? 'created' : 'updated';
  }

  /** Meet links are created asynchronously; check again shortly if still pending. */
  async takeLink(workspaceId: number, meetingId: number, event: GoogleEvent, attempt = 0): Promise<void> {
    const url = meetUrlOf(event);
    if (url) {
      await this.app.meetings.setGeneratedLink(workspaceId, meetingId, url);
      return;
    }
    if (attempt < 6) {
      await this.app.jobs.upsert(workspaceId, `gcal-link:${meetingId}`, { kind: GCAL_JOB.link, payload: { meetingId, attempt: attempt + 1 }, at: this.app.clock.now().plus({ seconds: 20 * (attempt + 1) }) });
    }
  }

  async checkLink(workspaceId: number, meetingId: number, attempt: number): Promise<void> {
    if (!(await this.active(workspaceId))) return;
    const i = (await this.integration(workspaceId))!;
    const event = await this.google!.getEvent(await this.accessToken(workspaceId), i.account, eventIdFor(workspaceId, meetingId));
    await this.takeLink(workspaceId, meetingId, event, attempt);
  }
}
