import type { App } from '../../app.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import type { JobHandler } from '../../core/scheduler/runner.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import { memberNames, projectOverride } from '../../core/telegram/helpers.js';
import type { Notifier } from '../../core/telegram/notifier.js';
import { show } from '../../core/telegram/render.js';
import { fmtStamp, fromDb } from '../../core/time.js';
import { b, code, esc, i, quote } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';
import { COMMS_JOB, LEVELS, URGENT_EVERY_MIN, URGENT_MAX, type NoticeLevel, type NoticeView } from './service.js';

export const LEVEL_GLYPH: Record<NoticeLevel, string> = { info: 'ⓘ', important: '◆', urgent: '🔴' };
const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };
const DRAFT = 'notice.new';

function ackLine(n: NoticeView, names: Map<number, string>): string {
  if (!n.recipients.length) return i(t('notice.no_recipients'));
  return n.recipients.map((u) => `${esc(names.get(u) ?? '?')} ${n.acked_by.includes(u) ? '✓' : '○'}`).join(`  ${G.dot}  `);
}

/** What a recipient sees (with the Acknowledge button). */
export function noticeMessage(n: NoticeView, names: Map<number, string>, forUser: number, repeat?: { n: number; max: number }): View {
  const acked = n.acked_by.includes(forUser);
  return {
    text: [
      `${LEVEL_GLYPH[n.level]} ${b(t(`notice.level.${n.level}`))} ${G.dot} ${t('notice.from', { name: names.get(n.created_by) ?? '?' })}${repeat ? ` ${i(t('notice.repeat', repeat))}` : ''}`,
      '',
      esc(n.body),
      '',
      `${code(n.project_code)} ${G.dot} ${i(`NT${n.id}`)}`,
    ].join('\n'),
    keyboard: acked || n.created_by === forUser ? [] : [[{ text: t('notice.btn_ack'), data: cb('nt', 'ack', enc(n.id)), style: n.level === 'urgent' ? 'danger' : 'success' }]],
  };
}

function noticeCard(n: NoticeView, names: Map<number, string>, me: number): View {
  const id = enc(n.id);
  const rows: Btn[][] = [];
  if (n.created_by !== me && !n.acked_by.includes(me) && !n.archived_at) rows.push([{ text: t('notice.btn_ack'), data: cb('nt', 'ack', id), style: 'success' }]);
  rows.push([n.archived_at ? { text: t('notice.btn_unarchive'), data: cb('nt', 'unarc', id) } : { text: t('notice.btn_archive'), data: cb('nt', 'arc', id) }]);
  rows.push([{ text: G.back, data: cb('nt', 'board', n.archived_at ? '1' : '0') }]);
  return {
    text: [
      `${LEVEL_GLYPH[n.level]} ${b(t(`notice.level.${n.level}`))} ${G.dot} ${t('notice.from', { name: names.get(n.created_by) ?? '?' })}${n.archived_at ? ` ${i(t('notice.archived'))}` : ''}`,
      quote(esc(n.body)),
      `${code(n.project_code)} ${G.dot} ${i(fmtStamp(fromDb(n.created_at)))}`,
      `${t('notice.acks')} ${ackLine(n, names)}`,
    ].join('\n'),
    keyboard: rows,
  };
}

async function board(ctx: MemberCtx, archived: boolean): Promise<View> {
  const list = await ctx.app.comms.list(ctx.actor, archived);
  const names = await memberNames(ctx.app, ctx.actor.workspaceId);
  const lines = list.map((n, idx) => `${b(String(idx + 1))}  ${LEVEL_GLYPH[n.level]} ${esc(n.body.split('\n')[0]!.slice(0, 70))}\n      ${code(n.project_code)} ${G.dot} ${ackLine(n, names)}`);
  return {
    text: `📣 ${b(t(archived ? 'notice.archive_title' : 'notice.board_title'))}\n${RULE}\n${lines.join('\n') || i(t('notice.empty'))}\n\n${i(t('notice.hint'))}`,
    keyboard: [
      ...grid(list.map((n, idx) => ({ text: String(idx + 1), data: cb('nt', 'o', enc(n.id)) })), 6),
      [{ text: archived ? t('notice.btn_board') : t('notice.btn_archive_list'), data: cb('nt', 'board', archived ? '0' : '1') }],
      [menuBtn],
    ],
  };
}

function draftView(id: number, d: { level: NoticeLevel; body: string; projectCode: string }): View {
  const e = enc(id);
  const nextLevel = LEVELS[(LEVELS.indexOf(d.level) + 1) % LEVELS.length]!;
  return {
    text: `${LEVEL_GLYPH[d.level]} ${b(t('notice.draft_title', { level: t(`notice.level.${d.level}`) }))}\n${RULE}\n${esc(d.body)}\n\n${code(d.projectCode)}${d.level === 'urgent' ? `\n${i(t('notice.urgent_hint', { every: URGENT_EVERY_MIN, max: URGENT_MAX }))}` : ''}`,
    keyboard: [
      [{ text: t('notice.btn_post'), data: cb('nd', 's', e), style: 'primary' }, { text: t('common.cancel'), data: cb('nd', 'c', e) }],
      [{ text: `${LEVEL_GLYPH[nextLevel]} ${t(`notice.level.${nextLevel}`)} ›`, data: cb('nd', 'l', e, nextLevel) }],
    ],
  };
}

const URGENCY = { info: 'nudge', important: 'direct', urgent: 'urgent' } as const;

function jobs(app: App, notifier: Notifier): JobHandler[] {
  const deliverTo = async (ws: number, n: NoticeView, users: number[], repeat?: { n: number; max: number }) => {
    const names = await memberNames(app, ws);
    for (const u of users) await notifier.deliver(ws, u, noticeMessage(n, names, u, repeat), URGENCY[n.level]);
  };
  return [
    {
      kind: COMMS_JOB.send, maxLateMs: 7 * 86_400_000, nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      async execute(job, p: { noticeId: number }) {
        const n = await app.comms.byId(job.workspace_id, p.noticeId);
        if (!n || n.deleted_at || n.archived_at) return 'sent';
        await deliverTo(job.workspace_id, n, n.recipients);
        return 'sent';
      },
    },
    {
      // Urgent notices repeat every 30 min to whoever hasn't acknowledged — at most 6 times.
      kind: COMMS_JOB.renotify, maxLateMs: 86_400_000, nextAfter: () => null,
      async plan(job, p: { noticeId: number; count: number }, { now }) {
        const n = await app.comms.byId(job.workspace_id, p.noticeId);
        if (!n || n.archived_at || n.deleted_at) return { action: 'skip', reason: 'closed', next: null };
        const pending = n.recipients.filter((u) => !n.acked_by.includes(u));
        if (!pending.length) return { action: 'skip', reason: 'all acknowledged', next: null };
        if (p.count >= URGENT_MAX) return { action: 'skip', reason: 'cap', next: null };
        const count = p.count + 1;
        return { action: 'send', next: count < URGENT_MAX ? now.plus({ minutes: URGENT_EVERY_MIN }) : null, payload: { ...p, count }, data: { pending, count } };
      },
      async execute(job, p: { noticeId: number }, plan) {
        const n = (await app.comms.byId(job.workspace_id, p.noticeId))!;
        const d = plan.data as { pending: number[]; count: number };
        await deliverTo(job.workspace_id, n, d.pending, { n: d.count + 1, max: URGENT_MAX + 1 });
        return 'sent';
      },
    },
    {
      kind: COMMS_JOB.acked, maxLateMs: 7 * 86_400_000, nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      async execute(job, p: { noticeId: number; userId: number }) {
        const n = await app.comms.byId(job.workspace_id, p.noticeId);
        if (!n) return 'sent';
        const names = await memberNames(app, job.workspace_id);
        await notifier.deliver(job.workspace_id, n.created_by, { text: t('notice.acked_by', { name: names.get(p.userId) ?? '?', body: n.body.slice(0, 80) }) }, 'nudge');
        return 'sent';
      },
    },
    {
      kind: COMMS_JOB.tell, maxLateMs: 7 * 86_400_000, nextAfter: () => null,
      plan: async () => ({ action: 'send', next: null }),
      async execute(job, p: { messageId: number }) {
        const m = await app.comms.message(job.workspace_id, p.messageId);
        if (!m) return 'sent';
        const names = await memberNames(app, job.workspace_id);
        const quoted = m.reply_to ? await app.comms.message(job.workspace_id, m.reply_to) : undefined;
        const r = await notifier.deliver(job.workspace_id, m.to_user_id, {
          text: `💬 ${b(esc(names.get(m.from_user_id) ?? '?'))}${quoted ? `\n${quote(esc(quoted.body.slice(0, 200)))}` : ''}\n${esc(m.body)}`,
          keyboard: [[{ text: t('tell.btn_reply'), data: cb('tm', 'r', enc(m.id)), style: 'primary' }]],
        }, 'direct');
        return r === 'failed' ? 'failed' : 'sent';
      },
    },
  ];
}

export const commsModule: TegbarModule = {
  name: 'comms',
  telegram({ app, reg, notifier }) {
    for (const h of jobs(app, notifier)) reg.job(h);

    reg.command({
      name: 'notice', group: 'other', description: 'cmd.notice',
      handler: async (ctx, args) => {
        if (!args.trim()) {
          await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'notice.body', {});
          return show(ctx, { text: t('notice.prompt') });
        }
        await startNotice(ctx, args);
      },
    });
    reg.command({ name: 'notices', group: 'other', description: 'cmd.notices', handler: async (ctx) => show(ctx, await board(ctx, false)) });
    reg.command({
      name: 'tell', group: 'other', description: 'cmd.tell',
      handler: async (ctx, args) => {
        const { app, actor } = ctx;
        const members = await app.members.list(actor.workspaceId);
        const handle = /^@([\p{L}\p{N}_]+)\s+/u.exec(args);
        const others = members.filter((m) => m.user_id !== actor.userId);
        const to = handle ? members.find((m) => m.handle === handle[1]!.toLowerCase()) : others.length === 1 ? others[0] : undefined;
        const body = handle ? args.slice(handle[0].length) : args;
        if (!to || !body.trim()) throw new DomainError('tell.usage');
        await app.comms.tell(actor, to.user_id, body);
        await show(ctx, { text: t('tell.sent', { name: to.display_name }) });
        await ctx.kick();
      },
    });
    reg.menuEntry({ label: 'menu.notices', command: 'notices', order: 65, group: 'alerts' });

    reg.input('notice.body', async (ctx, text) => startNotice(ctx, text));
    reg.input('tell.reply', async (ctx, text, p: { messageId: number }) => {
      const m = await ctx.app.comms.message(ctx.actor.workspaceId, p.messageId);
      if (!m || m.to_user_id !== ctx.actor.userId) throw new DomainError('error.not_found');
      await ctx.app.comms.tell(ctx.actor, m.from_user_id, text, m.id);
      const names = await memberNames(ctx.app, ctx.actor.workspaceId);
      await show(ctx, { text: t('tell.sent', { name: names.get(m.from_user_id) ?? '?' }) });
      await ctx.kick();
    });

    reg.callback('tm', async (ctx, [action, raw], answer) => {
      const id = dec(raw);
      if (action !== 'r' || !id) return answer(t('common.stale'), true);
      await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'tell.reply', { messageId: id });
      return show(ctx, { text: t('tell.reply_prompt') }, 'new');
    });

    reg.callback('nd', async (ctx, [action, raw, target], answer) => {
      const { app, actor } = ctx;
      const id = dec(raw);
      if (!id) return answer(t('common.stale'), true);
      const d = await app.drafts.get<{ level: NoticeLevel; body: string; projectId: number; projectCode: string }>(id, actor.userId, DRAFT);
      if (!d) return answer(t('qa.expired'), true);
      if (d.consumed) return answer(t('qa.already_handled'));
      if (action === 'l') {
        if (!LEVELS.includes(target as NoticeLevel)) return answer(t('common.stale'), true);
        const next = { ...d.payload, level: target as NoticeLevel };
        await app.drafts.update(id, actor.userId, next);
        return show(ctx, draftView(id, next));
      }
      if (!(await app.drafts.consume(id, actor.userId))) return answer(t('qa.already_handled'));
      if (action === 'c') return show(ctx, { text: i(t('common.cancelled')) });
      const n = await app.comms.post(actor, { projectId: d.payload.projectId, level: d.payload.level, body: d.payload.body });
      await answer(t('notice.posted'));
      await show(ctx, noticeCard(n, await memberNames(app, actor.workspaceId), actor.userId));
      await ctx.kick();
    });

    reg.callback('nt', async (ctx, [action, raw], answer) => {
      const { app, actor } = ctx;
      if (action === 'board') return show(ctx, await board(ctx, raw === '1'));
      const id = dec(raw);
      if (!id) return answer(t('common.stale'), true);
      const names = await memberNames(app, actor.workspaceId);
      switch (action) {
        case 'o': return show(ctx, noticeCard(await app.comms.get(actor, id), names, actor.userId));
        case 'ack': {
          const { notice, changed } = await app.comms.ack(actor, id);
          await answer(changed ? t('notice.ack_thanks') : t('qa.already_handled'));
          await ctx.kick();
          return show(ctx, noticeMessage(notice, names, actor.userId));
        }
        case 'arc': case 'unarc': {
          await app.comms.archive(actor, id, action === 'arc');
          return show(ctx, await board(ctx, false));
        }
        default: return answer(t('common.stale'), true);
      }
    });
  },
};

async function startNotice(ctx: MemberCtx, text: string): Promise<void> {
  const { app, actor } = ctx;
  let level: NoticeLevel = 'info';
  let body = text.trim();
  const m = /(^|\s)!(urgent|important|info)\b/i.exec(body);
  if (m) {
    level = m[2]!.toLowerCase() as NoticeLevel;
    body = body.replace(m[0], ' ').trim();
  }
  const { project, rest } = await projectOverride(app, actor, body);
  const p = project ?? (await app.projects.current(actor));
  if (!rest.trim()) throw new DomainError('notice.bad_body');
  const payload = { level, body: rest.trim(), projectId: p.id, projectCode: p.code };
  const id = await app.drafts.create(actor.workspaceId, actor.userId, DRAFT, payload);
  await show(ctx, draftView(id, payload), 'new');
}

