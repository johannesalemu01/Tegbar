/** Compact ids for callback_data (Telegram limits it to 64 bytes). */
export function enc(n: number): string {
  return n.toString(36);
}
export function dec(s: string | undefined): number | null {
  if (!s || !/^[0-9a-z]{1,11}$/.test(s)) return null;
  const n = Number.parseInt(s, 36);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
