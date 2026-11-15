import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/core/db/database.js';
import { enc } from '../src/core/ids.js';
import { fixedClock } from '../src/core/time.js';
import { GoogleClient, eventIdFor } from '../src/modules/gcal/google.js';
import { createOAuthHandler } from '../src/modules/gcal/telegram.js';
import { JOHN, SAMI, SETUP, makeBot, pairBoth } from './helpers.js';

/** In-memory imitation of the Google endpoints Tegbar uses. */
function fakeGoogle() {
  const events = new Map<string, any>();
  const calls: { method: string; path: string; body: any }[] = [];
  const state = { grantRevoked: false, failNext: 0, linkReadyAfterGets: 1, revoked: [] as string[] };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    calls.push({ method, path: u.pathname + u.search, body });
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      if (body.grant_type === 'authorization_code') return json(200, { access_token: 'at-1', refresh_token: '1//secret-refresh', expires_in: 3600 });
      if (state.grantRevoked) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: 'at-2', expires_in: 3600 });
    }
    if (u.pathname === '/revoke') { state.revoked.push(body.token); return json(200, {}); }
    if (state.failNext > 0) { state.failNext--; return json(503, { error: { message: 'backend error', status: 'UNAVAILABLE' } }); }
    if (u.pathname === '/calendar/v3/calendars/primary') return json(200, { id: 'founders@gmail.com' });
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/?]+))?$/.exec(u.pathname);
    if (m) {
      const id = m[2] ? decodeURIComponent(m[2]) : body.id;
      if (method === 'POST') {
        if (events.has(id)) return json(409, { error: { message: 'duplicate', status: 'ALREADY_EXISTS' } });
        const e = { ...body, gets: 0 };
        if (body.conferenceData?.createRequest) e.conferenceData = { createRequest: { status: { statusCode: 'pending' } } };
        events.set(id, e);
        return json(200, { id, ...e });
      }
      const e = events.get(id);
      if (!e) return json(404, { error: { message: 'not found' } });
      if (method === 'PATCH') { Object.assign(e, body); return json(200, { id, ...e }); }
      e.gets++;
      if (e.conferenceData && e.gets >= state.linkReadyAfterGets) e.hangoutLink = 'https://meet.google.com/xyz-abcd-efg';
      return json(200, { id, ...e });
    }
    return json(404, {});
  };
  return { events, calls, state, client: new GoogleClient('cid', 'csecret', 'https://tegbar.example.com/oauth/google/callback', fetchFn as never) };
}

async function setup(opts: { google?: boolean } = { google: true }) {
  const g = fakeGoogle();
  const clock = fixedClock('2026-11-15T10:00:00+03:00');
  const app = await createApp({
    database: openDatabase(':memory:'), clock, log: pino({ level: 'silent' }), setupCode: SETUP, seatNames: { A: 'John', B: 'Sami' },
    dataDir: mkdtempSync(join(tmpdir(), 'tegbar-gcal-')),
    google: opts.google ? { client: g.client, secretKey: randomBytes(32).toString('base64') } : {},
  });
  const { john, sami } = await pairBoth(app);
  const bot = makeBot(app);
  return { app, clock, bot, john, sami, g };
}

async function connect(app: any, bot: any) {
  await bot.tap(JOHN, 'gc:connect');
  const btn = [...bot.calls].reverse().find((c: any) => c.payload.reply_markup)!.payload.reply_markup.inline_keyboard.flat()[0];
  const state = new URL(btn.url).searchParams.get('state')!;
  return { state, result: await app.gcal.finishConnect(state, 'auth-code') };
}

describe('Google Calendar connection', () => {
  it('without server config it explains the setup', async () => {
    const { bot } = await setup({ google: false });
    await bot.send(JOHN, '/google');
    expect(bot.calls.at(-1)!.payload.text).toContain('GOOGLE_CLIENT_ID');
  });

  it('connects with a single-use state; the refresh token is stored encrypted', async () => {
    const { app, bot } = await setup();
    const { state, result } = await connect(app, bot);
    expect(result.account).toBe('founders@gmail.com');
    const row = await app.db.selectFrom('integrations').selectAll().executeTakeFirstOrThrow();
    expect(row.secret.startsWith('v1:')).toBe(true);
    expect(row.secret).not.toContain('secret-refresh');
    await expect(app.gcal.finishConnect(state, 'auth-code')).rejects.toThrow('gcal.bad_state');
    await expect(app.gcal.finishConnect('made-up', 'x')).rejects.toThrow('gcal.bad_state');
  });

  it('the callback page finishes the connection and tells the owner in Telegram', async () => {
    const { app, bot } = await setup();
    await bot.tap(JOHN, 'gc:connect');
    const url = new URL([...bot.calls].reverse().find((c: any) => c.payload.reply_markup)!.payload.reply_markup.inline_keyboard.flat()[0].url);
    const handler = createOAuthHandler(app, () => bot.bot.api);
    const res = { status: 0, body: '', writeHead(s: number) { this.status = s; return this; }, end(b: string) { this.body = b; } };
    await handler({ url: `/oauth/google/callback?state=${url.searchParams.get('state')}&code=abc` } as IncomingMessage, res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    expect(res.body).toContain('founders@gmail.com');
    expect(bot.calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === JOHN.id && c.payload.text.includes('Google Calendar connected'))).toBe(true);
    const bad = { ...res, status: 0, body: '' };
    await handler({ url: '/oauth/google/callback?state=nope&code=abc' } as IncomingMessage, bad as unknown as ServerResponse);
    expect(bad.status).toBe(400);
  });
});

describe('Google Calendar sync', () => {
  it('creates one event per meeting, fetches the async Meet link, then stays quiet', async () => {
    const { app, clock, bot, john, g } = await setup();
    await connect(app, bot);
    await app.flags.set(1, 'gcal', true);
    await app.gcal.syncAll(1);
    await bot.scheduler.tick();
    const sync = (await app.meetings.upcoming(john, 2)).find((m) => m.mode === 'virtual')!;
    const sit = (await app.meetings.upcoming(john, 2)).find((m) => m.mode === 'in_person')!;
    const ev = g.events.get(eventIdFor(1, sync.id));
    expect(ev).toMatchObject({ summary: 'Weekly sync', start: { dateTime: '2026-11-17T16:00:00.000Z', timeZone: 'Africa/Addis_Ababa' } });
    expect(ev.conferenceData.createRequest.status.statusCode).toBe('pending');
    expect(g.events.get(eventIdFor(1, sit.id))).toMatchObject({ location: 'The Spot, Kazanchis, Addis Ababa' });
    expect(g.events.size).toBe(14);
    expect((await app.meetings.get(john, sync.id)).link).toBeNull();

    clock.advance(25_000);
    await bot.scheduler.tick();
    expect((await app.meetings.get(john, sync.id)).link).toBe('https://meet.google.com/xyz-abcd-efg');

    const before = g.calls.length;
    await app.gcal.syncAll(1);
    await bot.scheduler.tick();
    expect(g.calls.filter((c) => c.method !== 'POST' || !c.path.includes('/token')).length - before).toBeLessThanOrEqual(1); // only a token refresh at most, no event calls
  });

  it('moves and skips propagate; a typed link means no Meet is generated', async () => {
    const { app, clock, bot, john, g } = await setup();
    await connect(app, bot);
    await app.flags.set(1, 'gcal', true);
    const sync = (await app.meetings.upcoming(john, 2)).find((m) => m.mode === 'virtual')!;
    await app.meetings.setLink(john, sync.id, 'meet.google.com/abc-defg-hij');
    await app.gcal.syncAll(1);
    await bot.scheduler.tick();
    expect(g.events.get(eventIdFor(1, sync.id)).conferenceData).toBeUndefined();
    clock.advance(1000);
    await app.meetings.move(john, sync.id, clock.now().plus({ days: 3 }).set({ hour: 18, minute: 0, second: 0, millisecond: 0 }));
    clock.advance(1000);
    await bot.scheduler.tick();
    expect(g.events.get(eventIdFor(1, sync.id)).start.dateTime).toBe('2026-11-18T15:00:00.000Z');
    await app.meetings.skip(john, sync.id);
    clock.advance(1000);
    await bot.scheduler.tick();
    expect(g.events.get(eventIdFor(1, sync.id)).status).toBe('cancelled');
  });

  it('attendee emails are invited (sendUpdates=all)', async () => {
    const { app, bot, g } = await setup();
    await connect(app, bot);
    await app.flags.set(1, 'gcal', true);
    await bot.send(SAMI, '/google email sami@example.com');
    await bot.scheduler.tick();
    const inserts = g.calls.filter((c) => c.method === 'POST' && c.path.includes('/events'));
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.every((c) => c.path.includes('sendUpdates=all'))).toBe(true);
    expect(inserts[0]!.body.attendees).toEqual([{ email: 'sami@example.com' }]);
  });

  it('a lost record recovers via 409 → patch; transient errors retry later', async () => {
    const { app, bot, john, g } = await setup();
    await connect(app, bot);
    await app.flags.set(1, 'gcal', true);
    const m = (await app.meetings.upcoming(john, 1))[0]!;
    expect(await app.gcal.syncMeeting(1, m.id)).toBe('created');
    await app.db.deleteFrom('gcal_events').execute(); // e.g. restored from an older backup
    expect(await app.gcal.syncMeeting(1, m.id)).toBe('updated');
    g.state.failNext = 1;
    await app.gcal.queue(1, m.id);
    await app.db.deleteFrom('gcal_events').execute();
    await bot.scheduler.tick();
    const job = await app.jobs.get(1, `gcal:${m.id}`);
    expect(job).toMatchObject({ status: 'active' });
    expect(JSON.parse(job!.payload).attempt).toBe(1);
  });

  it('a revoked grant stops syncing and asks the owner to reconnect, once', async () => {
    const { app, clock, bot, john, g } = await setup();
    await connect(app, bot);
    await app.flags.set(1, 'gcal', true);
    clock.advance(2 * 3_600_000); // cached access token expired
    (app.gcal as any).tokens.clear();
    g.state.grantRevoked = true;
    await app.gcal.syncAll(1);
    await bot.scheduler.tick();
    await bot.scheduler.tick();
    expect((await app.gcal.integration(1))!.status).toBe('needs_reconnect');
    expect(await app.gcal.active(1)).toBe(false);
    expect(bot.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === JOHN.id && c.payload.text.includes('stopped syncing'))).toHaveLength(1);
    void john;
  });

  it('disconnect revokes the token and deletes the record', async () => {
    const { app, bot, g } = await setup();
    await connect(app, bot);
    await bot.tap(JOHN, 'gc:disc');
    expect(g.state.revoked).toEqual(['1//secret-refresh']);
    expect(await app.gcal.integration(1)).toBeUndefined();
    void enc;
  });
});
