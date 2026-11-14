import { describe, expect, it } from 'vitest';
import { makeApp, pairBoth, ridehome } from './helpers.js';

async function setup() {
  const { app, clock } = await makeApp('2026-11-15T10:00:00+03:00');
  const { john, sami } = await pairBoth(app);
  const rh = await ridehome(app, john);
  const general = await app.projects.general(app.workspace.id);
  return { app, clock, john, sami, rh, general };
}

describe('task service', () => {
  it('creates with defaults and stores due time in UTC', async () => {
    const { app, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: '  Call   MMCY ', due: { date: '2026-11-16', time: '10:00' } });
    expect(t).toMatchObject({ title: 'Call MMCY', status: 'todo', priority: 'normal', owner_user_id: john.userId, project_code: 'RIDEHOME', owner_name: 'John' });
    expect(t.due_date).toBe('2026-11-16');
    expect(t.due_at).toBe('2026-11-16T07:00:00.000Z');
  });

  it('views: my / ours / today / week / overdue', async () => {
    const { app, john, sami, rh, general } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'mine today', due: { date: '2026-11-15', time: null } });
    await app.tasks.create(john, { projectId: rh.id, title: 'sami overdue', ownerUserId: sami.userId, due: { date: '2026-11-15', time: '09:00' } });
    await app.tasks.create(john, { projectId: general.id, title: 'mine next week', due: { date: '2026-11-21', time: null } });
    await app.tasks.create(john, { projectId: general.id, title: 'mine old', due: { date: '2026-11-10', time: null } });
    await app.tasks.create(john, { projectId: rh.id, title: 'no date' });

    const titles = async (f: Parameters<typeof app.tasks.list>[1]) => (await app.tasks.list(john, f)).items.map((t) => t.title);
    expect(await titles({ owner: 'me', projectId: null, status: 'open', due: 'any' })).toEqual(['mine old', 'mine today', 'mine next week', 'no date']);
    expect(await titles({ owner: 'all', projectId: rh.id, status: 'open', due: 'any' })).toEqual(['sami overdue', 'mine today', 'no date']);
    expect(await titles({ owner: 'all', projectId: null, status: 'open', due: 'today' })).toEqual(['sami overdue', 'mine today']);
    expect(await titles({ owner: 'all', projectId: null, status: 'open', due: 'week' })).toEqual(['sami overdue', 'mine today', 'mine next week']);
    // 10:00 now: 09:00 today is overdue, date-only today is not, the 10th is
    expect(await titles({ owner: 'all', projectId: null, status: 'open', due: 'overdue' })).toEqual(['mine old', 'sami overdue']);
    expect(await titles({ owner: sami.userId, projectId: null, status: 'open', due: 'any' })).toEqual(['sami overdue']);
  });

  it('paginates', async () => {
    const { app, john, rh } = await setup();
    for (let i = 1; i <= 11; i++) await app.tasks.create(john, { projectId: rh.id, title: `t${i}` });
    const p0 = await app.tasks.list(john, { owner: 'me', projectId: null, status: 'open', due: 'any' }, 0, 8);
    const p1 = await app.tasks.list(john, { owner: 'me', projectId: null, status: 'open', due: 'any' }, 1, 8);
    expect(p0.total).toBe(11);
    expect(p0.items).toHaveLength(8);
    expect(p1.items).toHaveLength(3);
  });

  it('done is idempotent and logs one event', async () => {
    const { app, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x' });
    expect((await app.tasks.setStatus(john, t.id, 'done')).changed).toBe(true);
    expect((await app.tasks.setStatus(john, t.id, 'done')).changed).toBe(false);
    const events = await app.tasks.history(john, t.id);
    expect(events.map((e) => e.action)).toEqual(['task.updated', 'task.created']);
    const done = await app.tasks.get(john, t.id);
    expect(done.completed_at).not.toBeNull();
    const reopened = await app.tasks.setStatus(john, t.id, 'todo');
    expect(reopened.task.completed_at).toBeNull();
  });

  it('soft delete, restore, /undo', async () => {
    const { app, john, sami, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'gone soon' });
    await app.tasks.remove(john, t.id);
    expect((await app.tasks.remove(john, t.id)).changed).toBe(false);
    await expect(app.tasks.get(john, t.id)).rejects.toThrow('error.not_found');
    expect((await app.tasks.list(john, { owner: 'all', projectId: null, status: 'all', due: 'any' })).total).toBe(0);
    // Sami's /undo does not restore John's deletion
    expect(await app.tasks.undoLastDelete(sami)).toBeNull();
    const back = await app.tasks.undoLastDelete(john);
    expect(back?.id).toBe(t.id);
    expect(await app.tasks.undoLastDelete(john)).toBeNull();
    const row = await app.db.selectFrom('tasks').selectAll().where('id', '=', t.id).executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
  });

  it('logs field-level history', async () => {
    const { app, john, sami, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x' });
    await app.tasks.update(john, t.id, { ownerUserId: sami.userId, priority: 'high', due: { date: '2026-11-20', time: '15:00' } });
    const [ev] = await app.tasks.history(john, t.id);
    const data = JSON.parse(ev!.data);
    expect(Object.keys(data.changes).sort()).toEqual(['due', 'owner', 'priority']);
    expect(data.changes.due.to).toBe('2026-11-20 15:00');
  });

  it('moving to another project clears a foreign area', async () => {
    const { app, john, rh, general } = await setup();
    const sales = (await app.projects.areas(john, rh.id)).find((a) => a.slug === 'sales')!;
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x', areaId: sales.id });
    const moved = await app.tasks.update(john, t.id, { projectId: general.id });
    expect(moved.task.area_id).toBeNull();
    await expect(app.tasks.update(john, t.id, { areaId: sales.id })).rejects.toThrow('task.area_mismatch');
  });

  it('snooze keeps the time of day for "tomorrow"', async () => {
    const { app, john, rh } = await setup();
    const t = await app.tasks.create(john, { projectId: rh.id, title: 'x', due: { date: '2026-11-15', time: '16:30' } });
    const s = await app.tasks.snooze(john, t.id, 'tom');
    expect(s.task.due_date).toBe('2026-11-16');
    expect(s.task.due_at).toBe('2026-11-16T13:30:00.000Z');
    const h = await app.tasks.snooze(john, t.id, '1h');
    expect(h.task.due_at).toBe('2026-11-15T08:00:00.000Z'); // 10:00 + 1h = 11:00 Addis
  });

  it('dashboard stats', async () => {
    const { app, john, rh } = await setup();
    await app.tasks.create(john, { projectId: rh.id, title: 'a', due: { date: '2026-11-01', time: null } });
    const b = await app.tasks.create(john, { projectId: rh.id, title: 'b' });
    await app.tasks.setStatus(john, b.id, 'done');
    const s = (await app.tasks.stats(john)).find((x) => x.projectId === rh.id)!;
    expect(s).toMatchObject({ open: 1, overdue: 1, doneThisWeek: 1 });
  });

  it('archived projects drop out of lists and cannot be current', async () => {
    const { app, john } = await setup();
    const p = await app.projects.create(john, { code: 'fleet', name: 'Fleet', description: 'B2B' });
    expect(p.code).toBe('FLEET');
    await app.tasks.create(john, { projectId: p.id, title: 'in fleet' });
    await app.projects.setCurrent(john, p.id);
    await app.projects.setArchived(john, p.id, true);
    expect((await app.projects.current(john)).code).toBe('RIDEHOME');
    expect((await app.tasks.list(john, { owner: 'all', projectId: null, status: 'open', due: 'any' })).total).toBe(0);
    await expect(app.projects.create(john, { code: 'FLEET', name: 'Dup' })).rejects.toThrow('project.code_taken');
  });
});
