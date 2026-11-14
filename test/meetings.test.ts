import { describe, expect, it } from 'vitest';
import { enc } from '../src/core/ids.js';
import { toDb } from '../src/core/time.js';
import { JOHN, SAMI, makeApp, makeBot, pairBoth, ridehome, type ApiCall } from './helpers.js';

async function setup(now = '2026-11-15T10:00:00+03:00') {
  const { app, clock } = await makeApp(now);
  const { john, sami } = await pairBoth(app);
  const bot = makeBot(app);
  const upcoming = await app.meetings.upcoming(john, 10);
  const sync = upcoming.find((m) => m.mode === 'virtual')!; // Tue 17 Nov 19:00
  const sit = upcoming.find((m) => m.mode === 'in_person')!; // Sat 21 Nov 10:00
  return { app, clock, bot, john, sami, sync, sit };
}
const sentTo = (calls: ApiCall[], chatId: number) => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
const buttons = (c: ApiCall | undefined) => (c?.payload.reply_markup?.inline_keyboard ?? []).flat() as any[];

describe('meeting schedule', () => {
  it('seeds two weekly slots and The Spot, and generates 8 weeks idempotently', async () => {
    const { app, john, sync, sit } = await setup();
    const series = await app.meetings.series(john);
    expect(series.map((s) => [s.title, s.weekday, s.time, s.mode])).toEqual([
      ['Weekly sync', 2, '19:00', 'virtual'],
      ['Weekly sit-down', 6, '10:00', 'in_person'],
    ]);
    expect(sync.startAt).toBe('2026-11-17T16:00:00.000Z');
    expect(sit.startAt).toBe('2026-11-21T07:00:00.000Z');
    expect(sit.place?.name).toBe('The Spot');
    const count = async () => Number((await app.db.selectFrom('meetings').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())!.n);
    expect(await count()).toBe(14); // 7 remaining weeks in the 8-week window × 2 slots (this week's already passed)
    expect(await app.meetings.generate(app.workspace.id)).toEqual([]);
    expect(await count()).toBe(14);
  });

  it('hosts alternate: one each per week, swapping weekly', async () => {
    const { app, john, sami } = await setup();
    const ms = await app.meetings.upcoming(john, 4);
    // week 1: virtual + in-person have different hosts; week 2: they swap
    expect(new Set([ms[0]!.hostUserId, ms[1]!.hostUserId])).toEqual(new Set([john.userId, sami.userId]));
    expect(ms[3]!.hostUserId).toBe(ms[0]!.hostUserId === john.userId ? john.userId : sami.userId);
    expect(ms[2]!.hostUserId).toBe(ms[1]!.hostUserId);
  });

  it('per-meeting overrides never alter the slot; slot edits keep overrides', async () => {
    const { app, clock, john, sync } = await setup();
    const moved = await app.meetings.move(john, sync.id, clock.now().plus({ days: 3 }).set({ hour: 18, minute: 0 }));
    await app.meetings.setMode(john, moved.meeting.id, 'in_person');
    const s = (await app.meetings.series(john)).find((x) => x.title === 'Weekly sync')!;
    expect([s.weekday, s.time, s.mode]).toEqual([2, '19:00', 'virtual']);

    await app.meetings.updateSeries(john, s.id, { time: '20:00', mode: 'virtual' });
    const after = await app.meetings.get(john, sync.id);
    expect(after.startAt).toBe(moved.meeting.startAt); // moved meeting keeps its time
    expect(after.mode).toBe('in_person'); // and its mode override
    const nextWeek = (await app.meetings.upcoming(john, 10)).find((m) => m.seriesId === s.id && m.id !== sync.id)!;
    expect(nextWeek.start.toFormat('HH:mm')).toBe('20:00');
    const exceptions = await app.db.selectFrom('meeting_exceptions').selectAll().where('meeting_id', '=', sync.id).execute();
    expect(exceptions.map((e) => e.field)).toEqual(['move', 'mode']);
  });

  it('pausing a slot cancels its future meetings; resuming restores them', async () => {
    const { app, john } = await setup();
    const s = (await app.meetings.series(john))[0]!;
    await app.meetings.updateSeries(john, s.id, { active: 0 });
    expect((await app.meetings.upcoming(john, 20)).filter((m) => m.seriesId === s.id)).toHaveLength(0);
    await app.meetings.updateSeries(john, s.id, { active: 1 });
    expect((await app.meetings.upcoming(john, 20)).filter((m) => m.seriesId === s.id).length).toBeGreaterThan(5);
  });

  it('extra one-off meeting and skip / un-skip', async () => {
    const { app, clock, bot, john, sync } = await setup();
    await bot.send(JOHN, '/meetings');
    await bot.tap(JOHN, 'mt:x:0');
    await bot.send(JOHN, 'thursday 18:00 in person Investor prep');
    const extra = (await app.meetings.upcoming(john, 10)).find((m) => m.seriesId === null)!;
    expect(extra).toMatchObject({ title: 'Investor prep', mode: 'in_person', startAt: '2026-11-19T15:00:00.000Z' });
    expect(sentTo(bot.calls, SAMI.id).map((c) => c.payload.text).join()).toContain('extra meeting added');

    await bot.tap(JOHN, `mt:skipx:${enc(sync.id)}`);
    await bot.tap(JOHN, `mt:skipx:${enc(sync.id)}`);
    expect((await app.meetings.get(john, sync.id)).status).toBe('skipped');
    expect(await app.jobs.activeByPrefix(app.workspace.id, `mtg:${sync.id}:`)).toEqual([]);
    await app.meetings.unskip(john, sync.id);
    expect((await app.jobs.activeByPrefix(app.workspace.id, `mtg:${sync.id}:`)).length).toBeGreaterThan(0);
    void clock;
  });
});

describe('virtual meeting links and reminders', () => {
  it('plans evening-before, 1h, 10m, start, link check and wrap-up jobs', async () => {
    const { app, sync, sit } = await setup();
    const keys = async (id: number) => (await app.jobs.activeByPrefix(app.workspace.id, `mtg:${id}:`)).map((j) => j.key.split(':')[2]).sort();
    expect(await keys(sync.id)).toEqual(['b10', 'b60', 'eve', 'link', 'start', 'wrap']);
    expect(await keys(sit.id)).toEqual(['b10', 'b60', 'eve', 'start', 'wrap']);
    const eve = await app.jobs.get(app.workspace.id, `mtg:${sync.id}:eve`);
    expect(eve!.next_fire_at).toBe('2026-11-16T17:00:00.000Z'); // Mon 20:00 Addis
  });

  it('validates and stores the Meet link; reminders carry a Join URL button', async () => {
    const { app, clock, bot, sync } = await setup();
    await bot.send(JOHN, '/meeting link https://zoom.us/j/1');
    expect(bot.calls.at(-1)?.payload.text).toContain('Google Meet');
    await bot.send(JOHN, '/meeting link meet.google.com/ABC-DEFG-HIJ');
    expect((await app.meetings.get({ userId: 1, workspaceId: 1 }, sync.id)).link).toBe('https://meet.google.com/abc-defg-hij');
    bot.calls.length = 0;
    clock.set('2026-11-17T18:00:20+03:00');
    await bot.scheduler.tick();
    for (const chat of [JOHN.id, SAMI.id]) {
      const msg = sentTo(bot.calls, chat).find((c) => c.payload.text.includes('in 1 hour'));
      expect(msg, `chat ${chat}`).toBeDefined();
      expect(buttons(msg).find((b) => b.url)?.url).toBe('https://meet.google.com/abc-defg-hij');
      expect(buttons(msg).map((b) => b.callback_data)).toContain(`mt:r:${enc(sync.id)}:g`);
    }
  });

  it('nags the host when the link is missing, then alerts both at the start', async () => {
    const { app, clock, bot, john, sami, sync } = await setup();
    const hostChat = sync.hostUserId === john.userId ? JOHN.id : SAMI.id;
    clock.set('2026-11-17T17:00:20+03:00'); // 2 hours before
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, hostChat).some((c) => c.payload.text.includes('please add the Meet link'))).toBe(true);
    bot.calls.length = 0;
    clock.set('2026-11-17T19:00:20+03:00');
    await bot.scheduler.tick();
    for (const chat of [JOHN.id, SAMI.id]) {
      const msg = sentTo(bot.calls, chat).find((c) => c.payload.text.includes('no Meet link yet'));
      expect(msg).toBeDefined();
      expect(buttons(msg).map((b) => b.callback_data)).toContain(`mt:lk:${enc(sync.id)}`);
    }
    void sami;
  });

  it('a room link on the slot covers every virtual meeting without its own link', async () => {
    const { app, john, sync } = await setup();
    const s = (await app.meetings.series(john)).find((x) => x.mode === 'virtual')!;
    await app.meetings.updateSeries(john, s.id, { room_url: 'meet.google.com/aaa-bbbb-ccc' });
    const m = await app.meetings.get(john, sync.id);
    expect(m).toMatchObject({ link: 'https://meet.google.com/aaa-bbbb-ccc', linkFromRoom: true });
    expect(await app.jobs.get(app.workspace.id, `mtg:${sync.id}:link`)).toBeDefined();
  });

  it('in-person reminders include the place and a venue when it has a pin', async () => {
    const { app, clock, bot, john, sit } = await setup();
    await app.meetings.updatePlace(john, sit.place!.id, { latitude: 9.0192, longitude: 38.7612 });
    clock.set('2026-11-21T09:00:20+03:00');
    await bot.scheduler.tick();
    const msg = sentTo(bot.calls, JOHN.id).find((c) => c.payload.text.includes('in 1 hour'));
    expect(msg?.payload.text).toContain('The Spot');
    expect(msg?.payload.text).toContain('Kazanchis');
    expect(bot.calls.filter((c) => c.method === 'sendVenue' && c.payload.chat_id === JOHN.id)).toHaveLength(1);
  });

  it('meeting reminders never duplicate across ticks and restarts', async () => {
    const { app, clock, bot } = await setup();
    clock.set('2026-11-17T18:50:20+03:00');
    await Promise.all([bot.scheduler.tick(), bot.scheduler.tick()]);
    const bot2 = makeBot(app);
    await bot2.scheduler.tick();
    const tenMin = [...bot.calls, ...bot2.calls].filter((c) => c.method === 'sendMessage' && c.payload.text.includes('in 10 min'));
    expect(tenMin).toHaveLength(2); // one per founder
  });

  it('pin can be set by sending a Telegram location', async () => {
    const { app, bot, john, sit } = await setup();
    await bot.tap(JOHN, `mt:ppin:${enc(sit.place!.id)}`);
    await bot.send(JOHN, 'Kazanchis'); // text is not a location
    expect(bot.calls.at(-1)?.payload.text).toContain('Telegram location');
    await (bot.bot as any).handleUpdate({
      update_id: 9999,
      message: { message_id: 1, date: 0, chat: { id: JOHN.id, type: 'private' }, from: { ...JOHN, is_bot: false }, location: { latitude: 9.01, longitude: 38.76 } },
    });
    expect((await app.meetings.placeById(app.workspace.id, sit.place!.id))!.latitude).toBe(9.01);
    void john;
  });
});

describe('RSVP and reschedule proposals', () => {
  it('quick move buttons carry the target time (double tap moves once)', async () => {
    const { app, bot, john, sync } = await setup();
    await bot.tap(JOHN, `mt:mv:${enc(sync.id)}`);
    const plus1h = buttons([...bot.calls].reverse().find((c) => c.payload.reply_markup)).find((b) => b.text === '+1 hour')!.callback_data;
    await bot.tap(JOHN, plus1h);
    await bot.tap(JOHN, plus1h);
    expect((await app.meetings.get(john, sync.id)).startAt).toBe('2026-11-17T17:00:00.000Z');
  });

  it("can't make it → proposal → partner accepts in one tap (exactly once)", async () => {
    const { app, bot, john, sami, sync } = await setup();
    await bot.tap(SAMI, `mt:r:${enc(sync.id)}:n`);
    expect(bot.calls.at(-1)?.payload.text).toContain('Propose another time');
    await bot.tap(SAMI, `mp:n:${enc(sync.id)}:tom`);
    await bot.tap(SAMI, `mp:n:${enc(sync.id)}:tom`); // double tap: one proposal, one message
    expect(sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('can’t make it'))).toHaveLength(1);
    const toJohn = sentTo(bot.calls, JOHN.id).find((c) => c.payload.text.includes('can’t make it'));
    expect(toJohn?.payload.text).toContain('Proposed');
    const accept = buttons(toJohn).find((b) => b.callback_data?.startsWith('mp:a:'))!.callback_data;

    await bot.tap(SAMI, accept); // proposer cannot accept their own
    expect((await app.meetings.get(john, sync.id)).moved).toBe(false);
    await bot.tap(JOHN, accept);
    await bot.tap(JOHN, accept);
    const m = await app.meetings.get(john, sync.id);
    expect(m.startAt).toBe('2026-11-18T16:00:00.000Z');
    expect(sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('accepted'))).toHaveLength(1);
    expect((await app.jobs.get(app.workspace.id, `mtg:${sync.id}:start`))!.next_fire_at).toBe('2026-11-18T16:00:00.000Z');
    // old "can't" is cleared; the proposer is going at the new time
    expect(m.rsvps.map((r) => [r.user_id, r.status])).toEqual([[sami.userId, 'going']]);
    void sami;
  });

  it('running late notifies the partner; RSVP taps are idempotent', async () => {
    const { app, bot, john, sync } = await setup();
    await bot.tap(JOHN, `mt:r:${enc(sync.id)}:l10`);
    await bot.tap(JOHN, `mt:r:${enc(sync.id)}:l10`);
    expect(sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('running about 10 min late'))).toHaveLength(1);
    expect((await app.meetings.get(john, sync.id)).rsvps).toHaveLength(1);
  });
});

describe('agenda, live meeting and summary', () => {
  it('auto-builds the agenda from blocked and overdue tasks, idempotently, keeping manual items', async () => {
    const { app, john, sync } = await setup();
    const rh = await ridehome(app, john);
    const blocked = await app.tasks.create(john, { projectId: rh.id, title: 'SMS gateway contract' });
    await app.tasks.setStatus(john, blocked.id, 'blocked');
    await app.tasks.create(john, { projectId: rh.id, title: 'Renew domain', priority: 'high', due: { date: '2026-11-10', time: null } });
    await app.tasks.create(john, { projectId: rh.id, title: 'Fine for now' });
    await app.meetings.ensureAgenda(john, sync.id);
    await app.meetings.addAgendaItem(john, sync.id, 'Hiring plan');
    await app.meetings.ensureAgenda(john, sync.id);
    const items = await app.meetings.agenda(john, sync.id);
    expect(items.map((a) => a.text)).toEqual(['SMS gateway contract', 'Renew domain', 'Hiring plan']);
    const up = await app.meetings.updateAgendaItem(john, items[2]!.id, 'up');
    expect(up.position).toBeLessThan(items[2]!.position);
  });

  it('live meeting: typed tasks become action items; end sends a summary and carries questions', async () => {
    const { app, bot, john, sync } = await setup();
    await bot.tap(JOHN, `mt:go:${enc(sync.id)}`);
    await bot.send(JOHN, 'Call MMCY friday @sami');
    expect(bot.calls.at(-1)?.payload.text).toContain('Action item for Weekly sync?');
    const save = buttons(bot.calls.at(-1)).find((b) => b.callback_data?.startsWith('qa:s:'))!.callback_data;
    await bot.tap(JOHN, save);
    await bot.tap(JOHN, `mt:out:${enc(sync.id)}:decision`);
    await bot.send(JOHN, 'Launch pilot with 20 riders');
    await bot.tap(JOHN, `mt:out:${enc(sync.id)}:question`);
    await bot.send(JOHN, 'Pricing for B2B?');
    bot.calls.length = 0;
    await bot.tap(JOHN, `mt:end:${enc(sync.id)}`);
    await bot.tap(JOHN, `mt:end:${enc(sync.id)}`);

    const summaryToSami = sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('Summary'));
    expect(summaryToSami).toHaveLength(1);
    const text = summaryToSami[0]!.payload.text;
    expect(text).toContain('Launch pilot with 20 riders');
    expect(text).toContain('Call MMCY');
    expect(text).toContain('Sami');
    expect(text).toContain('Pricing for B2B?');

    const next = (await app.meetings.upcoming(john, 10)).find((m) => m.seriesId === sync.seriesId && m.id !== sync.id)!;
    await app.meetings.ensureAgenda(john, next.id);
    const agenda = await app.meetings.agenda(john, next.id);
    expect(agenda.map((a) => a.text)).toContain('Pricing for B2B?');
    // last meeting's open action item shows up on the next agenda too
    expect(agenda.map((a) => a.text)).toContain('Call MMCY');

    const hist = await app.meetings.history(john);
    expect(hist.items).toHaveLength(0); // the meeting time is still in the future
  });

  it('sends a calendar file', async () => {
    const { bot, sync } = await setup();
    await bot.tap(JOHN, `mt:ics:${enc(sync.id)}`);
    expect(bot.calls.some((c) => c.method === 'sendDocument')).toBe(true);
  });

  it('every meeting screen fits Telegram limits', async () => {
    const { bot, sync, sit } = await setup();
    await bot.send(JOHN, '/meetings');
    await bot.send(JOHN, '/meeting');
    await bot.send(JOHN, '/agenda');
    for (const d of [`mt:o:${enc(sync.id)}`, `mt:c:${enc(sync.id)}`, `mt:c:${enc(sit.id)}`, `mt:host:${enc(sync.id)}`, `mt:place:${enc(sit.id)}`,
      `mt:len:${enc(sync.id)}`, 'mt:s:0', 'mt:pl:0', 'mt:h:0', `mt:mv:${enc(sync.id)}`, `mt:skip:${enc(sync.id)}`, 'mt:cfo:0']) await bot.tap(JOHN, d);
    const series = (await bot.calls.filter((c) => c.payload.reply_markup)).length;
    expect(series).toBeGreaterThan(10);
    for (const c of bot.calls) {
      for (const b of buttons(c)) if (b.callback_data) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      if (c.payload.text) expect(c.payload.text.length).toBeLessThan(4096);
    }
    expect(bot.calls.filter((c) => c.method === 'answerCallbackQuery').length).toBe(12);
  });
});

describe('meetings API', () => {
  it('lists meetings and accepts an RSVP', async () => {
    const { app, john, sync } = await setup();
    const { buildApiRouter } = await import('../src/core/api/routes.js');
    const router = buildApiRouter();
    const list = router.match('GET', '/meetings');
    expect(list && list !== 'method').toBeTruthy();
    const m = router.match('POST', `/meetings/${sync.id}/rsvp`);
    if (!m || m === 'method') throw new Error('no route');
    const member = (await app.members.findByTelegramId(JOHN.id))!.member;
    const r: any = await m.handler({ app, actor: john, member, params: m.params, query: new URLSearchParams(), body: { status: 'going' } });
    expect(r.changed).toBe(true);
    expect(router.list()).toContain('GET /meetings/:id/ics');
    void toDb;
  });
});
