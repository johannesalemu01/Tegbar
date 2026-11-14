/** HTML helpers for Telegram parse_mode=HTML. Always escape user text. */
export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export const b = (s: string) => `<b>${s}</b>`;
export const i = (s: string) => `<i>${s}</i>`;
export const code = (s: string) => `<code>${esc(s)}</code>`;
export const quote = (s: string, expandable = false) =>
  `<blockquote${expandable ? ' expandable' : ''}>${s}</blockquote>`;

/** Truncate for list rows; keeps messages well under Telegram's 4096-char limit. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Telegram's message limit is 4096 characters (after entity parsing). Keep a margin. */
export const MAX_MESSAGE = 3900;
