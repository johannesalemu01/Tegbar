# Phase 3 — demo script and sample transcript

Meetings: two weekly slots, Meet links and Join buttons, The Spot, reminders, RSVP and rescheduling, .ics, agenda, live meeting and summary.
Tip: for a quick live test, create an **extra meeting** a few minutes ahead (step 3). The 10-minute and start reminders then arrive while you watch.

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | John | `/meetings` | The next 6 meetings (💻 Weekly sync Tue 19:00, 📍 Weekly sit-down Sat 10:00 at The Spot). Hosts alternate. |
| 2 | John | ⚙ Slots → pick a slot → change day/time/length/mode/room | Future meetings follow the slot; ones you changed individually keep your change. |
| 3 | John | ＋ Extra meeting → `today 18:30 virtual Test call`, with a time about 12 minutes ahead | Sami is told "extra meeting added". About 2 minutes later, both of you get "in 10 min" with RSVP buttons, plus ⚠️ "no Meet link". |
| 4 | John | `/meeting link meet.google.com/abc-defg-hij` (any valid-looking code) | "Meet link saved"; Sami gets 🔗 with ▶ Join Meet. A Zoom link is rejected with a hint. |
| 5 | Sami | on a reminder tap **✕ Can't** → **Same time tomorrow** (tap twice) | John gets exactly one "Sami can't make it · Proposed …" with ✓ Accept / ✕ Decline. |
| 6 | John | tap **✓ Accept** (twice) | The meeting moves once and Sami gets "John accepted". The reminders move with it. |
| 7 | John | open the sit-down → ⚙ Change → 📍 Place / 👤 Host / ⏱ Length / ⏭ Skip | Only that meeting changes; Sami is notified of each change. |
| 8 | John | /meetings → 📍 Places → The Spot → 📌 Map pin → send a location | The place card shows 📌 and a venue; in-person reminders now include a map venue. |
| 9 | John | 📅 Calendar on a card | A `.ics` file. Opening it on the phone adds the meeting to Google Calendar with 60 and 10 min alerts, at the right Addis time. |
| 10 | John | mark a task blocked; give another a past due date; then `/agenda` | Both appear on the agenda. ＋ Add item adds your own. Tap a number → ✓ Discussed / ↑ / ✕ / ➜ Action item. |
| 11 | John | open the meeting → ▶ Start meeting → type `Call MMCY friday @sami` | "Action item for …?" → ✓ Save. Sami gets the assignment. |
| 12 | John | ◆ Decision → `Pilot with 20 riders`; ? Open question → `B2B pricing?` | Saved; the card counts outcomes. |
| 13 | John | ■ End & send summary (tap twice) | Both of you get one summary (decisions, action items with owner and date, open questions). The next meeting's agenda now includes "B2B pricing?". |
| 14 | John | /meetings → 🕘 History | Past meetings with held/skipped, length and RSVPs. |
| 15 | John | `/settings` → ◉ Evening before → `19:30`; ◉ Meeting reminders → turn off 10 min | All meeting reminders are re-planned. |
| 16 | either | restart the bot around a reminder | No duplicates; stale meeting reminders are skipped. |

**API smoke test (optional).** Set `API_ENABLED=on`. You need real Mini App launch data to call it; until the Mini App exists, use the signing helper in `src/core/api/initdata.ts` from a local script.

## Sample transcript

Generated with `npm run transcript:3`. The clock is moved by hand, HTML is stripped, and URL buttons are marked ↗.

**John:** /meetings

_Tegbar → John:_
```
◉ Meetings
┈┈┈┈┈┈┈┈┈┈┈┈
1  💻 Weekly sync
      Tuesday · 19:00–20:00 · John
2  📍 Weekly sit-down
      Saturday · 10:00–11:30 · Sami · The Spot
3  💻 Weekly sync
      Tue 24 Nov · 19:00–20:00 · Sami
4  📍 Weekly sit-down
      Sat 28 Nov · 10:00–11:30 · John · The Spot
5  💻 Weekly sync
      Tue 1 Dec · 19:00–20:00 · John
6  📍 Weekly sit-down
      Sat 5 Dec · 10:00–11:30 · Sami · The Spot

[1] [2] [3] [4] [5] [6]
[＋ Extra meeting] [🕘 History]
[⚙ Slots] [📍 Places] [📅 All (.ics)]
[☰ Menu]
```

**John:** taps [1]

_Tegbar → John (edits):_
```
◉ Weekly sync
Tuesday · 19:00–20:00
💻 Virtual · host John
⚠️ No Meet link yet · John adds it

RSVP  John ○  ·  Sami ○
📋 2 agenda items

[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [📅 Calendar] [⚙ Change]
[▶ Start meeting]
[‹ Back]
```

**⏱:** clock → Mon 20:00 (evening before)

_Tegbar → John:_
```
⚑ Still open · nudge 1 of 3
Renew domain
RIDEHOME · T2
🗓 Overdue · Thu 12 Nov

[✓ Done] [⏰ Snooze] [↗ Open]
```

_Tegbar → John:_
```
◉ Weekly sync · tomorrow
Tomorrow · 19:00–20:00
💻 Virtual · host John
⚠️ No Meet link yet · John adds it

Agenda
⊘ 1  blocked: SMS gateway contract · Sami
⚑ 2  overdue: Renew domain · John

[🔗 Add Meet link]
[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [↗ Open]
```

_Tegbar → Sami:_
```
◉ Weekly sync · tomorrow
Tomorrow · 19:00–20:00
💻 Virtual · host John
⚠️ No Meet link yet · John adds it

Agenda
⊘ 1  blocked: SMS gateway contract · Sami
⚑ 2  overdue: Renew domain · John

[🔗 Add Meet link]
[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [↗ Open]
```

**Sami:** taps [✕ Can’t]
_toast: RSVP saved_

_Tegbar → Sami (edits):_
```
Can’t make it. Propose another time?
Weekly sync

Your partner can accept with one tap.

[Same time tomorrow] [In 2 days]
[Pick a time…] [Skip this one]
[No proposal]
```

**Sami:** taps [Same time tomorrow]

_Tegbar → John:_
```
✕ Sami can’t make it
Weekly sync · Tomorrow · 19:00–20:00

Proposed: Wednesday, 19:00

[✓ Accept] [✕ Decline]
```

_Tegbar → Sami (edits):_
```
Proposal sent.

◉ Weekly sync
Tomorrow · 19:00–20:00
💻 Virtual · host John
⚠️ No Meet link yet · John adds it

RSVP  John ○  ·  Sami ✕
📋 2 agenda items

[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [📅 Calendar] [⚙ Change]
[▶ Start meeting]
[‹ Back]
```

**John:** taps [✓ Accept]
_toast: Accepted_

_Tegbar → Sami:_
```
✓ John accepted
Weekly sync: moved to Wednesday · 19:00–20:00

[↗ Open]
```

_Tegbar → John (edits):_
```
moved to Wednesday · 19:00–20:00

◉ Weekly sync · moved
Wednesday · 19:00–20:00
💻 Virtual · host John
⚠️ No Meet link yet · John adds it

RSVP  John ○  ·  Sami ✓
📋 2 agenda items

[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [📅 Calendar] [⚙ Change]
[▶ Start meeting]
[‹ Back]
```

**⏱:** clock → Wed 17:00 (2 h before, no link yet)

_Tegbar → John:_
```
⚑ Still open · nudge 2 of 3
Renew domain
RIDEHOME · T2
🗓 Overdue · Thu 12 Nov

[✓ Done] [⏰ Snooze] [↗ Open]
```

_Tegbar → John:_
```
⚠️ You are hosting: please add the Meet link
Weekly sync · Today · 19:00–20:00

Create a Google Meet and send me the link, so the Join button works for both of you.

[🔗 Add Meet link]
```

**John:** /meeting link meet.google.com/abc-defg-hij

_Tegbar → John:_
```
Meet link saved.

◉ Weekly sync · moved
Today · 19:00–20:00
💻 Virtual · host John
🔗 meet.google.com/abc-defg-hij

RSVP  John ○  ·  Sami ✓
📋 2 agenda items

[▶ Join Meet ↗]
[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [📅 Calendar] [⚙ Change]
[▶ Start meeting]
[‹ Back]
```

**⏱:** clock → Wed 18:00

_Tegbar → John:_
```
◉ Weekly sync · in 1 hour
Today · 19:00–20:00
💻 Virtual · host John
🔗 meet.google.com/abc-defg-hij

Agenda
⊘ 1  blocked: SMS gateway contract · Sami
⚑ 2  overdue: Renew domain · John

[▶ Join Meet ↗]
[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [↗ Open]
```

_Tegbar → Sami:_
```
◉ Weekly sync · in 1 hour
Today · 19:00–20:00
💻 Virtual · host John
🔗 meet.google.com/abc-defg-hij

Agenda
⊘ 1  blocked: SMS gateway contract · Sami
⚑ 2  overdue: Renew domain · John

[▶ Join Meet ↗]
[✓ Going] [⏱ +10] [⏱ +20] [✕ Can’t]
[📋 Agenda] [↗ Open]
```

**John:** taps [▶ Start meeting] at 19:00
_toast: Meeting started_

_Tegbar → John (edits):_
```
Meeting is live. Any task you send now becomes an action item.

◉ Weekly sync · live now
Today · 19:00–20:00
💻 Virtual · host John
🔗 meet.google.com/abc-defg-hij

RSVP  John ○  ·  Sami ✓
📋 2 agenda items

[▶ Join Meet ↗]
[📋 Agenda] [📅 Calendar] [⚙ Change]
[＋ Action item] [◆ Decision]
[? Open question] [✎ Note]
[■ End & send summary]
[‹ Back]
```

**John:** Call MMCY friday @sami

_Tegbar → John:_
```
✦ Action item for Weekly sync?
┈┈┈┈┈┈┈┈┈┈┈┈
Call MMCY
RIDEHOME
👤 Sami  ·  🗓 Friday

[✓ Save] [✕ Cancel]
[◇ RIDEHOME ›] [👤 Sami ›] [Normal ›]
[🗓 Remove date]
```

**John:** taps [✓ Save]
_toast: Added_

_Tegbar → John (edits):_
```
✓ Added as an action item of Weekly sync

Call MMCY
RIDEHOME · T3
○ To do  ·  Normal
👤 Sami
🗓 Friday

[↶ Undo] [✎ Edit] [◐ My tasks]
```

_Tegbar → Sami:_
```
John assigned this to you

Call MMCY
RIDEHOME · T3
○ To do  ·  Normal
👤 Sami
🗓 Friday

[✓ Done] [⏰ Snooze] [✎ Edit]
[👤 Reassign] [🕘 History] [🗑 Delete]
```

**John:** [◆ Decision] → Pilot with 20 riders in Bole

_Tegbar → John:_
```
What did you decide? One line.
```

_Tegbar → John:_
```
Decision recorded.

◉ Weekly sync · live now
Today · 19:00–20:00
💻 Virtual · host John
🔗 meet.google.com/abc-defg-hij

RSVP  John ○  ·  Sami ✓
📋 2 agenda items · 2 outcomes

[▶ Join Meet ↗]
[📋 Agenda] [📅 Calendar] [⚙ Change]
[＋ Action item] [◆ Decision]
[? Open question] [✎ Note]
[■ End & send summary]
[‹ Back]
```

**John:** [? Open question] → B2B pricing?

_Tegbar → John:_
```
What is still open? It will be carried to the next meeting.
```

_Tegbar → John:_
```
Open question recorded. It will be carried to the next meeting.

◉ Weekly sync · live now
Today · 19:00–20:00
💻 Virtual · host John
🔗 meet.google.com/abc-defg-hij

RSVP  John ○  ·  Sami ✓
📋 2 agenda items · 3 outcomes

[▶ Join Meet ↗]
[📋 Agenda] [📅 Calendar] [⚙ Change]
[＋ Action item] [◆ Decision]
[? Open question] [✎ Note]
[■ End & send summary]
[‹ Back]
```

**John:** taps [■ End & send summary]
_toast: Meeting ended_

_Tegbar → John (edits):_
```
📄 Summary · Weekly sync

Today · 19:00–20:00 · 1 min

RSVP  John ○  ·  Sami ✓

┈┈┈┈┈┈┈┈┈┈┈┈

Decisions
◆ Pilot with 20 riders in Bole

Action items
○ Call MMCY · Sami · Friday T3

Open questions
? B2B pricing?

Open questions were added to the next meeting (Tuesday).

[🕘 History] [☰ Menu]
```

_Tegbar → Sami:_
```
📄 Summary · Weekly sync

Today · 19:00–20:00 · 1 min

RSVP  John ○  ·  Sami ✓

┈┈┈┈┈┈┈┈┈┈┈┈

Decisions
◆ Pilot with 20 riders in Bole

Action items
○ Call MMCY · Sami · Friday T3

Open questions
? B2B pricing?

Open questions were added to the next meeting (Tuesday).

[🕘 History] [☰ Menu]
```
