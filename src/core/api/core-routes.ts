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
  /** One call for the Mini App home screen. */
  r.get('/overview', async ({ app, actor }) => {
    const mine = (f: Omit<Parameters<typeof app.tasks.list>[1], 'owner' | 'projectId'>) => app.tasks.list(actor, { owner: 'me', projectId: null, ...f }, 0, 1);
    const [today, overdue, open, next, approvals, notices] = await Promise.all([
      mine({ status: 'open', due: 'today' }), mine({ status: 'open', due: 'overdue' }), mine({ status: 'open', due: 'any' }),
      app.meetings.next(actor), app.approvals.pending(actor), app.comms.list(actor, false, 10),
    ]);
    return {
      counts: { today: today.total, overdue: overdue.total, open: open.total },
      nextMeeting: next ? { id: next.id, title: next.title, startAt: next.startAt, endAt: next.end.toUTC().toISO(), mode: next.mode, link: next.link, hostName: next.hostName, place: next.place?.name ?? null, status: next.status } : null,
      approvals: approvals.filter((a) => a.requested_by !== actor.userId).map((a) => ({ id: a.id, summary: a.summary, kind: a.kind, expiresAt: a.expires_at })),
      notices: notices.filter((n) => n.recipients.includes(actor.userId) && !n.acked_by.includes(actor.userId)).map((n) => ({ id: n.id, level: n.level, body: n.body, projectCode: n.project_code })),
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
