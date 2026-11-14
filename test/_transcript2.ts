/** Phase 2 sample conversation through the fake Telegram API: npm run transcript:2 */
import { JOHN, SAMI, makeApp, makeBot, pairBoth } from './helpers.js';
const { app, clock } = await makeApp('2026-11-15T10:00:00+03:00');
await pairBoth(app);
const bot = makeBot(app);
const out: string[] = [];
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const dump = (who: string, input: string) => {
  out.push(`\n**${who}:** ${input}`);
  for (const c of bot.calls) {
    if (c.method === 'sendMessage' || c.method === 'editMessageText') {
      const to = c.payload.chat_id === JOHN.id ? 'John' : 'Sami';
      const kb = (c.payload.reply_markup?.inline_keyboard ?? []).map((r: any[]) => r.map((b) => `[${b.text}]`).join(' ')).join('\n');
      out.push(`\n_Tegbar → ${to}${c.method === 'editMessageText' ? ' (edits the card)' : ''}:_\n\`\`\`\n${strip(c.payload.text)}${kb ? `\n\n${kb}` : ''}\n\`\`\``);
    }
    if (c.method === 'answerCallbackQuery' && c.payload.text) out.push(`_toast: ${c.payload.text}_`);
  }
  bot.calls.length = 0;
};
const at = async (iso: string, label: string) => { clock.set(iso); await bot.scheduler.tick(); dump('⏱', label); };

await bot.send(JOHN, '/add Call MMCY today 15:00 @sami !high #sales'); dump('John', '/add Call MMCY today 15:00 @sami !high #sales');
await bot.send(JOHN, '/add Team sync every monday 9am'); dump('John', '/add Team sync every monday 9am');
await bot.send(JOHN, '/remind us today 17:00 send the deck to MMCY'); dump('John', '/remind us today 17:00 send the deck to MMCY');
await bot.send(SAMI, '/focus 2h'); dump('Sami', '/focus 2h');
await at('2026-11-15T14:00:30+03:00', 'clock → 14:00 (Sami is in focus until 12:00 — already over)');
await at('2026-11-15T15:00:30+03:00', 'clock → 15:00');
await at('2026-11-15T17:00:30+03:00', 'clock → 17:00');
await at('2026-11-16T08:00:30+03:00', 'clock → Mon 08:00');
await at('2026-11-16T08:30:30+03:00', 'clock → Mon 08:30');
const sync = (await app.tasks.list({ userId: 1, workspaceId: 1 }, { owner: 'me', projectId: null, status: 'open', due: 'any', recurring: true })).items[0]!;
await bot.tap(JOHN, `t:d:${sync.id.toString(36)}:-`); dump('John', 'taps [✓ Done] on Team sync');
await bot.send(JOHN, '/settings'); dump('John', '/settings');
console.log(out.join('\n'));
