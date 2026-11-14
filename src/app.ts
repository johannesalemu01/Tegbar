import type { Logger } from 'pino';
import type { Database, Db } from './core/db/database.js';
import { coreMigrations } from './core/db/core.migrations.js';
import { migrateToLatest } from './core/db/migrations.js';
import type { Workspace } from './core/db/schema.js';
import type { TegbarModule } from './core/module.js';
import { Drafts } from './core/services/drafts.js';
import { EventLog } from './core/services/events.js';
import { FeatureFlags } from './core/services/flags.js';
import { Members } from './core/services/members.js';
import { Pairing } from './core/services/pairing.js';
import { PendingInputs } from './core/services/pending.js';
import { Permissions } from './core/services/permissions.js';
import { Projects } from './core/services/projects.js';
import { Settings } from './core/services/settings.js';
import { Workspaces } from './core/services/workspaces.js';
import { setZone, type Clock } from './core/time.js';
import { workspaceModule } from './modules/workspace/telegram.js';
import { taskMigrations } from './modules/tasks/migrations.js';
import { TaskService } from './modules/tasks/service.js';
import { tasksModule } from './modules/tasks/telegram.js';

/** Order matters only for menu/help layout. */
export const MODULES: TegbarModule[] = [
  { name: 'core', migrations: coreMigrations },
  workspaceModule,
  { ...tasksModule, migrations: taskMigrations },
];

export interface AppOptions {
  database: Database;
  clock: Clock;
  log: Logger;
  setupCode: string;
  seatNames?: Partial<Record<string, string>>;
  workspaceName?: string;
  timezone?: string;
}

export interface App {
  db: Db;
  database: Database;
  clock: Clock;
  log: Logger;
  workspace: Workspace;
  events: EventLog;
  permissions: Permissions;
  settings: Settings;
  flags: FeatureFlags;
  drafts: Drafts;
  pending: PendingInputs;
  members: Members;
  projects: Projects;
  pairing: Pairing;
  tasks: TaskService;
}

export async function createApp(o: AppOptions): Promise<App> {
  const timezone = o.timezone ?? 'Africa/Addis_Ababa';
  setZone(timezone);
  const { db } = o.database;

  const migrations = Object.assign({}, ...MODULES.map((m) => m.migrations ?? {}));
  const ran = await migrateToLatest(db, migrations);
  if (ran.length) o.log.info({ migrations: ran }, 'migrations applied');

  const events = new EventLog(o.clock);
  const permissions = new Permissions(db);
  const settings = new Settings(db, o.clock, permissions);
  const members = new Members(db, o.clock);
  const projects = new Projects(db, o.clock, permissions, events, settings);
  const workspace = await new Workspaces(db, o.clock).ensureDefault(o.workspaceName ?? 'Tegbar', timezone);
  await projects.seed(workspace.id);

  return {
    db,
    database: o.database,
    clock: o.clock,
    log: o.log,
    workspace,
    events,
    permissions,
    settings,
    flags: new FeatureFlags(db, o.clock),
    drafts: new Drafts(db, o.clock),
    pending: new PendingInputs(db, o.clock),
    members,
    projects,
    pairing: new Pairing(db, o.clock, settings, projects, events, { setupCode: o.setupCode, seatNames: o.seatNames ?? {} }),
    tasks: new TaskService(db, o.clock, permissions, events, projects, members),
  };
}
