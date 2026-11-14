/**
 * Tegbar's visual language. Telegram gives bots formatting, emoji, monospace
 * "chips", blockquotes (rendered with an accent bar) and three button styles.
 * The look is deliberately quiet: monochrome status glyphs, one warm accent for
 * priority, colour reserved for the buttons that matter.
 */
export const G = {
  todo: '○',
  doing: '◐',
  blocked: '⊘',
  done: '●',
  high: '🔸',
  low: '▫️',
  owner: '👤',
  repeat: '↻',
  due: '🗓',
  project: '◇',
  area: '⌁',
  dot: '·',
  ok: '✓',
  warn: '⚠️',
  sparkle: '✦',
  prev: '‹',
  next: '›',
  back: '‹ Back',
} as const;

export const STATUS_GLYPH: Record<string, string> = {
  todo: G.todo,
  doing: G.doing,
  blocked: G.blocked,
  done: G.done,
};

/** A thin divider that fits narrow phones. */
export const RULE = '┈┈┈┈┈┈┈┈┈┈┈┈';
