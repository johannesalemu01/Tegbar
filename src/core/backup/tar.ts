/**
 * Minimal POSIX ustar writer/reader for regular files only (no links,
 * devices or directories). Enough for Tegbar backups; keeps us dependency-free.
 * The reader refuses absolute paths and "..".
 */

const BLOCK = 512;

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

export function tarHeader(name: string, size: number, mtimeSec: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(0o600, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtimeSec, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export const tarPadding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);
export const tarEnd = () => Buffer.alloc(BLOCK * 2, 0);

export interface TarEntry {
  name: string;
  data: Buffer;
}

function safeName(name: string): boolean {
  return name.length > 0 && !name.startsWith('/') && !name.split('/').some((p) => p === '..' || p === '');
}

/** Incremental parser: feed chunks, collect complete entries. */
export class TarReader {
  private buf: Buffer = Buffer.alloc(0);
  private current: { name: string; size: number; chunks: Buffer[]; got: number } | null = null;
  private skip = 0;
  ended = false;

  constructor(private readonly onEntry: (e: TarEntry) => Promise<void> | void) {}

  async push(chunk: Buffer): Promise<void> {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.ended) return;
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buf.length);
        this.buf = this.buf.subarray(n);
        this.skip -= n;
        if (this.skip > 0) return;
      }
      if (this.current) {
        const need = this.current.size - this.current.got;
        const n = Math.min(need, this.buf.length);
        if (n > 0) {
          this.current.chunks.push(this.buf.subarray(0, n));
          this.current.got += n;
          this.buf = this.buf.subarray(n);
        }
        if (this.current.got < this.current.size) return;
        const done = this.current;
        this.current = null;
        this.skip = (BLOCK - (done.size % BLOCK)) % BLOCK;
        await this.onEntry({ name: done.name, data: Buffer.concat(done.chunks) });
        continue;
      }
      if (this.buf.length < BLOCK) return;
      const h = this.buf.subarray(0, BLOCK);
      this.buf = this.buf.subarray(BLOCK);
      if (h.every((b) => b === 0)) {
        this.ended = true;
        return;
      }
      const str = (start: number, len: number) => h.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
      if (Number.parseInt(str(148, 8).trim(), 8) !== sum) throw new Error('tar checksum mismatch');
      const prefix = str(345, 155);
      const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
      const type = str(156, 1) || '0';
      const size = Number.parseInt(str(124, 12).trim() || '0', 8);
      if (type !== '0') throw new Error(`unsupported tar entry type ${type}`);
      if (!safeName(name)) throw new Error(`unsafe path in backup: ${name}`);
      this.current = { name, size, chunks: [], got: 0 };
    }
  }
}
