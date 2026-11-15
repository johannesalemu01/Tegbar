# Phase 6 · Friday brief, workload view, wins — demo script

Turn each on in `/features`: **brief**, **workload**, **wins** (owners only; all off by default).

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | John | `/brief` while it is off | "optional feature … turn on brief in /features". |
| 2 | John | `/features` → Turn on brief, wins, workload | Each turns on once (double taps don't toggle back). |
| 3 | either | `/brief` | The brief below, built from your real data. |
| 4 | — | Friday at your "Week in review" time (/settings) | You get the brief instead of "Week in review": one message, not two. |
| 5 | Sami | `/win First paying rider in Bole #ridehome` | John: "🏆 Sami logged a win". It appears in `/wins` and the next brief. |
| 6 | John | start and end a meeting (/meetings → ▶ Start → ■ End) | `/wins` shows "Meeting streak: 1 week in a row". A planned meeting that never happened breaks it; one skipped on purpose doesn't. |
| 7 | John | `/workload` | Per person: open, overdue and done-per-week bars, plus open tasks per project. A 💡 hint with Reassign buttons appears only when one person has 5+ open tasks, at least twice the other's, and some sit in areas the other person owns. |
| 8 | John | `/features` → Turn off brief | Fridays go back to the normal "Week in review". |

## Sample brief (`npx tsx test/_brief_sample.ts`)

```
🗞 Founder brief  16–20 Nov
┈┈┈┈┈┈┈┈┈┈┈┈
✓ Done this week · 3 John 2 · Sami 1
   ● Set up backups
   ● Sign MMCY pilot
   ● Ship OTP fix

⚠ Stuck · 2
   ⚑ Renew domain · John
   ⊘ SMS gateway contract · Sami

◉ Next 7 days
   📍 Weekly sit-down · Tomorrow 10:00 · host Sami
   💻 Weekly sync · Tuesday 19:00 · host Sami
   1 task due

💰 Money
   This week 16,500.00 ETB · month so far 16,500.00 ETB
   🎯 RIDEHOME 82% · 16,500.00 ETB of 20,000.00 ETB
   ⚖ Sami owes John 8,250.00 ETB

🏆 Wins · 1
   🏆 First paying rider in Bole
   🔥 Meeting streak: 1 week in a row

➜ Three priorities
   1. Renew domain — overdue 6 days · John
   2. Unblock: SMS gateway contract — blocked · Sami
   3. Investor update — high priority, due in 3 days · Sami

Suggestions come from simple rules (overdue, blocked, due soon, pending decisions, budgets, approvals), not AI.
```
