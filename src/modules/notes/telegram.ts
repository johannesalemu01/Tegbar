import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { show } from '../../core/telegram/render.js';
import { fmtStamp, fromDb } from '../../core/time.js';
import { b, code, esc, i, quote } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { parseNote, type NoteRow } from './notes.js';

const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };

function card(n: NoteRow & { project_code: string }, banner?: string): View {
  const id = enc(n.id);
  const tags = (JSON.parse(n.tags) as string[]).map((x) => `#${esc(x)}`).join(' ');
  return {
    text: [
      banner ? `${i(esc(banner))}\n` : '',
      `✎ ${b(esc(n.title))}`,
      n.url ? `🔗 <a href="${esc(n.url)}">${esc(n.url.replace(/^https?:\/\//, '').slice(0, 60))}</a>` : '',
      n.body ? quote(esc(n.body), n.body.length > 300) : '',
      `${code(n.project_code)}${tags ? ` ${G.dot} ${tags}` : ''} ${G.dot} ${i(`N${n.id} · ${fmtStamp(fromDb(n.created_at))}`)}`,
      n.deleted_at ? i(t('note.deleted')) : '',
    ].filter(Boolean).join('\n'),
    keyboard: [
      n.deleted_at
        ? [{ text: t('task.btn_restore'), data: cb('no', 'res', id), style: 'primary' }]
        : [{ text: t('task.btn_edit'), data: cb('no', 'ed', id) }, { text: t('task.btn_delete'), data: cb('no', 'del', id) }],
      [{ text: G.back, data: cb('no', 'list', 'a') }],
    ],
  };
}

async function listView(ctx: MemberCtx, tag: string | null): Promise<View> {
  const { items, total } = await ctx.app.notes.list(ctx.actor, { tag }, 0, 10);
  return {
    text: `✎ ${b(t('note.list_title'))}${tag ? ` ${G.dot} #${esc(tag)}` : ''} ${i(`${G.dot} ${total}`)}\n${RULE}\n${items.map((n, k) => `${b(String(k + 1))}  ${esc(n.title)}${n.url ? ' 🔗' : ''}\n      ${code(n.project_code)} ${G.dot} ${(JSON.parse(n.tags) as string[]).map((x) => `#${esc(x)}`).join(' ')}`).join('\n') || i(t('note.empty'))}\n\n${i(t('note.hint'))}`,
    keyboard: [...grid(items.map((n, k) => ({ text: String(k + 1), data: cb('no', 'o', enc(n.id)) })), 5), [menuBtn]],
  };
}

async function save(ctx: MemberCtx, text: string): Promise<void> {
  const { app, actor } = ctx;
  const projects = await app.notes.codes(actor);
  const p = parseNote(text, projects.map((x) => x.code));
  if (!p.title) throw new DomainError('note.bad_title');
  const projectId = projects.find((x) => x.code === p.projectCode)?.id ?? (await app.projects.current(actor)).id;
  const n = await app.notes.create(actor, { projectId, title: p.title, body: p.body, url: p.url, tags: p.tags });
  await show(ctx, card(await app.notes.get(actor, n.id), t('note.saved')), 'new');
}

export const notesModule: TegbarModule = {
  name: 'notes',
  telegram({ reg }) {
    reg.command({
      name: 'note', group: 'other', description: 'cmd.note',
      handler: async (ctx, args) => {
        if (!args.trim()) {
          await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'note.new', {});
          return show(ctx, { text: t('note.prompt') });
        }
        await save(ctx, args);
      },
    });
    reg.command({
      name: 'notes', group: 'other', description: 'cmd.notes',
      handler: async (ctx, args) => show(ctx, await listView(ctx, /#([\p{L}\p{N}_-]+)/u.exec(args)?.[1]?.toLowerCase() ?? null)),
    });
    reg.input('note.new', async (ctx, text) => save(ctx, text));
    reg.input('note.edit', async (ctx, text, p: { id: number }) => {
      const parsed = parseNote(text, []);
      await ctx.app.notes.update(ctx.actor, p.id, { title: parsed.title, body: parsed.body });
      await show(ctx, card(await ctx.app.notes.get(ctx.actor, p.id), t('common.saved')), 'new');
    });
    reg.callback('no', async (ctx, [action, raw], answer) => {
      const { app, actor } = ctx;
      if (action === 'list') return show(ctx, await listView(ctx, null));
      const id = dec(raw);
      if (!id) return answer(t('common.stale'), true);
      switch (action) {
        case 'o': return show(ctx, card(await app.notes.get(actor, id, true)));
        case 'ed':
          await app.pending.set(actor.workspaceId, actor.userId, 'note.edit', { id });
          return show(ctx, { text: t('note.edit_prompt') }, 'new');
        case 'del': case 'res': {
          const { changed } = await app.notes.setDeleted(actor, id, action === 'del');
          await answer(changed ? t(action === 'del' ? 'task.deleted_toast' : 'task.restored') : t('common.nothing_changed'));
          return show(ctx, card(await app.notes.get(actor, id, true)));
        }
        default: return answer(t('common.stale'), true);
      }
    });
  },
};
