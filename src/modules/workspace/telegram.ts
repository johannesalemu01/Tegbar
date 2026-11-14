import type { App } from '../../app.js';
import type { Project, ProjectStatus } from '../../core/db/schema.js';
import { DomainError } from '../../core/errors.js';
import { t } from '../../core/i18n/index.js';
import { dec, enc } from '../../core/ids.js';
import type { TegbarModule } from '../../core/module.js';
import { PROJECT_STATUSES } from '../../core/services/projects.js';
import { S_TIME_FORMAT } from '../../core/services/settings.js';
import { memberNames, timeFormat } from '../../core/telegram/helpers.js';
import type { MemberCtx } from '../../core/telegram/context.js';
import type { Registry } from '../../core/telegram/registry.js';
import { show } from '../../core/telegram/render.js';
import { getZone } from '../../core/time.js';
import { b, code, esc, i, quote } from '../../core/ui/html.js';
import { cb, grid, type Btn } from '../../core/ui/keyboard.js';
import { G, RULE } from '../../core/ui/theme.js';
import type { View } from '../../core/ui/view.js';

const STATUS_LABEL: Record<ProjectStatus, () => string> = {
  idea: () => t('project.status.idea'),
  active: () => t('project.status.active'),
  paused: () => t('project.status.paused'),
  done: () => t('project.status.done'),
};

const menuBtn: Btn = { text: t('common.menu'), data: cb('m', 'menu') };

// ---------- views ----------

async function menuView(ctx: MemberCtx, reg: Registry): Promise<View> {
  const current = await ctx.app.projects.current(ctx.actor);
  const buttons = reg.menu.map((e): Btn => ({ text: t(e.label), data: cb('m', e.command), ...(e.order === 0 ? { style: 'primary' as const } : {}) }));
  const first = buttons.slice(0, 1);
  return {
    text: `${b('Tegbar')} ${i('· ተግባር')}\n${t('menu.current', { code: current.code })}`,
    keyboard: [first, ...grid(buttons.slice(1), 2)],
  };
}

function helpView(reg: Registry): View {
  const groups: Record<string, string[]> = {};
  for (const c of reg.commands.values()) (groups[c.group] ??= []).push(`/${c.name} — ${t(c.description)}`);
  const section = (key: 'start' | 'tasks' | 'projects' | 'other', title: string) =>
    groups[key]?.length ? `${b(title)}\n${groups[key].join('\n')}` : '';
  return {
    text: [
      t('help.intro'),
      section('start', t('help.group.start')),
      section('tasks', t('help.group.tasks')),
      section('projects', t('help.group.projects')),
      section('other', t('help.group.other')),
      t('help.quickadd'),
      t('help.security'),
    ]
      .filter(Boolean)
      .join('\n\n'),
    keyboard: [[menuBtn]],
  };
}

async function settingsView(ctx: MemberCtx, reg: Registry): Promise<View> {
  const { app, actor, member } = ctx;
  const current = await app.projects.current(actor);
  const fmt = await timeFormat(app, actor);
  const sections = await Promise.all(reg.settings.map((s) => s.render(ctx)));
  return {
    text: [
      b(t('settings.title')),
      RULE,
      t('settings.you', { name: member.display_name, handle: member.handle, seat: member.seat }),
      t('settings.project', { code: current.code }),
      t('settings.time_format', { fmt }),
      t('settings.zone', { zone: getZone() }),
      ...sections.map((s) => `\n${s.lines.join('\n')}`),
    ].join('\n'),
    keyboard: [
      [
        { text: t('settings.btn_project'), data: cb('s', 'p') },
        { text: t('settings.btn_fmt', { next: fmt === '24h' ? '12h' : '24h' }), data: cb('s', 'tf', fmt === '24h' ? '12h' : '24h') },
      ],
      ...sections.flatMap((s) => s.buttons),
      [menuBtn],
    ],
  };
}

async function projectsView(ctx: MemberCtx, archived: boolean): Promise<View> {
  const { app, actor } = ctx;
  const all = await app.projects.list(actor, { includeArchived: true });
  const list = all.filter((p) => Boolean(p.archived_at) === archived);
  const current = await app.projects.current(actor);
  const lines = list.map((p) => {
    const mark = p.id === current.id ? G.done : G.todo;
    return `${mark} ${b(esc(p.name))} ${code(p.code)} ${i(STATUS_LABEL[p.status]())}`;
  });
  const title = archived ? t('project.archived_title') : t('project.list_title');
  const body = lines.length ? lines.join('\n') : i(archived ? t('project.none_archived') : t('project.none'));
  const btns = grid(
    list.map((p) => ({ text: p.code, data: cb('p', 'o', enc(p.id)) })),
    3,
  );
  return {
    text: `${b(title)}\n${RULE}\n${body}\n\n${i(t('project.list_hint'))}`,
    keyboard: [
      ...btns,
      [
        ...(archived ? [] : [{ text: t('project.btn_new'), data: cb('p', 'n'), style: 'primary' as const }]),
        { text: archived ? t('project.btn_active') : t('project.btn_archived'), data: cb('p', 'l', archived ? '0' : '1') },
      ],
      [menuBtn],
    ],
  };
}

async function projectCard(ctx: MemberCtx, p: Project): Promise<View> {
  const { app, actor } = ctx;
  const [current, areas, names] = await Promise.all([
    app.projects.current(actor),
    app.projects.areas(actor, p.id),
    memberNames(app, actor.workspaceId),
  ]);
  const isCurrent = current.id === p.id;
  const links = [
    p.repo_url ? `<a href="${esc(p.repo_url)}">${t('project.repo')}</a>` : null,
    p.docs_url ? `<a href="${esc(p.docs_url)}">${t('project.docs')}</a>` : null,
  ].filter(Boolean);
  const areaLines = areas.map((a) => {
    const owner = a.owner_user_id ? names.get(a.owner_user_id) : null;
    const backup = a.backup_user_id ? names.get(a.backup_user_id) : null;
    return `${G.area} ${esc(a.name)} ${i(`— ${owner ? esc(owner) : t('project.unowned')}${backup ? ` · ${t('project.backup')} ${esc(backup)}` : ''}`)}`;
  });
  const status = STATUS_LABEL[p.status]();
  const text = [
    `${G.project} ${b(esc(p.name))}  ${code(p.code)}`,
    `${i(status)}${isCurrent ? ` ${G.dot} ${t('project.is_current')}` : ''}${p.archived_at ? ` ${G.dot} ${t('project.archived')}` : ''}`,
    p.description ? quote(esc(p.description)) : '',
    links.length ? links.join(` ${G.dot} `) : '',
    areaLines.length ? `${b(t('project.areas'))}\n${areaLines.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const id = enc(p.id);
  const rows: Btn[][] = [];
  if (!p.archived_at) {
    rows.push([
      ...(isCurrent ? [] : [{ text: t('project.btn_current'), data: cb('p', 'c', id), style: 'primary' as const }]),
      { text: t('project.btn_status', { status }), data: cb('p', 'st', id, PROJECT_STATUSES[(PROJECT_STATUSES.indexOf(p.status) + 1) % PROJECT_STATUSES.length]!) },
    ]);
    rows.push([
      { text: t('project.btn_rename'), data: cb('p', 'e', id, 'name') },
      { text: t('project.btn_desc'), data: cb('p', 'e', id, 'description') },
    ]);
    rows.push([
      { text: t('project.btn_repo'), data: cb('p', 'e', id, 'repo_url') },
      { text: t('project.btn_docs'), data: cb('p', 'e', id, 'docs_url') },
    ]);
    if (!p.is_general) rows.push([{ text: t('project.btn_archive'), data: cb('p', 'ar', id) }]);
  } else {
    rows.push([{ text: t('project.btn_unarchive'), data: cb('p', 'ua', id), style: 'primary' }]);
  }
  rows.push([{ text: G.back, data: cb('p', 'l', p.archived_at ? '1' : '0') }]);
  return { text, keyboard: rows };
}

async function switcherView(ctx: MemberCtx): Promise<View> {
  const list = await ctx.app.projects.list(ctx.actor);
  const current = await ctx.app.projects.current(ctx.actor);
  return {
    text: `${b(t('project.switch_title'))}\n${t('menu.current', { code: current.code })}\n\n${i(t('project.switch_hint'))}`,
    keyboard: [
      ...grid(
        list.map((p) => ({
          text: `${p.id === current.id ? `${G.done} ` : ''}${p.name}`,
          data: cb('p', 'sw', enc(p.id)),
          ...(p.id === current.id ? { style: 'primary' as const } : {}),
        })),
        2,
      ),
      [menuBtn],
    ],
  };
}

async function dashboardView(ctx: MemberCtx, reg: Registry): Promise<View> {
  const parts: string[] = [];
  for (const s of reg.dashboard) {
    const out = await s.render(ctx);
    if (out) parts.push(out);
  }
  return {
    text: `${b(t('dashboard.title'))}\n${RULE}\n${parts.join('\n\n') || i(t('dashboard.empty'))}`,
    keyboard: [[{ text: t('common.refresh'), data: cb('m', 'dashboard') }, menuBtn]],
  };
}

// ---------- module ----------

export const workspaceModule: TegbarModule = {
  name: 'workspace',
  telegram({ reg }) {
    reg.command({
      name: 'start', group: 'start', description: 'cmd.start',
      handler: async (ctx) => {
        await show(ctx, { text: t('start.back', { name: ctx.member.display_name }) });
        await show(ctx, await menuView(ctx, reg), 'new');
      },
    });
    reg.command({ name: 'help', group: 'start', description: 'cmd.help', handler: async (ctx) => show(ctx, helpView(reg)) });
    reg.command({ name: 'menu', group: 'start', description: 'cmd.menu', handler: async (ctx) => show(ctx, await menuView(ctx, reg)) });
    reg.command({ name: 'dashboard', group: 'projects', description: 'cmd.dashboard', handler: async (ctx) => show(ctx, await dashboardView(ctx, reg)) });
    reg.command({ name: 'projects', group: 'projects', description: 'cmd.projects', handler: async (ctx) => show(ctx, await projectsView(ctx, false)) });
    reg.command({
      name: 'project', group: 'projects', description: 'cmd.project',
      handler: async (ctx, args) => {
        if (!args) return show(ctx, await switcherView(ctx));
        const p = await ctx.app.projects.findByCode(ctx.actor, args.split(/\s+/)[0]!);
        if (!p) throw new DomainError('project.unknown_code', { code: args });
        await ctx.app.projects.setCurrent(ctx.actor, p.id);
        await show(ctx, { text: t('project.now_current', { name: p.name, code: p.code }) });
      },
    });
    reg.command({ name: 'settings', group: 'other', description: 'cmd.settings', handler: async (ctx) => show(ctx, await settingsView(ctx, reg)) });

    reg.menuEntry({ label: 'menu.dashboard', command: 'dashboard', order: 50 });
    reg.menuEntry({ label: 'menu.projects', command: 'projects', order: 60 });
    reg.menuEntry({ label: 'menu.settings', command: 'settings', order: 80 });
    reg.menuEntry({ label: 'menu.help', command: 'help', order: 90 });

    // Menu buttons run the command with no arguments.
    reg.callback('m', async (ctx, [command], answer) => {
      if (command === 'menu') return show(ctx, await menuView(ctx, reg));
      const def = command ? reg.commands.get(command) : undefined;
      if (!def) return answer(t('common.stale'), true);
      await ctx.app.pending.clear(ctx.actor.workspaceId, ctx.actor.userId);
      await def.handler(ctx, '');
    });

    // Settings
    reg.callback('s', async (ctx, [action, arg], answer) => {
      const { app, actor } = ctx;
      if (action === 'tf') {
        // The button carries the target value, so a double tap is harmless.
        if (arg !== '12h' && arg !== '24h') return answer(t('common.stale'), true);
        await app.settings.setAs(actor, S_TIME_FORMAT, actor.userId, arg);
        await answer(t('common.saved'));
        return show(ctx, await settingsView(ctx, reg));
      }
      if (action === 'p') return show(ctx, await switcherView(ctx));
      return answer(t('common.stale'), true);
    });

    // Projects
    reg.callback('p', async (ctx, [action, a1, a2], answer) => {
      const { app, actor } = ctx;
      if (action === 'l') return show(ctx, await projectsView(ctx, a1 === '1'));
      if (action === 'n') {
        await app.pending.set(actor.workspaceId, actor.userId, 'project.new', {});
        return show(ctx, { text: t('project.new_prompt'), keyboard: [[{ text: t('common.cancel'), data: cb('p', 'l', '0') }]] }, 'new');
      }
      const id = dec(a1);
      if (!id) return answer(t('common.stale'), true);
      const p = await app.projects.get(actor, id);
      switch (action) {
        case 'o':
          return show(ctx, await projectCard(ctx, p));
        case 'sw':
        case 'c': {
          const cur = await app.projects.setCurrent(actor, id);
          await answer(t('project.now_current_short', { code: cur.code }));
          return show(ctx, action === 'sw' ? await switcherView(ctx) : await projectCard(ctx, cur));
        }
        case 'st': {
          const next = a2 as ProjectStatus;
          if (!PROJECT_STATUSES.includes(next)) return answer(t('common.stale'), true);
          return show(ctx, await projectCard(ctx, await app.projects.update(actor, id, { status: next })));
        }
        case 'e': {
          const field = a2 as 'name' | 'description' | 'repo_url' | 'docs_url';
          if (!['name', 'description', 'repo_url', 'docs_url'].includes(field)) return answer(t('common.stale'), true);
          await app.pending.set(actor.workspaceId, actor.userId, 'project.edit', { id, field });
          return show(ctx, { text: t('project.edit_prompt', { field, name: p.name }) }, 'new');
        }
        case 'ar':
          return show(ctx, {
            text: t('project.archive_confirm', { name: p.name, code: p.code }),
            keyboard: [[
              { text: t('project.btn_archive_yes'), data: cb('p', 'arx', a1!), style: 'danger' },
              { text: t('common.cancel'), data: cb('p', 'o', a1!) },
            ]],
          });
        case 'arx':
          return show(ctx, await projectCard(ctx, await app.projects.setArchived(actor, id, true)));
        case 'ua':
          return show(ctx, await projectCard(ctx, await app.projects.setArchived(actor, id, false)));
        default:
          return answer(t('common.stale'), true);
      }
    });

    reg.input('project.new', async (ctx, text) => {
      // "CODE Name — description"
      const m = /^\s*#?([A-Za-z][A-Za-z0-9_]{1,11})\s+(.+?)(?:\s+[—–-]\s+(.+))?\s*$/s.exec(text);
      if (!m) {
        await ctx.app.pending.set(ctx.actor.workspaceId, ctx.actor.userId, 'project.new', {});
        throw new DomainError('project.new_format');
      }
      const p = await ctx.app.projects.create(ctx.actor, { code: m[1]!, name: m[2]!, description: m[3] ?? null });
      await show(ctx, await projectCard(ctx, p));
    });

    reg.input('project.edit', async (ctx, text, payload: { id: number; field: string }) => {
      const value = text.trim() === '-' ? null : text.trim();
      const patch: Record<string, string | null> = {};
      if (payload.field === 'name') {
        if (!value) throw new DomainError('project.bad_name');
        patch.name = value;
      } else if (['description', 'repo_url', 'docs_url'].includes(payload.field)) patch[payload.field] = value;
      const p = await ctx.app.projects.update(ctx.actor, payload.id, patch);
      await show(ctx, await projectCard(ctx, p));
    });
  },
};

export type { App };
