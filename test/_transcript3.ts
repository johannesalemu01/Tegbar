/** Phase 3 sample conversation through the fake Telegram API: npm run transcript:3 */
import { enc } from '../src/core/ids.js';
import { JOHN, SAMI, makeApp, makeBot, pairBoth, ridehome } from './helpers.js';
const { app, clock } = await makeApp('2026-11-15T10:00:00+03:00');
const { john } = await pairBoth(app);
const bot = makeBot(app);
const rh = await ridehome(app, john);
const blocked = await app.tasks.create(john, { projectId: rh.id, title: 'SMS gateway contract', ownerUserId: 2 });
await app.tasks.setStatus(john, blocked.id, 'blocked');
await app.tasks.create(john, { projectId: rh.id, title: 'Renew domain', priority: 'high', due: { date: '2026-11-12', time: null } });
const out: string[] = [];
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const dump = (who: string, input: string) => {
  out.push(`\n**${who}:** ${input}`);
  for (const c of bot.calls) {
    const to = c.payload.chat_id === JOHN.id ? 'John' : 'Sami';
    if (c.method === 'sendMessage' || c.method === 'editMessageText') {
      const kb = (c.payload.reply_markup?.inline_keyboard ?? []).map((r: any[]) => r.map((b) => (b.url ? `[${b.text} ↗]` : `[${b.text}]`)).join(' ')).filter(Boolean).join('\n');
      out.push(`\n_Tegbar → ${to}${c.method === 'editMessageText' ? ' (edits)' : ''}:_\n\`\`\`\n${strip(c.payload.text)}${kb ? `\n\n${kb}` : ''}\n\`\`\``);
    }
    if (c.method === 'sendDocument') out.push(`_Tegbar → ${to}: 📎 calendar file (.ics)_`);
    if (c.method === 'answerCallbackQuery' && c.payload.text) out.push(`_toast: ${c.payload.text}_`);
  }
  bot.calls.length = 0;
};
const at = async (iso: string, label: string) => { clock.set(iso); await bot.scheduler.tick(); dump('⏱', label); };
const sync = (await app.meetings.upcoming(john, 5)).find((m) => m.mode === 'virtual')!;
const id = enc(sync.id);

await bot.send(JOHN, '/meetings'); dump('John', '/meetings');
await bot.tap(JOHN, `mt:o:${id}`); dump('John', 'taps [1]');
await at('2026-11-16T20:00:20+03:00', 'clock → Mon 20:00 (evening before)');
await bot.tap(SAMI, `mt:r:${id}:n`); dump('Sami', 'taps [✕ Can’t]');
await bot.tap(SAMI, `mp:n:${id}:tom`); dump('Sami', 'taps [Same time tomorrow]');
const p = (await app.db.selectFrom('meeting_proposals').selectAll().execute())[0]!;
await bot.tap(JOHN, `mp:a:${enc(p.id)}`); dump('John', 'taps [✓ Accept]');
await at('2026-11-18T17:00:20+03:00', 'clock → Wed 17:00 (2 h before, no link yet)');
await bot.send(JOHN, '/meeting link meet.google.com/abc-defg-hij'); dump('John', '/meeting link meet.google.com/abc-defg-hij');
await at('2026-11-18T18:00:20+03:00', 'clock → Wed 18:00');
await bot.tap(JOHN, `mt:go:${id}`); dump('John', 'taps [▶ Start meeting] at 19:00');
await bot.send(JOHN, 'Call MMCY friday @sami'); dump('John', 'Call MMCY friday @sami');
const save = (await app.db.selectFrom('drafts').selectAll().orderBy('id', 'desc').executeTakeFirst())!;
await bot.tap(JOHN, `qa:s:${enc(save.id)}`); dump('John', 'taps [✓ Save]');
await bot.tap(JOHN, `mt:out:${id}:decision`); await bot.send(JOHN, 'Pilot with 20 riders in Bole'); dump('John', '[◆ Decision] → Pilot with 20 riders in Bole');
await bot.tap(JOHN, `mt:out:${id}:question`); await bot.send(JOHN, 'B2B pricing?'); dump('John', '[? Open question] → B2B pricing?');
await bot.tap(JOHN, `mt:end:${id}`); dump('John', 'taps [■ End & send summary]');
console.log(out.join('\n'));
