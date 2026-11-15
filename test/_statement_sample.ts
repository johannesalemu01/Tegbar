/** Writes a sample statement PDF + CSV (for eyeballing): npx tsx test/_statement_sample.ts <dir> */
import { writeFileSync } from 'node:fs';
import { statementCsv, statementPdf } from '../src/modules/costs/exports.js';
import { makeApp, pairBoth, ridehome } from './helpers.js';
const out = process.argv[2] ?? '.';
const { app } = await makeApp('2026-11-28T10:00:00+03:00');
const { john, sami } = await pairBoth(app);
const rh = await ridehome(app, john);
const general = await app.projects.general(1);
const cats = await app.costs.categories(john);
const cat = (s: string) => cats.find((c) => c.slug === s)!.id;
const add = (who: typeof john, amount: number, slug: string, date: string, extra: object = {}) =>
  app.costs.create(who, { projectId: rh.id, categoryId: cat(slug), amount, currency: 'ETB', date, paidBy: who.userId, method: 'bank', tag: 'expense', split: 'rule', ...extra });
await add(john, 1_200_000, 'hosting', '2026-11-02', { note: 'VPS + backups' });
await add(sami, 450_000, 'sms-maps', '2026-11-05', { method: 'telebirr', note: 'የኤስኤምኤስ ጥቅል (SMS bundle)' });
await add(john, 300_000, 'legal', '2026-11-09', { projectId: general.id, note: 'Trade license renewal' });
await add(sami, 2_000_000, 'other', '2026-11-12', { tag: 'capital', split: 'mine', note: 'Initial capital' });
await add(john, 85_050, 'travel', '2026-11-20', { method: 'cash', note: 'Ride to Bole, meeting with MMCY' });
const v = await add(john, 9_900, 'tools', '2026-11-21');
await app.costs.void(john, v.cost.id, 'Charged twice');
await app.costs.setBudget(john, rh.id, { period: 'monthly', amount: 2_000_000 });
const { settlement } = await app.costs.recordSettlement(sami, { toUserId: john.userId, amount: 100_000, currency: 'ETB', method: 'telebirr' });
await app.costs.decideSettlement(john, settlement.id, true);
const st = await app.costs.statement(john, '2026-11');
const names = new Map([[john.userId, 'John'], [sami.userId, 'Sami']]);
writeFileSync(`${out}/statement.pdf`, await statementPdf(st, names, { workspace: 'Tegbar', generatedAt: '28 Nov 10:00', monthLabel: 'November 2026' }));
writeFileSync(`${out}/statement.csv`, statementCsv(st, names));
