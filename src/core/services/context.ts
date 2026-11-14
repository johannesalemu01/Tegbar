import type { Clock } from '../time.js';
import type { Db } from '../db/database.js';
import type { Logger } from 'pino';

/** The acting person. Every domain operation receives one. */
export interface Actor {
  userId: number;
  workspaceId: number;
}

export interface CoreDeps {
  db: Db;
  clock: Clock;
  log: Logger;
}
