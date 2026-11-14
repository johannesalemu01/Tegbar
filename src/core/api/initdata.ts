import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App launch-data validation (https://core.telegram.org/bots/webapps,
 * "Validating data received via the Mini App"):
 *
 *   data_check_string = every received field except `hash`, sorted by key,
 *                       formatted "key=value", joined with "\n"
 *                       (`signature`, when present, is a received field and stays in)
 *   secret_key        = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   valid             = hex(HMAC_SHA256(secret_key, data_check_string)) == hash
 *
 * We also require a fresh `auth_date` (the docs recommend checking it).
 */
export interface MiniAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface InitData {
  user: MiniAppUser;
  authDate: number; // unix seconds
  fields: Record<string, string>;
}

export type InitDataError = 'missing_hash' | 'bad_hash' | 'expired' | 'future' | 'no_user';

function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function secretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

export function validateInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSec: number; nowSec: number },
): { ok: true; data: InitData } | { ok: false; error: InitDataError } {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'missing_hash' };
  const expected = createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, error: 'bad_hash' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, error: 'expired' };
  if (authDate > opts.nowSec + 60) return { ok: false, error: 'future' };
  if (opts.nowSec - authDate > opts.maxAgeSec) return { ok: false, error: 'expired' };

  let user: MiniAppUser | null = null;
  try {
    const u: unknown = JSON.parse(params.get('user') ?? 'null');
    if (u && typeof u === 'object' && Number.isSafeInteger((u as MiniAppUser).id)) user = u as MiniAppUser;
  } catch {
    user = null;
  }
  if (!user) return { ok: false, error: 'no_user' };
  return { ok: true, data: { user, authDate, fields: Object.fromEntries(params.entries()) } };
}

/** Produce signed launch data — for tests and local development tools only. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const hash = createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
