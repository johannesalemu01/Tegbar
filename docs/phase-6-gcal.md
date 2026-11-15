# Phase 6 · Google Calendar + automatic Meet links — demo script

Prerequisites: README §10 (Google Cloud project, **published** consent screen, web OAuth client with redirect `https://<PUBLIC_URL>/oauth/google/callback`, `.env` set).

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | John | `/google` | Status: "Not set up" if .env is missing, else "No Google account connected yet" with 🔗 Connect. |
| 2 | John | 🔗 Connect → Open Google sign-in → choose the account → allow | The browser says "✓ Google Calendar connected as …". Telegram: "📅 Google Calendar connected". Using the same link again fails ("expired or already used"). |
| 3 | John | `/features` → Turn on gcal | All upcoming meetings appear in that Google Calendar (Africa/Addis_Ababa time, 10-min popup). |
| 4 | Sami | `/google email sami@…` | Sami gets Google invites; the meetings show in Sami's own calendar. |
| 5 | — | Wait ~20 s | Virtual meetings without a link now have a Meet link: the Tegbar card shows 🔗 meet.google.com/… and ▶ Join opens it. |
| 6 | John | move a meeting (/meetings → ⚙ Change → Move) | The Google event moves; attendees get Google's update email. |
| 7 | John | skip a meeting | The Google event is cancelled. |
| 8 | John | type a link yourself (`/meeting link meet.google.com/…`) on another meeting | No extra Meet link is generated for it; the typed link stays. |
| 9 | John | revoke Tegbar in your Google account settings, then change a meeting | John gets one "Google Calendar stopped syncing — Reconnect". Syncing pauses until reconnected. |
| 10 | John | `/google` → Disconnect | Access is revoked at Google; existing events stay in the calendar. |
