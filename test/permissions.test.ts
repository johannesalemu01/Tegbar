import { describe, expect, it } from 'vitest';
import { MATRIX, type Action } from '../src/core/services/permissions.js';
import { toDb } from '../src/core/time.js';
import { makeApp, pairBoth, ridehome } from './helpers.js';

async function addUser(app: Awaited<ReturnType<typeof makeApp>>['app'], tg: number, wsRole: 'member' | 'viewer') {
  const now = toDb(app.clock.now());
  const u = await app.db.insertInto('users').values({
    telegram_id: tg, first_name: `U${tg}`, last_name: null, username: null, locale: null, blocked_at: null, created_at: now, updated_at: now,
  }).returning('id').executeTakeFirstOrThrow();
  await app.db.insertInto('workspace_members').values({
    workspace_id: app.workspace.id, user_id: u.id, role: wsRole, seat: null, display_name: `U${tg}`, handle: `u${tg}`,
    status: 'active', chat_id: tg, created_at: now, updated_at: now,
  }).execute();
  return { userId: u.id, workspaceId: app.workspace.id };
}

describe('central permissions', () => {
  it('owners can do everything in every project', async () => {
    const { app } = await makeApp();
    const { john } = await pairBoth(app);
    const p = await ridehome(app, john);
    for (const action of Object.keys(MATRIX) as Action[]) {
      expect(await app.permissions.can(john, action, { projectId: p.id })).toBe(true);
    }
  });

  it('outsiders and removed members can do nothing', async () => {
    const { app } = await makeApp();
    const { sami } = await pairBoth(app);
    const p = await ridehome(app, sami);
    const ghost = { userId: 9999, workspaceId: app.workspace.id };
    expect(await app.permissions.can(ghost, 'task.view', { projectId: p.id })).toBe(false);
    await app.db.updateTable('workspace_members').set({ status: 'removed' }).where('user_id', '=', sami.userId).execute();
    expect(await app.permissions.can(sami, 'task.view', { projectId: p.id })).toBe(false);
    await expect(app.tasks.list(sami, { owner: 'all', projectId: null, status: 'all', due: 'any' })).resolves.toEqual({ items: [], total: 0 });
  });

  it('members need a project role; viewers are read-only', async () => {
    const { app } = await makeApp();
    const { john } = await pairBoth(app);
    const p = await ridehome(app, john);
    const member = await addUser(app, 3001, 'member');
    const viewer = await addUser(app, 3002, 'viewer');

    // no project role yet → nothing in the project
    expect(await app.permissions.can(member, 'task.view', { projectId: p.id })).toBe(false);
    await expect(app.tasks.create(member, { projectId: p.id, title: 'x' })).rejects.toThrow('error.forbidden');

    const now = toDb(app.clock.now());
    await app.db.insertInto('project_members').values([
      { workspace_id: app.workspace.id, project_id: p.id, user_id: member.userId, role: 'member', created_at: now, updated_at: now },
      { workspace_id: app.workspace.id, project_id: p.id, user_id: viewer.userId, role: 'viewer', created_at: now, updated_at: now },
    ]).execute();

    expect(await app.permissions.can(member, 'task.create', { projectId: p.id })).toBe(true);
    expect(await app.permissions.can(member, 'project.archive', { projectId: p.id })).toBe(false);
    expect(await app.permissions.can(viewer, 'task.view', { projectId: p.id })).toBe(true);
    expect(await app.permissions.can(viewer, 'task.update', { projectId: p.id })).toBe(false);
    await expect(app.tasks.create(viewer, { projectId: p.id, title: 'x' })).rejects.toThrow('error.forbidden');
    expect(await app.permissions.visibleProjectIds(member)).toEqual([p.id]);
  });

  it('rejects projects from another workspace', async () => {
    const { app } = await makeApp();
    const { john } = await pairBoth(app);
    const now = toDb(app.clock.now());
    const ws2 = await app.db.insertInto('workspaces').values({ name: 'Other', timezone: 'UTC', created_at: now, updated_at: now }).returning('id').executeTakeFirstOrThrow();
    const foreign = await app.db.insertInto('projects').values({
      workspace_id: ws2.id, code: 'X', name: 'X', description: null, status: 'active', repo_url: null, docs_url: null,
      is_general: 0, archived_at: null, created_by: null, created_at: now, updated_at: now,
    }).returning('id').executeTakeFirstOrThrow();
    expect(await app.permissions.can(john, 'task.view', { projectId: foreign.id })).toBe(false);
  });

  it('only the owner of a user setting may change it', async () => {
    const { app } = await makeApp();
    const { john, sami } = await pairBoth(app);
    const { S_TIME_FORMAT } = await import('../src/core/services/settings.js');
    await app.settings.setAs(john, S_TIME_FORMAT, john.userId, '12h');
    await expect(app.settings.setAs(john, S_TIME_FORMAT, sami.userId, '12h')).rejects.toThrow('error.forbidden');
  });
});
