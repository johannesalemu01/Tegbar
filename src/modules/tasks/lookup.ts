import type { App } from '../../app.js';
import type { Actor } from '../../core/services/context.js';
import { timeFormat } from '../../core/telegram/helpers.js';
import type { Lookup } from './views.js';

/** Names, codes and formats needed to render tasks for `actor` (no Telegram context needed). */
export async function buildLookup(app: App, actor: Actor): Promise<Lookup> {
  const [members, projects, fmt] = await Promise.all([
    app.members.list(actor.workspaceId),
    app.projects.list(actor),
    timeFormat(app, actor),
  ]);
  const areas = new Map<number, string>();
  for (const p of projects) for (const a of await app.projects.areas(actor, p.id)) areas.set(a.id, a.name);
  return {
    now: app.clock.now(),
    fmt,
    meUserId: actor.userId,
    members: members.map((m) => ({ userId: m.user_id, name: m.display_name })),
    projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name })),
    areas,
  };
}
