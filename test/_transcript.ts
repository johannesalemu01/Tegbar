/** Renders a real sample conversation through the fake Telegram API: npm run transcript */
import { JOHN, SAMI, SETUP, makeApp, makeBot } from './helpers.js';
const { app } = await makeApp('2026-11-15T10:00:00+03:00');
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
await bot.send(JOHN, SETUP); dump('John', '(sends the setup code)');
await bot.send(SAMI, SETUP); dump('Sami', '(sends the setup code)');
await bot.send(JOHN, '/add Call MMCY tomorrow 10am @sami !high #ridehome #sales'); dump('John', '/add Call MMCY tomorrow 10am @sami !high #ridehome #sales');
await bot.send(JOHN, 'Renew domain 2026-11-20 #engineering'); dump('John', 'Renew domain 2026-11-20 #engineering');
await bot.send(JOHN, 'Draft pitch deck in december @bob'); 
const kb = [...bot.calls].reverse().find((c) => c.payload.reply_markup)!.payload.reply_markup.inline_keyboard.flat();
dump('John', 'Draft pitch deck in december @bob');
await bot.tap(JOHN, kb.find((b: any) => b.callback_data.startsWith('qa:s:')).callback_data); dump('John', 'taps [✓ Save]');
await bot.send(SAMI, '/my'); dump('Sami', '/my');
const t = (await app.tasks.list({ userId: 2, workspaceId: 1 }, { owner: 'me', projectId: null, status: 'open', due: 'any' })).items[0]!;
await bot.tap(SAMI, `t:o:${t.id.toString(36)}:my.0.m.a.o`); dump('Sami', 'taps [1]');
await bot.tap(SAMI, `t:d:${t.id.toString(36)}:my.0.m.a.o`); dump('Sami', 'taps [✓ Done]');
await bot.tap(SAMI, `t:d:${t.id.toString(36)}:my.0.m.a.o`); dump('Sami', 'taps [✓ Done] again');
await bot.send(JOHN, '/dashboard'); dump('John', '/dashboard');
console.log(out.join('\n'));
