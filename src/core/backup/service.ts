import { join } from 'node:path';
import type { DateTime } from 'luxon';
import type { Database } from '../db/database.js';
import { getZone, type Clock } from '../time.js';
import { createBackup, listBackups, rotateBackups } from './backup.js';

export interface BackupOptions {
  passphrase?: string | undefined;
  keep: number;
  time: string; // HH:mm local
  toTelegram: boolean;
}

/** Daily encrypted backups into DATA_DIR/backups, keeping the newest N. */
export class Backups {
  readonly dir: string;
  constructor(
    private readonly database: Database,
    private readonly dataDir: string,
    private readonly clock: Clock,
    readonly opts: BackupOptions,
    private readonly workspaceName: string,
  ) {
    this.dir = join(dataDir, 'backups');
  }

  get enabled(): boolean {
    return !!this.opts.passphrase && this.opts.passphrase.length >= 16;
  }

  async run(): Promise<{ file: string; name: string; bytes: number; removed: string[] }> {
    if (!this.enabled) throw new Error('backups are not configured (set BACKUP_PASSPHRASE, 16+ characters)');
    const now = this.clock.now();
    const name = `${now.setZone(getZone()).toFormat('yyyyMMdd-HHmmss')}.tgbk`;
    const r = await createBackup({
      sqlite: this.database.raw, receiptsDir: join(this.dataDir, 'receipts'), outFile: join(this.dir, name),
      passphrase: this.opts.passphrase!, workspace: this.workspaceName, now: now.toJSDate(),
    });
    const removed = await rotateBackups(this.dir, this.opts.keep);
    return { file: r.file, name, bytes: r.bytes, removed };
  }

  list() {
    return listBackups(this.dir);
  }

  nextRunAt(after: DateTime): DateTime {
    const [h, m] = this.opts.time.split(':').map(Number);
    let t = after.setZone(getZone()).set({ hour: h!, minute: m!, second: 0, millisecond: 0 });
    if (t <= after) t = t.plus({ days: 1 });
    return t;
  }
}
