# Phase 4 — demo script and sample transcript

Shared costs in ETB: entries, receipts, splits, balance, settle up, two-key approvals, budgets, recurring costs, statements (CSV and PDF) and invites.

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | John | `/spend 1500 hosting #ridehome telebirr VPS` | A card with **1,500.00 ETB · Hosting & servers**, John 50% / Sami 50%. Tap **✓ Save** twice: one cost is saved. |
| 2 | Sami | take a photo of any receipt and send it with the caption `/spend 400 sms yesterday` | A card with "📎 receipt attached" → ✓ Save. Tap 🧾 View on the cost to get the photo back. |
| 3 | Sami | `/spend 300 travel only-mine cash` → Save | "only mine" adds nothing to what John owes. |
| 4 | John | open a cost → ✎ Edit → Amount → `1600` | The shares are recalculated; 🕘 History shows the change. |
| 5 | John | open a cost → ⊘ Void → `Duplicate` | Marked VOID and no longer counted; the row and its reason stay. |
| 6 | Sami | `/balance` | "Sami owes John …" overall and per project. Tap **I paid John …** (twice): John gets **one** "Sami says they paid you" with ✓ Received / ✕ Not received. |
| 7 | John | tap **✓ Received** | Sami: "John confirmed". `/balance` → all square. |
| 8 | John | `/costs` → ⚖ Split rule → Custom % → `60/40` | Sami gets 🔑 "Second key needed" with ✓ Approve. John's own tap does nothing. After Sami approves, new costs split 60/40 and old ones keep 50/50. |
| 9 | John | `/budget #ridehome 2000 monthly`, then spend until past 80% and 100% | Both of you get one 80% warning and one "budget reached". |
| 10 | John | `/recurring_costs add 1200 hosting monthly on the 5th #ridehome auto alert 7d` | Listed under 🔁 Recurring. 7 days before: "Renews in 7 days". On the 5th at 09:00 it's recorded once. Use "remind" mode to get "✓ Record it now". |
| 11 | John | `/statement 2026-11` → ⬇ CSV and ⬇ PDF | The CSV opens in Excel/Sheets with Amharic intact. The PDF shows totals, who paid what, founder tags, balance at month end, budgets and entries. It also arrives on the 1st. |
| 12 | John | `/invite Abebe viewer` | A `TGB-…` code. It works only after Sami approves in `/approvals`; the person sends it to the bot and joins as a viewer. |
| 13 | either | `/help` | Includes the "Money" note: not accounting software, and what the founder tags mean. |

## Sample statement PDF

Generated from sample data with `npx tsx test/_statement_sample.ts <dir>`. I checked by eye that Amharic notes, the balance and the budget lines render correctly.

## Sample transcript

Generated with `npm run transcript:4` (HTML stripped).

**John:** /spend 1500 hosting #ridehome telebirr VPS for November

_Tegbar → John:_
```
✦ New cost · check and save
┈┈┈┈┈┈┈┈┈┈┈┈
1,500.00 ETB · Hosting & servers
RIDEHOME · 🗓 Today
👤 paid by John · 📱 Telebirr · John 50% / Sami 50%
✎ VPS for November

[✓ Save] [✕ Cancel]
[◇ RIDEHOME ›] [▤ Hosting & ser…]
[👤 John ›] [📱 Telebirr ›]
[⚖ project rule ›] [🏷 Company expense (reimburse) ›]
[✎ Amount] [🗓 Date] [✎ Note]
```

**John:** taps [✓ Save]
_toast: Saved._

_Tegbar → John (edits):_
```
Saved

1,500.00 ETB
Hosting & servers · RIDEHOME · C1
🗓 Today · 📱 Telebirr
👤 paid by John
⚖ John 750.00 ETB · Sami 750.00 ETB (project rule)

VPS for November

[📎 Receipt]
[✎ Edit] [🕘 History] [⊘ Void]
[💰 Costs]
```

**Sami:** /spend 400 sms paid-by me yesterday

_Tegbar → Sami:_
```
✦ New cost · check and save
┈┈┈┈┈┈┈┈┈┈┈┈
400.00 ETB · SMS & maps
RIDEHOME · 🗓 Yesterday
👤 paid by Sami · 🏦 Bank · John 50% / Sami 50%

[✓ Save] [✕ Cancel]
[◇ RIDEHOME ›] [▤ SMS & maps]
[👤 Sami ›] [🏦 Bank ›]
[⚖ project rule ›] [🏷 Company expense (reimburse) ›]
[✎ Amount] [🗓 Date] [✎ Note]
```

**Sami:** taps [✓ Save]
_toast: Saved._

_Tegbar → Sami (edits):_
```
Saved

400.00 ETB
SMS & maps · RIDEHOME · C2
🗓 Yesterday · 🏦 Bank
👤 paid by Sami
⚖ John 200.00 ETB · Sami 200.00 ETB (project rule)

[📎 Receipt]
[✎ Edit] [🕘 History] [⊘ Void]
[💰 Costs]
```

**John:** /budget #ridehome 2000 monthly

_Tegbar → John:_
```
🎯 RIDEHOME budget: 95% used · 1,900.00 ETB of 2,000.00 ETB this month

Set: /budget #ridehome 20000 monthly · /budget #ridehome 150000 total · /budget #ridehome off. Warnings at 80% and 100%.

[💰 Costs]
```

_Tegbar → John:_
```
🎯 RIDEHOME: 80% of budget used
1,900.00 ETB of 2,000.00 ETB this month.

[💰 Costs]
```

_Tegbar → Sami:_
```
🎯 RIDEHOME: 80% of budget used
1,900.00 ETB of 2,000.00 ETB this month.

[💰 Costs]
```

**Sami:** /balance

_Tegbar → Sami:_
```
⚖ Balance
┈┈┈┈┈┈┈┈┈┈┈┈
Overall
   Sami owes John 550.00 ETB

RIDEHOME
   Sami owes John 550.00 ETB


Computed from every cost and confirmed settlement. Nothing is stored as a running total.

[I paid John 550.00 ETB]
[I paid John another amount…]
[💰 Costs] [☰ Menu]
```

**Sami:** taps [I paid John 550.00 ETB] (the amount shown)
_toast: Sent for confirmation_

_Tegbar → John:_
```
💸 Sami says they paid you 550.00 ETB
🏦 Bank · Today

Tegbar can’t see bank or Telebirr transfers. Confirm only if you received the money.

[✓ Received] [✕ Not received]
```

_Tegbar → Sami (edits):_
```
💸 Recorded: you paid John 550.00 ETB. John will be asked to confirm.
```

**John:** taps [✓ Received]
_toast: Confirmed_

_Tegbar → Sami:_
```
✓ John confirmed receiving 550.00 ETB.
```

_Tegbar → John (edits):_
```
✓ You confirmed receiving 550.00 ETB. The balance is updated.
```

**John:** /costs

_Tegbar → John:_
```
💰 Costs · November 2026 · All
┈┈┈┈┈┈┈┈┈┈┈┈
Total 1,900.00 ETB
▁▁▁▁▁█  Jun–Nov · ETB

▤ Hosting & servers · 1,500.00 ETB
▤ SMS & maps · 400.00 ETB

1  1,500.00 ETB · Hosting & servers
      Today · RIDEHOME · John · VPS for November
2  400.00 ETB · SMS & maps
      Yesterday · RIDEHOME · Sami

[1] [2]
[‹] [◇ All ›] [›]
[＋ Spend] [⚖ Balance] [📄 Statement]
[🎯 Budget] [⚖ Split rule]
[🔁 Recurring] [▤ Categories]
[☰ Menu]
```

**⏱:** clock → 1 Dec 09:00 (statement day)

_Tegbar → John:_
```
📄 Statement · November 2026
┈┈┈┈┈┈┈┈┈┈┈┈
Total 1,900.00 ETB · 2 entries

RIDEHOME 1,900.00 ETB

▤ Hosting & servers 1,500.00 ETB
▤ SMS & maps 400.00 ETB

👤 John · paid 1,500.00 ETB · share 950.00 ETB
👤 Sami · paid 400.00 ETB · share 950.00 ETB

⚖ At month end: All square in ETB ✓

[⬇ CSV] [⬇ PDF]
[💰 Costs]
```

_Tegbar → Sami:_
```
📄 Statement · November 2026
┈┈┈┈┈┈┈┈┈┈┈┈
Total 1,900.00 ETB · 2 entries

RIDEHOME 1,900.00 ETB

▤ Hosting & servers 1,500.00 ETB
▤ SMS & maps 400.00 ETB

👤 John · paid 1,500.00 ETB · share 950.00 ETB
👤 Sami · paid 400.00 ETB · share 950.00 ETB

⚖ At month end: All square in ETB ✓

[⬇ CSV] [⬇ PDF]
[💰 Costs]
```
