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

## Adding a module

1. `src/modules/<name>/schema.ts`: table interfaces plus declaration merging into `DB`:
   ```ts
   declare module '../../core/db/schema.js' { interface DB { notes: NotesTable } }
   ```
2. `migrations.ts`: `{ 'YYYYMMDDHHmm_<name>_init': { up, down } }`, using `withId`, `withWorkspace`, `withStamps`.
3. `service.ts`: a class taking `db`, `clock`, `permissions`, `events`. Add any new actions to `Action` and `MATRIX` in `permissions.ts`.
4. `telegram.ts`: export a `TegbarModule` whose `telegram({ app, reg })` registers commands, callbacks (unique prefix), inputs, menu entries and dashboard sections.
5. In `src/app.ts`, construct the service on `App` and add the module to `MODULES`.
6. Strings go in `en.ts`; tests go in `test/`.

No other module needs to change.

## PostgreSQL later

Kysely already supports PostgreSQL. To move: change `withId` to an identity column and swap `SqliteDialect` for `PostgresDialect`. Two other things need care: `bigint` Telegram ids, and the `case`/`coalesce` SQL used in task ordering (it is standard SQL). Domain code does not change.

## Phase status

Phase 1: core, pairing, projects, permissions, settings, tasks, events, Docker.
Next: the persistent scheduler (`jobs` table, 30 s poll, idempotency key per fire) in Phase 2.
