/** Phase 4 sample conversation through the fake Telegram API: npm run transcript:4 */
import { JOHN, SAMI, makeApp, makeBot, pairBoth } from './helpers.js';
const { app, clock } = await makeApp('2026-11-15T10:00:00+03:00');
await pairBoth(app);
const bot = makeBot(app);
const out: string[] = [];
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const dump = (who: string, input: string) => {
  out.push(`\n**${who}:** ${input}`);
  for (const c of bot.calls) {
    const to = c.payload.chat_id === JOHN.id ? 'John' : 'Sami';
    if (c.method === 'sendMessage' || c.method === 'editMessageText') {
      const kb = (c.payload.reply_markup?.inline_keyboard ?? []).map((r: any[]) => r.map((b) => `[${b.text}]`).join(' ')).filter(Boolean).join('\n');
      out.push(`\n_Tegbar → ${to}${c.method === 'editMessageText' ? ' (edits)' : ''}:_\n\`\`\`\n${strip(c.payload.text)}${kb ? `\n\n${kb}` : ''}\n\`\`\``);
    }
    if (c.method === 'sendDocument') out.push(`_Tegbar → ${to}: 📎 file_`);
    if (c.method === 'answerCallbackQuery' && c.payload.text) out.push(`_toast: ${c.payload.text}_`);
  }
  bot.calls.length = 0;
};
const btn = (prefix: string) => ([...bot.calls].reverse().find((c) => c.payload.reply_markup)?.payload.reply_markup.inline_keyboard.flat() as any[]).find((b) => b.callback_data?.startsWith(prefix)).callback_data;

await bot.send(JOHN, '/spend 1500 hosting #ridehome telebirr VPS for November');
const save1 = btn('cn:s:'); dump('John', '/spend 1500 hosting #ridehome telebirr VPS for November');
await bot.tap(JOHN, save1); dump('John', 'taps [✓ Save]');
await bot.send(SAMI, '/spend 400 sms paid-by me yesterday'); const save2 = btn('cn:s:'); dump('Sami', '/spend 400 sms paid-by me yesterday');
await bot.tap(SAMI, save2); dump('Sami', 'taps [✓ Save]');
await bot.send(JOHN, '/budget #ridehome 2000 monthly'); dump('John', '/budget #ridehome 2000 monthly');
await bot.send(SAMI, '/balance'); const pay = btn('se:new:'); dump('Sami', '/balance');
await bot.tap(SAMI, pay); dump('Sami', 'taps [I paid John 550.00 ETB] (the amount shown)');
const confirm = (bot.calls.length ? btn('se:c:') : null);
const req = (await app.db.selectFrom('settlements').selectAll().execute())[0]!;
await bot.tap(JOHN, `se:c:${req.id.toString(36)}`); dump('John', 'taps [✓ Received]');
await bot.send(JOHN, '/costs'); dump('John', '/costs');
clock.set('2026-12-01T09:00:30+03:00'); await bot.scheduler.tick(); dump('⏱', 'clock → 1 Dec 09:00 (statement day)');
void confirm;
console.log(out.join('\n'));
