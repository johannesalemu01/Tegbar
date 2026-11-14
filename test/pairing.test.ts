import { describe, expect, it } from 'vitest';
import { EVE, JOHN, SAMI, SETUP, makeApp } from './helpers.js';

describe('pairing lock', () => {
  it('pairs the first two users as seats A and B, then closes registration', async () => {
    const { app } = await makeApp();
    const ws = app.workspace.id;
    expect(await app.pairing.isClosed(ws)).toBe(false);

    const a = await app.pairing.tryPair(ws, JOHN, JOHN.id, SETUP);
    expect(a).toMatchObject({ kind: 'paired', seat: 'A', complete: false });
    expect(await app.pairing.isClosed(ws)).toBe(false);

    const b = await app.pairing.tryPair(ws, SAMI, SAMI.id, `/start ${SETUP}`);
    expect(b).toMatchObject({ kind: 'paired', seat: 'B', complete: true });
    expect(await app.pairing.isClosed(ws)).toBe(true);

    // A third person with the right code is ignored — forever.
    expect(await app.pairing.tryPair(ws, EVE, EVE.id, SETUP)).toEqual({ kind: 'ignored' });
    expect((await app.members.list(ws)).map((m) => m.display_name)).toEqual(['John', 'Sami']);
  });

  it('ignores wrong codes without creating anything', async () => {
    const { app } = await makeApp();
    expect(await app.pairing.tryPair(app.workspace.id, EVE, EVE.id, 'guess')).toEqual({ kind: 'ignored' });
    expect(await app.pairing.tryPair(app.workspace.id, EVE, EVE.id, `${SETUP}x`)).toEqual({ kind: 'ignored' });
    expect(await app.members.findByTelegramId(EVE.id)).toBeNull();
  });

  it('does not create a second seat when a member re-sends the code', async () => {
    const { app } = await makeApp();
    await app.pairing.tryPair(app.workspace.id, JOHN, JOHN.id, SETUP);
    const again = await app.pairing.tryPair(app.workspace.id, JOHN, JOHN.id, SETUP);
    expect(again.kind).toBe('already_member');
    expect(await app.members.list(app.workspace.id)).toHaveLength(1);
  });

  it('makes both founders owners of every project and assigns area owners', async () => {
    const { app } = await makeApp();
    await app.pairing.tryPair(app.workspace.id, JOHN, JOHN.id, SETUP);
    await app.pairing.tryPair(app.workspace.id, SAMI, SAMI.id, SETUP);
    const pm = await app.db.selectFrom('project_members').selectAll().execute();
    const projects = await app.db.selectFrom('projects').selectAll().execute();
    expect(projects.map((p) => p.code).sort()).toEqual(['GENERAL', 'RIDEHOME']);
    expect(pm).toHaveLength(projects.length * 2);
    expect(pm.every((r) => r.role === 'owner')).toBe(true);

    const john = await app.members.findByTelegramId(JOHN.id);
    const eng = await app.db.selectFrom('areas').selectAll().where('slug', '=', 'engineering').executeTakeFirstOrThrow();
    const sales = await app.db.selectFrom('areas').selectAll().where('slug', '=', 'sales').executeTakeFirstOrThrow();
    expect(eng.owner_user_id).toBe(john!.user.id);
    expect(sales.backup_user_id).toBe(john!.user.id);
  });

  it('survives a restart: closed state is persisted in the database', async () => {
    const { app } = await makeApp();
    await app.pairing.tryPair(app.workspace.id, JOHN, JOHN.id, SETUP);
    await app.pairing.tryPair(app.workspace.id, SAMI, SAMI.id, SETUP);
    // even if a seat is freed, SETUP_CODE never works again
    await app.db.updateTable('workspace_members').set({ status: 'removed' }).where('seat', '=', 'B').execute();
    expect(await app.pairing.tryPair(app.workspace.id, EVE, EVE.id, SETUP)).toEqual({ kind: 'ignored' });
  });
});
