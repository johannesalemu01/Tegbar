# Phase 6 · Mini App dashboard — demo script

| # | Who | Do | Expect |
|---|---|---|---|
| 0 | John (laptop) | `npm run preview` → open http://localhost:5173/app/?demo=1 | The design with fake data, in light or dark (follows your OS). |
| 1 | John (server) | Set up HTTPS (README §9), set `API_ENABLED=on` + `PUBLIC_URL=https://…`, restart | `curl https://…/app/` returns the page; `/healthz` is OK. |
| 2 | John | `/features` | "miniapp" is off. A warning appears if PUBLIC_URL / API_ENABLED is missing. |
| 3 | John | **Turn on miniapp** (tap twice) | It turns on once. A **Dashboard** button appears next to the message field for both of you, and `/menu` shows **🖥 Open dashboard** first. |
| 4 | Sami | tap **Dashboard** | Home: "Good …, Sami", counts, the next meeting with ▶ Join, any notices and approvals. Telegram's theme is used. |
| 5 | Sami | Board → type `Call MMCY friday 10am @john !high` → Add | The card appears. John gets "Sami assigned this to you" in the chat. |
| 6 | Sami | tap a card → **Doing**, then **✓ Mark done** | It moves columns. The task history in the chat shows the changes. |
| 7 | John | Calendar → **+10** on the next meeting | Sami gets "John is running about 10 min late". |
| 8 | John | Costs → ‹ › months | The trend bars and categories change; the balance matches `/balance`. |
| 9 | John | Home → **✓ Approve** on a pending request | The same as approving in the chat (one second key). |
| 10 | John | `/features` → **Turn off miniapp** | The Dashboard button goes back to the command menu for both of you. |

Screenshots: `docs/img/miniapp-*.png` (from `?demo=1`).
