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
import { Hooks } from './core/hooks.js';
import { Jobs } from './core/services/jobs.js';
import { Availability } from './core/services/availability.js';
import { Approvals } from './core/services/approvals.js';
import { reminderMigrations } from './modules/reminders/migrations.js';
import { ReminderPlanner, ReminderService } from './modules/reminders/service.js';
import { remindersModule } from './modules/reminders/telegram.js';
import { coreApi } from './core/api/core-routes.js';
import { tasksApi } from './modules/tasks/api.js';
import { meetingsApi } from './modules/meetings/api.js';
import { meetingMigrations } from './modules/meetings/migrations.js';
import { MeetingPlanner, MeetingService } from './modules/meetings/service.js';
import { meetingsModule } from './modules/meetings/telegram.js';
import { costMigrations } from './modules/costs/migrations.js';
import { CostService } from './modules/costs/service.js';
import { costsModule } from './modules/costs/telegram.js';
import { costsApi } from './modules/costs/api.js';
import { join } from 'node:path';
import { Search } from './core/services/search.js';
import { Purge } from './core/services/purge.js';
import { Exporter } from './core/services/exporter.js';
import { Backups, type BackupOptions } from './core/backup/service.js';
import { NoteService, noteMigrations } from './modules/notes/notes.js';
import { notesModule } from './modules/notes/telegram.js';
import { DecisionService, decisionMigrations } from './modules/decisions/decisions.js';
import { decisionsModule } from './modules/decisions/telegram.js';
import { CommsService, commsMigrations } from './modules/comms/service.js';
import { commsModule } from './modules/comms/telegram.js';
import { areasModule } from './modules/areas/telegram.js';
import { dataModule } from './modules/data/telegram.js';
import { knowledgeApi } from './modules/data/api.js';
import { miniappModule } from './modules/miniapp/telegram.js';
import { InsightService, insightMigrations } from './modules/insights/service.js';
import { insightsModule } from './modules/insights/telegram.js';
import { insightsApi } from './modules/insights/api.js';
import { workspaceModule } from './modules/workspace/telegram.js';
import { taskMigrations } from './modules/tasks/migrations.js';
import { TaskService } from './modules/tasks/service.js';
import { tasksModule } from './modules/tasks/telegram.js';

/** Order matters only for menu/help layout. */
export const MODULES: TegbarModule[] = [
  { name: 'core', migrations: coreMigrations, api: coreApi },
  workspaceModule,
  { ...tasksModule, migrations: taskMigrations, api: tasksApi },
  { ...remindersModule, migrations: reminderMigrations },
  { ...meetingsModule, migrations: meetingMigrations, api: meetingsApi },
  { ...costsModule, migrations: costMigrations, api: costsApi },
  areasModule,
  { ...commsModule, migrations: commsMigrations },
  { ...decisionsModule, migrations: decisionMigrations },
  { ...notesModule, migrations: noteMigrations },
  { ...dataModule, api: knowledgeApi },
  miniappModule,
  { ...insightsModule, migrations: insightMigrations, api: insightsApi },
];

export interface AppOptions {
  database: Database;
  clock: Clock;
  log: Logger;
  setupCode: string;
  seatNames?: Partial<Record<string, string>>;
  workspaceName?: string;
  timezone?: string;
  /** Where receipts and backups are stored. */
  dataDir?: string;
  backup?: BackupOptions;
}

export interface App {
  db: Db;
  database: Database;
  clock: Clock;
  log: Logger;
  hooks: Hooks;
  jobs: Jobs;
  availability: Availability;
  approvals: Approvals;
  reminders: ReminderService;
  planner: ReminderPlanner;
  meetings: MeetingService;
  meetingPlanner: MeetingPlanner;
  costs: CostService;
  notes: NoteService;
  decisions: DecisionService;
  comms: CommsService;
  search: Search;
  purge: Purge;
  exporter: Exporter;
  backups: Backups;
  /** Phase 6: Friday brief, workload, wins (reads across modules through their services). */
  insights: InsightService;
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

  const hooks = new Hooks(o.log);
  const events = new EventLog(o.clock);
  const permissions = new Permissions(db);
  const settings = new Settings(db, o.clock, permissions, hooks);
  const jobs = new Jobs(db, o.clock);
  const members = new Members(db, o.clock);
  const approvals = new Approvals(db, o.clock, permissions, events, jobs, members);
  // Adding a person after pairing: the invite code only works once another owner approves.
  approvals.register<{ name: string; role: string }>({
    kind: 'member.invite', action: 'member.invite',
    describe: (p) => `Invite ${p.name} as ${p.role}`,
    execute: async () => undefined,
  });
  const projects = new Projects(db, o.clock, permissions, events, settings);
  const workspace = await new Workspaces(db, o.clock).ensureDefault(o.workspaceName ?? 'Tegbar', timezone);
  await projects.seed(workspace.id);

  const tasks = new TaskService(db, o.clock, permissions, events, projects, members, hooks);
  const planner = new ReminderPlanner(db, o.clock, jobs, settings, tasks, members);
  const reminders = new ReminderService(db, o.clock, permissions, events, jobs, members);
  const meetings = new MeetingService(db, o.clock, permissions, events, hooks, members, settings, projects, tasks);
  const meetingPlanner = new MeetingPlanner(db, o.clock, jobs, settings, meetings);
  const costs = new CostService(db, o.clock, permissions, events, jobs, members, settings, projects, approvals, {
    receiptsDir: join(o.dataDir ?? './data', 'receipts'),
  });

  // Domain wiring: keep scheduled jobs in step with the data they depend on.
  hooks.on('task.changed', (e) => planner.syncTask(e.workspaceId, e.taskId));
  hooks.on('member.paired', (e) => planner.syncUser(e.workspaceId, e.userId));
  hooks.on('settings.changed', (e) => (e.scope === 'user' ? planner.onUserSetting(e.workspaceId, e.scopeId, e.key) : undefined));
  hooks.on('meeting.changed', (e) => meetingPlanner.syncMeeting(e.workspaceId, e.meetingId));
  hooks.on('member.paired', async (e) => {
    await meetings.generate(e.workspaceId);
    await meetingPlanner.syncAll(e.workspaceId); // host rotation and attendees changed
  });
  hooks.on('settings.changed', (e) => (e.scope === 'workspace' && e.key.startsWith('meeting_') ? meetingPlanner.syncAll(e.workspaceId) : undefined));
  hooks.on('task.linked', (e) =>
    e.link.type === 'meeting' ? meetings.recordLinkedTask({ userId: e.actorUserId, workspaceId: e.workspaceId }, e.link.id, e.taskId) : undefined,
  );

  const notes = new NoteService(db, o.clock, permissions, events, projects);
  const decisions = new DecisionService(db, o.clock, permissions, events, members, approvals, jobs);
  const comms = new CommsService(db, o.clock, permissions, events, members, jobs);
  const backups = new Backups(o.database, o.dataDir ?? './data', o.clock, o.backup ?? { keep: 14, time: '02:30', toTelegram: false }, o.workspaceName ?? 'Tegbar');

  // Two-key rule for area owners.
  approvals.register<{ areaId: number; ownerUserId: number; label: string }>({
    kind: 'areas.owner', action: 'area.manage',
    describe: (p) => `Change area owner: ${p.label}`,
    execute: async (decider, p, requester) => projects.applyAreaOwner(decider, p.areaId, p.ownerUserId, requester.userId),
  });

  // Search, purge and export: every module contributes its own part.
  const search = new Search();
  search.register('task', (a, q, n) => tasks.search(a, q, n));
  search.register('note', (a, q, n) => notes.search(a, q, n));
  search.register('decision', (a, q, n) => decisions.search(a, q, n));
  search.register('notice', (a, q, n) => comms.search(a, q, n));
  search.register('meeting', (a, q, n) => meetings.search(a, q, n));
  const purge = new Purge(permissions, approvals);
  for (const p of [tasks.purger(), notes.purger(), comms.purger(), decisions.purger(), costs.purger()]) purge.register(p);
  const exporter = new Exporter();
  exporter.register('tasks', async (a) => (await tasks.list(a, { owner: 'all', projectId: null, status: 'all', due: 'any' }, 0, 1_000_000)).items.map((x) => ({
    id: `T${x.id}`, project: x.project_code, title: x.title, status: x.status, priority: x.priority, owner: x.owner_name, area: x.area_name,
    due_date: x.due_date, due_at_utc: x.due_at, recurrence: x.recurrence, notes: x.notes, created_at: x.created_at, completed_at: x.completed_at,
  })));
  exporter.register('notes', async (a) => (await notes.list(a, {}, 0, 1_000_000)).items.map((x) => ({
    id: `N${x.id}`, project: x.project_code, title: x.title, body: x.body, url: x.url, tags: (JSON.parse(x.tags) as string[]).join(' '), created_at: x.created_at,
  })));
  exporter.register('decisions', async (a) => (await decisions.list(a, {}, 0, 1_000_000)).items.map((x) => ({
    id: `D${x.id}`, project: x.project_code, title: x.title, why: x.rationale, status: x.status, decided_on: x.decided_on, superseded_by: x.superseded_by ? `D${x.superseded_by}` : null, created_at: x.created_at,
  })));
  exporter.register('notices', async (a) => [...(await comms.list(a, false, 100_000)), ...(await comms.list(a, true, 100_000))].map((x) => ({
    id: `NT${x.id}`, project: x.project_code, level: x.level, body: x.body, acknowledged_by: x.acked_by.length, archived_at: x.archived_at, created_at: x.created_at,
  })));
  exporter.register('meetings', async (a) => [...(await meetings.history(a, 0, 100_000)).items, ...(await meetings.upcoming(a, 100))].map((m) => ({
    id: `M${m.id}`, title: m.title, start_utc: m.startAt, duration_min: m.durationMin, mode: m.mode, host: m.hostName, status: m.status,
    place: m.place?.name ?? null, link: m.link, started_at: m.startedAt, ended_at: m.endedAt,
  })));
  exporter.register('costs', async (a) => (await costs.list(a, { includeVoided: true }, 0, 1_000_000)).items.map((c) => ({
    id: `C${c.id}`, date: c.spent_on, project: c.project_code, category: c.category_name, amount_minor: c.amount_minor, currency: c.currency,
    paid_by: c.payer_name, method: c.method, founder_tag: c.founder_tag, split: c.splits.map((s) => `${s.name}:${s.amount}`).join('; '),
    note: c.note, status: c.status, void_reason: c.void_reason,
  })));
  exporter.register('settlements', async (a) => (await costs.settlementsFor(a)).map((s) => ({
    id: `S${s.id}`, date: s.paid_on, from_user: s.from_user_id, to_user: s.to_user_id, amount_minor: s.amount_minor, currency: s.currency, method: s.method, status: s.status,
  })));

  // Meeting agenda: pending decisions and unacknowledged important/urgent notices.
  meetings.addAgendaSource(async (actor) => {
    const out = [];
    for (const d of (await decisions.list(actor, { status: 'proposed' }, 0, 20)).items) out.push({ refType: 'decision', refId: d.id, text: d.title, rank: 12 });
    for (const n of await comms.list(actor, false, 20)) {
      if (n.level !== 'info' && n.recipients.some((u) => !n.acked_by.includes(u))) out.push({ refType: 'notice', refId: n.id, text: n.body.split('\n')[0]!.slice(0, 120), rank: n.level === 'urgent' ? 5 : 15 });
    }
    return out;
  });
  // A decision taken in a meeting goes into the decision log, agreed by the attendees.
  hooks.on('meeting.outcome', async (e) => {
    if (e.kind !== 'decision') return;
    await decisions.propose({ userId: e.actorUserId, workspaceId: e.workspaceId }, { projectId: e.projectId, title: e.text, meetingId: e.meetingId, agreedBy: e.attendees });
  });

  await costs.seed(workspace.id);
  if (backups.enabled && (await jobs.get(workspace.id, 'backup:daily'))?.status !== 'active') {
    await jobs.upsert(workspace.id, 'backup:daily', { kind: 'backup.daily', payload: {}, at: backups.nextRunAt(o.clock.now()) });
  }
  await costs.syncAll(workspace.id); // recurring-cost and monthly statement jobs (idempotent)
  hooks.on('settings.changed', (e) => (e.scope === 'workspace' && e.key === 'statement_day' ? costs.syncAll(e.workspaceId) : undefined));
  await meetings.seed(workspace.id);
  await meetings.generate(workspace.id);


  const app = {
    db,
    database: o.database,
    clock: o.clock,
    log: o.log,
    hooks,
    jobs,
    availability: new Availability(db, settings),
    approvals,
    reminders,
    planner,
    meetings,
    meetingPlanner,
    costs,
    notes,
    decisions,
    comms,
    search,
    purge,
    exporter,
    backups,
    workspace,
    events,
    permissions,
    settings,
    flags: new FeatureFlags(db, o.clock),
    drafts: new Drafts(db, o.clock),
    pending: new PendingInputs(db, o.clock),
    members,
    projects,
    pairing: new Pairing(db, o.clock, settings, projects, events, { setupCode: o.setupCode, seatNames: o.seatNames ?? {} }, hooks),
    tasks,
  } as App;
  app.insights = new InsightService(app);
  return app;
}
