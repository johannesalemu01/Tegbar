import { statSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enc } from '../src/core/ids.js';
import { statementCsv, statementPdf } from '../src/modules/costs/exports.js';
import { S_CURRENCIES, S_SPEND_THRESHOLD } from '../src/modules/costs/settings.js';
import { EVE, JOHN, SAMI, SETUP, makeApp, makeBot, pairBoth, ridehome, type ApiCall } from './helpers.js';

async function setup(now = '2026-11-15T10:00:00+03:00') {
  const { app, clock } = await makeApp(now);
  const { john, sami } = await pairBoth(app);
  const bot = makeBot(app);
  const rh = await ridehome(app, john);
  const cats = await app.costs.categories(john);
  const cat = (slug: string) => cats.find((c) => c.slug === slug)!.id;
  const spend = (who: typeof john, amount: number, extra: Partial<Parameters<typeof app.costs.create>[1]> = {}) =>
    app.costs.create(who, { projectId: rh.id, categoryId: cat('hosting'), amount, currency: 'ETB', date: '2026-11-14', paidBy: who.userId, method: 'bank', tag: 'expense', split: 'rule', ...extra });
  return { app, clock, bot, john, sami, rh, cat, spend };
}
const sentTo = (calls: ApiCall[], chatId: number) => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chatId);
const lastKb = (calls: ApiCall[]) => ([...calls].reverse().find((c) => c.payload.reply_markup)?.payload.reply_markup.inline_keyboard ?? []).flat() as any[];
const transfers = async (app: any, actor: any, projectId: number | null = null) => (await app.costs.balances(actor, projectId)).flatMap((b: any) => b.transfers.map((t: any) => ({ ...t, currency: b.currency })));

describe('recording costs', () => {
  it('seeds the default categories', async () => {
    const { app, john } = await setup();
    expect((await app.costs.categories(john)).map((c) => c.name)).toEqual([
      'Hosting & servers', 'SMS & maps', 'Tools & subscriptions', 'Legal & registration', 'Marketing', 'Travel', 'Equipment', 'Other',
    ]);
  });

  it('/spend shows a card; Save twice records exactly one cost with a frozen 50/50 split', async () => {
    const { app, bot, john } = await setup();
    await bot.send(JOHN, '/spend 1,500.50 ETB hosting #ridehome paid-by me telebirr');
    const card = bot.calls.at(-1)!.payload.text;
    expect(card).toContain('1,500.50 ETB');
    expect(card).toContain('Hosting &amp; servers');
    const save = lastKb(bot.calls).find((b) => b.callback_data?.startsWith('cn:s:'))!.callback_data;
    await bot.tap(JOHN, save);
    await bot.tap(JOHN, save);
    const { items } = await app.costs.list(john, {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ amount_minor: 150_050, currency: 'ETB', method: 'telebirr', status: 'active' });
    expect(items[0]!.splits.map((s) => s.amount)).toEqual([75_025, 75_025]);
    expect(Number.isInteger(items[0]!.amount_minor)).toBe(true);
  });

  it('odd santim goes to the payer; "only mine" does not affect the balance', async () => {
    const { app, john, sami, spend } = await setup();
    const { cost } = await spend(sami, 101);
    expect(Object.fromEntries(cost.splits.map((s) => [s.userId, s.amount]))).toEqual({ [john.userId]: 50, [sami.userId]: 51 });
    await spend(john, 99_999, { split: 'mine' });
    expect(await transfers(app, john)).toEqual([{ from: john.userId, to: sami.userId, amount: 50, currency: 'ETB' }]);
  });

  it('blocks disabled currencies and future dates; allows USD with a typed rate', async () => {
    const { app, bot, john, spend } = await setup();
    await bot.send(JOHN, '/spend $20 hosting');
    expect(bot.calls.at(-1)!.payload.text).toContain('USD is not enabled');
    await bot.tap(JOHN, lastKb(bot.calls).find((b) => b.callback_data?.startsWith('cn:s:'))!.callback_data);
    expect((await app.costs.list(john, {})).total).toBe(0);
    await expect(spend(john, 100, { date: '2026-12-01' })).rejects.toThrow('cost.future_date');

    await app.settings.setAs(john, S_CURRENCIES, john.workspaceId, ['ETB', 'USD']);
    await expect(spend(john, 2_000, { currency: 'USD' })).rejects.toThrow('cost.need_rate');
    const { cost } = await spend(john, 2_000, { currency: 'USD', rateMicro: 125_500_000 });
    expect(cost.rate_micro).toBe(125_500_000);
    const st = await app.costs.statement(john, '2026-11');
    expect(st.currencies).toEqual(['USD']);
    await spend(john, 10_000);
    const st2 = await app.costs.statement(john, '2026-11');
    expect(st2.converted).toMatchObject({ reporting: 'ETB', total: 251_000 + 10_000, rates: [{ currency: 'USD', rateMicro: 125_500_000, source: 'entry' }] });
  });

  it('edits are logged and re-split; voids keep the row and leave totals', async () => {
    const { app, john, sami, spend } = await setup();
    const { cost } = await spend(john, 100_000);
    await app.costs.edit(sami, cost.id, { amount: 120_000 });
    const edited = await app.costs.get(john, cost.id);
    expect(edited.splits.map((s) => s.amount)).toEqual([60_000, 60_000]);
    await expect(app.costs.void(john, cost.id, 'x')).rejects.toThrow('cost.void_reason');
    expect((await app.costs.void(john, cost.id, 'Duplicate of bank entry')).changed).toBe(true);
    expect((await app.costs.void(john, cost.id, 'again')).changed).toBe(false);
    expect(await transfers(app, john)).toEqual([]);
    const row = await app.db.selectFrom('costs').selectAll().where('id', '=', cost.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'voided', void_reason: 'Duplicate of bank entry', amount_minor: 120_000 });
    const actions = (await app.costs.history(john, cost.id)).map((e) => e.action);
    expect(actions).toEqual(['cost.voided', 'cost.updated', 'cost.created']);
    await expect(app.costs.edit(john, cost.id, { amount: 1 })).rejects.toThrow('cost.is_voided');
  });
});

describe('balances and settling up', () => {
  it('who owes whom, overall and per project; settle with one tap + confirmation', async () => {
    const { app, bot, john, sami, rh, cat, spend } = await setup();
    await spend(john, 150_000);
    const general = await app.projects.general(john.workspaceId);
    await spend(sami, 40_000, { projectId: general.id, categoryId: cat('sms-maps') });
    expect(await transfers(app, john)).toEqual([{ from: sami.userId, to: john.userId, amount: 55_000, currency: 'ETB' }]);
    expect(await transfers(app, john, rh.id)).toEqual([{ from: sami.userId, to: john.userId, amount: 75_000, currency: 'ETB' }]);

    await bot.send(SAMI, '/balance');
    expect(bot.calls.at(-1)!.payload.text).toContain('Sami owes John');
    const pay = lastKb(bot.calls).find((b) => b.callback_data?.startsWith('se:new:'))!.callback_data;
    await bot.tap(SAMI, pay);
    await bot.tap(SAMI, pay); // double tap → one record
    const req = sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('says they paid you'));
    expect(req).toHaveLength(1);
    expect(await transfers(app, john)).toHaveLength(1); // pending does not count yet

    const confirm = (req[0]!.payload.reply_markup.inline_keyboard.flat() as any[]).find((b) => b.callback_data.startsWith('se:c:')).callback_data;
    await bot.tap(SAMI, confirm); // payer cannot confirm
    expect(await transfers(app, john)).toHaveLength(1);
    await bot.tap(JOHN, confirm);
    await bot.tap(JOHN, confirm);
    expect(await transfers(app, john)).toEqual([]);
    expect(sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('John confirmed'))).toHaveLength(1);
  });
});

describe('two-key approvals', () => {
  it('a split-rule change waits for the other person; old costs keep their split', async () => {
    const { app, bot, john, sami, rh, spend } = await setup();
    const { cost: before } = await spend(john, 10_000);
    await bot.tap(JOHN, `cs:split:${enc(rh.id)}:custom`);
    await bot.send(JOHN, '60/40');
    await bot.tap(JOHN, `cs:split:${enc(rh.id)}:custom`);
    await bot.send(JOHN, '60/40'); // same request again → reused, one card
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('Second key'))).toHaveLength(1);
    const card = sentTo(bot.calls, SAMI.id).find((c) => c.payload.text.includes('Second key'))!;
    expect(card.payload.text).toContain('RIDEHOME');
    expect((await app.costs.splitRule(john.workspaceId, rh.id)).mode).toBe('equal');
    const approve = (card.payload.reply_markup.inline_keyboard.flat() as any[]).find((b) => b.callback_data.startsWith('ap:a:')).callback_data;
    await bot.tap(JOHN, approve); // requester cannot approve
    expect((await app.costs.splitRule(john.workspaceId, rh.id)).mode).toBe('equal');
    await bot.tap(SAMI, approve);
    await bot.tap(SAMI, approve);
    expect((await app.costs.splitRule(john.workspaceId, rh.id)).mode).toBe('custom');
    const { cost: after } = await spend(john, 10_000);
    expect(after.splits.map((s) => s.amount)).toEqual([6_000, 4_000]);
    expect((await app.costs.get(john, before.id)).splits.map((s) => s.amount)).toEqual([5_000, 5_000]);
    expect(sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('Sami approved'))).toHaveLength(1);
  });

  it('spends above the threshold count only after approval (threshold off by default)', async () => {
    const { app, john, sami, spend } = await setup();
    expect((await spend(john, 5_000_000)).needsApproval).toBe(false);
    await app.settings.setAs(john, S_SPEND_THRESHOLD, john.workspaceId, 1_000_000);
    const { cost, needsApproval } = await spend(john, 2_000_000);
    expect(needsApproval).toBe(true);
    expect(cost.status).toBe('pending_approval');
    const [a] = await app.approvals.pending(sami);
    await app.approvals.decide(sami, a!.id, true);
    expect((await app.costs.get(john, cost.id)).status).toBe('active');
  });

  it('a third person joins only with an approved invite code', async () => {
    const { app, bot } = await setup();
    await bot.send(JOHN, '/invite Abebe viewer');
    const code = /TGB-[A-Z2-7]{10}/.exec(bot.calls.find((c) => c.payload.text?.includes('TGB-'))!.payload.text)![0];
    expect(await app.pairing.tryPair(app.workspace.id, EVE, EVE.id, code)).toEqual({ kind: 'ignored' });
    const [a] = await app.approvals.pending({ userId: 2, workspaceId: 1 });
    await app.approvals.decide({ userId: 2, workspaceId: 1 }, a!.id, true);
    const r = await app.pairing.tryPair(app.workspace.id, EVE, EVE.id, code);
    expect(r).toMatchObject({ kind: 'paired' });
    expect(await app.pairing.tryPair(app.workspace.id, { id: 7777, first_name: 'X' }, 7777, code)).toEqual({ kind: 'ignored' });
    expect(await app.pairing.tryPair(app.workspace.id, { id: 7778, first_name: 'Y' }, 7778, SETUP)).toEqual({ kind: 'ignored' });
    const eve = { userId: (r as any).member.user_id, workspaceId: 1 };
    const rh = await ridehome(app, eve);
    expect(await app.permissions.can(eve, 'cost.view', { projectId: rh.id })).toBe(true);
    expect(await app.permissions.can(eve, 'cost.create', { projectId: rh.id })).toBe(false);
  });
});

describe('budgets, recurring costs, receipts, statements', () => {
  it('budget warnings at 80% and 100%, once each', async () => {
    const { app, bot, john, rh, spend } = await setup();
    await app.costs.setBudget(john, rh.id, { period: 'monthly', amount: 200_000 });
    await spend(john, 170_000);
    await spend(john, 10_000);
    await spend(john, 30_000);
    await spend(john, 30_000);
    await bot.scheduler.tick();
    const toJohn = sentTo(bot.calls, JOHN.id).map((c) => c.payload.text);
    expect(toJohn.filter((x) => x.includes('80% of budget'))).toHaveLength(1);
    expect(toJohn.filter((x) => x.includes('budget reached'))).toHaveLength(1);
    expect(sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('budget'))).toHaveLength(2);
  });

  it('recurring cost: renewal alert, then recorded exactly once, then advances', async () => {
    const { app, clock, bot, john, rh, cat } = await setup();
    const r = await app.costs.createRecurring(john, {
      projectId: rh.id, categoryId: cat('hosting'), amount: 120_000, currency: 'ETB', paidBy: john.userId, method: 'card', note: 'VPS',
      recurrence: { freq: 'monthly', interval: 1, day: 25, anchor: '2026-11-25' }, action: 'create', alertDays: 7,
    });
    expect(r.next_date).toBe('2026-11-25');
    clock.set('2026-11-18T09:00:30+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, SAMI.id).some((c) => c.payload.text.includes('Renews in 7 days'))).toBe(true);
    clock.set('2026-11-25T09:00:30+03:00');
    await Promise.all([bot.scheduler.tick(), bot.scheduler.tick()]);
    await makeBot(app).scheduler.tick();
    const costs = await app.costs.list(john, {});
    expect(costs.items.filter((c) => c.recurring_id === r.id)).toHaveLength(1);
    expect((await app.costs.recurringById(john.workspaceId, r.id))!.next_date).toBe('2026-12-25');
    expect((await app.jobs.get(john.workspaceId, `rc:${r.id}:due`))!.next_fire_at).toBe('2026-12-25T06:00:00.000Z');
  });

  it('remind-mode recurring: one-tap "Record it now" is idempotent', async () => {
    const { app, clock, bot, john, rh, cat } = await setup();
    const r = await app.costs.createRecurring(john, {
      projectId: rh.id, categoryId: cat('sms-maps'), amount: 50_000, currency: 'ETB', paidBy: john.userId, method: 'telebirr', note: 'SMS credits',
      recurrence: { freq: 'monthly', interval: 1, day: 16, anchor: '2026-11-16' }, action: 'remind', alertDays: 0,
    });
    clock.set('2026-11-16T09:00:30+03:00');
    await bot.scheduler.tick();
    const btn = (sentTo(bot.calls, JOHN.id).at(-1)!.payload.reply_markup.inline_keyboard.flat() as any[])[0].callback_data;
    await bot.tap(JOHN, btn);
    await bot.tap(JOHN, btn);
    expect((await app.costs.list(john, {})).items.filter((c) => c.recurring_id === r.id)).toHaveLength(1);
  });

  it('a photo with a /spend caption becomes a cost with a private receipt file', async () => {
    const { app, bot, john } = await setup();
    await (bot.bot as any).handleUpdate({
      update_id: 5000,
      message: {
        message_id: 1, date: 0, chat: { id: JOHN.id, type: 'private' }, from: { ...JOHN, is_bot: false }, caption: '/spend 300 hosting',
        photo: [{ file_id: 'small', file_unique_id: 'u1', width: 90, height: 90, file_size: 100 }, { file_id: 'big', file_unique_id: 'u2', width: 900, height: 900, file_size: 1000 }],
      },
    });
    await bot.tap(JOHN, lastKb(bot.calls).find((b) => b.callback_data?.startsWith('cn:s:'))!.callback_data);
    const [c] = (await app.costs.list(john, {})).items;
    expect(c!.receipt_count).toBe(1);
    const [rec] = await app.costs.receipts(john, c!.id);
    expect(rec!.telegram_file_id).toBe('big');
    const path = app.costs.receiptPath(rec!.path!);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await bot.tap(JOHN, `co:rv:${enc(c!.id)}`);
    expect(bot.calls.some((x) => x.method === 'sendPhoto' && x.payload.photo === 'big')).toBe(true);
  });

  it('statement: CSV (BOM, quoting, formula-safe, Amharic) and a real PDF; sent on the statement day', async () => {
    const { app, clock, bot, john, sami, spend } = await setup();
    await spend(john, 150_000, { note: 'VPS, Nov — ለአገልጋይ' });
    await spend(sami, 2_000, { note: '=HYPERLINK("x")', tag: 'capital' });
    const st = await app.costs.statement(john, '2026-11');
    const names = new Map([[john.userId, 'John'], [sami.userId, 'Sami']]);
    const csv = statementCsv(st, names);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"VPS, Nov — ለአገልጋይ"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('1500.00');
    const { cost: dup } = await spend(john, 500);
    await app.costs.void(john, dup.id, 'Charged twice');
    const csv2 = statementCsv(await app.costs.statement(john, '2026-11'), names);
    expect(csv2).toContain('voided,Charged twice');
    const pdf = await statementPdf(st, names, { workspace: 'Tegbar', generatedAt: 'now', monthLabel: 'November 2026' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5_000);

    clock.set('2026-12-01T09:00:30+03:00');
    await bot.scheduler.tick();
    const sent = sentTo(bot.calls, JOHN.id).find((c) => c.payload.text.includes('Statement'))!;
    expect(sent.payload.text).toContain('November 2026');
    expect(sent.payload.text).toContain('1,520.00 ETB');
    await bot.tap(JOHN, (sent.payload.reply_markup.inline_keyboard.flat() as any[]).find((b) => b.callback_data.startsWith('cs:pdf:')).callback_data);
    expect(bot.calls.some((c) => c.method === 'sendDocument')).toBe(true);
  });

  it('every costs screen fits Telegram limits and every tap is answered', async () => {
    const { bot, spend, john } = await setup();
    const { cost } = await spend(john, 12_345, { note: 'x'.repeat(300) });
    for (const cmd of ['/costs', '/balance', '/statement 2026-11', '/budget', '/recurring_costs', '/approvals', '/settle']) await bot.send(JOHN, cmd);
    const taps = [`co:o:${enc(cost.id)}`, `co:e:${enc(cost.id)}`, `co:h:${enc(cost.id)}`, `co:ec:${enc(cost.id)}`, 'cs:split:a', 'cs:cats:0', 'cs:rec:0', 'cd:202611:a:0', 'cs:bud:a'];
    for (const d of taps) await bot.tap(JOHN, d);
    for (const c of bot.calls) {
      for (const b of (c.payload.reply_markup?.inline_keyboard ?? []).flat() as any[]) if (b.callback_data) expect(Buffer.byteLength(b.callback_data), b.callback_data).toBeLessThanOrEqual(64);
      if (c.payload.text) expect(c.payload.text.length).toBeLessThan(4096);
    }
    expect(bot.calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(taps.length);
  });
});
