import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';

export type ButtonStyle = 'primary' | 'success' | 'danger';
export type Btn =
  | { text: string; data: string; style?: ButtonStyle }
  | { text: string; url: string; style?: ButtonStyle };

let stylesEnabled = true;
export function setButtonStyles(on: boolean): void {
  stylesEnabled = on;
}

/** Telegram allows 1-64 bytes of callback_data. We fail loudly in development. */
export const MAX_CALLBACK_BYTES = 64;

export function cb(...parts: (string | number)[]): string {
  const data = parts.join(':');
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) throw new Error(`callback_data too long: ${data}`);
  return data;
}

export function keyboard(rows: Btn[][]): InlineKeyboardMarkup {
  return {
    inline_keyboard: rows
      .filter((r) => r.length > 0)
      .map((row) =>
        row.map((btn): InlineKeyboardButton => {
          const style = stylesEnabled && btn.style ? { style: btn.style } : {};
          return 'url' in btn
            ? { text: btn.text, url: btn.url, ...style }
            : { text: btn.text, callback_data: btn.data, ...style };
        }),
      ),
  };
}

/** Lay buttons out in rows of `perRow`. */
export function grid(buttons: Btn[], perRow: number): Btn[][] {
  const rows: Btn[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}
