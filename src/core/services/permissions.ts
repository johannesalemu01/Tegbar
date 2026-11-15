import type { DbOrTx } from '../db/database.js';
import type { Role } from '../db/schema.js';
import { ForbiddenError } from '../errors.js';
import type { Actor } from './context.js';

/**
 * THE permission check. Every domain service calls `authorize` (or `can`)
 * before reading or changing anything; handlers and scheduled jobs never check
 * roles themselves.
 *
 * Rules:
 *  - The actor must be an active member of the workspace.
 *  - Workspace owners are implicitly owners of every project in it.
 *  - Otherwise the project role (project_members) applies for project-scoped actions.
 */
export type Action =
  | 'workspace.view'
  | 'workspace.manage'
  | 'settings.workspace'
  | 'project.view'
  | 'project.create'
  | 'project.update'
  | 'project.archive'
  | 'task.view'
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'reminder.create'
  | 'reminder.view'
  | 'meeting.view'
  | 'meeting.manage'
  | 'meeting.series'
  | 'member.invite'
  | 'cost.view'
  | 'cost.create'
  | 'cost.edit'
  | 'cost.manage';

const ALL: readonly Role[] = ['owner', 'member', 'viewer'];
const EDIT: readonly Role[] = ['owner', 'member'];
const OWN: readonly Role[] = ['owner'];

export const MATRIX: Readonly<Record<Action, readonly Role[]>> = {
  'workspace.view': ALL,
  'workspace.manage': OWN,
  'settings.workspace': OWN,
  'project.view': ALL,
  'project.create': EDIT,
  'project.update': OWN,
  'project.archive': OWN,
  'task.view': ALL,
  'task.create': EDIT,
  'task.update': EDIT,
  'task.delete': EDIT,
  'reminder.create': EDIT,
  'reminder.view': ALL,
  'meeting.view': ALL,
  'meeting.manage': EDIT,
  'meeting.series': OWN,
  'member.invite': OWN,
  'cost.view': ALL,
  'cost.create': EDIT,
  'cost.edit': EDIT,
  /** budgets, categories, split rules, recurring costs, rates */
  'cost.manage': OWN,
};

export interface Target {
  projectId?: number | null;
}

export class Permissions {
  constructor(private readonly db: DbOrTx) {}

  async workspaceRole(actor: Actor, exec: DbOrTx = this.db): Promise<Role | null> {
    const m = await exec
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', actor.workspaceId)
      .where('user_id', '=', actor.userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return m?.role ?? null;
  }

  async roleFor(actor: Actor, target: Target = {}, exec: DbOrTx = this.db): Promise<Role | null> {
    const wsRole = await this.workspaceRole(actor, exec);
    if (!wsRole) return null;
    if (target.projectId == null) return wsRole;
    const project = await exec
      .selectFrom('projects')
      .select('workspace_id')
      .where('id', '=', target.projectId)
      .executeTakeFirst();
    if (!project || project.workspace_id !== actor.workspaceId) return null;
    if (wsRole === 'owner') return 'owner';
    const pm = await exec
      .selectFrom('project_members')
      .select('role')
      .where('workspace_id', '=', actor.workspaceId)
      .where('project_id', '=', target.projectId)
      .where('user_id', '=', actor.userId)
      .executeTakeFirst();
    return pm?.role ?? null;
  }

  async can(actor: Actor, action: Action, target: Target = {}, exec: DbOrTx = this.db): Promise<boolean> {
    const role = await this.roleFor(actor, target, exec);
    return role !== null && MATRIX[action].includes(role);
  }

  async authorize(actor: Actor, action: Action, target: Target = {}, exec: DbOrTx = this.db): Promise<void> {
    if (!(await this.can(actor, action, target, exec))) throw new ForbiddenError();
  }

  /** Project ids the actor may see — used to scope every cross-project query. */
  async visibleProjectIds(actor: Actor, exec: DbOrTx = this.db): Promise<number[]> {
    const wsRole = await this.workspaceRole(actor, exec);
    if (!wsRole) return [];
    if (wsRole === 'owner') {
      const rows = await exec.selectFrom('projects').select('id').where('workspace_id', '=', actor.workspaceId).execute();
      return rows.map((r) => r.id);
    }
    const rows = await exec
      .selectFrom('project_members')
      .select('project_id')
      .where('workspace_id', '=', actor.workspaceId)
      .where('user_id', '=', actor.userId)
      .execute();
    return rows.map((r) => r.project_id);
  }
}
