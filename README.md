# DisplayBoard

A live Supreme Court war-room display board — overlays the public SC board
with a chamber's own tracked matters: court proximity ("2 away"), a route
rail showing which court to reach next, full-screen approach alerts, and
in-app chat for the team to coordinate.

- **`board.html`** — the app.
- **`board-dev/`** — dev/test assets and the Cloudflare Worker relay source.
- **`pace-collector.html`** — standalone tool for calibrating each court's real pace; never ships to the display app.

Split out of `SD-Chamber` with full git history — see `CLAUDE.md` for the
full handover (architecture, deployment state, and why the Firestore data is
still deliberately shared with SD-Chamber even though the code now lives
separately).

## Setup
1. Firebase project + Firestore rules — see `CLAUDE.md` (currently shares
   SD-Chamber's project, by design: the board reads that project's live day
   sheets).
2. Enable GitHub Pages (Settings → Pages → branch `main` / root).
3. Enable Actions write permission, then run "Supreme Court cause-list fetch
   (multi-wave)" once to seed `court-updates.json` — see `CAUSELIST-SETUP.md`.
4. Closed-phone push (optional) — see `PUSH-SETUP.md`.

Local dev: `python3 -m http.server` and open `board-dev/board-test.html`
(demo build; regenerate with `python3 make-board-test.py` after editing
`board.html`).
