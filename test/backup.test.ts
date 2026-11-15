import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SQLite from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createBackup, extractBackup, restoreBackup, rotateBackups } from '../src/core/backup/backup.js';
import { TarReader, tarEnd, tarHeader, tarPadding } from '../src/core/backup/tar.js';

const PASS = 'correct horse battery staple 2026';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tegbar-bk-'));
  const dbPath = join(dir, 'tegbar.db');
  const db = new SQLite(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec("create table kysely_migration(name text); insert into kysely_migration values ('202611050001_core_init');");
  db.exec("create table notes(id integer primary key, body text); insert into notes(body) values ('ሰላም — hello');");
  mkdirSync(join(dir, 'receipts', '1', '2026-11'), { recursive: true });
  writeFileSync(join(dir, 'receipts', '1', '2026-11', 'r1.jpg'), Buffer.alloc(70_000, 7));
  return { dir, db, dbPath };
}

describe('tar', () => {
  it('round-trips files and rejects unsafe paths', async () => {
    const data = Buffer.from('ሰላም');
    const tar = Buffer.concat([tarHeader('a/b.txt', data.length, 0), data, tarPadding(data.length), tarEnd()]);
    const got: string[] = [];
    const r = new TarReader((e) => void got.push(`${e.name}:${e.data.toString()}`));
    for (let i = 0; i < tar.length; i += 100) await r.push(tar.subarray(i, i + 100)); // tiny chunks
    expect(got).toEqual(['a/b.txt:ሰላም']);
    const evil = Buffer.concat([tarHeader('../etc/passwd', 1, 0), Buffer.from('x'), tarPadding(1), tarEnd()]);
    await expect(new TarReader(() => undefined).push(evil)).rejects.toThrow(/unsafe path/);
  });
});

describe('encrypted backups', () => {
  it('backup → restore round trip (database and receipts), file is private', async () => {
    const f = fixture();
    const out = join(f.dir, 'backups', '20261115-0230.tgbk');
    const r = await createBackup({ sqlite: f.db, receiptsDir: join(f.dir, 'receipts'), outFile: out, passphrase: PASS, workspace: 'Tegbar', now: new Date('2026-11-15T00:00:00Z') });
    expect(r.manifest).toMatchObject({ format: 1, migrations: ['202611050001_core_init'], files: 2 });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out).includes(Buffer.from('hello'))).toBe(false); // encrypted

    f.db.exec("insert into notes(body) values ('after backup')");
    f.db.close();
    const res = await restoreBackup({ file: out, passphrase: PASS, dataDir: f.dir, now: new Date('2026-11-16T00:00:00Z') });
    const restored = new SQLite(join(f.dir, 'tegbar.db'), { readonly: true });
    expect(restored.prepare('select body from notes').all()).toEqual([{ body: 'ሰላም — hello' }]);
    restored.close();
    expect(readFileSync(join(f.dir, 'receipts', '1', '2026-11', 'r1.jpg')).length).toBe(70_000);
    expect(existsSync(join(res.previous, 'tegbar.db'))).toBe(true); // old data kept aside
  });

  it('rejects a wrong passphrase and a tampered file, touching nothing', async () => {
    const f = fixture();
    const out = join(f.dir, 'b.tgbk');
    await createBackup({ sqlite: f.db, receiptsDir: join(f.dir, 'receipts'), outFile: out, passphrase: PASS, workspace: 'T', now: new Date() });
    await expect(extractBackup(out, `${PASS}!`, join(f.dir, 'stage1'))).rejects.toThrow(/wrong passphrase/);
    const bytes = readFileSync(out);
    bytes[200] = bytes[200]! ^ 0x01;
    writeFileSync(join(f.dir, 'evil.tgbk'), bytes);
    await expect(extractBackup(join(f.dir, 'evil.tgbk'), PASS, join(f.dir, 'stage2'))).rejects.toThrow();
    expect(existsSync(join(f.dir, 'stage1'))).toBe(false);
    expect(existsSync(join(f.dir, 'stage2'))).toBe(false);
    await expect(extractBackup(join(f.dir, 'tegbar.db'), PASS, join(f.dir, 'stage3'))).rejects.toThrow(/not a Tegbar backup/);
  });

  it('keeps only the newest N', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tegbar-rot-'));
    for (const n of ['20261101', '20261102', '20261103', '20261104']) writeFileSync(join(dir, `${n}-0230.tgbk`), 'x');
    expect(await rotateBackups(dir, 2)).toEqual(['20261101-0230.tgbk', '20261102-0230.tgbk']);
  });
});
