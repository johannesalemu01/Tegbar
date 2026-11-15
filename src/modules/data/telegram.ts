import { InputFile } from 'grammy';
import { readFile } from 'node:fs/promises';
import type { App } from '../../app.js';
import { t } from '../../core/i18n/index.js';
import type { TegbarModule } from '../../core/module.js';
import type { JobHandler } from '../../core/scheduler/runner.js';
import type { SearchHit } from '../../core/services/search.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import { show } from '../../core/telegram/render.js';
import { fmtStamp, localDate } from '../../core/time.js';
import { b, code, esc, i } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { toCsv } from '../costs/exports.js';

const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };
/** Telegram bots may upload files up to 50 MB; keep a margin. */
const MAX_UPLOAD = 49 * 1024 * 1024;

const OPEN: Record<string, (id: number) => string> = {
  task: (id) => cb('t', 'o', id.toString(36), '-'),
  note: (id) => cb('no', 'o', id.toString(36)),
  decision: (id) => cb('dc', 'o', id.toString(36)),
  notice: (id) => cb('nt', 'o', id.toString(36)),
  meeting: (id) => cb('mt', 'o', id.toString(36)),
};
const TYPE_GLYPH: Record<string, string> = { task: '○', note: '✎', decision: '◆', notice: '📣', meeting: '◉' };

function searchView(q: string, hits: SearchHit[]): View {
  const lines = hits.map((h, k) => `${b(String(k + 1))}  ${TYPE_GLYPH[h.type] ?? G.dot} ${esc(h.title.slice(0, 80))}\n      ${i(t(`search.type.${h.type}` as 'search.type.task'))}${h.projectCode ? ` ${G.dot} ${code(h.projectCode)}` : ''}${h.snippet ? ` ${G.dot} ${esc(h.snippet.slice(0, 50))}` : ''}`);
  return {
    text: `🔎 ${b(t('search.title', { q }))}\n${RULE}\n${lines.join('\n') || i(t('search.none'))}`,
    keyboard: [...grid(hits.filter((h) => OPEN[h.type]).map((h, k) => ({ text: String(k + 1), data: OPEN[h.type]!(h.id) })), 6), [menuBtn]],
  };
}

function exportView(names: string[]): View {
  return {
    text: `⬇ ${b(t('export.title'))}\n${i(t('export.hint'))}`,
    keyboard: [
      ...grid(names.map((n) => ({ text: `${n}.csv`, data: cb('dx', 'csv', n) })), 3),
      [{ text: t('export.btn_all'), data: cb('dx', 'json', 'all'), style: 'primary' }],
      [menuBtn],
    ],
  };
}

async function purgeHome(ctx: MemberCtx): Promise<View> {
  const rows: Btn[][] = [];
  const lines: string[] = [];
  for (const p of ctx.app.purge.list()) {
    const n = (await p.candidates(ctx.actor)).length;
    lines.push(`${esc(p.label)}: ${b(String(n))}${p.twoKey ? ` ${i(t('purge.two_key'))}` : ''}`);
    if (n) rows.push([{ text: t('purge.btn_type', { label: p.label, n }), data: cb('px', 'pick', p.type) }]);
  }
  return { text: `🧹 ${b(t('purge.title'))}\n${RULE}\n${lines.join('\n')}\n\n${t('purge.explain')}`, keyboard: [...rows, [menuBtn]] };
}

function backupJob(app: App, notifier: Notifier, onError: (err: unknown) => Promise<void>): JobHandler {
  return {
    kind: 'backup.daily',
    maxLateMs: 12 * 3_600_000,
    nextAfter: (_j, _p, now) => app.backups.nextRunAt(now),
    plan: async (_j, _p, { now }) => ({ action: 'send', next: app.backups.nextRunAt(now) }),
    async execute(job) {
      try {
        const r = await app.backups.run();
        const seatA = await app.members.bySeat(job.workspace_id, 'A');
        if (seatA && app.backups.opts.toTelegram) {
          if (r.bytes <= MAX_UPLOAD) {
            await notifier.sendFile(job.workspace_id, seatA.user_id, await readFile(r.file), r.name, t('backup.caption', { name: r.name }));
          } else {
            await notifier.deliver(job.workspace_id, seatA.user_id, { text: t('backup.too_big', { name: r.name }) }, 'nudge');
          }
        }
        return 'sent';
      } catch (err) {
        await onError(err);
        return 'failed';
      }
    },
  };
}

export const dataModule: TegbarModule = {
  name: 'data',
  telegram({ app, reg, notifier }) {
    reg.job(backupJob(app, notifier, async (err) => app.log.error({ err }, 'backup failed')));

    reg.command({
      name: 'search', group: 'other', description: 'cmd.search',
      handler: async (ctx, args) => {
        const q = args.trim();
        if (q.length < 2) {
          await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'search.q', {});
          return show(ctx, { text: t('search.prompt') });
        }
        await show(ctx, searchView(q, await ctx.app.search.query(ctx.actor, q, { limitPerType: 4 })));
      },
    });
    reg.input('search.q', async (ctx, text) => show(ctx, searchView(text.trim(), await ctx.app.search.query(ctx.actor, text, { limitPerType: 4 }))));

    reg.command({
      name: 'export', group: 'other', description: 'cmd.export',
      handler: async (ctx) => {
        await ctx.app.permissions.authorize(ctx.actor, 'data.export');
        await show(ctx, exportView(ctx.app.exporter.names()));
      },
    });
    reg.callback('dx', async (ctx, [kind, name], answer) => {
      await ctx.app.permissions.authorize(ctx.actor, 'data.export');
      const day = localDate(ctx.app.clock.now());
      await answer(t('cost.preparing'));
      if (kind === 'json') {
        const data = { exportedAt: ctx.app.clock.now().toISO(), timezone: 'Africa/Addis_Ababa', note: 'Money amounts are integers in the smallest unit (santim for ETB).', ...(await ctx.app.exporter.all(ctx.actor)) };
        return void (await ctx.replyWithDocument(new InputFile(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), `tegbar-export-${day}.json`)));
      }
      if (kind !== 'csv' || !name || !ctx.app.exporter.names().includes(name)) return answer(t('common.stale'), true);
      const rows = await ctx.app.exporter.rows(ctx.actor, name);
      const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const csv = toCsv([header, ...rows.map((r) => header.map((h) => r[h] ?? null))]);
      await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), `tegbar-${name}-${day}.csv`));
    });

    reg.command({
      name: 'purge', group: 'other', description: 'cmd.purge',
      handler: async (ctx) => {
        await ctx.app.permissions.authorize(ctx.actor, 'data.purge');
        await show(ctx, await purgeHome(ctx));
      },
    });
    reg.callback('px', async (ctx, [action, type], answer) => {
      const { app, actor } = ctx;
      await app.permissions.authorize(actor, 'data.purge');
      if (action === 'home') return show(ctx, await purgeHome(ctx));
      const p = app.purge.get(type ?? '');
      const items = await p.candidates(actor);
      if (!items.length) return answer(t('purge.nothing_left'), true);
      if (action === 'pick') {
        return show(ctx, {
          text: `🧹 ${b(t('purge.confirm_title', { label: p.label, n: items.length }))}\n${items.slice(0, 15).map((x) => `· ${esc(x.label)}`).join('\n')}${items.length > 15 ? `\n${i(t('digest.more', { n: items.length - 15 }))}` : ''}\n\n${b(t('purge.warning'))}\n${i(t('purge.backups_note'))}`,
          keyboard: [[
            { text: p.twoKey ? t('purge.btn_request') : t('purge.btn_yes'), data: cb('px', 'go', p.type), style: 'danger' },
            { text: t('common.cancel'), data: cb('px', 'home', '-') },
          ]],
        });
      }
      if (action === 'go') {
        const r = await app.purge.run(actor, p.type, items.map((x) => x.id));
        await answer(r.done ? t('purge.done_toast') : t('cost.split_requested'));
        await ctx.kick();
        return show(ctx, { text: r.done ? t('purge.done', { rows: r.rows, files: r.files }) : t('purge.requested') });
      }
      return answer(t('common.stale'), true);
    });

    reg.command({
      name: 'backup', group: 'other', description: 'cmd.backup',
      handler: async (ctx) => show(ctx, await backupView(ctx)),
    });
    reg.callback('bk', async (ctx, [action], answer) => {
      await ctx.app.permissions.authorize(ctx.actor, 'backup.manage');
      if (action !== 'now') return answer(t('common.stale'), true);
      if (!ctx.app.backups.enabled) return answer(t('backup.not_configured_short'), true);
      await answer(t('backup.running'));
      const r = await ctx.app.backups.run();
      if (r.bytes <= MAX_UPLOAD) await ctx.replyWithDocument(new InputFile(await readFile(r.file), r.name), { caption: t('backup.caption', { name: r.name }) });
      await show(ctx, await backupView(ctx), 'new');
    });
  },
};

async function backupView(ctx: MemberCtx): Promise<View> {
  await ctx.app.permissions.authorize(ctx.actor, 'backup.manage');
  const bk = ctx.app.backups;
  if (!bk.enabled) return { text: t('backup.not_configured'), keyboard: [[menuBtn]] };
  const list = await bk.list();
  const next = bk.nextRunAt(ctx.app.clock.now());
  return {
    text: [
      `🔐 ${b(t('backup.title'))}`,
      RULE,
      t('backup.status', { n: list.length, keep: bk.opts.keep, time: bk.opts.time, next: fmtStamp(next) }),
      list.slice(0, 5).map((f) => `· ${code(f.name)} ${i(`${(f.bytes / 1024 / 1024).toFixed(1)} MB`)}`).join('\n'),
      '',
      i(t('backup.explain')),
    ].join('\n'),
    keyboard: [[{ text: t('backup.btn_now'), data: cb('bk', 'now'), style: 'primary' }], [menuBtn]],
  };
}

