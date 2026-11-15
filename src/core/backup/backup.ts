import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import SQLite from 'better-sqlite3';
import { TarReader, tarEnd, tarHeader, tarPadding } from './tar.js';

/**
 * Encrypted backups.
 *
 *   file = "TGBKUP01" | salt(16) | iv(12) | AES-256-GCM( gzip( tar ) ) | tag(16)
 *   key  = scrypt(passphrase, salt, N=2^15, r=8, p=1) → 32 bytes
 *
 * tar contents: manifest.json, db/tegbar.db (consistent online snapshot),
 * receipts/** . Nothing is restored unless the GCM tag verifies (wrong
 * passphrase or a single flipped bit → rejected) and SQLite's integrity check
 * passes.
 */
const MAGIC = Buffer.from('TGBKUP01', 'ascii');
const HEADER = MAGIC.length + 16 + 12;
const TAG = 16;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 16) throw new Error('BACKUP_PASSPHRASE must be at least 16 characters');
  return scryptSync(passphrase.normalize('NFC'), salt, 32, SCRYPT);
}

export interface Manifest {
  format: 1;
  createdAt: string;
  workspace: string;
  migrations: string[];
  files: number;
  bytes: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Create an encrypted backup of `dbPath` + `receiptsDir` at `outFile` (atomic rename). */
export async function createBackup(opts: {
  sqlite: SQLite.Database;
  receiptsDir: string;
  outFile: string;
  passphrase: string;
  workspace: string;
  now: Date;
}): Promise<{ file: string; bytes: number; manifest: Manifest }> {
  await mkdir(dirname(opts.outFile), { recursive: true, mode: 0o700 });
  const tmpDb = `${opts.outFile}.db.tmp`;
  await opts.sqlite.backup(tmpDb); // consistent snapshot while the bot keeps running
  try {
    const receipts: string[] = [];
    for await (const f of walk(opts.receiptsDir)) receipts.push(f);
    const dbSize = (await stat(tmpDb)).size;
    let bytes = dbSize;
    for (const f of receipts) bytes += (await stat(f)).size;
    const snapshot = new SQLite(tmpDb, { readonly: true });
    const migrations = (snapshot.prepare('select name from kysely_migration order by name').all() as { name: string }[]).map((r) => r.name);
    snapshot.close();
    const manifest: Manifest = { format: 1, createdAt: opts.now.toISOString(), workspace: opts.workspace, migrations, files: receipts.length + 1, bytes };

    const mtime = Math.floor(opts.now.getTime() / 1000);
    async function* entries(): AsyncGenerator<Buffer> {
      const m = Buffer.from(JSON.stringify(manifest, null, 2));
      yield tarHeader('manifest.json', m.length, mtime);
      yield m;
      yield tarPadding(m.length);
      const files: [string, string][] = [['db/tegbar.db', tmpDb], ...receipts.map((f): [string, string] => [`receipts/${relative(opts.receiptsDir, f).split('\\').join('/')}`, f])];
      for (const [name, path] of files) {
        const size = (await stat(path)).size;
        yield tarHeader(name, size, mtime);
        for await (const chunk of createReadStream(path)) yield chunk as Buffer;
        yield tarPadding(size);
      }
      yield tarEnd();
    }

    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(opts.passphrase, salt), iv);
    const part = `${opts.outFile}.part`;
    await writeFile(part, Buffer.concat([MAGIC, salt, iv]), { mode: 0o600 });
    await pipeline(Readable.from(entries()), createGzip({ level: 6 }), cipher, createWriteStream(part, { flags: 'a', mode: 0o600 }));
    await writeFile(part, cipher.getAuthTag(), { flag: 'a' });
    await rename(part, opts.outFile);
    return { file: opts.outFile, bytes: (await stat(opts.outFile)).size, manifest };
  } finally {
    await rm(tmpDb, { force: true });
  }
}

/**
 * Decrypt + verify + extract into `stagingDir`. Throws on a wrong passphrase,
 * tampering, unsafe paths or a corrupt database. Nothing outside stagingDir
 * is touched.
 */
export async function extractBackup(file: string, passphrase: string, stagingDir: string): Promise<Manifest> {
  const size = (await stat(file)).size;
  if (size < HEADER + TAG) throw new Error('not a Tegbar backup (too small)');
  const fh = await open(file, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  await fh.read(head, 0, HEADER, 0);
  await fh.read(tag, 0, TAG, size - TAG);
  await fh.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Tegbar backup (bad magic)');
  const salt = head.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = head.subarray(MAGIC.length + 16, HEADER);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  let manifest: Manifest | null = null;
  const reader = new TarReader(async (e) => {
    if (e.name === 'manifest.json') {
      manifest = JSON.parse(e.data.toString('utf8')) as Manifest;
      return;
    }
    if (!(e.name === 'db/tegbar.db' || e.name.startsWith('receipts/'))) throw new Error(`unexpected file in backup: ${e.name}`);
    const out = join(stagingDir, e.name);
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    await writeFile(out, e.data, { mode: 0o600 });
  });
  const sink = new Transform({
    async transform(chunk: Buffer, _enc, cb) {
      try {
        await reader.push(chunk);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  try {
    await pipeline(createReadStream(file, { start: HEADER, end: size - TAG - 1 }), decipher, createGunzip(), sink);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(/auth|unable to authenticate|bad decrypt/i.test(msg) ? 'wrong passphrase or the file was modified' : msg);
  }
  if (!manifest || !existsSync(join(stagingDir, 'db/tegbar.db'))) {
    await rm(stagingDir, { recursive: true, force: true });
    throw new Error('backup is incomplete');
  }
  const db = new SQLite(join(stagingDir, 'db/tegbar.db'), { readonly: true });
  try {
    const r = db.pragma('integrity_check', { simple: true });
    if (r !== 'ok') throw new Error(`database integrity check failed: ${String(r)}`);
  } finally {
    db.close();
  }
  return manifest;
}

/**
 * Restore: extract + verify into a staging dir, then move the current
 * database and receipts aside (data/pre-restore-<time>/) and put the backup
 * in place. Run only while the bot is stopped.
 */
export async function restoreBackup(opts: { file: string; passphrase: string; dataDir: string; now: Date }): Promise<{ manifest: Manifest; previous: string }> {
  const stamp = opts.now.toISOString().replace(/[:.]/g, '-');
  const staging = join(opts.dataDir, `restore-${stamp}`);
  const manifest = await extractBackup(opts.file, opts.passphrase, staging);
  const previous = join(opts.dataDir, `pre-restore-${stamp}`);
  await mkdir(previous, { recursive: true, mode: 0o700 });
  for (const f of ['tegbar.db', 'tegbar.db-wal', 'tegbar.db-shm']) {
    if (existsSync(join(opts.dataDir, f))) await rename(join(opts.dataDir, f), join(previous, f));
  }
  if (existsSync(join(opts.dataDir, 'receipts'))) await rename(join(opts.dataDir, 'receipts'), join(previous, 'receipts'));
  await rename(join(staging, 'db/tegbar.db'), join(opts.dataDir, 'tegbar.db'));
  if (existsSync(join(staging, 'receipts'))) await rename(join(staging, 'receipts'), join(opts.dataDir, 'receipts'));
  await rm(staging, { recursive: true, force: true });
  return { manifest, previous };
}

/** Keep the newest `keep` backups in `dir`. */
export async function rotateBackups(dir: string, keep: number): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.tgbk')).sort();
  const remove = files.slice(0, Math.max(0, files.length - keep));
  for (const f of remove) await rm(join(dir, f), { force: true });
  return remove;
}

export async function listBackups(dir: string): Promise<{ name: string; bytes: number }[]> {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.tgbk')).sort().reverse()) out.push({ name: f, bytes: (await stat(join(dir, f))).size });
  return out;
}

