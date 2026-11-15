import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** public/app relative to this file — works from src/ (tsx) and dist/ (node). */
export const MINIAPP_DIR = fileURLToPath(new URL('../../../public/app/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

/**
 * Serves the Mini App under /app/. Read-only, no directory listing, no path
 * traversal. A strict Content-Security-Policy allows only our own files plus
 * Telegram's SDK; frame-ancestors allows Telegram Web, which embeds Mini Apps
 * in an iframe ([VERIFY] if Telegram changes its web client domains).
 */
export function createStaticHandler(root = MINIAPP_DIR, prefix = '/app') {
  const headers = {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self' https://telegram.org",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return true;
    }
    if (url.pathname === prefix) {
      res.writeHead(301, { location: `${prefix}/` }).end();
      return true;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice(prefix.length + 1)) || 'index.html';
    } catch {
      res.writeHead(400).end();
      return true;
    }
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root.endsWith(sep) ? root : root + sep)) || rel.includes('\0')) {
      res.writeHead(404).end();
      return true;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      const isHtml = extname(file) === '.html';
      res.writeHead(200, {
        ...headers,
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        // index is always revalidated; assets are referenced with ?v=… so they can be cached
        'cache-control': isHtml ? 'no-cache' : 'public, max-age=86400',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
    return true;
  };
}
