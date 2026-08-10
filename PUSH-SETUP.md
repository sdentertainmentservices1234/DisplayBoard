# Closed-phone push notifications — setup (board.html)

Pops a notification on a phone **even when the app is closed**, for:

- **Chat** — a new chamber chat message → the other members' phones.
- **Court** — when a colleague's matter is **≤4 items away** → that colleague's phone.

Built on **Web Push (VAPID)** delivered by your existing **Cloudflare board worker**
(`board-dev/worker.js`, the `sd-board.*.workers.dev` you already run). No Firebase
upgrade, no new bill.

---

## One-time setup (≈15 min, done by Adith)

### 1. Generate the VAPID key pair
On any machine with Node (or use an online VAPID generator):
```bash
npx web-push generate-vapid-keys
```
Copy the **Public Key** and **Private Key** it prints.

### 2. Cloudflare — add a KV store to the worker
Dashboard → **Workers & Pages** → your `sd-board` worker → **Settings**:
- **Bindings → KV namespace binding**: create a namespace (name it `sd-push-subs`),
  bind it to the worker with the **Variable name `SUBS`** (exactly).
- **Variables and Secrets** → add three **Secrets**:
  - `VAPID_PUBLIC`  = the public key from step 1
  - `VAPID_PRIVATE` = the private key from step 1
  - `VAPID_SUBJECT` = `mailto:you@yourdomain` (any contact mailto/URL)

### 3. Deploy the updated worker
Paste the new `board-dev/worker.js` into the worker (Edit code → replace → **Deploy**).
It keeps the board relay exactly as before and adds `/push-subscribe`,
`/push-unsubscribe`, `/push-send`.

### 4. Put the PUBLIC key in the app
In `board.html`, set:
```js
const VAPID_PUBLIC = "PASTE_THE_PUBLIC_KEY_HERE";
```
Commit / GitHub-pencil-edit → Pages redeploys. (Leave it `""` to keep push off.)

### 5. Each colleague, once, on their phone
- **Install the app to the Home Screen** (iPhone Safari → Share → *Add to Home
  Screen*; Android Chrome → *Install app*). **On iPhone this is mandatory** — iOS
  16.4+ only allows push from an installed web app, never a Safari tab.
- Open the installed app → tap the **🔔 bell** → **Allow** notifications.

Test: from one phone send a chat message → the other installed phones should pop it.

---

## How it works / limits (read this)

- The bell subscribes the device and registers it with the worker (`/push-subscribe`,
  keyed by uid in KV). The service worker's `push` handler shows the notification even
  when the app is closed.
- **Chat** push fires from the **sender's** device (it's open when they type) →
  worker → every other subscribed member. Reliable.
- **Court (≤4 away)** push fires from **any open board instance** that has alerts on:
  its live proximity engine detects the crossing and asks the worker to push the
  matter's assigned colleague(s). The worker **de-dupes** (per court+item+level+day)
  so many open phones = one push.
  - ⚠️ **This means at least one board must be open (bell on) for court pushes** — in
    practice, keep the **war-room display open during court hours** (it becomes the
    trigger for everyone). If every phone is closed and no display is up, no court
    push goes out. (A fully autonomous version — the worker polling the board on a
    cron with no open instance needed — is a later upgrade; it requires porting the
    proximity engine into the worker.)
- iOS may batch/delay pushes when the phone is idle; not second-perfect.
- Turning the bell **off** unsubscribes that device.

## Files
- `board.html` — `VAPID_PUBLIC`, `syncPushSub()/dropPushSub()/relayPush()`, hooks in
  the bell, `sendChat`, and `fireCourtAlert`.
- `board-sw.js` — `push` event handler (`sdboard-v15`).
- `board-dev/worker.js` — `/push-*` endpoints + Web Push (aes128gcm + VAPID) crypto.
