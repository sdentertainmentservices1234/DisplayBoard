# SC cause-list auto-fetch — setup

A static web app can't scrape the Supreme Court site (cross-origin PDFs). So a
scheduled **GitHub Action** downloads the published SC lists, extracts each
court's **bench (coram)** per list-type, and writes `court-updates.json` next
to `index.html`. The app reads it same-origin: when Staff add a day-sheet
matter and pick the **court no + causelist type**, the app fills in the
authoritative bench "as per the causelist" and prints it on the office list.

## What Staff do (no technical steps)

Add / edit a day-sheet matter → enter court no, item no, **causelist type**
(Miscellaneous / Regular / Chamber / Single Judge / Registrar / Curative &
Review), cause title, briefing counsel. The Bench fills itself from the SC list
for that date; a "Use this bench" chip lets them accept or override it.

## Files (already in this repo)

| File | What it is |
|------|------------|
| `fetch_causelist.py` | Checks the 6 SC list types for the next ~8 weekdays (cheap 1KB probes; downloads a PDF only when the court re-published it) and extracts per-court benches + per-item case lines. |
| `.github/workflows/causelist.yml` | Runs the fetcher hourly, 08:00–23:00 IST Mon–Sat; commits `court-updates.json` only when something changed. |
| `court-updates.json` | **Generated** by the Action — the per-court benches the app reads. (A seed for 13-07-2026 is committed; the Action overwrites it.) |

## One-time GitHub setup (≈2 min, admin only)

1. **Allow the Action to commit:** repo **Settings → Actions → General →
   Workflow permissions → "Read and write permissions"** → Save.
2. **Run it once:** repo **Actions** tab → *Supreme Court cause-list fetch* →
   **Run workflow**. After ~1–3 min it commits a fresh `court-updates.json`.
3. Open the app → Day sheet: the toolbar shows **"SC benches loaded"** for any
   date the lists are out; adding a matter now auto-fills the bench.

## Notes & limits

- **Drafting aid only** — the court's published list is authoritative.
- List-type PDF codes (verified against real PDFs): Miscellaneous `M_J`,
  Regular `F_J`, Chamber `M_C`, Single Judge `M_S`, Registrar `M_R`,
  Curative & Review `M_CC` (each `_1` main, some days `_2` supplementary).
- The Action runs **hourly, 08:00–23:00 IST (Mon–Sat)** — worst-case gap
  between the court publishing a list and the app knowing about it is ~1 hour.
  Each run probes with tiny 1KB requests and only downloads lists that actually
  changed; a no-change run commits nothing, so the repo stays quiet.
- The app also re-fetches `court-updates.json` on its own when it's brought
  back to the foreground (or the Day sheet is opened) with data older than
  10 minutes — Staff never need to reload.
- Court vacation days simply have no lists.
- To pause it: repo **Actions** tab → the workflow → **⋯ → Disable workflow**.
