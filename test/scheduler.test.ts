import { describe, expect, it } from 'vitest';
import { S_DND_UNTIL, S_FOCUS_UNTIL } from '../src/core/services/availability.js';
import { toDb } from '../src/core/time.js';
import { S_DIGEST_DAILY } from '../src/modules/reminders/settings.js';
import { JOHN, SAMI, makeApp, makeBot, pairBoth, ridehome, type ApiCall } from './helpers.js';

async function setup(now = '2026-11-15T10:00:00+03:00') {
  const { app, clock } = await makeApp(now);
  const { john, sami } = await pairBoth(app);
  const bot = makeBot(app);
  const rh = await ridehome(app, john);
  return { app, clock, bot, john, sami, rh };
}

const sentTo = (calls: ApiCall[], chatId: number) => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
const keys = async (app: Awaited<ReturnType<typeof setup>>['app'], prefix: string) =>
  (await app.jobs.activeByPrefix(app.workspace.id, prefix)).map((j) => j.key).sort();

describe('task reminders', () => {
  it('plans before-due, at-due and overdue jobs and keeps them in step with the task', async () => {
    const { app, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'Pitch', due: { date: '2026-11-17', time: '15:00' } });
    expect(await keys(app, `task:${t.id}:`)).toEqual([`task:${t.id}:b1440`, `task:${t.id}:b60`, `task:${t.id}:due`, `task:${t.id}:od`]);
    const b60 = await app.jobs.get(app.workspace.id, `task:${t.id}:b60`);
    expect(b60!.next_fire_at).toBe('2026-11-17T11:00:00.000Z'); // 14:00 Addis

    await app.tasks.update(john, t.id, { due: { date: '2026-11-15', time: '10:30' } });
    expect(await keys(app, `task:${t.id}:`)).toEqual([`task:${t.id}:due`, `task:${t.id}:od`]);

    await app.tasks.setStatus(john, t.id, 'done');
    expect(await keys(app, `task:${t.id}:`)).toEqual([]);
  });

  it('fires once: double tick, restart and a second process never duplicate', async () => {
    const { app, clock, bot, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'Call MMCY', due: { date: '2026-11-15', time: '12:00' } });
    clock.set('2026-11-15T11:00:30+03:00');
    await Promise.all([bot.scheduler.tick(), bot.scheduler.tick()]);
    await bot.scheduler.tick();
    const bot2 = makeBot(app); // restart
    await bot2.scheduler.tick();
    const sends = [...sentTo(bot.calls, JOHN.id), ...sentTo(bot2.calls, JOHN.id)];
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.text).toContain('Due in 1 hour');
    expect(sends[0]!.payload.text).toContain('Call MMCY');
    const fires = await app.db.selectFrom('job_fires').selectAll().execute();
    expect(fires.filter((f) => f.status === 'sent')).toHaveLength(1);
    void t;
  });

  it('a crash after claiming does not resend (at-most-once)', async () => {
    const { app, clock, bot, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x', due: { date: '2026-11-15', time: '12:00' } });
    clock.set('2026-11-15T11:00:30+03:00');
    const job = (await app.jobs.get(app.workspace.id, `task:${t.id}:b60`))!;
    await app.jobs.claim(job, { status: 'claimed', next: null, counted: true }); // ...process dies here
    await makeBot(app).scheduler.tick();
    expect(sentTo(bot.calls, JOHN.id)).toHaveLength(0);
  });

  it('after short downtime: skips the 1-hour reminder, sends "due now" marked late', async () => {
    const { app, clock, john, rh } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'Ship', due: { date: '2026-11-15', time: '12:00' } });
    clock.set('2026-11-15T12:30:00+03:00'); // down from 10:00 to 12:30
    const bot = makeBot(app);
    const r = await bot.scheduler.tick();
    const sends = sentTo(bot.calls, JOHN.id);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.text).toContain('Due now');
    expect(sends[0]!.payload.text).toContain('Sent late');
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it('after long downtime: one overdue nudge instead of a burst of stale reminders', async () => {
    const { app, clock, john, rh } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'Ship', due: { date: '2026-11-15', time: '12:00' } });
    clock.set('2026-11-15T15:00:00+03:00');
    const bot = makeBot(app);
    await bot.scheduler.tick();
    const sends = sentTo(bot.calls, JOHN.id);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.text).toContain('Still open');
  });

  it('does not remind about a task that was completed or re-dated', async () => {
    const { app, clock, bot, john, rh } = await setup();
    const a = await app.tasks.create(john, { projectId: rh.id, title: 'a', due: { date: '2026-11-15', time: '12:00' } });
    const b = await app.tasks.create(john, { projectId: rh.id, title: 'b', due: { date: '2026-11-15', time: '12:00' } });
    await app.tasks.setStatus(john, a.id, 'done');
    await app.tasks.update(john, b.id, { due: { date: '2026-11-20', time: '12:00' } });
    clock.set('2026-11-15T12:00:30+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, JOHN.id)).toHaveLength(0);
  });

  it('overdue nudges stop after the cap', async () => {
    const { app, clock, bot, john, rh } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'Renew domain', due: { date: '2026-11-15', time: '12:00' } });
    let t = Date.parse('2026-11-15T09:00:30Z');
    for (let i = 0; i < 24 * 7; i++) {
      // walk a week in 1-hour steps, staying out of quiet hours issues by just ticking every hour
      t += 3_600_000;
      clock.set(new Date(t).toISOString());
      await bot.scheduler.tick();
    }
    const nudges = sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('Still open'));
    expect(nudges).toHaveLength(3);
    expect(nudges.map((n) => /nudge (\d) of 3/.exec(n.payload.text)?.[1])).toEqual(['1', '2', '3']);
  });

  it('reminds the current owner and only while they still have access', async () => {
    const { app, clock, bot, john, sami, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x', ownerUserId: sami.userId, due: { date: '2026-11-15', time: '12:00' } });
    await app.db.updateTable('workspace_members').set({ status: 'removed' }).where('user_id', '=', sami.userId).execute();
    clock.set('2026-11-15T11:00:30+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, SAMI.id)).toHaveLength(0);
    void t;
  });
});

describe('quiet hours, focus, DND', () => {
  it('holds a late-evening reminder until quiet hours end', async () => {
    const { app, clock, bot, john, rh } = await setup('2026-11-15T21:00:00+03:00');
    await app.tasks.create(john, { projectId: rh.id, title: 'Late thing', due: { date: '2026-11-15', time: '23:00' } });
    clock.set('2026-11-15T23:00:30+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, JOHN.id)).toHaveLength(0);
    clock.set('2026-11-16T07:00:30+03:00');
    await bot.scheduler.tick();
    // By 07:00 the task is overdue: exactly one message, the overdue nudge.
    const sends = sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('Late thing'));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.text).toContain('Still open');
  });

  it('focus holds nudges but not direct assignments; DND holds both', async () => {
    const { app, clock, bot, john, sami, rh } = await setup();
    await app.settings.setAs(sami, S_FOCUS_UNTIL, sami.userId, toDb(clock.now().plus({ hours: 2 })));
    await bot.send(JOHN, '/add Review contract @sami');
    expect(sentTo(bot.calls, SAMI.id)).toHaveLength(1); // direct: delivered

    await app.settings.setAs(sami, S_DND_UNTIL, sami.userId, toDb(clock.now().plus({ hours: 1 })));
    bot.calls.length = 0;
    await bot.send(JOHN, '/add Sign NDA @sami');
    expect(sentTo(bot.calls, SAMI.id)).toHaveLength(0); // held
    expect((await app.jobs.activeByPrefix(app.workspace.id, 'notify:')).length).toBe(1);
    clock.set('2026-11-15T11:00:30+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, SAMI.id).map((c) => c.payload.text).join()).toContain('Sign NDA');
    void rh;
  });
});

describe('digests', () => {
  it('schedules digests for both founders at their times', async () => {
    const { app } = await setup();
    const daily = await app.jobs.activeByPrefix(app.workspace.id, 'digest:daily:');
    expect(daily).toHaveLength(2);
    expect(daily[0]!.next_fire_at).toBe('2026-11-16T05:00:00.000Z'); // Mon 08:00 Addis
    const plan = await app.jobs.activeByPrefix(app.workspace.id, 'digest:plan:');
    expect(plan[0]!.next_fire_at).toBe('2026-11-16T05:30:00.000Z');
    const review = await app.jobs.activeByPrefix(app.workspace.id, 'digest:review:');
    expect(review[0]!.next_fire_at).toBe('2026-11-20T14:00:00.000Z');
  });

  it('sends the daily digest with today and overdue items, then plans tomorrow', async () => {
    const { app, clock, bot, john, rh } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'Pay hosting', due: { date: '2026-11-16', time: null } });
    await app.tasks.create(john, { projectId: rh.id, title: 'Old thing', due: { date: '2026-11-10', time: null } });
    clock.set('2026-11-16T08:00:20+03:00');
    await bot.scheduler.tick();
    const digest = sentTo(bot.calls, JOHN.id).find((c) => c.payload.text.includes('Good morning'));
    expect(digest?.payload.text).toContain('Pay hosting');
    expect(digest?.payload.text).toContain('Old thing');
    const job = (await app.jobs.get(app.workspace.id, `digest:daily:${john.userId}`))!;
    expect(job.next_fire_at).toBe('2026-11-17T05:00:00.000Z');
  });

  it('a digest more than 2 hours late is skipped and rescheduled, not sent', async () => {
    const { app, clock, john } = await setup();
    clock.set('2026-11-18T12:00:00+03:00'); // offline Mon → Wed noon
    const bot = makeBot(app);
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('Good morning'))).toHaveLength(0);
    const job = (await app.jobs.get(app.workspace.id, `digest:daily:${john.userId}`))!;
    expect(job.next_fire_at).toBe('2026-11-19T05:00:00.000Z');
  });

  it('changing the digest time in settings moves the job; off cancels it', async () => {
    const { app, john } = await setup();
    await app.settings.setAs(john, S_DIGEST_DAILY, john.userId, '07:15');
    expect((await app.jobs.get(app.workspace.id, `digest:daily:${john.userId}`))!.next_fire_at).toBe('2026-11-16T04:15:00.000Z');
    await app.settings.setAs(john, S_DIGEST_DAILY, john.userId, null);
    expect((await app.jobs.get(app.workspace.id, `digest:daily:${john.userId}`))!.status).toBe('cancelled');
  });
});

describe('recurring tasks', () => {
  it('completing creates the next occurrence once, with reminders', async () => {
    const { app, bot, john } = await setup();
    await bot.send(JOHN, '/add Team sync every monday 9am');
    const first = (await app.tasks.list(john, { owner: 'me', projectId: null, status: 'open', due: 'any' })).items[0]!;
    expect(first).toMatchObject({ title: 'Team sync', due_date: '2026-11-16' });
    const r1 = await app.tasks.setStatus(john, first.id, 'done');
    expect(r1.spawned).toMatchObject({ due_date: '2026-11-23', title: 'Team sync', series_id: first.id });
    expect(r1.spawned!.due_at).toBe('2026-11-23T06:00:00.000Z');
    await app.tasks.setStatus(john, first.id, 'todo');
    const r2 = await app.tasks.setStatus(john, first.id, 'done');
    expect(r2.spawned).toBeUndefined();
    expect((await app.tasks.list(john, { owner: 'me', projectId: null, status: 'open', due: 'any', recurring: true })).total).toBe(1);
    expect(await keys(app, `task:${r1.spawned!.id}:`)).toContain(`task:${r1.spawned!.id}:due`);
  });

  it('skips occurrences already in the past', async () => {
    const { app, john, rh } = await setup();
    const t = await app.tasks.create(john, {
      projectId: rh.id, title: 'daily check', due: { date: '2026-11-01', time: null },
      recurrence: { freq: 'daily', interval: 1, anchor: '2026-11-01' },
    });
    const r = await app.tasks.setStatus(john, t.id, 'done');
    expect(r.spawned!.due_date).toBe('2026-11-15');
  });

  it('repeat can be set from the card buttons', async () => {
    const { app, bot, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'invoice', due: { date: '2026-11-30', time: null } });
    await bot.tap(JOHN, `t:er:${t.id.toString(36)}:-:mo`);
    expect(JSON.parse((await app.tasks.get(john, t.id)).recurrence!)).toEqual({ freq: 'monthly', interval: 1, day: 30, anchor: '2026-11-30' });
  });
});

describe('one-off reminders', () => {
  it('/remind us delivers to both founders, each respecting their own DND', async () => {
    const { app, clock, bot, sami } = await setup();
    await app.settings.setAs(sami, S_DND_UNTIL, sami.userId, toDb(clock.now().plus({ hours: 3 })));
    await bot.send(JOHN, '/remind us today 11:00 send the deck to MMCY');
    expect(bot.calls.at(-1)?.payload.text).toContain('Reminder set');
    clock.set('2026-11-15T11:00:30+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('send the deck'))).toHaveLength(2); // confirmation + reminder
    expect(sentTo(bot.calls, SAMI.id)).toHaveLength(0);
    clock.set('2026-11-15T13:00:30+03:00');
    await bot.scheduler.tick();
    const toSami = sentTo(bot.calls, SAMI.id);
    expect(toSami).toHaveLength(1);
    expect(toSami[0]!.payload.text).toContain('from John');
  });

  it('rejects past times and missing dates with guidance', async () => {
    const { bot } = await setup();
    await bot.send(JOHN, '/remind me call the bank');
    expect(bot.calls.at(-1)?.payload.text).toContain('Tell me when');
    await bot.send(JOHN, '/remind me 2026-11-01 09:00 call the bank');
    expect(bot.calls.at(-1)?.payload.text).toContain('already passed');
  });

  it('cancel from the list; a cancelled reminder never fires', async () => {
    const { app, clock, bot, john } = await setup();
    await bot.send(JOHN, '/remind me in 2 hours stretch');
    const [r] = await app.reminders.upcoming(john);
    await bot.tap(JOHN, `rm:x:${r!.id.toString(36)}`);
    await bot.tap(JOHN, `rm:x:${r!.id.toString(36)}`); // double tap
    clock.set('2026-11-15T12:30:00+03:00');
    bot.calls.length = 0;
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, JOHN.id)).toHaveLength(0);
  });
});

describe('focus command', () => {
  it('/focus 2h then off', async () => {
    const { app, bot, john } = await setup();
    await bot.send(JOHN, '/focus 2h');
    expect(bot.calls.at(-1)?.payload.text).toContain('Focus on');
    expect(await app.settings.get(app.workspace.id, S_FOCUS_UNTIL, john.userId)).toBe('2026-11-15T09:00:00.000Z');
    await bot.tap(JOHN, 'fo:off');
    expect(await app.settings.get(app.workspace.id, S_FOCUS_UNTIL, john.userId)).toBeNull();
  });
});

describe('double taps on Phase 2 buttons', () => {
  it('snoozing a reminder twice keeps one follow-up', async () => {
    const { app, clock, bot, john } = await setup();
    await bot.send(JOHN, '/remind me today 10:30 stretch');
    clock.set('2026-11-15T10:30:30+03:00');
    await bot.scheduler.tick();
    const [src] = await app.db.selectFrom('reminders').selectAll().execute();
    await bot.tap(JOHN, `rm:z:${src!.id.toString(36)}:1h`);
    await bot.tap(JOHN, `rm:z:${src!.id.toString(36)}:1h`);
    expect((await app.reminders.upcoming(john)).filter((r) => r.source_id === src!.id)).toHaveLength(1);
  });

  it('toggle buttons carry their target value', async () => {
    const { app, bot, john } = await setup();
    await bot.tap(JOHN, 'rs:bt:15:1');
    await bot.tap(JOHN, 'rs:bt:15:1');
    expect(await app.settings.get(app.workspace.id, (await import('../src/modules/reminders/settings.js')).S_REMIND_BEFORE, john.userId)).toEqual([1440, 60, 15]);
    await bot.tap(JOHN, 's:tf:12h');
    await bot.tap(JOHN, 's:tf:12h');
    const { S_TIME_FORMAT } = await import('../src/core/services/settings.js');
    expect(await app.settings.get(app.workspace.id, S_TIME_FORMAT, john.userId)).toBe('12h');
  });

  it('draft cycle buttons are idempotent', async () => {
    const { app, bot, john } = await setup();
    await bot.send(JOHN, 'Buy domain');
    const btn = (prefix: string) => bot.calls.flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []).reverse().find((b: any) => b.callback_data?.startsWith(prefix));
    const pr = btn('qa:r:');
    await bot.tap(JOHN, pr.callback_data);
    await bot.tap(JOHN, pr.callback_data);
    await bot.tap(JOHN, btn('qa:s:').callback_data);
    const t = (await app.tasks.list(john, { owner: 'me', projectId: null, status: 'open', due: 'any' })).items[0]!;
    expect(t.priority).toBe('high');
  });
});
