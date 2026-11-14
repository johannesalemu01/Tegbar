import type { Migration } from 'kysely/migration';
import type { ApiRouter } from './api/router.js';
import type { TelegramSetup } from './telegram/registry.js';

/**
 * A feature module. To add one:
 *  1. create src/modules/<name>/ with schema.ts (+ DB declaration merging),
 *     migrations.ts, service.ts (pure domain, calls Permissions), telegram.ts
 *  2. construct its service in src/app.ts and list the module in MODULES.
 * Modules never import each other's telegram code; they may use each other's
 * services through the App object.
 */
export interface TegbarModule {
  name: string;
  migrations?: Record<string, Migration>;
  /** Register commands, callbacks, text inputs, menu buttons and dashboard sections. */
  telegram?(setup: TelegramSetup): void;
  /** Register HTTP API routes (under /api/v1). Handlers call domain services only. */
  api?(router: ApiRouter): void;
  // Phase 2: jobs?(scheduler) — scheduled job kinds owned by the module.
}
