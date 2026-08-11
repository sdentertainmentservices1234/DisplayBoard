# DisplayBoard — Claude Code handover

A live Supreme Court war-room display board for a chamber — overlays the
public SC board with the chamber's own tracked matters (court proximity,
route rail, approach alerts, chat), plus lightweight push notifications.

## Origin (Aug 2026)

This repo was split out of `SD-Chamber` (owner: "protect the app since it is
being distributed on large scale — the first step is to move the repo"). It
carries the **real git history** of every commit that touched board.html and
its supporting files (extracted with `git filter-repo`, 20 commits) — nothing
was squashed or rewritten as a fresh start.

**SD-Chamber still has its own copy of board.html and is left untouched** —
this is a deliberate transition-period overlap (owner's call), not a mistake.
Once DisplayBoard is verified live and correctly deployed, board.html and its
exclusive files should be removed from SD-Chamber in a separate follow-up step
so there's only one source of truth. Do not delete them from SD-Chamber
without the owner's explicit go-ahead.

**Self-contained, except the data.** The cause-list fetcher, its scheduled
Action, and the PWA icons were duplicated here (lightly rebranded — see
`fetch_causelist.py`'s docstring/User-Agent) so this repo doesn't depend on
SD-Chamber for anything to build or deploy. The one thing that is
**deliberately still shared**: the **Firestore database** (`sd-chamber-1aa78`).
board.html reads the SAME `daysheets/{date}` documents the chamber app
(index.html, in SD-Chamber) writes — that live sync between "clerk prepares
the day sheet" and "the display board shows it instantly" is the whole point
of the design, so the two apps intentionally point at the same Firebase
project. Splitting the *code* into two repos does not (and should not, unless
explicitly asked) split the *data*.

## Deployment state

- **Repo:** `DisplayBoard` under GitHub user `sdentertainmentservices1234`, public.
- **Firebase project:** `sd-chamber-1aa78` — SAME project as SD-Chamber (see
  above). Auth email/password ON, Firestore in `asia-south1`.
- **firebaseConfig is baked into board.html** (public by design; security is
  in the rules, not secrecy) — same values as SD-Chamber's index.html:
  apiKey AIzaSyAagQ_-1LLvKtmsfJwSPJvURHWB-FkO-NQ, project sd-chamber-1aa78,
  appId 1:287957629475:web:9c7804acf3060c73abcf96.
- **Not yet deployed from this repo.** Enable GitHub Pages (Settings → Pages
  → Deploy from branch `main` / root) to go live at
  `https://sdentertainmentservices1234.github.io/DisplayBoard/board.html`.
  Until then the board is still served from the SD-Chamber Pages site.
- **Cause-list Action needs a first run:** like every fresh clone of this
  fetcher, enable Actions write permission (Settings → Actions → General →
  Workflow permissions → Read and write) then run `Supreme Court cause-list
  fetch (multi-wave)` once manually (`workflow_dispatch`) to seed
  `court-updates.json`. See `CAUSELIST-SETUP.md`.

## Files

| File | Purpose |
|---|---|
| `board.html` | The display board itself — single-file PWA. |
| `board-sw.js` | Service worker (`sdboard-v15` at time of split) — network-first HTML, cache-first for the immutable libs; never caches Firestore/Auth/court-updates.json. |
| `board-manifest.json` | PWA manifest for board.html. |
| `board-dev/` | Test/dev assets: `board-test.html` (demo build, regenerate with `make-board-test.py`), `get_board_sample_2026-07-13.html` (a saved real board HTML sample the demo parses against), `parse-board.js`/`parse-seq.js` (standalone parser tests), `worker.js` (the Cloudflare Worker relay source — proxies the live SC board + handles Web Push subscribe/send, see `PUSH-SETUP.md`), `court-layout.png` (reference for the COURT_XY/RING geometry in board.html's route rail). |
| `make-board-test.py` | Rebuilds `board-dev/board-test.html` from `board.html`: `python3 make-board-test.py`. |
| `pace-collector.html` | Standalone, no-Firebase page that logs each court's real disposal pace to localStorage, for calibrating `MIN_PER_ITEM`/route-rail ETAs. Never ships to the display app itself — see its section below. |
| `PUSH-SETUP.md` | Closed-phone Web Push setup (VAPID keys + Cloudflare Worker KV binding). |
| `fetch_causelist.py` + `.github/workflows/causelist.yml` | Scheduled Action: fetches the SC's published cause lists → commits `court-updates.json` (coram/totals per date→list-type→court). See `CAUSELIST-SETUP.md`. |
| `court-updates.json` | Fetcher output, committed by the Action. A stale seed travels with the repo split; the Action overwrites it on first run. |
| `icon-192.png` / `icon-512.png` / `apple-touch-icon.png` | App icons (gold "SD" monogram) — same assets SD-Chamber uses; `make-icon.py` regenerates them (Pillow + Fraunces TTF). |
| `firestore.rules` | **Git-ignored on purpose** (matches SD-Chamber's own convention) — the real rules live in the Firebase console (shared project, see above). A local-only copy is kept on disk for reference; it is NOT committed. |

## Architecture (from board.html)

Single-file PWA, Firebase v10.12.2 ESM, top-level await. `DEMO` flag switches
between the real Firestore branch and an in-memory demo (`db.watchDoc`,
`db.set`, etc.) — same `db`/`auth` shape as SD-Chamber's index.html.

- **Board fetch:** `fetchBoard()` polls a Cloudflare Worker relay
  (`board-dev/worker.js`, deployed separately) that proxies the live SC
  display board HTML (`?ctype=c`), the published sequence marquee (`?seq`),
  and the per-court remark column (`?remarks=<token>`).
- **Proximity engine:** classify(e, boardRow, ctx) in the inline classifier —
  sequence-aware "N away", passover handling (declared sequence AND
  no-sequence end-of-board assumption), Regular-list (101+ series) handling,
  mentioning/pronouncement phases. See the "Display board" sections that
  follow for the specific rules encoded here.
- **Route rail:** a horizontal strip of court "stops" ranked by walk-aware
  ETA — `COURT_XY`/`RING` (the physical Supreme Court building's courtroom
  layout — same for every viewer, not chamber-specific) + live per-court pace
  (`posOf`/`paceVel`/`reachMinsFor`, learns each court's real speed through
  its declared sequence over the last ~15–20 min).
- **Day-scoped collaboration (`briefaccess/{aorUid}`):** an external AoR can
  request to briefly track the senior's board; approval is scoped to the ONE
  day it was sought for (`linkWindow`), enforced server-side in
  `firestore.rules`, not just the UI.
- **Full-screen approach flash + alerts + closed-phone push:** see the
  dedicated sections below (carried over verbatim from the pre-split history).

## Display board — Regular list is numbered 101+ (board.html)

Regular-list matters are numbered in the **101+ series**; a court finishes its
whole Misc list (main + supp) before starting Regular. In `classify()` for a
`listType=Regular` matter still behind Misc: `gap = miscLeft + (regRank − 1)` where
`regRank = itemNo − 100` (item 101 = the 1st Regular matter, so it's `miscLeft`
away, NOT `miscLeft + 101`). `miscLeft` = causelist Misc total (`miscTotalFor`,
main+supp) or the live sequence position. Misc runs 1…200+ and CAN reach into the
101 range, so item size alone can't tell Misc from Regular — `onRegularList()`
detects Regular two ways: current item `> miscTotal` (Misc < 101 days), OR the
item **resetting** from ≈ the end of Misc back down into the 101 series (`itemHi`
per-court high vs a big drop; Misc ≥ 101 days). The badge says **"N away"**, not
"Reg N". Reserved item series = court PHASE, not a queue position: **800s =
mentioning**, **1500s = judgement pronouncement** — classify returns "mentioning
is on" / "pronouncement is on" with NO gap.

**Passover-aware "N away":** the normal-proximity gap folds in passovers, not
just OVER items. `passoverItemsFor(court)` gathers every passed-over item
(remark column `isPassOver` + shared `config/live.po` marks + board-observed
`boardPO`), and `poAdjust(court,cur,ours,seq,passIdx)` returns a net delta:
**−1** for each item passed over ahead of us that is recalled AFTER us, **+1**
for each passed-over matter recalled BEFORE us. Recall point = the mark's own
"after N" hint, else the sequence's declared passover slot, else end-of-board.

**Sequence-order "N away":** the gap is the distance in the court's TRUE call
order (`orderPos`), not raw item numbers — the declared sequence in its given
order, THEN every other item ascending ("…then the rest of the matters").

**Our-matter passed over, NO sequence declared:** don't show a bare "recall"
badge — assume the court takes passovers at the END of the board: gap =
`(miscTotalFor(court) − currentItem) + passoversBeforeOurs(court,ours)`. Falls
back to "passed over" (never "recall") only when no causelist total is fetched.

**Cancelling "over"/PO actually clears it:** `clearDone`/`clearPO` write a
**null tombstone** for the mark instead of `delete`-ing the key — prod
Firestore deep-merges nested maps, so a deleted key would otherwise persist.

## Display-board chat — fresh every day (board.html)

Shows ONLY today's messages (`todayMsgs()` filters by `msgDay(m)===todayISO()`);
`purgeOldChat()` (once/session, best-effort) deletes messages older than
today. WhatsApp-style bubbles, consecutive same-sender grouping, IST clock
times. The messages watcher calls `paintChatList()` (rewrites only
`#chatList`) so an incoming message never wipes what someone is typing.
Keyboard-aware on phone: `fitChat()` pins the chat box to
`window.visualViewport` so the composer stays above the soft keyboard.

## Display-board full-screen approach flash (board.html)

Any of our matters **≤2 away** triggers a **persistent** full-screen overlay
(`runFlash`/`showFlash`) — stays until the screen is TOUCHED or the matter
leaves the ≤2 set (called/over/receded), no auto-dismiss timer. One panel per
reaching court (capped 6): COURT n, distance (ON NOW/NEXT/N AWAY), ON (item
now on), OURS (our item). Colour is **amber**, not red (owner: "polite but
urgent", red read as an emergency) — `flashpulse` 1.1s breathe.

**Route rail** (`#paneTop` → `.route-rail`/`renderRail()`) — the everyday,
non-modal version of the same idea: our actionable matters, soonest-to-reach
first, one stop per court, tap → `openCourtModal`.

## Display-board closed-phone push (board.html + board-dev/worker.js)

Web Push (VAPID/aes128gcm) via the Cloudflare board worker — pops on a phone
even when the app is closed, for chat + court ≤4 away. **Inert until
`VAPID_PUBLIC` is set in board.html AND the worker has the `SUBS` KV binding +
`VAPID_PUBLIC/PRIVATE/SUBJECT` secrets** — see `PUSH-SETUP.md`. iOS 16.4+
needs the app installed to the Home Screen. **Model = RELAY, not autonomous:**
needs SOME open board (bell on) to detect a crossing — a fully-closed-phone,
no-open-instance version needs the proximity engine ported into the worker
(future upgrade).

## Display-board alerts (board.html, Phase 1, no backend)

A bell toggle (`btnNotify`/`toggleNotify`, `localStorage.boardNotify`)
requests Notification permission. `runAlerts()` fires a system notification
as a matter crosses into "get ready" (soon) then "head now" (now), deduped
per court+item. A screen wake lock keeps the app polling. Reliable only while
the app is open/awake — see closed-phone push above for the rest.

## Court-pace study — separate collector (`pace-collector.html`)

Standalone, no-Firebase/no-auth page: polls the board relay every 60s and
logs `[t, seqPos, item, phase]` per court/day to `localStorage` whenever a
court moves to a new item, to learn each court's real disposal pace. Owner's
call: keep the display app itself unburdened — analysis/calibration happens
from the pasted data, and only the resulting timing constant goes into
board.html's `MIN_PER_ITEM`/pace logic. The collector never ships any UI into
the display app.

## Testing conventions

- Syntax gate after every edit: extract the module script from board.html →
  JavaScriptCore (`/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`)
  with a tiny script calling `checkModuleSyntax(readFile("_mod.mjs"))` — no
  Node on the owner's Mac.
- Behaviour: `python3 -m http.server` + browser-pane preview against
  `board-dev/board-test.html` (demo build, regenerate with
  `python3 make-board-test.py` after editing board.html).
- Test the cause-list parser OFFLINE against saved PDFs; don't hammer the
  live SC site in dev.

## Pending

1. **This is step 1 of a broader "protect the app" plan** (owner, Aug 2026) —
   moving the display board to its own repo. Owner has not yet specified the
   further steps (e.g. whether the shared Firestore data eventually needs its
   own project, whether business logic should move behind a server/Worker to
   hide it from the client bundle, etc.) — don't assume; ask before building
   toward a specific interpretation.
2. Enable GitHub Pages on this repo and verify the live board works end to
   end before removing board.html from SD-Chamber (see "Origin" above).
3. Enable Actions write permission + run the cause-list workflow once (fresh
   clone, hasn't run here yet).
4. Deploy `board-dev/worker.js` as its own Cloudflare Worker if not already
   pointed at from board.html's `BOARD_PROXY` (check the current value — it
   may still point at the original SD-Chamber-era Worker, which is fine to
   keep sharing since it's just a stateless relay/proxy, not something that
   needs its own copy).

## Working with the owner

Adith is an Advocate on Record — sophisticated, direct, allergic to
over-agreement. Flag weak reasoning proactively; expects "tested" to mean
actually tested (show the check). Legal-domain terminology must be exact
(diary no. vs case no., AoR, mentioning, pass-over, passed-over vs over).
