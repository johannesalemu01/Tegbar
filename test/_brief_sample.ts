/** Prints a sample Friday brief (HTML stripped): npx tsx test/_brief_sample.ts */
import { briefView } from '../src/modules/insights/telegram.js';
import { memberNames } from '../src/core/telegram/helpers.js';
import { makeApp, pairBoth, ridehome } from './helpers.js';
const { app, clock } = await makeApp('2026-11-17T19:05:00+03:00');
const { john, sami } = await pairBoth(app);
await app.flags.set(1, 'wins', true);
const rh = await ridehome(app, john);
const sync = (await app.meetings.upcoming(john, 1))[0]!;
await app.meetings.start(john, sync.id); await app.meetings.end(john, sync.id);
clock.set('2026-11-19T10:00:00+03:00');
for (const [who, title] of [[john, 'Ship OTP fix'], [sami, 'Sign MMCY pilot'], [john, 'Set up backups']] as const) { const t = await app.tasks.create(who, { projectId: rh.id, title, priority: 'high' }); await app.tasks.setStatus(who, t.id, 'done'); }
const b = await app.tasks.create(sami, { projectId: rh.id, title: 'SMS gateway contract' }); await app.tasks.setStatus(sami, b.id, 'blocked');
await app.tasks.create(john, { projectId: rh.id, title: 'Renew domain', due: { date: '2026-11-14', time: null } });
await app.tasks.create(sami, { projectId: rh.id, title: 'Investor update', priority: 'high', due: { date: '2026-11-23', time: null } });
await app.decisions.propose(john, { projectId: rh.id, title: 'Price per km for B2B' });
clock.set('2026-11-20T17:00:00+03:00');
await app.costs.setBudget(john, rh.id, { period: 'monthly', amount: 2_000_000 });
const cats = await app.costs.categories(john);
await app.costs.create(john, { projectId: rh.id, categoryId: cats[0]!.id, amount: 1_650_000, currency: 'ETB', date: '2026-11-19', paidBy: john.userId, method: 'bank', tag: 'expense', split: 'rule' });
await app.insights.addWin(sami, 'First paying rider in Bole', rh.id);
const v = briefView(await app.insights.brief(john), await memberNames(app, 1), app.clock.now());
console.log(v.text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&'));
