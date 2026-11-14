# Phase 1 — demo script and sample transcript

## Demo script (about 10 minutes, two phones)

**Setup.** Set `BOT_TOKEN`, `SETUP_CODE`, `PERSON_A_NAME=John` and `PERSON_B_NAME=Sami` in `.env`, then run `npm run dev` (or `docker compose up -d --build`).

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | a third phone (optional) | send `hello`, then `/start` | **No reply at all.** |
| 2 | John | send the setup code | The code message disappears. Welcome "co-founder A". |
| 3 | Sami | send `/start <code>` | Welcome "co-founder B". John gets "Sami just joined". |
| 4 | the third phone | send the setup code | Still no reply. Registration is closed. |
| 5 | John | type `/` | The command list shows (it is set only for your two chats). |
| 6 | John | `/menu` | Menu with ＋ Add task highlighted. Current project `RIDEHOME`. |
| 7 | John | `/add Call MMCY tomorrow 10am @sami !high #sales` | Saved at once: "Added" card. **Sami** gets "John assigned this to you". |
| 8 | John | `Draft pitch deck in december @bob` (plain text) | A "Save as a task?" card with two ⚠️ notes. Tap **👤 John ›** to cycle the owner, then **✓ Save**. Tap Save again: toast "Already handled", no duplicate. |
| 9 | Sami | `/my` → tap **1** → **✓ Done**, then **✓ Done** again | The card turns "Done"; the second tap says "Already done". |
| 10 | Sami | **↺ Reopen** → **⏰ Snooze** → **Tomorrow** | The due date moves to tomorrow with the same time. |
| 11 | Sami | **✎ Edit** → **Due** → send `friday 5pm` | The card shows Friday, 17:00 (Addis time). |
| 12 | Sami | **🕘 History** | Every change, who made it and when (Addis time). |
| 13 | John | `/ours` → tap the filter buttons **👤 Everyone**, **◇ RIDEHOME**, **Open** | Each tap cycles the filter, and the list edits in place. |
| 14 | John | open a task → **🗑 Delete** → **Yes, delete** → then `/undo` | The task is restored. |
| 15 | John | `/projects` → **＋ New project** → `FLEET Fleet Ops — B2B pilot` | New project card with default areas and owners. |
| 16 | John | `/add Call partner #fleet` then `/project #general` | The task lands in FLEET; the current project is now GENERAL. |
| 17 | John | `/dashboard` | Counts per project and per person. |
| 18 | either | restart the bot (`docker compose restart`), then tap an old button | It still works, or says it is out of date. Nothing is duplicated. |
| 19 | John | `/settings` → **◷ Use 12h** | Times now show like `10:00 AM`. |

## Sample transcript

Generated with `npm run transcript`. These are the real bot messages; HTML tags are stripped and buttons are shown in brackets.
The clock is Sunday 15 Nov 2026, 10:00 Addis Ababa.

**John:** (sends the setup code)

_Tegbar → John:_
```
✦ Welcome to Tegbar, John.
You are co-founder A. Waiting for your co-founder to send the setup code.

I deleted your setup-code message. Open /menu to start, or just send me a task like:
Call MMCY tomorrow 10am !high
```

**Sami:** (sends the setup code)

_Tegbar → Sami:_
```
✦ Welcome to Tegbar, Sami.
You are co-founder B. Both founders are now paired and registration is closed for good.

I deleted your setup-code message. Open /menu to start, or just send me a task like:
Call MMCY tomorrow 10am !high
```

_Tegbar → John:_
```
✦ Sami just joined Tegbar. Registration is now closed.
```

**John:** /add Call MMCY tomorrow 10am @sami !high #ridehome #sales

_Tegbar → John:_
```
✓ Added

Call MMCY
RIDEHOME · Sales · T1
○ To do  ·  🔸 High
👤 Sami
🗓 Tomorrow, 10:00

[↶ Undo] [✎ Edit] [◐ My tasks]
```

_Tegbar → Sami:_
```
John assigned this to you

Call MMCY
RIDEHOME · Sales · T1
○ To do  ·  🔸 High
👤 Sami
🗓 Tomorrow, 10:00

[✓ Done] [⏰ Snooze] [✎ Edit]
[👤 Reassign] [🕘 History] [🗑 Delete]
```

**John:** Renew domain 2026-11-20 #engineering

_Tegbar → John:_
```
✦ Save as a task?
┈┈┈┈┈┈┈┈┈┈┈┈
Renew domain
RIDEHOME · Engineering
👤 John  ·  🗓 Friday

[✓ Save] [✕ Cancel]
[◇ RIDEHOME ›] [👤 John ›] [Normal ›]
[🗓 Remove date]
```

**John:** Draft pitch deck in december @bob

_Tegbar → John:_
```
✦ Save as a task?
┈┈┈┈┈┈┈┈┈┈┈┈
Draft pitch deck
RIDEHOME
👤 John  ·  🗓 Tue 1 Dec

⚠️ I don't know @bob, so it's assigned to you.
⚠️ “december” is vague. Check the date.

[✓ Save] [✕ Cancel]
[◇ RIDEHOME ›] [👤 John ›] [Normal ›]
[🗓 Remove date]
```

**John:** taps [✓ Save]
_toast: Added_

_Tegbar → John (edits the card):_
```
✓ Added

Draft pitch deck
RIDEHOME · T2
○ To do  ·  Normal
👤 John
🗓 Tue 1 Dec

[↶ Undo] [✎ Edit] [◐ My tasks]
```

**Sami:** /my

_Tegbar → Sami:_
```
My tasks · 1 open
┈┈┈┈┈┈┈┈┈┈┈┈
○ 1  Call MMCY 🔸
      RIDEHOME · Sales · Tomorrow, 10:00

[1]
[👤 Me] [◇ All] [Open]
[＋ Add] [☰ Menu]
```

**Sami:** taps [1]

_Tegbar → Sami (edits the card):_
```
Call MMCY
RIDEHOME · Sales · T1
○ To do  ·  🔸 High
👤 Sami
🗓 Tomorrow, 10:00

[✓ Done] [⏰ Snooze] [✎ Edit]
[👤 Reassign] [🕘 History] [🗑 Delete]
[‹ Back]
```

**Sami:** taps [✓ Done]
_toast: ✓ Done_

_Tegbar → Sami (edits the card):_
```
✓ Done

Call MMCY
RIDEHOME · Sales · T1
● Done  ·  🔸 High
👤 Sami
🗓 Tomorrow, 10:00

[↺ Reopen] [🕘 History]
[🗑 Delete]
[‹ Back]
```

**Sami:** taps [✓ Done] again
_toast: Already done_

_Tegbar → Sami (edits the card):_
```
Call MMCY
RIDEHOME · Sales · T1
● Done  ·  🔸 High
👤 Sami
🗓 Tomorrow, 10:00

[↺ Reopen] [🕘 History]
[🗑 Delete]
[‹ Back]
```

**John:** /dashboard

_Tegbar → John:_
```
Dashboard
┈┈┈┈┈┈┈┈┈┈┈┈
Tasks by project
◇ RideHome
      1 open · 1 done this week
◇ General · quiet

By person
👤 John · 1 open
👤 Sami · 0 open

[↻ Refresh] [☰ Menu]
```
