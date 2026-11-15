import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApiRouter } from '../src/core/api/routes.js';
import { createStaticHandler } from '../src/core/http/static.js';
import { configureMiniApp } from '../src/modules/miniapp/telegram.js';
import { JOHN, SAMI, makeApp, makeBot, pairBoth, ridehome } from './helpers.js';

let server: Server | null = null;
afterEach(async () => {
  configureMiniApp({ publicUrl: undefined, apiEnabled: false });
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

async function serveStatic() {
  const handler = createStaticHandler();
  server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(418).end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('Mini App static files', () => {
  it('serves the app with a strict CSP and blocks traversal', async () => {
    const base = await serveStatic();
    const index = await fetch(`${base}/app/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    const csp = index.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self' https://telegram.org");
    expect(csp).toContain("connect-src 'self'");
    expect(await index.text()).toContain('telegram-web-app.js');
    expect((await fetch(`${base}/app/core.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/app/../package.json`)).status).not.toBe(200);
    expect((await fetch(`${base}/app/%2e%2e/package.json`)).status).not.toBe(200); // URL parser resolves it outside /app/
    expect((await fetch(`${base}/app/%2e%2e%2f%2e%2e%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/app`, { redirect: 'manual' })).status).toBe(301);
    expect((await fetch(`${base}/app/`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(418);
  });
});

describe('Mini App switch', () => {
  it('stays off until configured and switched on; then menu + chat menu button appear for both', async () => {
    const { app } = await makeApp();
    await pairBoth(app);
    const bot = makeBot(app);
    await bot.send(JOHN, '/app');
    expect(bot.calls.at(-1)!.payload.text).toContain('dashboard is off');
    await bot.send(JOHN, '/features');
    expect(bot.calls.at(-1)!.payload.text).toContain('PUBLIC_URL');

    configureMiniApp({ publicUrl: 'https://tegbar.example.com/', apiEnabled: true });
    await bot.tap(JOHN, 'ff:miniapp:1');
    await bot.tap(JOHN, 'ff:miniapp:1'); // target value → idempotent
    expect(await app.flags.isEnabled(app.workspace.id, 'miniapp')).toBe(true);
    const menuCalls = bot.calls.filter((c) => c.method === 'setChatMenuButton');
    expect(new Set(menuCalls.map((c) => c.payload.chat_id))).toEqual(new Set([JOHN.id, SAMI.id]));
    expect(menuCalls.at(-1)!.payload.menu_button).toMatchObject({ type: 'web_app', web_app: { url: 'https://tegbar.example.com/app/' } });

    bot.calls.length = 0;
    await bot.send(SAMI, '/menu');
    const kb = bot.calls.at(-1)!.payload.reply_markup.inline_keyboard.flat();
    expect(kb[0]).toMatchObject({ web_app: { url: 'https://tegbar.example.com/app/' } });

    await bot.tap(JOHN, 'ff:miniapp:0');
    expect(bot.calls.filter((c) => c.method === 'setChatMenuButton').at(-1)!.payload.menu_button).toEqual({ type: 'commands' });
    const events = await app.db.selectFrom('events').select('action').where('entity_type', '=', 'feature_flag').execute();
    expect(events.map((e) => e.action)).toEqual(['flag.enabled', 'flag.enabled', 'flag.disabled']);
  });
});

describe('Mini App endpoints', () => {
  it('/overview and /costs/summary return what the screens need', async () => {
    const { app } = await makeApp();
    const { john, sami } = await pairBoth(app);
    const rh = await ridehome(app, john);
    await app.tasks.create(john, { projectId: rh.id, title: 'today', due: { date: '2026-11-15', time: null } });
    await app.tasks.create(john, { projectId: rh.id, title: 'late', due: { date: '2026-11-01', time: null } });
    await app.comms.post(sami, { projectId: rh.id, level: 'urgent', body: 'Check this' });
    const cats = await app.costs.categories(john);
    await app.costs.create(john, { projectId: rh.id, categoryId: cats[0]!.id, amount: 150_000, currency: 'ETB', date: '2026-11-14', paidBy: john.userId, method: 'bank', tag: 'expense', split: 'rule' });
    const router = buildApiRouter();
    const member = (await app.members.findByTelegramId(JOHN.id))!.member;
    const call = async (path: string, q = '') => {
      const m = router.match('GET', path);
      if (!m || m === 'method') throw new Error(`no route ${path}`);
      return m.handler({ app, actor: john, member, params: m.params, query: new URLSearchParams(q), body: undefined }) as Promise<any>;
    };
    const o = await call('/overview');
    expect(o.counts).toEqual({ today: 1, overdue: 1, open: 2 });
    expect(o.nextMeeting).toMatchObject({ title: 'Weekly sync', mode: 'virtual' });
    expect(o.notices).toHaveLength(1);
    const s = await call('/costs/summary', 'month=2026-11');
    expect(s.totals).toEqual([{ currency: 'ETB', amountMinor: 150_000 }]);
    expect(s.byCategory[0]).toMatchObject({ name: 'Hosting & servers', amountMinor: 150_000 });
    expect(s.balance[0].transfers).toEqual([{ from: sami.userId, to: john.userId, amount: 75_000 }]);
    expect(s.recent[0]).toMatchObject({ amountMinor: 150_000, payerName: 'John' });
  });
});
