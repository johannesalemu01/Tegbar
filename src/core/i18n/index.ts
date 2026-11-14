import { en } from './en.js';

export type Messages = typeof en;
export type MessageKey = keyof Messages;
export type MessageParams<K extends MessageKey> = Messages[K] extends (p: infer P) => string ? [P] : [];

/** Translate. One locale today; the signature is ready for per-user locales. */
export function t<K extends MessageKey>(key: K, ...params: MessageParams<K>): string {
  const v = en[key] as string | ((p: unknown) => string);
  return typeof v === 'function' ? v(params[0]) : v;
}
