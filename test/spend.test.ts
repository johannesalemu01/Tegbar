import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { parseSpend, type SpendContext } from '../src/modules/costs/parse.js';

const now = DateTime.fromISO('2026-11-15T10:00', { zone: 'Africa/Addis_Ababa' }); // Sunday
const ctx: SpendContext = {
  now, meUserId: 1,
  members: [{ userId: 1, handles: ['john'] }, { userId: 2, handles: ['sami'] }],
  projects: [{ id: 10, code: 'GENERAL' }, { id: 11, code: 'RIDEHOME' }],
  categories: [
    { id: 1, slug: 'hosting', name: 'Hosting & servers', aliases: ['server', 'servers', 'vps', 'domain'] },
    { id: 2, slug: 'sms-maps', name: 'SMS & maps', aliases: ['sms', 'maps'] },
    { id: 8, slug: 'other', name: 'Other', aliases: ['misc'] },
  ],
  allowedCurrencies: ['ETB'], defaultCurrency: 'ETB',
};

describe('spend parser', () => {
  it('parses the spec example', () => {
    expect(parseSpend('1500 ETB hosting #ridehome paid-by me', ctx)).toMatchObject({
      amount: 150_000, currency: 'ETB', categoryId: 1, projectId: 11, paidBy: 1, method: 'bank', tag: 'expense', split: 'rule',
      date: '2026-11-15', note: '', issues: [],
    });
  });

  it('understands birr, decimals, method, payer, split, tag, date and a note', () => {
    const r = parseSpend('1,250.50 birr sms paid by @sami telebirr only-mine yesterday for OTP bundle', ctx);
    expect(r).toMatchObject({ amount: 125_050, currency: 'ETB', categoryId: 2, paidBy: 2, method: 'telebirr', split: 'mine', date: '2026-11-14', note: 'OTP bundle' });
    expect(parseSpend('20000 capital other', ctx).tag).toBe('capital');
    expect(parseSpend('300 vps 2026-11-02', ctx).date).toBe('2026-11-02');
  });

  it('weekday names mean the past for spends', () => {
    expect(parseSpend('300 vps friday', ctx).date).toBe('2026-11-13');
  });

  it('reports problems instead of guessing', () => {
    expect(parseSpend('hosting', ctx).issues).toContainEqual({ kind: 'no_amount' });
    expect(parseSpend('12.345 hosting', ctx).issues).toContainEqual({ kind: 'bad_amount', value: '12.345' });
    expect(parseSpend('$20 hosting', ctx).issues).toContainEqual({ kind: 'currency_not_allowed', value: 'USD' });
    expect(parseSpend('20 USD hosting rate 125.5', { ...ctx, allowedCurrencies: ['ETB', 'USD'] })).toMatchObject({ currency: 'USD', amount: 2000, rateMicro: 125_500_000, issues: [] });
    expect(parseSpend('200 lunch', ctx).issues).toContainEqual({ kind: 'no_category' });
    expect(parseSpend('200 hosting paid-by bob', ctx).issues).toContainEqual({ kind: 'unknown_person', value: 'bob' });
    expect(parseSpend('200 hosting #nope', ctx).issues).toContainEqual({ kind: 'unknown_project', value: 'nope' });
    expect(parseSpend('200 hosting 2026-12-01', ctx).issues).toContainEqual({ kind: 'future_date' });
  });

  it('a three-letter category is not a currency', () => {
    expect(parseSpend('400 sms', ctx)).toMatchObject({ amount: 40_000, currency: 'ETB', categoryId: 2, issues: [] });
    expect(parseSpend('400 SMS', ctx)).toMatchObject({ currency: 'ETB', categoryId: 2 });
    expect(parseSpend('20 usd hosting', { ...ctx, allowedCurrencies: ['ETB', 'USD'] }).currency).toBe('USD');
  });

  it('a month name in the note is not the date', () => {
    expect(parseSpend('1500 hosting VPS for November', ctx)).toMatchObject({ date: '2026-11-15', note: 'VPS for November', issues: [] });
  });

  it('keeps Amharic notes', () => {
    expect(parseSpend('450 sms ለመልዕክት ጥቅል', ctx).note).toBe('ለመልዕክት ጥቅል');
  });
});
