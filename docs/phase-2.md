# Phase 2 — demo script and sample transcript

Reminders, digests, focus mode, quiet hours and recurring tasks. Use both phones.
Tip: to see reminders without waiting, use due times a few minutes ahead. The scheduler checks every 30 seconds.

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | John | `/add Test reminder in 62 minutes @sami` | Sami gets "John assigned this to you". About 2 minutes later Sami gets **⏰ Due in 1 hour** with ✓ Done, ⏰ Snooze, ↗ Open. |
| 2 | Sami | tap **✓ Done** on that reminder | The message becomes the task card, marked Done. No more reminders for it. |
| 3 | John | `/add Ping MMCY in 3 minutes` | At the due time: **⏰ Due now**. If not done, one **⚑ Still open · nudge 1 of 3** an hour later, then at most 2 more (one a day). |
| 4 | John | `/remind us in 2 minutes stand up and stretch` | "Reminder set · for both of you". Two minutes later both phones get 🔔. Sami's says "from John". |
| 5 | Sami | tap **⏰ +1 hour** twice | One follow-up only (check with `/remind`). |
| 6 | Sami | `/focus 1h`, then John assigns Sami a task and creates a reminder for Sami's task due in 2 minutes | The assignment arrives (direct). The task reminder waits until focus ends. |
| 7 | Sami | `/focus dnd 1h`, then John assigns another task | Nothing arrives until DND ends, then it does. |
| 8 | Sami | `/focus off` | "Focus ended". Held nudges arrive on the next tick. |
| 9 | John | `/add Team sync every monday 9am` | The card shows **↻ Every Mon** and Monday 09:00. Tap ✓ Done: "Done · next: Mon …". `/recurring` lists it. |
| 10 | John | open any task → ✎ Edit → ↻ Repeat → **Monthly** | ↻ Monthly on the <day> |
| 11 | John | `/digest` | Today's digest now, plus ▦ Week ahead and ✓ Week in review buttons. |
| 12 | John | `/settings` → **☀ Daily** → send `07:30` | Settings shows "Daily digest: 07:30". The next digest arrives at 07:30. |
| 13 | John | `/settings` → **⏰ Before due** → tap 15 min | 15 min is added. Tapping it twice does not undo it. |
| 14 | John | `/settings` → **🌙 Quiet hours** → send `23:00-06:30` | Late reminders are held until 06:30. |
| 15 | either | `docker compose restart` around a reminder's time | It arrives once, never twice. If the bot was down more than the catch-up window, stale items are skipped (no burst of old messages). |

## Sample transcript

Generated with `npm run transcript:2` (the clock is moved by hand; HTML stripped).

**John:** /add Call MMCY today 15:00 @sami !high #sales

_Tegbar → John:_
```
✓ Added

Call MMCY
RIDEHOME · Sales · T1
○ To do  ·  🔸 High
👤 Sami
🗓 Today, 15:00

[↶ Undo] [✎ Edit] [◐ My tasks]
```

_Tegbar → Sami:_
```
John assigned this to you

Call MMCY
RIDEHOME · Sales · T1
○ To do  ·  🔸 High
👤 Sami
🗓 Today, 15:00

[✓ Done] [⏰ Snooze] [✎ Edit]
[👤 Reassign] [🕘 History] [🗑 Delete]
```

**John:** /add Team sync every monday 9am

_Tegbar → John:_
```
✓ Added

Team sync
RIDEHOME · T2
○ To do  ·  Normal
👤 John
🗓 Tomorrow, 09:00
↻ Every Mon

[↶ Undo] [✎ Edit] [◐ My tasks]
```

**John:** /remind us today 17:00 send the deck to MMCY

_Tegbar → John:_
```
🔔 Reminder set
send the deck to MMCY
Today, 17:00 · for both of you

[✕ Cancel reminder] [🔔 All reminders]
```

**Sami:** /focus 2h

_Tegbar → Sami:_
```
◎ Focus
┈┈┈┈┈┈┈┈┈┈┈┈
◎ Focus on until Today, 12:00: reminders and digests wait; direct messages still arrive.
Quiet hours: 22:00–07:00 (change in /settings)
Held messages are delivered when it ends, never dropped. Urgent notices always break through.

[◎ 1 hour] [◎ 2 hours] [◎ 4 hours]
[🌙 DND 1 hour] [🌙 DND until 08:00]
[Turn off]
[☰ Menu]
```

**⏱:** clock → 14:00 (Sami is in focus until 12:00 — already over)

_Tegbar → Sami:_
```
⏰ Due in 1 hour
Call MMCY
RIDEHOME · Sales · T1
🗓 Today, 15:00

[✓ Done] [⏰ Snooze] [↗ Open]
```

**⏱:** clock → 15:00

_Tegbar → Sami:_
```
⏰ Due now
Call MMCY
RIDEHOME · Sales · T1
🗓 Today, 15:00

[✓ Done] [⏰ Snooze] [↗ Open]
```

**⏱:** clock → 17:00

_Tegbar → Sami:_
```
⚑ Still open · nudge 1 of 3
Call MMCY
RIDEHOME · Sales · T1
🗓 Overdue · Today, 15:00

[✓ Done] [⏰ Snooze] [↗ Open]
```

_Tegbar → John:_
```
🔔 Reminder
send the deck to MMCY

[⏰ +1 hour] [⏰ Tomorrow 09:00] [✓ Got it]
```

_Tegbar → Sami:_
```
🔔 Reminder · from John
send the deck to MMCY

[⏰ +1 hour] [⏰ Tomorrow 09:00] [✓ Got it]
```

**⏱:** clock → Mon 08:00

_Tegbar → John:_
```
☀️ Good morning, John  Monday 16 Nov
┈┈┈┈┈┈┈┈┈┈┈┈
Due today · 1
○ Team sync · Today, 09:00 · RIDEHOME

👤 Sami · 1 open · 1 overdue

[◷ Today] [⚑ Overdue] [◐ My tasks]
```

_Tegbar → Sami:_
```
☀️ Good morning, Sami  Monday 16 Nov
┈┈┈┈┈┈┈┈┈┈┈┈
Overdue · 1
○ Call MMCY 🔸 · Overdue · Yesterday, 15:00 · RIDEHOME

👤 John · 1 open

[◷ Today] [⚑ Overdue] [◐ My tasks]
```

_Tegbar → John:_
```
⏰ Due in 1 hour
Team sync
RIDEHOME · T2
🗓 Today, 09:00

[✓ Done] [⏰ Snooze] [↗ Open]
```

**⏱:** clock → Mon 08:30

_Tegbar → John:_
```
▦ Week ahead  16–22 Nov
┈┈┈┈┈┈┈┈┈┈┈┈
Mine, next 7 days · 1
○ Team sync · Today, 09:00 · RIDEHOME

[◷ Today] [⚑ Overdue] [◐ My tasks]
```

_Tegbar → Sami:_
```
▦ Week ahead  16–22 Nov
┈┈┈┈┈┈┈┈┈┈┈┈
Overdue · 1
○ Call MMCY 🔸 · Overdue · Yesterday, 15:00 · RIDEHOME

[◷ Today] [⚑ Overdue] [◐ My tasks]
```

**John:** taps [✓ Done] on Team sync
_toast: ✓ Done_

_Tegbar → John (edits the card):_
```
✓ Done · next: Mon 23 Nov, 09:00

Team sync
RIDEHOME · T2
● Done  ·  Normal
👤 John
🗓 Today, 09:00
↻ Every Mon

[↺ Reopen] [🕘 History]
[🗑 Delete]
```

**John:** /settings

_Tegbar → John:_
```
Settings
┈┈┈┈┈┈┈┈┈┈┈┈
You: John (@john) · seat A
Current project: RIDEHOME
Time format: 24h
Time zone: Africa/Addis_Ababa

☀ Daily digest: 08:00
▦ Week ahead: Mon 08:30
✓ Week in review: Fri 17:00
🌙 Quiet hours: 22:00–07:00
⏰ Remind before due: 1 day, 1 hour

[◇ Current project] [◷ Use 12h]
[☀ Daily] [▦ Week ahead] [✓ Review]
[🌙 Quiet hours] [⏰ Before due]
[☰ Menu]
```
