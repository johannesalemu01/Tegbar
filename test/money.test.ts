import { describe, expect, it } from 'vitest';
import {
  allocate, convert, decimalString, equalShares, formatMoney, netPositions, parseAmount, parseRate, suggestTransfers, validShares,
} from '../src/modules/costs/money.js';

describe('amounts', () => {
  it('parses decimal strings exactly into santim', () => {
    expect(parseAmount('1500', 'ETB')).toBe(150_000);
    expect(parseAmount('1,500.5', 'ETB')).toBe(150_050);
    expect(parseAmount('0.01', 'ETB')).toBe(1);
    expect(parseAmount('1 234 567.89', 'ETB')).toBe(123_456_789);
    expect(parseAmount('0.1', 'ETB')! + parseAmount('0.2', 'ETB')!).toBe(30); // no float drift
    expect(parseAmount('1.234', 'ETB')).toBeNull();
    expect(parseAmount('0', 'ETB')).toBeNull();
    expect(parseAmount('-5', 'ETB')).toBeNull();
    expect(parseAmount('1e3', 'ETB')).toBeNull();
    expect(parseAmount('99999999999999', 'ETB')).toBeNull();
    expect(parseAmount('500', 'JPY')).toBe(500);
  });

  it('formats from integers', () => {
    expect(formatMoney(150_050, 'ETB')).toBe('1,500.50 ETB');
    expect(formatMoney(5, 'ETB')).toBe('0.05 ETB');
    expect(formatMoney(-125_000, 'ETB')).toBe('−1,250.00 ETB');
    expect(decimalString(-125_000, 'ETB')).toBe('-1250.00');
    expect(decimalString(123_456_789, 'ETB')).toBe('1234567.89');
  });
});

describe('splits', () => {
  it('equal shares in basis points always sum to 10000', () => {
    expect(equalShares([1, 2])).toEqual([{ userId: 1, bp: 5000 }, { userId: 2, bp: 5000 }]);
    expect(equalShares([1, 2, 3]).map((s) => s.bp)).toEqual([3334, 3333, 3333]);
    expect(validShares(equalShares([1, 2, 3]))).toBe(true);
    expect(validShares([{ userId: 1, bp: 6000 }, { userId: 2, bp: 3000 }])).toBe(false);
  });

  it('allocates exactly, odd santim to the payer', () => {
    const half = equalShares([1, 2]);
    expect(allocate(101, half, [2, 1])).toEqual([{ userId: 1, amount: 50 }, { userId: 2, amount: 51 }]);
    expect(allocate(101, half, [1, 2])).toEqual([{ userId: 1, amount: 51 }, { userId: 2, amount: 50 }]);
    const thirds = equalShares([1, 2, 3]);
    const r = allocate(100, thirds, [3]);
    expect(r.reduce((a, x) => a + x.amount, 0)).toBe(100);
    expect(allocate(10_000, [{ userId: 1, bp: 6000 }, { userId: 2, bp: 4000 }])).toEqual([{ userId: 1, amount: 6000 }, { userId: 2, amount: 4000 }]);
    expect(allocate(999, [{ userId: 1, bp: 10_000 }, { userId: 2, bp: 0 }])).toEqual([{ userId: 1, amount: 999 }, { userId: 2, amount: 0 }]);
  });

  it('sums exactly for many random amounts and shares', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let k = 0; k < 2000; k++) {
      const amount = 1 + Math.floor(rnd() * 1e11);
      const a = Math.floor(rnd() * 10_001);
      const parts = allocate(amount, [{ userId: 1, bp: a }, { userId: 2, bp: 10_000 - a }], [2, 1]);
      expect(parts[0]!.amount + parts[1]!.amount).toBe(amount);
      expect(Math.abs(parts[0]!.amount - (amount * a) / 10_000)).toBeLessThan(1);
    }
  });
});

describe('rates and conversion', () => {
  it('parses typed rates and converts with half-up rounding', () => {
    expect(parseRate('125.5')).toBe(125_500_000);
    expect(parseRate('0.0075')).toBe(7_500);
    expect(parseRate('abc')).toBeNull();
    expect(convert(1_000, 'USD', 'ETB', 125_500_000)).toBe(125_500); // 10.00 USD → 1,255.00 ETB
    expect(convert(1, 'USD', 'ETB', 125_555_000)).toBe(126); // 0.01 × 125.555 = 1.25555 ETB → 1.26
    expect(convert(500, 'JPY', 'ETB', 850_000)).toBe(42_500);
    expect(convert(777, 'ETB', 'ETB', 1)).toBe(777);
  });
});

describe('ledger', () => {
  it('computes who owes whom from entries and settlements', () => {
    const costs = [
      { currency: 'ETB', paidBy: 1, amount: 150_000, splits: [{ userId: 1, amount: 75_000 }, { userId: 2, amount: 75_000 }] },
      { currency: 'ETB', paidBy: 2, amount: 40_000, splits: [{ userId: 1, amount: 20_000 }, { userId: 2, amount: 20_000 }] },
      { currency: 'ETB', paidBy: 1, amount: 10_000, splits: [{ userId: 1, amount: 10_000 }, { userId: 2, amount: 0 }] }, // "only mine"
    ];
    const nets = netPositions(costs, [])!.get('ETB')!;
    expect(Object.fromEntries(nets)).toEqual({ 1: 55_000, 2: -55_000 });
    expect(suggestTransfers(nets)).toEqual([{ from: 2, to: 1, amount: 55_000 }]);
    const after = netPositions(costs, [{ currency: 'ETB', from: 2, to: 1, amount: 55_000 }]).get('ETB')!;
    expect(suggestTransfers(after)).toEqual([]);
  });

  it('keeps currencies separate', () => {
    const n = netPositions([
      { currency: 'ETB', paidBy: 1, amount: 100, splits: [{ userId: 1, amount: 50 }, { userId: 2, amount: 50 }] },
      { currency: 'USD', paidBy: 2, amount: 100, splits: [{ userId: 1, amount: 50 }, { userId: 2, amount: 50 }] },
    ], []);
    expect(Object.fromEntries(n.get('ETB')!)).toEqual({ 1: 50, 2: -50 });
    expect(Object.fromEntries(n.get('USD')!)).toEqual({ 1: -50, 2: 50 });
  });

  it('three people settle with at most two transfers', () => {
    const nets = new Map([[1, 300], [2, -100], [3, -200]]);
    const t = suggestTransfers(nets);
    expect(t).toEqual([{ from: 3, to: 1, amount: 200 }, { from: 2, to: 1, amount: 100 }]);
  });
});
