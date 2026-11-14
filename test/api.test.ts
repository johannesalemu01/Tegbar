import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { signInitData, validateInitData } from '../src/core/api/initdata.js';
import { buildApiRouter } from '../src/core/api/routes.js';
import { createApiHandler } from '../src/core/api/server.js';
import { EVE, JOHN, makeApp, pairBoth, ridehome } from './helpers.js';

const TOKEN = '0000000:TEST-TOKEN-not-real-xxxxxxxxxxxx';
let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(now = '2026-11-15T10:00:00+03:00') {
  const { app, clock } = await makeApp(now);
  const { john, sami } = await pairBoth(app);
  const handler = createApiHandler(app, buildApiRouter(), { botToken: TOKEN, maxAgeSec: 3600, onError: async () => undefined });
  server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/v1`;
  const authDate = String(Math.floor(clock.now().toSeconds()));
  const initFor = (u: { id: number; first_name: string }, extra: Record<string, string> = {}) =>
    signInitData({ auth_date: authDate, query_id: 'AAE', user: JSON.stringify(u), ...extra }, TOKEN);
  const call = async (path: string, init: RequestInit & { as?: { id: number; first_name: string }; raw?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `tma ${init.raw ?? initFor(init.as ?? JOHN)}`,
      },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { app, clock, john, sami, call, initFor, base };
}

describe('Mini App initData validation', () => {
  const fields = { auth_date: '1794700000', query_id: 'AAE', user: JSON.stringify({ id: 1, first_name: 'A' }), signature: 'sig' };
  it('accepts correctly signed data (signature field included in the check string)', () => {
    const r = validateInitData(signInitData(fields, TOKEN), TOKEN, { maxAgeSec: 3600, nowSec: 1794700100 });
    expect(r.ok && r.data.user.id).toBe(1);
  });
  it('rejects tampering, the wrong bot token, stale and future data', () => {
    const good = signInitData(fields, TOKEN);
    const tampered = good.replace('%22id%22%3A1', '%22id%22%3A2');
    expect(validateInitData(tampered, TOKEN, { maxAgeSec: 3600, nowSec: 1794700100 })).toEqual({ ok: false, error: 'bad_hash' });
    expect(validateInitData(good, `${TOKEN}x`, { maxAgeSec: 3600, nowSec: 1794700100 })).toEqual({ ok: false, error: 'bad_hash' });
    expect(validateInitData(good, TOKEN, { maxAgeSec: 3600, nowSec: 1794710000 })).toEqual({ ok: false, error: 'expired' });
    expect(validateInitData(good, TOKEN, { maxAgeSec: 3600, nowSec: 1794690000 })).toEqual({ ok: false, error: 'future' });
    expect(validateInitData('auth_date=1&user=x', TOKEN, { maxAgeSec: 3600, nowSec: 1 })).toEqual({ ok: false, error: 'missing_hash' });
  });
});

describe('HTTP API', () => {
  it('requires valid launch data from a member', async () => {
    const { call, initFor } = await start();
    expect((await call('/me', { raw: '' })).status).toBe(401);
    expect((await call('/me', { raw: initFor(JOHN).replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`) })).status).toBe(401);
    expect((await call('/me', { as: EVE })).status).toBe(403);
    const me = await call('/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ displayName: 'John', seat: 'A', timezone: 'Africa/Addis_Ababa', currentProject: { code: 'RIDEHOME' } });
  });

  it('rejects launch data older than the max age', async () => {
    const { call, clock, initFor } = await start();
    const old = initFor(JOHN);
    clock.set('2026-11-15T12:00:00+03:00');
    expect((await call('/me', { raw: old })).status).toBe(401);
  });

  it('task lifecycle uses the same domain rules as the bot', async () => {
    const { app, call, john } = await start();
    const created = await call('/tasks', { method: 'POST', body: JSON.stringify({ text: 'Call MMCY tomorrow 10am @sami !high #sales' }) });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Call MMCY', priority: 'high', ownerName: 'Sami', projectCode: 'RIDEHOME', dueAt: '2026-11-16T07:00:00.000Z' });

    const ambiguous = await call('/tasks', { method: 'POST', body: JSON.stringify({ text: 'something @bob' }) });
    expect(ambiguous.status).toBe(422);

    const id = created.body.id;
    const patched = await call(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    expect(patched.body).toMatchObject({ changed: true, task: { status: 'done' } });
    const again = await call(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    expect(again.body.changed).toBe(false);

    const list = await call('/tasks?owner=all&status=all');
    expect(list.body.total).toBe(1);
    expect((await call(`/tasks/${id}/history`)).body.length).toBe(2);
    expect((await call(`/tasks/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call('/tasks?owner=all&status=all')).body.total).toBe(0);
    expect((await call(`/tasks/${id}/restore`, { method: 'POST', body: '{}' })).status).toBe(200);
    // reminder jobs were planned exactly as from Telegram
    expect((await app.jobs.activeByPrefix(app.workspace.id, `task:${id}:`)).length).toBe(0); // done → none
    void john;
  });

  it('validates input and maps domain errors to HTTP codes', async () => {
    const { app, call, john } = await start();
    const rh = await ridehome(app, john);
    expect((await call('/tasks', { method: 'POST', body: JSON.stringify({ projectId: rh.id }) })).status).toBe(400);
    expect((await call('/tasks', { method: 'POST', body: '{bad' })).status).toBe(400);
    expect((await call('/tasks/99999')).status).toBe(404);
    expect((await call('/tasks/abc')).status).toBe(400);
    expect((await call('/nope')).status).toBe(404);
    expect((await call('/me', { method: 'DELETE' })).status).toBe(405);
    const r = await call('/tasks?owner=bogus');
    expect(r.status).toBe(400);
    // a viewer-like outsider project is invisible: General/RideHome only
    expect((await call('/projects')).body.map((p: any) => p.code).sort()).toEqual(['GENERAL', 'RIDEHOME']);
  });
});
