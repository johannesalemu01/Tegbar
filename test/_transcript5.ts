/** Phase 5 sample conversation: npm run transcript:5 */
import { JOHN, SAMI, makeApp, makeBot, pairBoth } from './helpers.js';
const { app } = await makeApp('2026-11-15T10:00:00+03:00');
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
    if (c.method === 'answerCallbackQuery' && c.payload.text) out.push(`_toast: ${c.payload.text}_`);
  }
  bot.calls.length = 0;
};
const btn = (prefix: string, chat?: number) => ([...bot.calls].reverse().find((c) => c.payload.reply_markup && (!chat || c.payload.chat_id === chat))!.payload.reply_markup.inline_keyboard.flat() as any[]).find((b) => b.callback_data?.startsWith(prefix)).callback_data;

await bot.send(JOHN, '/notice !urgent SMS gateway is down — riders get no OTP'); const post = btn('nd:s:'); dump('John', '/notice !urgent SMS gateway is down — riders get no OTP');
await bot.tap(JOHN, post); const ack = btn('nt:ack:', SAMI.id); dump('John', 'taps [📣 Post]');
await bot.tap(SAMI, ack); dump('Sami', 'taps [✓ Acknowledged]');
await bot.send(JOHN, '/tell can you call MMCY before 3?'); const reply = btn('tm:r:', SAMI.id); dump('John', '/tell can you call MMCY before 3?');
await bot.tap(SAMI, reply); await bot.send(SAMI, 'yes, calling at 2'); dump('Sami', 'taps [↩ Reply] → yes, calling at 2');
await bot.send(JOHN, '/decide Launch in Bole first — highest demand in our survey'); const agree = btn('dc:ag:', SAMI.id); dump('John', '/decide Launch in Bole first — highest demand in our survey');
await bot.tap(SAMI, agree); dump('Sami', 'taps [✓ Agree]');
await bot.send(SAMI, '/note Rider survey results #ridehome #research https://docs.example.com/survey'); dump('Sami', '/note Rider survey results #ridehome #research https://…');
await bot.send(JOHN, '/search bole'); dump('John', '/search bole');
console.log(out.join('\n'));
