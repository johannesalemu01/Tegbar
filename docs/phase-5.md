# Phase 5 — demo script and sample transcript

Notices, /tell, areas with the two-key rule, the decision log, notes, search, export, purge and encrypted backups.

**Before you start:** add `BACKUP_PASSPHRASE=<openssl rand -base64 32>` to `.env`, save the passphrase in your password manager, and restart.

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | Sami | `/focus dnd 2h` | Do-not-disturb is on. |
| 2 | John | `/notice !urgent SMS gateway is down` → 📣 Post (tap twice) | Sami gets **one** 🔴 URGENT despite DND. Without ✓ Acknowledged it repeats every 30 min, at most 6 more times. |
| 3 | Sami | ✓ Acknowledged | John: "Sami acknowledged". No more repeats. `/notices` shows "Seen: Sami ✓". |
| 4 | John | `/notice New logo files in Drive` (info) while Sami is in Focus | Arrives after Focus ends. |
| 5 | John | `/tell can you call MMCY before 3?` | Sami gets 💬 with ↩ Reply. Her reply comes back to John, quoting his message. |
| 6 | John | `/areas` → Sales → "Owner: John" | 🔑 Sami gets an approval card. The owner changes only after Sami taps ✓ Approve. "Backup: …" changes immediately. |
| 7 | John | `/decide Launch in Bole first — highest demand` | Proposed. Sami gets "John proposes a decision" with ✓ Agree, and after she agrees both see "Decision agreed". |
| 8 | John | `/decisions` → open it → ✎ Edit → new text | 🔑 It waits for Sami's approval, because the decision is agreed. |
| 9 | either | During a live meeting: ◆ Decision → `Pilot with 20 riders` | It appears in `/decisions` as agreed, linked to the meeting. |
| 10 | Sami | `/note Rider survey #ridehome #research https://…` then `/notes #research` | Saved with tag and link; listed under the tag. |
| 11 | John | `/search bole` (or an Amharic word) | Hits from tasks, notes, decisions, notices and meeting outcomes, each one tap to open. |
| 12 | John | `/export` → tasks.csv, then ⬇ Everything (JSON) | Files arrive; the CSV opens in Excel/Sheets with Amharic intact. |
| 13 | John | delete a task, then `/purge` → Purge deleted tasks → Yes | It's gone for good; History is redacted. Voided costs ask Sami for approval first. |
| 14 | John | `/backup` → 🔐 Back up now | An encrypted `.tgbk` file arrives. At 02:30 one arrives automatically. |
| 15 | John | on the server: `docker compose exec tegbar node dist/cli.js verify /data/backups/<file>.tgbk` | "OK: created …". With a wrong passphrase: "wrong passphrase or the file was modified". |
| 16 | John | restore drill on a spare machine (README section 5) | The data comes back, and the previous data is kept in `data/pre-restore-…`. |

## Sample transcript

Generated with `npm run transcript:5` (HTML stripped).

**John:** /notice !urgent SMS gateway is down — riders get no OTP

_Tegbar → John:_
```
🔴 New notice · URGENT
┈┈┈┈┈┈┈┈┈┈┈┈
SMS gateway is down — riders get no OTP

RIDEHOME
Urgent notices break through quiet hours and DND, and repeat every 30 min (max 6×) until acknowledged.

[📣 Post] [✕ Cancel]
[ⓘ Info ›]
```

**John:** taps [📣 Post]
_toast: Posted_

_Tegbar → John (edits):_
```
🔴 URGENT · from John
SMS gateway is down — riders get no OTP
RIDEHOME · 15 Nov 10:00
Seen: Sami ○

[🗄 Archive]
[‹ Back]
```

_Tegbar → Sami:_
```
🔴 URGENT · from John

SMS gateway is down — riders get no OTP

RIDEHOME · NT1

[✓ Acknowledged]
```

**Sami:** taps [✓ Acknowledged]
_toast: Acknowledged_

_Tegbar → John:_
```
✓ Sami acknowledged: SMS gateway is down — riders get no OTP
```

_Tegbar → Sami (edits):_
```
🔴 URGENT · from John

SMS gateway is down — riders get no OTP

RIDEHOME · NT1
```

**John:** /tell can you call MMCY before 3?

_Tegbar → John:_
```
💬 Sent to Sami.
```

_Tegbar → Sami:_
```
💬 John
can you call MMCY before 3?

[↩ Reply]
```

**Sami:** taps [↩ Reply] → yes, calling at 2

_Tegbar → Sami:_
```
Send your reply.
```

_Tegbar → Sami:_
```
💬 Sent to John.
```

_Tegbar → John:_
```
💬 Sami
can you call MMCY before 3?
yes, calling at 2

[↩ Reply]
```

**John:** /decide Launch in Bole first — highest demand in our survey

_Tegbar → John:_
```
◇ Launch in Bole first
highest demand in our survey
Proposed · RIDEHOME · D1
Agreed by: John

[✎ Edit] [⤴ Supersede] [🗑 Delete]
[‹ Back]
```

_Tegbar → Sami:_
```
◇ John proposes a decision

◇ Launch in Bole first
highest demand in our survey
Proposed · RIDEHOME · D1
Agreed by: John

[✓ Agree]
[✎ Edit] [⤴ Supersede] [🗑 Delete]
[‹ Back]
```

**Sami:** taps [✓ Agree]
_toast: Agreed_

_Tegbar → John:_
```
◆ Decision agreed

◆ Launch in Bole first
highest demand in our survey
Agreed · Today · RIDEHOME · D1
Agreed by: John, Sami

[✎ Edit] [⤴ Supersede] [🗑 Delete]
[‹ Back]
```

_Tegbar → Sami (edits):_
```
◆ Launch in Bole first
highest demand in our survey
Agreed · Today · RIDEHOME · D1
Agreed by: John, Sami

[✎ Edit] [⤴ Supersede] [🗑 Delete]
[‹ Back]
```

**Sami:** /note Rider survey results #ridehome #research https://…

_Tegbar → Sami:_
```
Saved

✎ Rider survey results
🔗 docs.example.com/survey
RIDEHOME · #research · N1 · 15 Nov 10:00

[✎ Edit] [🗑 Delete]
[‹ Back]
```

**John:** /search bole

_Tegbar → John:_
```
🔎 Search: bole
┈┈┈┈┈┈┈┈┈┈┈┈
1  ◆ Launch in Bole first
      decision · RIDEHOME · agreed

[1]
[☰ Menu]
```
