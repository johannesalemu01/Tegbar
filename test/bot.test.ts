import { describe, expect, it } from 'vitest';
import { enc } from '../src/core/ids.js';
import { EVE, JOHN, SAMI, SETUP, allCallbackData, lastKeyboard, lastText, makeApp, makeBot, pairBoth, ridehome } from './helpers.js';

async function setup() {
  const { app, clock } = await makeApp();
  const bot = makeBot(app);
  return { app, clock, bot };
}

const answers = (calls: { method: string }[]) => calls.filter((c) => c.method === 'answerCallbackQuery').length;

describe('bot: access', () => {
  it('outsiders are silently ignored (no reply, no answer)', async () => {
    const { bot } = await setup();
    await bot.send(EVE, 'hello');
    await bot.send(EVE, '/start');
    await bot.tap(EVE, 'm:my');
    expect(bot.calls).toEqual([]);
  });

  it('pairing over Telegram deletes the code message and greets both people', async () => {
    const { app, bot } = await setup();
    await bot.send(JOHN, SETUP);
    expect(bot.calls.map((c) => c.method)).toContain('deleteMessage');
    expect(bot.calls.find((c) => c.method === 'sendMessage')?.payload.text).toContain('Welcome to Tegbar, John');
    bot.calls.length = 0;
    await bot.send(SAMI, `/start ${SETUP}`);
    const sends = bot.calls.filter((c) => c.method === 'sendMessage');
    expect(sends.map((c) => c.payload.chat_id).sort()).toEqual([JOHN.id, SAMI.id]);
    expect(sends.find((c) => c.payload.chat_id === JOHN.id)?.payload.text).toContain('Sami');
    const scoped = bot.calls.filter((c) => c.method === 'setMyCommands').map((c) => c.payload.scope.chat_id);
    expect(scoped.sort()).toEqual([JOHN.id, SAMI.id]);
    expect(await app.pairing.isClosed(app.workspace.id)).toBe(true);
    bot.calls.length = 0;
    await bot.send(EVE, SETUP);
    expect(bot.calls).toEqual([]);
  });
});

describe('bot: callbacks', () => {
  it('double-tapping Done changes the task once and answers both taps', async () => {
    const { app, bot } = await setup();
    const { john } = await pairBoth(app);
    const rh = await ridehome(app, john);
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x' });
    await bot.tap(JOHN, `t:d:${enc(t.id)}:-`);
    await bot.tap(JOHN, `t:d:${enc(t.id)}:-`);
    expect(answers(bot.calls)).toBe(2);
    const texts = bot.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text);
    expect(texts).toEqual(['✓ Done', 'Already done']);
    const events = await app.tasks.history(john, t.id);
    expect(events.filter((e) => e.action === 'task.updated')).toHaveLength(1);
  });

  it('stale or malformed buttons are answered with a hint, never crash', async () => {
    const { app, bot } = await setup();
    await pairBoth(app);
    for (const data of ['zz:1', 't:d:!!:-', 't:nope:1:-', 'tl:garbage', 'qa:s:zzzz', 'p:o:', 't:o:99999:-']) {
      bot.calls.length = 0;
      await bot.tap(JOHN, data);
      expect(answers(bot.calls), data).toBe(1);
    }
  });

  it('a button for a deleted task after a restart still answers safely', async () => {
    const { app, bot } = await setup();
    const { john } = await pairBoth(app);
    const rh = await ridehome(app, john);
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x' });
    await app.tasks.remove(john, t.id);
    const bot2 = makeBot(app); // "restart"
    await bot2.tap(JOHN, `t:d:${enc(t.id)}:-`);
    expect(answers(bot2.calls)).toBe(1);
    expect((await app.tasks.get(john, t.id, { includeDeleted: true })).status).toBe('todo');
  });

  it('quick-add draft: Save tapped twice creates exactly one task', async () => {
    const { app, bot } = await setup();
    const { john } = await pairBoth(app);
    await bot.send(JOHN, 'Call MMCY tomorrow 10am @nobody');
    expect(lastText(bot.calls)).toContain('Save as a task?');
    const save = lastKeyboard(bot.calls).flat().find((b: any) => b.callback_data?.startsWith('qa:s:'));
    await bot.tap(JOHN, save.callback_data);
    await bot.tap(JOHN, save.callback_data);
    const list = await app.tasks.list(john, { owner: 'all', projectId: null, status: 'all', due: 'any' });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ title: 'Call MMCY', due_date: '2026-11-16' });
    expect(answers(bot.calls)).toBe(2);
  });

  it('/add without ambiguity saves immediately and notifies the assignee', async () => {
    const { app, bot } = await setup();
    const { john } = await pairBoth(app);
    await bot.send(JOHN, '/add Send contract friday @sami !high');
    const list = await app.tasks.list(john, { owner: 'all', projectId: null, status: 'open', due: 'any' });
    expect(list.items[0]).toMatchObject({ title: 'Send contract', priority: 'high', owner_name: 'Sami' });
    const toSami = bot.calls.find((c) => c.method === 'sendMessage' && c.payload.chat_id === SAMI.id);
    expect(toSami?.payload.text).toContain('John assigned this to you');
  });

  it('pending question survives a restart and a button tap cancels it', async () => {
    const { app, bot } = await setup();
    const { john } = await pairBoth(app);
    await bot.send(JOHN, '/add');
    const bot2 = makeBot(app);
    await bot2.send(JOHN, 'Book venue next monday');
    expect((await app.tasks.list(john, { owner: 'me', projectId: null, status: 'open', due: 'any' })).total).toBe(1);

    await bot2.send(JOHN, '/add');
    await bot2.tap(JOHN, 'm:my');
    await bot2.send(JOHN, 'just chatting');
    expect(lastText(bot2.calls)).toContain('Save as a task?'); // not auto-saved
  });

  it('every keyboard we send fits Telegram callback_data limits', async () => {
    const { app, bot } = await setup();
    const { john } = await pairBoth(app);
    const rh = await ridehome(app, john);
    for (let i = 0; i < 10; i++) await app.tasks.create(john, { projectId: rh.id, title: `Task ${i} ${'x'.repeat(150)}` });
    for (const cmd of ['/menu', '/my', '/ours', '/today', '/week', '/overdue', '/projects', '/dashboard', '/settings', '/help', '/project', '/focus', '/remind', '/digest', '/recurring']) {
      await bot.send(JOHN, cmd);
    }
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x' });
    for (const a of ['o', 'z', 'e', 'a', 'x', 'h', 'ed', 'ep', 'es', 'ea', 'ej', 'er']) await bot.tap(JOHN, `t:${a}:${enc(t.id)}:my.0.m.a.o`);
    for (const d of ['rs:b', 'dg:p', 'dg:r', 'fo:f:60']) await bot.tap(JOHN, d);
    const data = allCallbackData(bot.calls);
    expect(data.length).toBeGreaterThan(50);
    for (const d of data) expect(Buffer.byteLength(d), d).toBeLessThanOrEqual(64);
    for (const c of bot.calls.filter((x) => x.payload.text)) expect(c.payload.text.length).toBeLessThan(4096);
  });

  it('list pages and filters round-trip through callback data', async () => {
    const { app, bot } = await setup();
    const { john } = await pairBoth(app);
    const rh = await ridehome(app, john);
    for (let i = 1; i <= 10; i++) await app.tasks.create(john, { projectId: rh.id, title: `n${i}` });
    await bot.send(JOHN, '/my');
    expect(lastText(bot.calls)).toContain('10 open');
    const next = lastKeyboard(bot.calls).flat().find((b: any) => b.text === '›');
    await bot.tap(JOHN, next.callback_data);
    expect(lastText(bot.calls)).toContain('n9');
    expect(lastText(bot.calls)).not.toContain('n1 ');
  });

  it('unknown commands and non-text messages get guidance', async () => {
    const { app, bot } = await setup();
    await pairBoth(app);
    await bot.send(JOHN, '/frobnicate');
    expect(lastText(bot.calls)).toContain('/help');
  });
});

describe('bot: menu', () => {
  it('front shows add + four groups + More; groups open sub-menus', async () => {
    const { app, bot } = await setup();
    await pairBoth(app);
    await bot.send(JOHN, '/menu');
    const front = allCallbackData(bot.calls);
    expect(front).toEqual(['m:add', 'm:g:tasks', 'm:g:alerts', 'm:meetings', 'm:costs', 'm:g:more']);
    bot.calls.length = 0;
    await bot.tap(JOHN, 'm:g:tasks');
    expect(allCallbackData(bot.calls)).toEqual(['m:add', 'm:my', 'm:today', 'm:week', 'm:overdue', 'm:ours', 'm:menu']);
    bot.calls.length = 0;
    await bot.tap(JOHN, 'm:g:alerts');
    expect(allCallbackData(bot.calls)).toEqual(['m:remind', 'm:notices', 'm:focus', 'm:menu']);
    bot.calls.length = 0;
    await bot.tap(JOHN, 'm:g:nope');
    expect(answers(bot.calls)).toBe(1);
  });
});
