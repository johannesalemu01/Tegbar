/**
 * Money rules (strict, pure, tested):
 *  - amounts are integers in the currency's smallest unit (ETB: santim, 2 decimals)
 *  - parsing and formatting work on strings and BigInt — a float never touches money
 *  - splits are basis points (1/100 of a percent); 10 000 bp = 100 %
 *  - allocation uses the largest-remainder method, so shares always add up
 *    exactly to the amount; leftover units go to the payer first (then seat order)
 *  - exchange rates are typed by people (never fetched) as decimals with up to 6
 *    places, stored as integer micro-units
 */

const MINOR: Record<string, number> = { ETB: 2, USD: 2, EUR: 2, GBP: 2, KES: 2, AED: 2, CNY: 2, JPY: 0 };
export const MAX_AMOUNT = 1_000_000_000_000; // 10 billion ETB in santim — well inside Number.MAX_SAFE_INTEGER

export function minorUnits(currency: string): number {
  return MINOR[currency] ?? 2;
}

export function isCurrency(s: string): boolean {
  return /^[A-Z]{3}$/.test(s);
}

/** "1,500", "1500.5", "1 500.50" → minor units. Null if malformed or too many decimals. */
export function parseAmount(input: string, currency: string): number | null {
  const s = input.trim().replace(/[\s,_]/g, '');
  const m = /^(\d{1,13})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const decimals = minorUnits(currency);
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const value = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (value <= 0n || value > BigInt(MAX_AMOUNT)) return null;
  return Number(value);
}

/** 150050 → "1,500.50". Signed amounts keep their sign. */
export function formatNumber(minor: number, currency: string): string {
  const decimals = minorUnits(currency);
  const neg = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const base = 10n ** BigInt(decimals);
  const int = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals ? `.${(abs % base).toString().padStart(decimals, '0')}` : '';
  return `${neg ? '−' : ''}${int}${frac}`;
}

export function formatMoney(minor: number, currency: string): string {
  return `${formatNumber(minor, currency)} ${currency}`;
}

/** Plain decimal for CSV ("-1500.50"), no grouping. */
export function decimalString(minor: number, currency: string): string {
  const decimals = minorUnits(currency);
  const neg = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const base = 10n ** BigInt(decimals);
  return `${neg ? '-' : ''}${abs / base}${decimals ? `.${(abs % base).toString().padStart(decimals, '0')}` : ''}`;
}

export interface Share {
  userId: number;
  bp: number;
}

export function equalShares(userIds: number[]): Share[] {
  if (userIds.length === 0) return [];
  const base = Math.floor(10_000 / userIds.length);
  let rest = 10_000 - base * userIds.length;
  return userIds.map((userId) => ({ userId, bp: base + (rest-- > 0 ? 1 : 0) }));
}

export function validShares(shares: Share[]): boolean {
  return (
    shares.length > 0 &&
    shares.every((s) => Number.isInteger(s.bp) && s.bp >= 0 && s.bp <= 10_000) &&
    shares.reduce((a, s) => a + s.bp, 0) === 10_000 &&
    new Set(shares.map((s) => s.userId)).size === shares.length
  );
}

/**
 * Split `amount` by basis points. Exact: the parts always sum to `amount`.
 * Leftover units (from rounding down) go by largest remainder; ties go to
 * the users in `tieOrder` first (we pass the payer, then seat order).
 */
export function allocate(amount: number, shares: Share[], tieOrder: number[] = []): { userId: number; amount: number }[] {
  if (!validShares(shares)) throw new Error('shares must sum to 10000 bp');
  const total = BigInt(amount);
  const parts = shares.map((s, idx) => {
    const exact = total * BigInt(s.bp);
    return { userId: s.userId, amount: exact / 10_000n, rem: exact % 10_000n, idx };
  });
  let left = total - parts.reduce((a, p) => a + p.amount, 0n);
  const rank = (u: number) => {
    const i = tieOrder.indexOf(u);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const order = [...parts].filter((p) => shares[p.idx]!.bp > 0)
    .sort((a, b) => (a.rem === b.rem ? rank(a.userId) - rank(b.userId) || a.idx - b.idx : a.rem > b.rem ? -1 : 1));
  for (let i = 0; left > 0n; i = (i + 1) % order.length, left--) order[i]!.amount += 1n;
  return parts.map((p) => ({ userId: p.userId, amount: Number(p.amount) }));
}

/** "125.5" → 125_500_000 (micro-units). Up to 6 decimals, positive. */
export function parseRate(input: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) return null;
  const v = Number(BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0')));
  return v > 0 ? v : null;
}

export function formatRate(micro: number): string {
  const s = `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, '0')}`.replace(/\.?0+$/, '');
  return s;
}

/**
 * Convert with a person-entered rate ("1 FROM = rate TO"), rounding half away
 * from zero. Integer maths only.
 */
export function convert(minor: number, from: string, to: string, rateMicro: number): number {
  if (from === to) return minor;
  const num = BigInt(minor) * BigInt(rateMicro) * 10n ** BigInt(minorUnits(to));
  const den = 1_000_000n * 10n ** BigInt(minorUnits(from));
  const neg = num < 0n;
  const abs = neg ? -num : num;
  const q = (abs * 2n + den) / (den * 2n);
  return Number(neg ? -q : q);
}

// ---------- ledger ----------

export interface LedgerCost {
  currency: string;
  paidBy: number;
  amount: number;
  splits: { userId: number; amount: number }[];
}
export interface LedgerSettlement {
  currency: string;
  from: number;
  to: number;
  amount: number;
}

/**
 * Net position per currency per person: what they paid minus their share,
 * adjusted by confirmed settlements. Positive = others owe them.
 * Always computed from entries — never stored.
 */
export function netPositions(costs: LedgerCost[], settlements: LedgerSettlement[]): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  const add = (cur: string, user: number, delta: number) => {
    const m = out.get(cur) ?? new Map<number, number>();
    m.set(user, (m.get(user) ?? 0) + delta);
    out.set(cur, m);
  };
  for (const c of costs) {
    add(c.currency, c.paidBy, c.amount);
    for (const s of c.splits) add(c.currency, s.userId, -s.amount);
  }
  for (const s of settlements) {
    add(s.currency, s.from, s.amount);
    add(s.currency, s.to, -s.amount);
  }
  return out;
}

/** Fewest simple transfers that settle everyone (greedy; exact for two people). */
export function suggestTransfers(nets: Map<number, number>): { from: number; to: number; amount: number }[] {
  const debtors = [...nets].filter(([, v]) => v < 0).map(([u, v]) => ({ u, v: -v })).sort((a, b) => b.v - a.v || a.u - b.u);
  const creditors = [...nets].filter(([, v]) => v > 0).map(([u, v]) => ({ u, v })).sort((a, b) => b.v - a.v || a.u - b.u);
  const out: { from: number; to: number; amount: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i]!.v, creditors[j]!.v);
    if (amt > 0) out.push({ from: debtors[i]!.u, to: creditors[j]!.u, amount: amt });
    debtors[i]!.v -= amt;
    creditors[j]!.v -= amt;
    if (debtors[i]!.v === 0) i++;
    if (creditors[j]!.v === 0) j++;
  }
  return out;
}
