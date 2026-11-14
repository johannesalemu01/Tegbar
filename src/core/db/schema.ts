import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Database type. Core tables are declared here; feature modules add their own
 * tables through declaration merging:
 *
 *   declare module '../../core/db/schema.js' {
 *     interface DB { tasks: TasksTable }
 *   }
 *
 * Conventions (portable to PostgreSQL):
 *  - integer surrogate ids, ISO-8601 UTC text timestamps, 0/1 integers for flags,
 *    JSON stored as text, money as integer minor units (added in Phase 4).
 *  - every table carries workspace_id, created_at and updated_at
 *    (exceptions: `workspaces` itself and `users`, which are global identities
 *    linked to workspaces through workspace_members).
 */
export interface DB {
  workspaces: WorkspacesTable;
  users: UsersTable;
  workspace_members: WorkspaceMembersTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  areas: AreasTable;
  settings: SettingsTable;
  feature_flags: FeatureFlagsTable;
  events: EventsTable;
  drafts: DraftsTable;
  pending_inputs: PendingInputsTable;
}

interface Stamps {
  created_at: string;
  updated_at: string;
}

export interface WorkspacesTable extends Stamps {
  id: Generated<number>;
  name: string;
  timezone: string;
}

export interface UsersTable extends Stamps {
  id: Generated<number>;
  telegram_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  locale: string | null;
  /** Set when Telegram returns 403 (user blocked the bot). Cleared on next message. */
  blocked_at: string | null;
}

export type Role = 'owner' | 'member' | 'viewer';

export interface WorkspaceMembersTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  role: Role;
  /** 'A' = technical co-founder, 'B' = business co-founder, null for later members. */
  seat: string | null;
  display_name: string;
  /** Lower-case handle used by quick add: @john */
  handle: string;
  status: 'active' | 'removed';
  /** private chat id used for notifications */
  chat_id: number;
}

export type ProjectStatus = 'idea' | 'active' | 'paused' | 'done';

export interface ProjectsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  code: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  repo_url: string | null;
  docs_url: string | null;
  /** 1 for the company-wide "General" project */
  is_general: number;
  archived_at: string | null;
  created_by: number | null;
}

export interface ProjectMembersTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  user_id: number;
  role: Role;
}

export interface AreasTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number;
  name: string;
  slug: string;
  owner_user_id: number | null;
  backup_user_id: number | null;
  sort_order: number;
  archived_at: string | null;
}

export type SettingScope = 'workspace' | 'project' | 'user';

export interface SettingsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  scope: SettingScope;
  scope_id: number;
  key: string;
  value: string; // JSON
}

export interface FeatureFlagsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  scope: 'workspace' | 'project';
  scope_id: number;
  key: string;
  enabled: number;
}

/** Append-only audit log. The repository exposes insert and read only. */
export interface EventsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  project_id: number | null;
  actor_user_id: number | null;
  entity_type: string;
  entity_id: number | null;
  action: string;
  data: string; // JSON
}

/** A proposed item awaiting confirmation (e.g. a quick-add card). Consumed exactly once. */
export interface DraftsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  kind: string;
  payload: string; // JSON
  expires_at: string;
  consumed_at: string | null;
}

/** "The next text message from this user answers question X." One per user. */
export interface PendingInputsTable extends Stamps {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  kind: string;
  payload: string; // JSON
  expires_at: string;
}

export type Workspace = Selectable<WorkspacesTable>;
export type User = Selectable<UsersTable>;
export type Member = Selectable<WorkspaceMembersTable>;
export type Project = Selectable<ProjectsTable>;
export type Area = Selectable<AreasTable>;
export type NewEvent = Insertable<EventsTable>;
export type ProjectUpdate = Updateable<ProjectsTable>;
