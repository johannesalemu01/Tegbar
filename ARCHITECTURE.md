# Tegbar architecture

Tegbar is one Node.js process: a grammY bot, a domain layer, and SQLite.
It is small on purpose. This page explains where code goes and why.

```
Telegram ──► grammY Bot ──► gate (pairing / membership) ──► Registry
                                                         ├─ commands      /my, /add …
                                                         ├─ callbacks     "t:d:e:-"
                                                         ├─ text inputs   pending questions
                                                         └─ text handlers quick add
                              Telegram layer  (src/core/telegram, src/modules/*/telegram.ts)
                                   │  views: text + buttons, no business rules
                                   ▼
                              Domain services (src/core/services, src/modules/*/service.ts)
                                   │  every method takes an Actor and calls Permissions
                                   ▼
                              Storage (Kysely → better-sqlite3; PostgreSQL later)
```

## Layers

| Layer | Lives in | Rules |
|---|---|---|
| Telegram | `src/core/telegram/`, `src/modules/*/telegram.ts`, `views.ts` | Parse input, call a service, render a `View`. No SQL, no permission logic. |
| Domain | `src/core/services/`, `src/modules/*/service.ts`, pure helpers like `quickadd.ts` | All rules, validation, events. Testable without Telegram. |
| Storage | `src/core/db/`, `src/modules/*/migrations.ts`, `schema.ts` | Kysely queries in services; dialect-specific bits only in `migrations.ts` helpers. |

## Core

- **Workspaces → projects → everything.** Every table has `workspace_id`; every work item has `project_id`. The `General` project holds company-wide items.
- **Permissions** (`core/services/permissions.ts`) is the only place that knows roles. Domain services call `authorize(actor, action, { projectId })` before every read or write. Workspace owners are implicitly owners of every project; others need a `project_members` row. Lists are scoped with `visibleProjectIds(actor)`.
- **Events** (`core/services/events.ts`) is append-only: insert and read only. Task history is read from it; there is no separate `task_events` table (one source of truth).
- **Settings** are typed and declared with `defineSetting` (scope: workspace / project / user). **Feature flags** are declared with `defineFlag`, are off by default, and resolve project → workspace → default.
- **Drafts** back confirmation cards; `consume()` is atomic so "Save" works exactly once.
- **Pending inputs** remember "the next text from this user answers X" in the database, so restarts never break a flow. Any command or button press clears it.
- **Time**: instants are stored as UTC ISO strings; local dates as `YYYY-MM-DD`. Every display goes through `core/time.ts`, which converts to `Africa/Addis_Ababa`.
- **Strings**: every user-facing string is in `core/i18n/en.ts`. Parameters are raw; the string functions escape them.

## Telegram conventions

- `callback_data` is `prefix:action:compactId:state[:extra]`, base36 ids, max 64 bytes (`cb()` throws if longer).
- Every callback is answered exactly once (`answer()` in `core/telegram/bot.ts`), even on errors and stale data.
- Buttons are idempotent: handlers act on current DB state, so double taps and old buttons are safe ("Already done").
- Inside a callback, views edit the message in place; "message is not modified" is ignored.
- 429s are retried after `retry_after`; 403s mark the user as blocked (`core/telegram/guard.ts`).
- Outsiders get no reply at all; command menus are set per member chat, so outsiders don't even see the commands.

## Scheduler (Phase 2)

All time-based work goes through one scheduler (`core/scheduler/runner.ts`). Nothing is held in memory.

- `jobs` has one row per logical job, identified by a stable `key` such as `task:12:b60` (1 hour before), `task:12:od`, `digest:daily:<user>` or `rem:7`.
  Domain code only calls `jobs.upsert(key, …)` and `jobs.cancel(key)`. **`ReminderPlanner`** is idempotent: after any change it makes the jobs table match the data.
  It runs on `task.changed`, `settings.changed` and `member.paired` hooks, and once at start-up (`syncAll`).
- Every 30 s, `tick()` loads the due jobs. For each one, the handler first **plans** (send / skip / hold, and the next fire time) with no side effects.
  The runner then **claims** the fire in one transaction: it moves the job on (guarded by `next_fire_at = <old value>`) and inserts into `job_fires`, where `(job_id, fire_at)` is unique.
  Only then does it **execute** the send. Two ticks, a restart or a second process can never send the same moment twice.
  A crash in the few milliseconds between claim and send drops that one message (at-most-once); the ledger row stays `claimed`.
- Catch-up: each handler declares `maxLateMs`. Older fires are marked `stale` and the job moves to its next regular time.
  Handlers also skip obsolete work. If the task is done or re-dated, the `dueKey` no longer matches and the reminder is not sent.
  Once the overdue nudge is due, the "due now" reminder is dropped so only one message goes out.
- Delivery classes (`core/services/availability.ts`): `urgent` is always delivered. `direct` (person-to-person) is held by quiet hours and DND. `nudge` (reminders, digests) is also held by Focus.
  `Notifier.deliver()` sends now or creates a `notify.deliver` job for when the person is available; nudge handlers reschedule themselves the same way.
- Permissions still apply: a scheduled reminder loads the task **as its owner** through `TaskService.get`, so someone who lost access gets nothing.

Modules register job handlers with `reg.job(handler)`.

## Hooks

`core/hooks.ts` carries in-process events emitted after commit (`task.changed`, `settings.changed`, `member.paired`).
Use them to keep derived state, such as scheduled jobs, in step without modules importing each other.
They are not the audit log; that is `events`.

## HTTP API

`core/api/` holds the transport for a future Mini App or dashboard:

- `initdata.ts` validates Telegram's signed launch data.
- `router.ts` is a tiny path router.
- `server.ts` handles auth, member lookup, rate limit, JSON body limits and error mapping:
  `DomainError` → 400, `ForbiddenError` → 403, `NotFoundError` → 404, zod → 400 with issues, anything else → 500 plus a critical alert.

Modules add routes in `api(router)`. Handlers are thin: parse input with zod, then call a service with `req.actor`. The service authorizes, exactly as for Telegram.
A new client (Mini App, dashboard, integration) needs no business logic of its own.

## Meetings (Phase 3)

- `meeting_series` holds the weekly slots. `meetings` holds one row per occurrence, keyed by `(series_id, week_start)`, where `week_start` is the Monday of that week.
  Moving a slot to another weekday therefore keeps each week's meeting, with its agenda and RSVPs.
- **Overrides, not copies.** A meeting row stores only what was changed for that meeting (mode, length, host, place, link, `moved`). Everything else is resolved from the slot when read.
  So per-meeting changes never alter the slot, and slot edits never overwrite per-meeting changes. `start_at` is materialised for queries and is re-timed only for meetings that were not moved.
  Every override is also written to `meeting_exceptions` and to `events`.
- The host rotation is deterministic: `(weekIndex + slot.ordinal) % members`. With two people and two slots, each person hosts once a week, and they swap weekly.
- `MeetingService.generate()` is idempotent. It runs at start-up, daily at 03:00 (a scheduler job), and after slot edits or pairing.
- `MeetingPlanner` keeps the reminder jobs (`mtg:<id>:eve|b60|b10|start|link|wrap`) in step through the `meeting.changed` hook. A moved meeting changes `startKey`, so old jobs become obsolete.
- Agenda sources are pluggable: `meetings.addAgendaSource(fn)`. Phase 5 will add pending decisions and unacknowledged notices this way.
- A live meeting registers a *draft linker*, so plain-text tasks become its action items through the `task.linked` hook. The tasks module knows nothing about meetings.

## Adding a module

1. `src/modules/<name>/schema.ts`: table interfaces plus declaration merging into `DB`:
   ```ts
   declare module '../../core/db/schema.js' { interface DB { notes: NotesTable } }
   ```
2. `migrations.ts`: `{ 'YYYYMMDDHHmm_<name>_init': { up, down } }`, using `withId`, `withWorkspace`, `withStamps`.
3. `service.ts`: a class taking `db`, `clock`, `permissions`, `events`. Add any new actions to `Action` and `MATRIX` in `permissions.ts`.
4. `telegram.ts`: export a `TegbarModule` whose `telegram({ app, reg, notifier })` registers commands, callbacks (unique prefix), inputs, menu entries, dashboard and settings sections, and job handlers.
   Buttons that change state must carry the **target value** (e.g. `s:tf:12h`, not "toggle"), so a double tap is harmless.
5. In `src/app.ts`, construct the service on `App` and add the module to `MODULES`.
6. Strings go in `en.ts`; tests go in `test/`.

No other module needs to change.

## PostgreSQL later

Kysely already supports PostgreSQL. To move: change `withId` to an identity column and swap `SqliteDialect` for `PostgresDialect`. Two other things need care: `bigint` Telegram ids, and the `case`/`coalesce` SQL used in task ordering (it is standard SQL). Domain code does not change.

## Phase status

Phase 1: core, pairing, projects, permissions, settings, tasks, events, Docker.
Phase 2: scheduler, task reminders, overdue nudges, one-off reminders, digests, quiet hours / focus / DND, recurring tasks.
Next: meetings (Phase 3).
