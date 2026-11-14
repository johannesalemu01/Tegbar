import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect, type Transaction } from 'kysely';
import type { DB } from './schema.js';

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Either the root handle or an open transaction — services accept both. */
export type DbOrTx = Db | Tx;

export interface Database {
  db: Db;
  /** The underlying driver. Used only by backup code; never by domain logic. */
  raw: SQLite.Database;
  close(): Promise<void>;
}

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const raw = new SQLite(path);
  if (path !== ':memory:') raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
  return {
    db,
    raw,
    close: async () => {
      await db.destroy();
      if (raw.open) raw.close();
    },
  };
}
