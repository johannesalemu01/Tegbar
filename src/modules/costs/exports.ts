import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { decimalString, formatMoney, formatRate } from './money.js';
import type { StatementData } from './service.js';

// ---------- CSV ----------

/** RFC 4180 field quoting. Cells starting with = + - @ are prefixed with ' (spreadsheet formula injection). */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null)[][]): string {
  // UTF-8 BOM so Excel shows Amharic correctly.
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function statementCsv(s: StatementData, names: Map<number, string>): string {
  const rows: (string | number | null)[][] = [[
    'type', 'id', 'date', 'project', 'category', 'note', 'amount', 'currency', 'paid_by', 'method', 'founder_tag', 'split', 'status', 'void_reason', 'receipts',
  ]];
  // Every entry of the month, voided ones included (with their reason).
  for (const c of s.entries) {
    rows.push([
      'cost', `C${c.id}`, c.spent_on, c.project_code, c.category_name, c.note, decimalString(c.amount_minor, c.currency), c.currency, c.payer_name,
      c.method, c.founder_tag, c.splits.map((x) => `${x.name}:${decimalString(x.amount, c.currency)}`).join('; '), c.status, c.void_reason, c.receipt_count,
    ]);
  }
  for (const st of s.settlements) {
    rows.push([
      'settlement', `S${st.id}`, st.paid_on, '', '', st.note, decimalString(st.amount_minor, st.currency), st.currency,
      names.get(st.from_user_id) ?? '?', st.method, '', `to ${names.get(st.to_user_id) ?? '?'}`, st.status, '', '',
    ]);
  }
  return toCsv(rows);
}

// ---------- PDF ----------

const require = createRequire(import.meta.url);
const FONT_DIR = join(dirname(require.resolve('@fontsource/noto-sans-ethiopic/package.json')), 'files');
const ETHIOPIC = /[ሀ-᎟ⶀ-⷟꬀-꬯]/;
const RUNS = /[ሀ-᎟ⶀ-⷟꬀-꬯]+|[^ሀ-᎟ⶀ-⷟꬀-꬯]+/g;

/**
 * Monthly statement as PDF. Noto Sans Ethiopic (OFL) is embedded and text is
 * split into script runs, so Amharic and English render side by side.
 */
export function statementPdf(s: StatementData, names: Map<number, string>, opts: { workspace: string; generatedAt: string; monthLabel: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Tegbar statement ${s.month}`, Author: opts.workspace } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('eth', join(FONT_DIR, 'noto-sans-ethiopic-ethiopic-400-normal.woff'));
    doc.registerFont('lat', join(FONT_DIR, 'noto-sans-ethiopic-latin-400-normal.woff'));
    doc.registerFont('latb', join(FONT_DIR, 'noto-sans-ethiopic-latin-700-normal.woff'));

    const write = (text: string, size = 10, bold = false, color = '#1f2328') => {
      const runs = text.match(RUNS) ?? [''];
      doc.fillColor(color);
      runs.forEach((r, i) => doc.font(ETHIOPIC.test(r) ? 'eth' : bold ? 'latb' : 'lat').fontSize(size).text(r, { continued: i < runs.length - 1 }));
    };
    const gap = (n = 0.5) => doc.moveDown(n);
    const heading = (t: string) => {
      gap(0.8);
      write(t, 12, true, '#0b5394');
      doc.moveTo(48, doc.y + 2).lineTo(547, doc.y + 2).strokeColor('#d0d7de').lineWidth(0.5).stroke();
      gap(0.4);
    };

    write('Tegbar · ተግባር', 9, false, '#57606a');
    write(`Monthly statement — ${opts.monthLabel}`, 18, true);
    write(`${opts.workspace} · generated ${opts.generatedAt} (Africa/Addis_Ababa)`, 9, false, '#57606a');

    heading('Totals by project');
    for (const p of s.byProject) write(`${p.code}    ${formatMoney(p.amount, p.currency)}`);
    if (!s.byProject.length) write('No costs this month.', 10, false, '#57606a');

    heading('By category');
    for (const c of s.byCategory) write(`${c.name}    ${formatMoney(c.amount, c.currency)}`);

    heading('Who paid what');
    for (const p of s.perPerson) write(`${p.name}: paid ${formatMoney(p.paid, p.currency)} · share ${formatMoney(p.share, p.currency)} · net ${formatMoney(p.paid - p.share, p.currency)}`);

    if (s.byTag.length) {
      heading('Founder money (tags only, not accounting advice)');
      const label = { expense: 'Company expense paid personally', capital: 'Capital contribution', loan: 'Loan to the company' } as const;
      for (const t of s.byTag) write(`${t.name}: ${label[t.tag]} — ${formatMoney(t.amount, t.currency)}`);
    }

    if (s.settlements.length) {
      heading('Settlements (confirmed)');
      for (const st of s.settlements) write(`${st.paid_on}  S${st.id}  ${names.get(st.from_user_id) ?? '?'} paid ${names.get(st.to_user_id) ?? '?'}  ${formatMoney(st.amount_minor, st.currency)}`);
    }

    heading('Balance at month end');
    if (!s.balanceAtEnd.some((b) => b.transfers.length)) write('All square.');
    for (const b of s.balanceAtEnd) for (const tr of b.transfers) write(`${names.get(tr.from) ?? '?'} owes ${names.get(tr.to) ?? '?'}: ${formatMoney(tr.amount, b.currency)}`);

    if (s.converted) {
      heading(`Converted total (${s.converted.reporting})`);
      write(formatMoney(s.converted.total, s.converted.reporting), 11, true);
      for (const r of s.converted.rates) write(`Rate used: 1 ${r.currency} = ${formatRate(r.rateMicro)} ${s.converted.reporting} (${r.source === 'entry' ? 'entered on the entry' : 'entered for the month'})`, 9, false, '#57606a');
      if (s.converted.missing.length) write(`No rate entered for: ${s.converted.missing.join(', ')} — not included.`, 9, false, '#9a6700');
    }

    if (s.budgets.length) {
      heading('Budgets');
      for (const b of s.budgets) write(`${b.code} (${b.period}): ${formatMoney(b.spent, b.currency)} of ${formatMoney(b.budget, b.currency)}`);
    }

    heading('Entries');
    for (const c of s.costs) {
      write(`${c.spent_on}  C${c.id}  ${formatMoney(c.amount_minor, c.currency)}  ${c.project_code} · ${c.category_name} · paid by ${c.payer_name} (${c.method})${c.note ? ` — ${c.note}` : ''}`, 9);
    }
    if (s.voidedCount) write(`${s.voidedCount} voided entr${s.voidedCount === 1 ? 'y' : 'ies'} not counted (see CSV).`, 9, false, '#57606a');

    gap(1.2);
    write('Tegbar records what you enter; it is not accounting software. Ask an accountant how to treat each item.', 8, false, '#57606a');
    doc.end();
  });
}
