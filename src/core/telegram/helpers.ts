import type { App } from '../../app.js';
import type { Project } from '../db/schema.js';
import type { Actor } from '../services/context.js';
import { S_TIME_FORMAT } from '../services/settings.js';
import type { TimeFormat } from '../time.js';

/** Pull a "#code" project override out of command arguments. */
export async function projectOverride(app: App, actor: Actor, args: string): Promise<{ project: Project | null; rest: string; unknown: string | null }> {
  let project: Project | null = null;
  let unknown: string | null = null;
  const parts: string[] = [];
  for (const word of args.split(/\s+/).filter(Boolean)) {
    if (word.startsWith('#') && word.length > 1 && !project) {
      const p = await app.projects.findByCode(actor, word);
      if (p) {
        project = p;
        continue;
      }
      unknown = word;
    }
    parts.push(word);
  }
  return { project, rest: parts.join(' '), unknown };
}

export function timeFormat(app: App, actor: Actor): Promise<TimeFormat> {
  return app.settings.get(actor.workspaceId, S_TIME_FORMAT, actor.userId);
}

export async function memberNames(app: App, workspaceId: number): Promise<Map<number, string>> {
  return new Map((await app.members.list(workspaceId)).map((m) => [m.user_id, m.display_name]));
}
