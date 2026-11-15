/**
 * Tegbar maintenance CLI.
 *
 *   node dist/cli.js backup                          make an encrypted backup now (bot may be running)
 *   node dist/cli.js verify  <file.tgbk>             decrypt + check integrity (changes nothing)
 *   node dist/cli.js restore <file.tgbk> --bot-is-stopped
 *
 * Needs DATA_DIR (default ./data) and BACKUP_PASSPHRASE in the environment.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SQLite from 'better-sqlite3';
import { createBackup, extractBackup, restoreBackup, rotateBackups } from './core/backup/backup.js';

async function main(): Promise<void> {
  const [cmd, file, flag] = process.argv.slice(2);
  const dataDir = process.env.DATA_DIR ?? './data';
  const pass = process.env.BACKUP_PASSPHRASE ?? '';
  if (pass.length < 16) throw new Error('Set BACKUP_PASSPHRASE (16+ characters) — the same one used to create the backup.');

  if (cmd === 'backup') {
    const db = new SQLite(join(dataDir, 'tegbar.db'), { readonly: false });
    const name = `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.tgbk`;
    const r = await createBackup({ sqlite: db, receiptsDir: join(dataDir, 'receipts'), outFile: join(dataDir, 'backups', name), passphrase: pass, workspace: 'Tegbar', now: new Date() });
    db.close();
    await rotateBackups(join(dataDir, 'backups'), Number(process.env.BACKUP_KEEP ?? 14));
    console.log(`backup written: ${r.file} (${r.bytes} bytes, ${r.manifest.files} files)`);
    return;
  }
  if (cmd === 'verify' && file) {
    const staging = mkdtempSync(join(tmpdir(), 'tegbar-verify-'));
    try {
      const m = await extractBackup(file, pass, staging);
      console.log(`OK: created ${m.createdAt}, ${m.files} files, ${m.bytes} bytes, migrations up to ${m.migrations.at(-1)}`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return;
  }
  if (cmd === 'restore' && file) {
    if (flag !== '--bot-is-stopped') throw new Error('Stop the bot first (docker compose stop tegbar), then add --bot-is-stopped.');
    const r = await restoreBackup({ file, passphrase: pass, dataDir, now: new Date() });
    console.log(`restored backup from ${r.manifest.createdAt}. Previous data kept in ${r.previous}. Start the bot again.`);
    return;
  }
  console.log('usage: cli.js backup | verify <file.tgbk> | restore <file.tgbk> --bot-is-stopped');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
