import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import SQLite from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { extractBackup } from '../src/core/backup/backup.js';
import { openDatabase } from '../src/core/db/database.js';
import { enc } from '../src/core/ids.js';
import { S_DND_UNTIL, S_FOCUS_UNTIL } from '../src/core/services/availability.js';
import { fixedClock, toDb } from '../src/core/time.js';
import { parseNote } from '../src/modules/notes/notes.js';
import { JOHN, SAMI, SETUP, makeApp, makeBot, pairBoth, ridehome, type ApiCall } from './helpers.js';

const PASS = 'a-very-long-backup-passphrase';
async function setup(opts: { backup?: boolean } = {}) {
  let ctx;
  if (opts.backup) {
    const dataDir = mkdtempSync(join(tmpdir(), 'tegbar-p5-'));
    const database = openDatabase(join(dataDir, 'tegbar.db'));
    const clock = fixedClock('2026-11-15T10:00:00+03:00');
    const app = await createApp({ database, clock, log: pino({ level: 'silent' }), setupCode: SETUP, seatNames: { A: 'John', B: 'Sami' }, dataDir, backup: { passphrase: PASS, keep: 3, time: '02:30', toTelegram: true } });
    ctx = { app, clock, dataDir };
  } else ctx = { ...(await makeApp()), dataDir: '' };
  const { john, sami } = await pairBoth(ctx.app);
  const bot = makeBot(ctx.app);
  const rh = await ridehome(ctx.app, john);
  return { ...ctx, bot, john, sami, rh };
}
const sentTo = (calls: ApiCall[], chat: number) => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chat);
const kb = (c: ApiCall | undefined) => (c?.payload.reply_markup?.inline_keyboard ?? []).flat() as any[];
const lastKb = (calls: ApiCall[]) => kb([...calls].reverse().find((c) => c.payload.reply_markup));

describe('notices', () => {
  it('urgent notices break through DND, repeat until acknowledged, and stop after the cap', async () => {
    const { app, clock, bot, sami } = await setup();
    await app.settings.setAs(sami, S_DND_UNTIL, sami.userId, toDb(clock.now().plus({ hours: 12 })));
    await bot.send(JOHN, '/notice !urgent Server is down, check SMS gateway');
    const post = lastKb(bot.calls).find((b) => b.callback_data?.startsWith('nd:s:')).callback_data;
    await bot.tap(JOHN, post);
    await bot.tap(JOHN, post); // one notice only
    const first = sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('URGENT'));
    expect(first).toHaveLength(1);
    let t = Date.parse('2026-11-15T07:00:00Z');
    for (let k = 0; k < 10; k++) {
      t += 30 * 60_000 + 1000;
      clock.set(new Date(t).toISOString());
      await bot.scheduler.tick();
    }
    expect(sentTo(bot.calls, SAMI.id).filter((c) => c.payload.text.includes('URGENT'))).toHaveLength(1 + 6);
    expect((await app.db.selectFrom('notices').selectAll().execute())).toHaveLength(1);
  });

  it('acknowledging stops the repeats and tells the poster once', async () => {
    const { app, clock, bot } = await setup();
    await bot.send(JOHN, '/notice !urgent Pay the domain today');
    await bot.tap(JOHN, lastKb(bot.calls).find((b) => b.callback_data?.startsWith('nd:s:')).callback_data);
    const ack = kb(sentTo(bot.calls, SAMI.id).at(-1)).find((b) => b.callback_data?.startsWith('nt:ack:')).callback_data;
    await bot.tap(SAMI, ack);
    await bot.tap(SAMI, ack);
    expect(sentTo(bot.calls, JOHN.id).filter((c) => c.payload.text.includes('Sami</b> acknowledged'))).toHaveLength(1);
    bot.calls.length = 0;
    clock.set('2026-11-15T12:00:00+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, SAMI.id)).toHaveLength(0);
    void app;
  });

  it('info notices respect focus mode', async () => {
    const { app, clock, bot, sami } = await setup();
    await app.settings.setAs(sami, S_FOCUS_UNTIL, sami.userId, toDb(clock.now().plus({ hours: 1 })));
    await bot.send(JOHN, '/notice New logo files are in Drive');
    await bot.tap(JOHN, lastKb(bot.calls).find((b) => b.callback_data?.startsWith('nd:s:')).callback_data);
    expect(sentTo(bot.calls, SAMI.id)).toHaveLength(0);
    clock.set('2026-11-15T11:00:30+03:00');
    await bot.scheduler.tick();
    expect(sentTo(bot.calls, SAMI.id).some((c) => c.payload.text.includes('New logo'))).toBe(true);
  });

  it('/tell delivers with a Reply button, and replies quote the original', async () => {
    const { bot } = await setup();
    await bot.send(JOHN, '/tell call me when you are free');
    const msg = sentTo(bot.calls, SAMI.id).at(-1)!;
    expect(msg.payload.text).toContain('call me when you are free');
    await bot.tap(SAMI, kb(msg)[0].callback_data);
    await bot.send(SAMI, 'in 10 minutes');
    const back = sentTo(bot.calls, JOHN.id).at(-1)!;
    expect(back.payload.text).toContain('in 10 minutes');
    expect(back.payload.text).toContain('call me when you are free');
  });
});

describe('areas and the two-key rule', () => {
  it('owner changes wait for the other person; backups change directly', async () => {
    const { app, bot, john, sami, rh } = await setup();
    const sales = (await app.projects.areas(john, rh.id)).find((a) => a.slug === 'sales')!;
    expect(sales.owner_user_id).toBe(sami.userId);
    await bot.tap(JOHN, `ar:own:${enc(sales.id)}:${enc(john.userId)}`);
    expect((await app.projects.area(john, sales.id)).owner_user_id).toBe(sami.userId);
    const card = sentTo(bot.calls, SAMI.id).find((c) => c.payload.text.includes('Change area owner'))!;
    const approve = kb(card).find((b) => b.callback_data.startsWith('ap:a:')).callback_data;
    await bot.tap(JOHN, approve);
    expect((await app.projects.area(john, sales.id)).owner_user_id).toBe(sami.userId);
    await bot.tap(SAMI, approve);
    expect((await app.projects.area(john, sales.id)).owner_user_id).toBe(john.userId);
    await bot.tap(JOHN, `ar:bk:${enc(sales.id)}:${enc(sami.userId)}`);
    expect((await app.projects.area(john, sales.id)).backup_user_id).toBe(sami.userId);
  });
});

describe('decision log', () => {
  it('proposed → agreed; editing an agreed decision needs approval; supersede', async () => {
    const { app, bot, john, sami } = await setup();
    await bot.send(JOHN, '/decide Use Telebirr first — lower fees for riders');
    const [d] = (await app.decisions.list(john, {})).items;
    expect(d).toMatchObject({ status: 'proposed', rationale: 'lower fees for riders' });
    const proposal = sentTo(bot.calls, SAMI.id).find((c) => c.payload.text.includes('proposes a decision'))!;
    const agree = kb(proposal).find((b) => b.callback_data.startsWith('dc:ag:')).callback_data;
    await bot.tap(SAMI, agree);
    await bot.tap(SAMI, agree);
    const agreed = await app.decisions.get(john, d!.id);
    expect(agreed.status).toBe('agreed');
    expect(agreed.agreed_by.sort()).toEqual([john.userId, sami.userId].sort());

    const r = await app.decisions.edit(john, d!.id, { title: 'Use Telebirr only' });
    expect(r.applied).toBe(false);
    expect((await app.decisions.get(john, d!.id)).title).toBe('Use Telebirr first');
    await app.approvals.decide(sami, r.approvalId!, true);
    expect((await app.decisions.get(john, d!.id)).title).toBe('Use Telebirr only');

    const nd = await app.decisions.propose(sami, { projectId: d!.project_id, title: 'Support cards too', supersedes: d!.id });
    expect((await app.decisions.get(john, d!.id))).toMatchObject({ status: 'superseded', superseded_by: nd.id });
  });

  it('decisions taken in a meeting land in the log as agreed', async () => {
    const { app, john } = await setup();
    const m = (await app.meetings.upcoming(john, 2))[0]!;
    await app.meetings.start(john, m.id);
    await app.meetings.addOutcome(john, m.id, 'decision', 'Pilot with 20 riders');
    const [d] = (await app.decisions.list(john, {})).items;
    expect(d).toMatchObject({ title: 'Pilot with 20 riders', status: 'agreed', meeting_id: m.id });
  });

  it('pending decisions and unacknowledged urgent notices join the next agenda', async () => {
    const { app, john, sami, rh } = await setup();
    await app.decisions.propose(john, { projectId: rh.id, title: 'Hire a driver lead' });
    await app.comms.post(sami, { projectId: rh.id, level: 'urgent', body: 'Insurance expires Friday' });
    const m = (await app.meetings.upcoming(john, 1))[0]!;
    await app.meetings.ensureAgenda(john, m.id);
    const texts = (await app.meetings.agenda(john, m.id)).map((a) => a.text);
    expect(texts[0]).toBe('Insurance expires Friday');
    expect(texts).toContain('Hire a driver lead');
  });
});

describe('notes and search', () => {
  it('parses notes with project, tags and links', () => {
    expect(parseNote('Pricing call #ridehome #sales https://docs.example.com/x\nThey want 3 tiers', ['RIDEHOME'])).toEqual({
      title: 'Pricing call', body: 'They want 3 tiers', url: 'https://docs.example.com/x', tags: ['sales'], projectCode: 'RIDEHOME',
    });
  });

  it('/search finds tasks, notes, decisions, notices and meeting outcomes (Amharic too)', async () => {
    const { app, bot, john, sami, rh } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'ቦሌ ላይ ሾፌሮች ፈልግ (Bole drivers)' });
    await bot.send(JOHN, '/note Driver onboarding checklist #ridehome #ops');
    await app.decisions.propose(john, { projectId: rh.id, title: 'Drivers keep 85%' });
    await app.comms.post(sami, { projectId: rh.id, level: 'info', body: 'Driver meetup on Saturday' });
    const m = (await app.meetings.upcoming(john, 1))[0]!;
    await app.meetings.addOutcome(john, m.id, 'note', 'Drivers asked for weekly payouts');
    const hits = await app.search.query(john, 'driver');
    expect(new Set(hits.map((h) => h.type))).toEqual(new Set(['task', 'note', 'decision', 'notice', 'meeting']));
    expect((await app.search.query(john, 'ሾፌሮች')).map((h) => h.type)).toEqual(['task']);
    expect(await app.search.query(john, '%')).toEqual([]);
    await bot.send(JOHN, '/search driver');
    const v = bot.calls.at(-1)!;
    expect(v.payload.text).toContain('Search: driver');
    expect(kb(v).length).toBeGreaterThanOrEqual(5);
  });
});

describe('purge and export', () => {
  it('only already-deleted items can be purged; content and history are removed', async () => {
    const { app, bot, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'Secret supplier price 4200' });
    await expect(app.purge.run(john, 'tasks', [t.id])).rejects.toThrow('purge.nothing');
    await app.tasks.remove(john, t.id);
    await bot.send(JOHN, '/purge');
    await bot.tap(JOHN, 'px:pick:tasks');
    await bot.tap(JOHN, 'px:go:tasks');
    expect(await app.db.selectFrom('tasks').selectAll().where('id', '=', t.id).executeTakeFirst()).toBeUndefined();
    const ev = await app.db.selectFrom('events').selectAll().where('entity_type', '=', 'task').where('entity_id', '=', t.id).execute();
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.data === '{"redacted":true}')).toBe(true);
    expect(JSON.stringify(await app.db.selectFrom('events').selectAll().execute())).not.toContain('4200');
  });

  it('voided costs (and receipt files) need a second key to purge', async () => {
    const { app, john, sami, rh } = await setup();
    const cats = await app.costs.categories(john);
    const { cost } = await app.costs.create(john, { projectId: rh.id, categoryId: cats[0]!.id, amount: 1000, currency: 'ETB', date: '2026-11-14', paidBy: john.userId, method: 'cash', tag: 'expense', split: 'rule' });
    const path = await app.costs.saveReceiptFile(1, Buffer.from('img'), '.jpg');
    await app.costs.addReceipt(john, cost.id, { fileId: 'f', uniqueId: 'u', path, mime: 'image/jpeg', size: 3 });
    await app.costs.void(john, cost.id, 'Wrong entry');
    const r = await app.purge.run(john, 'costs', [cost.id]);
    expect(r.done).toBe(false);
    expect(existsSync(app.costs.receiptPath(path))).toBe(true);
    await app.approvals.decide(sami, r.approvalId!, true);
    expect(existsSync(app.costs.receiptPath(path))).toBe(false);
    expect(await app.db.selectFrom('costs').selectAll().where('id', '=', cost.id).executeTakeFirst()).toBeUndefined();
  });

  it('exports CSV per type and everything as JSON', async () => {
    const { app, bot, john, rh } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'ሰላም task, with comma' });
    await bot.send(JOHN, '/export');
    await bot.tap(JOHN, 'dx:csv:tasks');
    await bot.tap(JOHN, 'dx:json:all');
    expect(bot.calls.filter((c) => c.method === 'sendDocument')).toHaveLength(2);
    const all = await app.exporter.all(john);
    expect(Object.keys(all).sort()).toEqual(['costs', 'decisions', 'meetings', 'notes', 'notices', 'settlements', 'tasks']);
    expect(all.tasks![0]).toMatchObject({ title: 'ሰላም task, with comma', project: 'RIDEHOME' });
  });
});

describe('encrypted backups (end to end)', () => {
  it('daily job backs up at 02:30, sends it to John, and the file restores the real database', async () => {
    const { app, clock, bot, john, rh, dataDir } = await setup({ backup: true });
    await app.tasks.create(john, { projectId: rh.id, title: 'Backup me' });
    clock.set('2026-11-16T02:30:30+03:00');
    await bot.scheduler.tick();
    expect(bot.calls.some((c) => c.method === 'sendDocument' && c.payload.chat_id === JOHN.id)).toBe(true);
    const files = readdirSync(join(dataDir, 'backups')).filter((f) => f.endsWith('.tgbk'));
    expect(files).toHaveLength(1);
    const staging = mkdtempSync(join(tmpdir(), 'tegbar-verify-'));
    const manifest = await extractBackup(join(dataDir, 'backups', files[0]!), PASS, staging);
    expect(manifest.migrations).toContain('202611150800_comms_init');
    const restored = new SQLite(join(staging, 'db/tegbar.db'), { readonly: true });
    expect(restored.prepare("select title from tasks where title = 'Backup me'").get()).toEqual({ title: 'Backup me' });
    restored.close();
  });

  it('/backup is owner-only and "Back up now" sends the file; rotation keeps 3', async () => {
    const { app, bot, dataDir } = await setup({ backup: true });
    for (let k = 0; k < 4; k++) {
      await bot.tap(JOHN, 'bk:now');
      (app.clock as ReturnType<typeof fixedClock>).advance(1000);
    }
    expect(readdirSync(join(dataDir, 'backups')).filter((f) => f.endsWith('.tgbk'))).toHaveLength(3);
    expect(bot.calls.filter((c) => c.method === 'sendDocument').length).toBe(4);
  });

  it('without a passphrase backups are clearly off', async () => {
    const { bot } = await setup();
    await bot.send(JOHN, '/backup');
    expect(bot.calls.at(-1)!.payload.text).toContain('Backups are <b>off</b>');
  });
});
