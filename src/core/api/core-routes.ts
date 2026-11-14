import { getZone, toDb } from '../time.js';
import { idParam, type ApiRouter } from './router.js';

/** Core routes: identity, members, projects. */
export function coreApi(r: ApiRouter): void {
  r.get('/me', async ({ app, actor, member }) => {
    const current = await app.projects.current(actor);
    return {
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      displayName: member.display_name,
      handle: member.handle,
      seat: member.seat,
      role: member.role,
      timezone: getZone(),
      currentProject: { id: current.id, code: current.code, name: current.name },
      serverTime: toDb(app.clock.now()),
    };
  });
  r.get('/members', async ({ app, actor }) =>
    (await app.members.list(actor.workspaceId)).map((m) => ({ userId: m.user_id, displayName: m.display_name, handle: m.handle, seat: m.seat, role: m.role })),
  );
  r.get('/projects', async ({ app, actor, query }) => {
    const list = await app.projects.list(actor, { includeArchived: query.get('archived') === '1' });
    return list.map((p) => ({
      id: p.id, code: p.code, name: p.name, description: p.description, status: p.status,
      repoUrl: p.repo_url, docsUrl: p.docs_url, isGeneral: p.is_general === 1, archivedAt: p.archived_at,
    }));
  });
  r.get('/projects/:id/areas', async (req) => {
    const areas = await req.app.projects.areas(req.actor, idParam(req));
    return areas.map((a) => ({ id: a.id, name: a.name, slug: a.slug, ownerUserId: a.owner_user_id, backupUserId: a.backup_user_id }));
  });
}
