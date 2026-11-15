import { describe, expect, it } from 'vitest';
import { buildApiRouter } from '../src/core/api/routes.js';
import { JOHN, SAMI, makeApp, makeBot, pairBoth, ridehome, type ApiCall } from './helpers.js';

async function setup() {
  const { app, clock } = await makeApp('2026-11-15T10:00:00+03:00');
  const { john, sami } = await pairBoth(app);
  const bot = makeBot(app);
  const rh = await ridehome(app, john);
  return { app, clock, bot, john, sami, rh };
}
const sentTo = (calls: ApiCall[], chat: number) => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chat);

describe('Friday founder brief', () => {
  it('is off by default: Friday sends the normal Week in review', async () => {
    const { clock, bot } = await setup();
    await bot.send(JOHN, '/brief');
    expect(bot.calls.at(-1)!.payload.text).toContain('optional feature');
    clock.set('2026-11-20T17:00:30+03:00');
    await bot.scheduler.tick();
    const fri = sentTo(bot.calls, JOHN.id).map((c) => c.payload.text);
    expect(fri.some((x) => x.includes('Week in review'))).toBe(true);
    expect(fri.some((x) => x.includes('Founder brief'))).toBe(false);
  });

  it('when on, replaces Week in review with the brief (one Friday message)', async () => {
    const { app, clock, bot, john, sami, rh } = await setup();
    await app.flags.set(app.workspace.id, 'brief', true);
    await app.flags.set(app.workspace.id, 'wins', true);
    clock.set('2026-11-17T19:05:00+03:00'); // during Tuesday's Weekly sync
    const sync = (await app.meetings.upcoming(john, 1))[0]!;
    await app.meetings.start(john, sync.id);
    await app.meetings.end(john, sync.id);
    clock.set('2026-11-18T09:00:00+03:00');
    const done = await app.tasks.create(john, { projectId: rh.id, title: 'Ship OTP fix', priority: 'high' });
    await app.tasks.setStatus(john, done.id, 'done');
    const blocked = await app.tasks.create(sami, { projectId: rh.id, title: 'SMS gateway contract' });
    await app.tasks.setStatus(sami, blocked.id, 'blocked');
    await app.tasks.create(john, { projectId: rh.id, title: 'Renew domain', due: { date: '2026-11-12', time: null } });
    await app.costs.setBudget(john, rh.id, { period: 'monthly', amount: 100_000 });
    const cats = await app.costs.categories(john);
    await app.costs.create(john, { projectId: rh.id, categoryId: cats[0]!.id, amount: 90_000, currency: 'ETB', date: '2026-11-18', paidBy: john.userId, method: 'bank', tag: 'expense', split: 'rule' });
    await app.insights.addWin(sami, 'First paying rider', rh.id);

    clock.set('2026-11-20T17:00:30+03:00');
    bot.calls.length = 0;
    await bot.scheduler.tick();
    const toJohn = sentTo(bot.calls, JOHN.id).map((c) => c.payload.text);
    expect(toJohn.filter((x) => x.includes('Week in review'))).toHaveLength(0);
    const brief = toJohn.find((x) => x.includes('Founder brief'))!;
    expect(brief).toContain('Done this week · 1');
    expect(brief).toContain('Ship OTP fix');
    expect(brief).toContain('Stuck · 2'); // blocked + overdue > 3 days
    expect(brief).toContain('Weekly sit-down');
    expect(brief).toContain('900.00 ETB');
    expect(brief).toContain('90%');
    expect(brief).toContain('First paying rider');
    expect(brief).toContain('Meeting streak: 1 week');
    const pri = brief.slice(brief.indexOf('Three priorities'));
    expect(pri.indexOf('Renew domain')).toBeLessThan(pri.indexOf('SMS gateway'));
    expect(sentTo(bot.calls, SAMI.id).some((c) => c.payload.text.includes('Founder brief'))).toBe(true);
  });
});

describe('workload and wins', () => {
  it('workload shows facts and a hint only when it fits', async () => {
    const { app, bot, john, sami, rh } = await setup();
    await app.flags.set(app.workspace.id, 'workload', true);
    const eng = (await app.projects.areas(john, rh.id)).find((a) => a.slug === 'engineering')!; // owned by John
    for (let k = 0; k < 6; k++) await app.tasks.create(sami, { projectId: rh.id, title: `Sami task ${k}`, ownerUserId: sami.userId, ...(k === 0 ? { areaId: eng.id } : {}) });
    await app.tasks.create(john, { projectId: rh.id, title: 'John task' });
    await bot.send(JOHN, '/workload');
    const v = bot.calls.at(-1)!;
    expect(v.payload.text).toContain('6 open');
    expect(v.payload.text).toContain('Sami has 6 open tasks and John has 1');
    expect(v.payload.text).toContain('Sami task 0');
    expect(v.payload.text).not.toContain('Sami task 1');
    expect(v.payload.text).toContain('no scores');
    const btn = (v.payload.reply_markup.inline_keyboard.flat() as any[]).find((b) => b.text.startsWith('👤 Reassign'));
    expect(btn.callback_data).toMatch(/^t:a:/);
  });

  it('/win tells the partner once; wins and streak are listed', async () => {
    const { app, bot } = await setup();
    await app.flags.set(app.workspace.id, 'wins', true);
    await bot.send(JOHN, '/win First paying rider in Bole #ridehome');
    expect(sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('logged a win'))).toHaveLength(1);
    await bot.send(SAMI, '/wins');
    expect(bot.calls.at(-1)!.payload.text).toContain('First paying rider in Bole');
  });

  it('API endpoints follow the feature switches', async () => {
    const { app, john } = await setup();
    const r = buildApiRouter();
    const member = (await app.members.findByTelegramId(JOHN.id))!.member;
    const call = async (path: string) => {
      const m = r.match('GET', path);
      if (!m || m === 'method') throw new Error('no route');
      return m.handler({ app, actor: john, member, params: m.params, query: new URLSearchParams(), body: undefined });
    };
    await expect(call('/brief')).rejects.toThrow('error.forbidden');
    await app.flags.set(app.workspace.id, 'brief', true);
    await expect(call('/brief')).resolves.toMatchObject({ priorities: expect.any(Array) });
  });
});
