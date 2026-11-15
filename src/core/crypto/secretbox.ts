import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets (e.g. an OAuth refresh token) before they are stored
 * in the database. AES-256-GCM, key = 32 bytes from SECRET_KEY (base64).
 * Format: "v1:" + base64(iv(12) | ciphertext | tag(16)).
 */
export function parseKey(b64: string | undefined): Buffer | null {
  if (!b64) return null;
  const k = Buffer.from(b64, 'base64');
  return k.length === 32 ? k : null;
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')}`;
}

export function open(sealed: string, key: Buffer): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown secret format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}
