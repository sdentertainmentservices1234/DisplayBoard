// SD-Chamber — SC display-board relay (Cloudflare Worker)
// Fetches the Supreme Court live display board server-side (browsers can't:
// the gov site sends no CORS headers) and returns it to our app with CORS on.
// A short edge cache means 100 chamber devices polling = ~2 fetches/min at source.
//
//   ?ctype=c            -> the live court-wise board (regular).  ctype=v = video.
//   ?remarks=<token>    -> a court's FULL cause list, PARSED to a small
//                          { court, items:{ "5":"OVER", "7":"PASS OVER" } } JSON.
//                          The <token> is the display_court_all_cases.php query
//                          string taken from a court's row on the main board. The
//                          page itself is ~0.5 MB; parsing it here keeps the phone
//                          download to ~1 KB.
//
// Deploy: dash.cloudflare.com → Workers & Pages → Create → paste this → Deploy.
// Then use the *.workers.dev URL in board.html (BOARD_PROXY).

const HOST = "https://wdb.sci.gov.in";
const SRC  = HOST + "/get_board.php";                    // ?ctype=c (regular) | v (video)
const SEQ_SRC = HOST + "/display_original.php";          // the OLD board page; its <marquee> carries
                                                         // the day's court-wise SEQUENCE line (from ~9:30am)
const EDGE_TTL  = 6;                                     // board: 6s (see note below)
const RMK_TTL   = 25;                                    // remarks change slowly; cache longer
const SEQ_TTL   = 45;                                    // the sequence line changes slowly; cache longer

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Parse a court's full-cause-list page down to { item -> remark }. Each matter is
// a <tr class="record"> whose LAST cell is the remark column; the bench writes
// OVER / PASS OVER (in bold) there, or leaves it blank. Only non-blank remarks are
// returned. Advocate/heading cells are excluded so a "P:"/"R:" never leaks in.
function parseRemarks(html) {
  const strip = s => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const items = {};
  const rows = html.split(/<tr class="record"/i).slice(1);
  for (let raw of rows) {
    raw = raw.split(/<\/tr>/i)[0];
    const tds = [...raw.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (tds.length < 3) continue;
    const item = strip(tds[0]);
    if (!/^\d/.test(item)) continue;                     // first cell must be the item number
    const last = tds[tds.length - 1];                    // remark column
    const bold = last.match(/<b>([\s\S]*?)<\/b>/i);
    let rem = strip(bold ? bold[1] : last);
    if (!rem) continue;                                  // blank remark (the common case) — skip
    if (/\bVs\b|P:|R:/i.test(rem)) continue;             // safety: not a remark cell
    const up = rem.toUpperCase();
    let norm;
    if (/PASS\s*OVER/.test(up))      norm = "PASS OVER";
    else if (/^OVER$/.test(up))      norm = "OVER";
    else if (/PART\s*HEARD/.test(up))norm = "PART HEARD";
    else if (/DISPOSED/.test(up))    norm = "DISPOSED";
    else if (rem.length <= 24)       norm = rem;         // keep any other short remark verbatim
    else continue;
    items[item] = norm;
  }
  const cm = html.match(/Court\s+(\d+)\s*:/i);
  return { court: cm ? cm[1] : null, items };
}

// The OLD display board publishes a court-wise SEQUENCE line in a scrolling
// <marquee> (inside <div id="marquee">…</div>), from ~9:30am — BEFORE the courts
// actually start calling matters. Pull that text out verbatim; the app parses it
// into per-court order so the route can be planned the moment it's up. Returns ""
// when the marquee is empty (nights / holidays / before it's published).
function parseSeqLine(html) {
  const strip = s => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&#039;|&apos;/g, "'").replace(/\s+/g, " ").trim();
  // Prefer the dedicated container; fall back to the <marquee> element itself.
  let m = html.match(/<div[^>]*id="marquee"[^>]*>([\s\S]*?)<\/div>/i);
  if (!m) m = html.match(/<marquee[^>]*>([\s\S]*?)<\/marquee>/i);
  return m ? strip(m[1]) : "";
}

async function upstream(url) {
  return fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Referer": HOST + "/display_original.php",
    },
    cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
  });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(req.url);

    // ---- Web Push endpoints (closed-phone notifications) ----
    if (req.method === "POST" && u.pathname.startsWith("/push-")) {
      try { return await handlePush(u.pathname, req, env); }
      catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: JSONH }); }
    }
    // ---- CourtReach's own Web Push subscribe/unsubscribe (its scheduled() tick below does
    // the sending — there's no /cr-push-send, unlike SD-Chamber's relay model) ----
    if (req.method === "POST" && u.pathname.startsWith("/cr-push-")) {
      try { return await handleCRPush(u.pathname, req, env); }
      catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: JSONH }); }
    }

    // ---- per-court remarks (parsed JSON) ----
    const token = u.searchParams.get("remarks");
    if (token != null) {
      if (!/^[A-Za-z0-9.]+$/.test(token))
        return new Response(JSON.stringify({ error: "bad token" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      const target = `${HOST}/display_court_all_cases.php?${token}`;
      const cache = caches.default;
      const key = new Request("https://cache/remarks/" + token, { method: "GET" });
      let hit = await cache.match(key);
      if (hit) {
        const h = new Headers(hit.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
        h.set("X-Board-Cache", "hit");
        return new Response(hit.body, { status: 200, headers: h });
      }
      let resp;
      try { resp = await upstream(target); }
      catch (e) { return new Response(JSON.stringify({ error: "upstream " + e }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }); }
      const body = await resp.text();
      const json = JSON.stringify(parseRemarks(body));
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${RMK_TTL}` };
      await cache.put(key, new Response(json, { headers }));
      return new Response(json, { headers: { ...CORS, ...headers, "X-Board-Cache": "miss" } });
    }

    // ---- court-wise SEQUENCE line (old board's marquee), parsed to {seq:"…"} ----
    if (u.searchParams.get("seq") != null) {
      const cache = caches.default;
      const key = new Request("https://cache/seqline", { method: "GET" });
      let hit = await cache.match(key);
      if (hit) {
        const h = new Headers(hit.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
        h.set("X-Board-Cache", "hit");
        return new Response(hit.body, { status: 200, headers: h });
      }
      let resp;
      try { resp = await upstream(SEQ_SRC); }
      catch (e) { return new Response(JSON.stringify({ error: "upstream " + e }), { status: 502, headers: JSONH }); }
      const json = JSON.stringify({ seq: parseSeqLine(await resp.text()) });
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${SEQ_TTL}` };
      await cache.put(key, new Response(json, { headers }));
      return new Response(json, { headers: { ...CORS, ...headers, "X-Board-Cache": "miss" } });
    }

    // ---- live court-wise board ----
    const ctype = (u.searchParams.get("ctype") || "c").toLowerCase();
    if (ctype !== "c" && ctype !== "v")
      return new Response("bad ctype", { status: 400, headers: CORS });

    const target = `${SRC}?ctype=${ctype}`;
    const cache = caches.default;
    const key = new Request(target, { method: "GET" });
    let hit = await cache.match(key);
    if (hit) {
      const h = new Headers(hit.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
      h.set("X-Board-Cache", "hit");
      return new Response(hit.body, { status: hit.status, headers: h });
    }
    let resp;
    try { resp = await upstream(target); }
    catch (e) { return new Response("upstream fetch failed: " + e, { status: 502, headers: CORS }); }
    const body = await resp.text();
    const out = new Response(body, {
      status: resp.status,
      headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${EDGE_TTL}`, "X-Board-Cache": "miss" },
    });
    await cache.put(key, new Response(body, {
      status: resp.status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${EDGE_TTL}` },
    }));
    return out;
  },

  // CourtReach's autonomous closed-phone watcher — see the CR_ section far below. Runs on
  // whatever Cron Trigger is configured in the dashboard for this worker, independent of
  // whether ANY device has courtreach.app open (unlike SD-Chamber's relay-based push above,
  // which needs an open board to notice a crossing in the first place).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(crTick(env));
  },
};

/* ============================================================================
   WEB PUSH  (closed-phone notifications) — RFC 8291 (aes128gcm) + VAPID (RFC 8292)
   Needs, in the Cloudflare dashboard:
     • a KV namespace bound as  SUBS
     • secrets  VAPID_PUBLIC  VAPID_PRIVATE  VAPID_SUBJECT  (e.g. mailto:you@…)
   VAPID keys: `npx web-push generate-vapid-keys` (public also goes in board.html).
   Endpoints (POST JSON):
     /push-subscribe   {uid, name, sub}        store a device
     /push-unsubscribe {uid, endpoint}         remove a device
     /push-send        {kind:"chat"|"court", …}fan a notification out (de-duped)
   ============================================================================ */
const JSONH = { ...CORS, "Content-Type": "application/json" };
function hash32(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0).toString(36); }
const subKey = (uid, ep) => "sub:" + uid + ":" + hash32(ep);

async function handlePush(path, req, env){
  const KV = env.SUBS;
  if(!KV) return new Response(JSON.stringify({error:"KV 'SUBS' not bound"}), {status:500, headers:JSONH});
  let b; try{ b = await req.json(); }catch(_){ return new Response("{}", {status:400, headers:JSONH}); }

  if(path === "/push-subscribe"){
    if(!b.uid || !b.sub?.endpoint) return new Response(JSON.stringify({error:"bad"}), {status:400, headers:JSONH});
    await KV.put(subKey(b.uid, b.sub.endpoint), JSON.stringify({uid:b.uid, name:b.name||"", sub:b.sub}), {expirationTtl:60*60*24*45});
    return new Response(JSON.stringify({ok:true}), {headers:JSONH});
  }
  if(path === "/push-unsubscribe"){
    if(b.uid && b.endpoint) await KV.delete(subKey(b.uid, b.endpoint));
    return new Response(JSON.stringify({ok:true}), {headers:JSONH});
  }
  if(path === "/push-send"){
    if(!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return new Response(JSON.stringify({error:"VAPID secrets unset"}), {status:500, headers:JSONH});
    // de-dup: many open instances may report the same event
    const dkey = b.kind==="court" ? `dd:court:${b.court}:${b.item}:${b.level}:${b.date}`
               : b.kind==="chat"  ? `dd:chat:${b.id}` : null;
    if(!dkey) return new Response(JSON.stringify({error:"bad kind"}), {status:400, headers:JSONH});
    if(await KV.get(dkey)) return new Response(JSON.stringify({ok:true, dup:true}), {headers:JSONH});
    await KV.put(dkey, "1", {expirationTtl:600});
    // recipients
    let uids = [];
    if(b.kind==="court") uids = [...new Set((b.toUids||[]).map(String))];
    else { const l = await KV.list({prefix:"sub:"}); const set=new Set();
      for(const k of l.keys){ const uid=k.name.split(":")[1]; if(uid && uid!==String(b.fromUid)) set.add(uid); } uids=[...set]; }
    const payload = JSON.stringify({title:b.title||"SD Board", body:b.body||"", tag:b.tag||b.kind, urgent:!!b.urgent});
    let sent=0;
    for(const uid of uids){
      const l = await KV.list({prefix:"sub:"+uid+":"});
      for(const k of l.keys){
        const rec = await KV.get(k.name); if(!rec) continue;
        let sub; try{ sub = JSON.parse(rec).sub; }catch(_){ continue; }
        try{ const st = await sendPush(sub, payload, env.VAPID_PUBLIC, env.VAPID_PRIVATE, env.VAPID_SUBJECT); if(st===404||st===410) await KV.delete(k.name); else if(st>=200&&st<300) sent++; }catch(_){}
      }
    }
    return new Response(JSON.stringify({ok:true, sent}), {headers:JSONH});
  }
  return new Response(JSON.stringify({error:"unknown"}), {status:404, headers:JSONH});
}

// --- crypto helpers (WebCrypto, available in Workers) ---
function b64uToBytes(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); s+="=".repeat((4-s.length%4)%4);
  const bin=atob(s), u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return u; }
function bytesToB64u(b){ b=new Uint8Array(b); let s=""; for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function concatU8(...a){ let n=0; for(const x of a)n+=x.length; const o=new Uint8Array(n); let p=0; for(const x of a){ o.set(x,p); p+=x.length; } return o; }
async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey("raw", ikm, {name:"HKDF"}, false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF", hash:"SHA-256", salt, info}, key, len*8));
}
// pub/priv/subject passed explicitly (not read off env directly) so the SAME function serves
// more than one app's VAPID identity sharing this worker — see the CourtReach section below,
// which has its own keys/subject, not SD-Chamber's.
async function vapidAuth(endpoint, pub, priv, subject){
  const aud = new URL(endpoint).origin;
  const enc = o => bytesToB64u(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = enc({typ:"JWT", alg:"ES256"}) + "." + enc({aud, exp:Math.floor(Date.now()/1000)+12*3600, sub:subject||"mailto:admin@sdchamber"});
  const pubBytes = b64uToBytes(pub);                                // 65: 0x04 x(32) y(32)
  const jwk = { kty:"EC", crv:"P-256", x:bytesToB64u(pubBytes.slice(1,33)), y:bytesToB64u(pubBytes.slice(33,65)), d:priv, ext:true };
  const key = await crypto.subtle.importKey("jwk", jwk, {name:"ECDSA", namedCurve:"P-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"}, key, new TextEncoder().encode(signingInput));
  return "vapid t=" + signingInput + "." + bytesToB64u(new Uint8Array(sig)) + ", k=" + pub;
}
async function encryptPayload(sub, plaintext){
  const clientPub = b64uToBytes(sub.keys.p256dh);                 // 65
  const auth = b64uToBytes(sub.keys.auth);                        // 16
  const eph = await crypto.subtle.generateKey({name:"ECDH", namedCurve:"P-256"}, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey)); // 65
  const clientKey = await crypto.subtle.importKey("raw", clientPub, {name:"ECDH", namedCurve:"P-256"}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH", public:clientKey}, eph.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyInfo = concatU8(new TextEncoder().encode("WebPush: info\0"), clientPub, ephPub);
  const ikm = await hkdf(auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, {name:"AES-GCM"}, false, ["encrypt"]);
  const rec = concatU8(new TextEncoder().encode(plaintext), new Uint8Array([2]));   // 0x02 = last record
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv:nonce}, aesKey, rec));
  const rs = new Uint8Array([0,0,0x10,0]);                        // record size 4096
  return concatU8(salt, rs, new Uint8Array([65]), ephPub, ct);    // aes128gcm header + body
}
async function sendPush(sub, payload, pub, priv, subject){
  const body = await encryptPayload(sub, payload);
  const res = await fetch(sub.endpoint, { method:"POST", headers:{
    "Authorization": await vapidAuth(sub.endpoint, pub, priv, subject),
    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
    "TTL": "1800" }, body });
  return res.status;                                              // 201 ok · 404/410 gone
}

/* ============================================================================
   COURTREACH — autonomous closed-phone push (owner: "I want notifications to
   come even when the phone is locked... How can we make it happen").
   ----------------------------------------------------------------------------
   Unlike SD-Chamber's push above (a RELAY: some open board detects a crossing and asks the
   worker to fan it out), this runs the check ITSELF on a schedule — no device needs to be
   open anywhere. That's the only way it actually covers a solo advocate whose own phone is
   the only device: nothing else exists to notice their case got close if their phone is
   locked and nothing else is running.

   Needs, in the Cloudflare dashboard (see CourtReach's PUSH-SETUP.md):
     • a KV namespace bound as  CR_SUBS      (subscriptions + per-user/court "last gap" state)
     • secrets  CR_VAPID_PUBLIC  CR_VAPID_PRIVATE  CR_VAPID_SUBJECT  (mailto:… — separate
       identity from SD-Chamber's own VAPID_* secrets above, different app, different keys)
     • secret   CR_FIRESTORE_SA_KEY   — the FULL JSON of a courtreach-ee02b service-account
       key (Firebase console → courtreach-ee02b → Project settings → Service accounts →
       Generate new private key), pasted as one secret value. This is what lets the worker
       read tracked matters directly — a Google-IAM-authenticated call, so it reads straight
       through Firestore Security Rules exactly like the daysheet-sync Action already does
       with its own COURTREACH_SA_KEY GitHub secret (same courtreach-ee02b project — you can
       reuse that exact key file here rather than generating a new one, if you still have it).
     • a Cron Trigger — every minute, roughly 8:30am to 4:30pm IST, weekdays only (the exact
       expression is in CourtReach's PUSH-SETUP.md, not spelled out here: it contains the two
       characters that close THIS comment). Cloudflare Cron is always UTC and can't run more
       than once a minute.
   Endpoints (POST JSON):
     /cr-push-subscribe   {idToken, name, sub}   store a device
     /cr-push-unsubscribe {idToken, endpoint}    remove a device
   BOTH require a valid Firebase ID token and act on the uid INSIDE it — see
   verifyFirebaseToken(). A `uid` in the body is ignored; it used to be believed, which let
   anyone subscribe their own phone to another advocate's court alerts.
   (No /cr-push-send — sending only ever happens from the scheduled tick below, never a
   client request, since the whole point is not depending on a client being there to ask.)

   Deliberate v1 scope, not silently — flagged here so it's a known gap, not a surprise:
     • Only honours a case's OWN declared status (My cases → Case over / Passover — see
       courtreach.html's CASE_STATUSES) for "over"/"passover" handling, not the live board's
       own OVER/PASS OVER remark column the way the in-app classify() also does. That remark
       data needs a PER-COURT extra fetch (?remarks=<token>) keyed off a token scraped from
       the main board row; wiring that in for every court any subscriber is tracking is a
       real addition, not a one-line one — left for a follow-up round once this base version
       is confirmed working.
     • itemHi is not persisted across ticks, so onRegularList's second detection path (the
       reset-from-high-back-to-101 signal) has nothing to work with here even though the
       engine supports it — the code is present and correct, the INPUT isn't. Regular-list
       gap math still runs off the simpler "current item > misc total" signal. Feeding
       itemHi from KV is the fix; it is a real addition, not a one-liner.
   ============================================================================ */
const CR_FIRESTORE_PROJECT = "courtreach-ee02b";
const crSubKey = (uid, ep) => "cr:sub:" + uid + ":" + hash32(ep);
const crStateKey = (uid, court, item) => "cr:st:" + uid + ":" + court + ":" + item;

// ---- Firebase ID-token verification -----------------------------------------------------
// These endpoints used to believe whatever `uid` the request body claimed. There is no
// browser-side secret that could have fixed that — anyone could POST their own push
// endpoint against another advocate's uid and start receiving that person's court alerts
// ("Court 7 — your item 43 is ~3 away"), which is live intelligence on someone else's
// listings. So the caller now presents a Firebase ID token and the Worker checks the
// signature itself, against Google's published certificates. The uid it acts on is the one
// INSIDE the token; the body's uid is only a convenience field.
const CR_PROJECT = "courtreach-ee02b";
// Google publishes the same signing keys as X.509 certificates AND as a JWK set. Take the
// JWK set: WebCrypto imports it directly, so there is no hand-rolled X.509/DER parsing
// standing between an attacker and this check.
const GOOGLE_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let _jwkCache = null;   // {byKid, exp} — the keys rotate daily; honour Cache-Control
async function googleJwks(){
  if(_jwkCache && _jwkCache.exp > Date.now()) return _jwkCache.byKid;
  const r = await fetch(GOOGLE_JWKS);
  const j = await r.json();
  const byKid = {};
  for(const k of (j.keys||[])) if(k.kid) byKid[k.kid] = k;
  const m = (r.headers.get("cache-control")||"").match(/max-age=(\d+)/);
  _jwkCache = { byKid, exp: Date.now() + (m ? parseInt(m[1],10) : 3600) * 1000 };
  return byKid;
}
async function verifyFirebaseToken(jwt){
  if(typeof jwt !== "string" || jwt.split(".").length !== 3) return null;
  const [h64, p64, s64] = jwt.split(".");
  let head, body;
  try{
    head = JSON.parse(new TextDecoder().decode(b64uToBytes(h64)));
    body = JSON.parse(new TextDecoder().decode(b64uToBytes(p64)));
  }catch(_){ return null; }
  if(head.alg !== "RS256" || !head.kid) return null;
  const now = Math.floor(Date.now()/1000);
  if(!(body.exp > now) || !(body.iat <= now + 300)) return null;
  if(body.aud !== CR_PROJECT) return null;
  if(body.iss !== "https://securetoken.google.com/" + CR_PROJECT) return null;
  if(!body.sub) return null;
  const jwk = (await googleJwks())[head.kid];
  if(!jwk) return null;
  let key;
  try{
    key = await crypto.subtle.importKey("jwk", {kty:jwk.kty, n:jwk.n, e:jwk.e, alg:"RS256", ext:true},
      {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"}, false, ["verify"]);
  }catch(_){ return null; }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    b64uToBytes(s64), new TextEncoder().encode(h64 + "." + p64));
  return ok ? body.sub : null;
}

async function handleCRPush(path, req, env){
  const KV = env.CR_SUBS;
  if(!KV) return new Response(JSON.stringify({error:"KV 'CR_SUBS' not bound"}), {status:500, headers:JSONH});
  let b; try{ b = await req.json(); }catch(_){ return new Response("{}", {status:400, headers:JSONH}); }

  // Whose device is this, really? Not whoever the body says.
  const uid = await verifyFirebaseToken(b.idToken);
  if(!uid) return new Response(JSON.stringify({error:"unauthenticated"}), {status:401, headers:JSONH});

  if(path === "/cr-push-subscribe"){
    if(!b.sub?.endpoint) return new Response(JSON.stringify({error:"bad"}), {status:400, headers:JSONH});
    await KV.put(crSubKey(uid, b.sub.endpoint), JSON.stringify({uid, name:b.name||"", sub:b.sub}), {expirationTtl:60*60*24*45});
    return new Response(JSON.stringify({ok:true}), {headers:JSONH});
  }
  if(path === "/cr-push-unsubscribe"){
    if(b.endpoint) await KV.delete(crSubKey(uid, b.endpoint));
    return new Response(JSON.stringify({ok:true}), {headers:JSONH});
  }
  return new Response(JSON.stringify({error:"unknown"}), {status:404, headers:JSONH});
}

// ---- Google service-account auth → Firestore REST (RFC 7523 JWT-bearer) ----
function pemToDer(pem){
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}
let _crTokenCache = null;   // {token, exp} — best-effort reuse if the isolate survives between ticks
async function crFirestoreToken(env){
  if(_crTokenCache && _crTokenCache.exp > Date.now()+30000) return _crTokenCache.token;
  const sa = JSON.parse(env.CR_FIRESTORE_SA_KEY);
  const now = Math.floor(Date.now()/1000);
  const enc = o => bytesToB64u(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = enc({alg:"RS256", typ:"JWT"}) + "." + enc({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key),
    {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = signingInput + "." + bytesToB64u(new Uint8Array(sig));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:"grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt });
  const j = await res.json();
  if(!j.access_token) throw new Error("Firestore auth failed: " + JSON.stringify(j));
  _crTokenCache = { token:j.access_token, exp: Date.now() + (j.expires_in||3600)*1000 };
  return j.access_token;
}
// Firestore REST documents are typed ({fields:{name:{stringValue:"..."}}}) — flatten to plain JS.
function fsValue(v){
  if(v==null) return null;
  if("stringValue" in v) return v.stringValue;
  if("integerValue" in v) return parseInt(v.integerValue,10);
  if("doubleValue" in v) return v.doubleValue;
  if("booleanValue" in v) return v.booleanValue;
  if("nullValue" in v) return null;
  if("timestampValue" in v) return v.timestampValue;
  if("arrayValue" in v) return (v.arrayValue.values||[]).map(fsValue);
  if("mapValue" in v) return fsDoc({fields:v.mapValue.fields||{}});
  return null;
}
function fsDoc(d){
  if(!d || !d.fields) return null;
  const out = {}; for(const k in d.fields) out[k] = fsValue(d.fields[k]);
  return out;
}
async function fsGet(token, path){
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${CR_FIRESTORE_PROJECT}/databases/(default)/documents/${path}`,
    { headers:{ "Authorization": "Bearer " + token } });
  if(res.status===404) return null;
  if(!res.ok) return null;
  return fsDoc(await res.json());
}
// Structured query: SELECT * FROM <collection> WHERE <field> == <value>. Returns [{id,...}].
async function fsQueryEq(token, collection, field, value){
  const body = { structuredQuery: { from:[{collectionId:collection}],
    where: { fieldFilter: { field:{fieldPath:field}, op:"EQUAL", value:{stringValue:String(value)} } } } };
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${CR_FIRESTORE_PROJECT}/databases/(default)/documents:runQuery`,
    { method:"POST", headers:{ "Authorization":"Bearer "+token, "Content-Type":"application/json" }, body:JSON.stringify(body) });
  if(!res.ok) return [];
  const rows = await res.json();
  return rows.filter(r=>r.document).map(r=>({ id:r.document.name.split("/").pop(), ...fsDoc(r.document) }));
}

// Ported verbatim from courtreach.html's parseBoard() — same live-board HTML, same fields.
function parseBoardCR(html){
  const strip = s => s.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&")
    .replace(/&#039;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&gt;/g,">").replace(/&lt;/g,"<").replace(/\s+/g," ").trim();
  const rows = html.split(/<tr class="record">/i).slice(1); const courts=[];
  for(let raw of rows){ raw=raw.split(/<\/tr>/i)[0];
    let court=""; let m=raw.match(/btn-primary[^>]*>\s*([0-9]+)/i); if(m) court=m[1];
    if(!court){ const im=raw.match(/id="cl_(\d+)"/i); if(im) court=im[1]; }
    const cl=raw.match(/id="cl_\d+"[^>]*>(.*?)<\/td>/is); const cltext=cl?strip(cl[1]):"";
    let item="",status=cltext; const im2=cltext.match(/^(\d+(?:\.\d+)?)\s+(.*)$/); if(im2){ item=im2[1]; status=im2[2].trim(); }
    if(!court) continue;
    courts.push({ court, item, status, passover:/pass\s*over/i.test(status) });
  }
  return { courts };
}

/* ---- board-engine.js, embedded VERBATIM (self.BoardEngine) ----
   The Cloudflare dashboard editor can't import across repos, so this is a manual copy of
   CourtReach's board-engine.js — see that file's own header on why it is built portable in
   the first place ("so the identical file can run in the browser... AND inside the
   Cloudflare worker").

   It said "verbatim" before and wasn't: a hand-copied classify() had been edited here
   independently and had missed three fixes made on the CourtReach side (the itemHi fallback
   in the Regular branch, the miscPOLeft boundary, and the recalled-passover queue branch).
   The visible effect was push notifications quoting distances the app itself had stopped
   quoting — the same "21 away"/"9 away" numbers that were fixed in the app. So the partial
   copy is gone: what follows is the whole file, unedited, and the ONLY local line is the
   alias below it.

   TO UPDATE: copy CourtReach/board-engine.js over the block between these markers, whole.
   Do not hand-edit the engine here. Everything the worker needs is reachable through the
   public API; if something isn't, export it THERE.
   >>> BEGIN board-engine.js >>> */
/* ============================================================================
   SD Chamber Display Board — PURE proximity engine (shared, server-ready)
   ----------------------------------------------------------------------------
   This is board.html's classify()/seq/order/passover logic with EVERY global it
   used to reach for lifted into an explicit `ctx`. Same maths, no DOM, no
   Firestore, no globals — so the identical file can run in the browser (thin
   client) AND inside the Cloudflare worker (/compute), and be unit-tested in
   isolation. It is deliberately byte-faithful to the live engine; a cross-check
   harness (board-engine-check) diffs it against the running board.html to prove
   they never disagree before anything ships.

   ctx (all optional; missing → treated as empty):
     nowMins          int    minutes-into-day IST (was nowMinsIST())
     seqByCourt       {court: "raw sequence text"}      (marquee, ?seq)
     remarksByCourt   {court: {items:{item: "OVER"|"PASS OVER"|…}}}
     poMarks          {"court_item": {mode,after,…}|null}   already date-filtered
     doneMarks        {"court_item": {v:"att"|"abs",…}|null} already date-filtered
     boardPO          {"court_item": true}                   currently outstanding, live-observed
     recalledPO       {"court_item": true}                   confirmed recalled earlier today —
                                                               tells classify() a court's passover
                                                               queue is already moving, not merely
                                                               declared
     itemHi           {court: highestRawItemSeenToday}
     miscTotalByCourt {court: int|null}   Misc list size (caller precomputes)
     boardByCourt     {court: bcRow}      the parsed board keyed by court
   ============================================================================ */
(function (root) {
  "use strict";
  const MENT_END = 640;          // 10:40 IST — mentioning done
  const REG_BASE = 101;          // Regular list numbered 101+
  const poKey = (court, item) => String(court) + "_" + String(item);

  // ---- pure sequence maths (identical to board.html) ----
  function isMentioning(item) { const s = String(item || "").trim(); return s !== "" && !/^\d/.test(s); }

  function seqInfo(text) {
    if (!text) return { seq: [], passIdx: null };
    const norm = String(text).replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 TO $2");
    const toks = norm.toUpperCase().replace(/[^0-9A-Z. ]/g, " ").split(/\s+/).filter(Boolean);
    const out = [], seen = new Set(); let passIdx = null;
    const push = n => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (passIdx == null && (t === "PASSOVER" || t === "PASSOVERS" || t === "PO" || (t === "PASS" && (toks[i + 1] === "OVER" || toks[i + 1] === "OVERS")))) passIdx = out.length;
      const num = t.match(/^(\d+)(?:\.\d+)?$/); if (!num) continue;
      const a = parseInt(num[1], 10);
      if (toks[i + 1] === "TO" && /^\d+$/.test(toks[i + 2] || "")) {
        const b = parseInt(toks[i + 2], 10);
        if (b >= a && b - a < 600) { for (let k = a; k <= b; k++) push(k); } else push(a); i += 2;
      } else push(a);
    }
    return { seq: out, passIdx };
  }

  function parseSequenceLine(text) {
    const out = {};
    if (!text) return out;
    const T = " " + String(text).toUpperCase().replace(/\s+/g, " ") + " ";
    const re = /COURT\s*(?:NO\.?|NUMBER|ROOM)?\s*(\d{1,2})\b/g;
    const anchors = []; let m;
    while ((m = re.exec(T))) anchors.push({ court: String(parseInt(m[1], 10)), afterNum: re.lastIndex });
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const nextStart = (i + 1 < anchors.length) ? T.lastIndexOf("COURT", anchors[i + 1].afterNum) : T.length;
      let seg = T.slice(a.afterNum, nextStart).trim();
      seg = seg.replace(/^[:\-–.\s]+/, "");
      if (seg && seqInfo(seg).seq.length) out[a.court] = seg;
    }
    return out;
  }

  function orderPos(seq, item) {
    item = Math.floor(parseFloat(item)); if (isNaN(item)) return null;
    const i = seq.indexOf(item); if (i >= 0) return i;
    const seqSet = new Set(seq); let before = 0;
    for (let n = 1; n < item; n++) { if (!seqSet.has(n)) before++; }
    return seq.length + before;
  }

  function preStartGap(seqTxt, ours) {
    const { seq } = seqInfo(seqTxt); if (!seq.length) return null;
    const op = orderPos(seq, ours); return op == null ? null : op;
  }
  function preStartResult(g) {
    const short = g === 0 ? "up next" : g + " ahead";
    const lab = g === 0 ? "opens · you're up first" : "opens · ~" + g + " ahead in the sequence";
    return { tier: g <= 4 ? "soon" : "later", label: lab, short, gap: g, preStart: true };
  }

  // ---- ctx-backed overlays (were globals) ----
  function detailRemark(ctx, court, item) {
    const r = (ctx.remarksByCourt || {})[String(court)]; if (!r || !r.items) return "";
    const s = String(item); if (r.items[s]) return r.items[s];
    const n = String(Math.floor(parseFloat(item)));
    return (n !== "NaN" && r.items[n]) || "";
  }
  const isOver = (ctx, court, item) => /^over$/i.test(detailRemark(ctx, court, item));
  const isPassOver = (ctx, court, item) => /pass\s*over/i.test(detailRemark(ctx, court, item));

  function overAhead(ctx, court, curItem, ours) {
    const r = (ctx.remarksByCourt || {})[String(court)]; if (!r || !r.items) return 0;
    const c = parseFloat(curItem), o = parseFloat(ours); if (isNaN(c) || isNaN(o)) return 0;
    let n = 0;
    for (const k in r.items) {
      if (!/^over$/i.test(r.items[k])) continue;
      const v = parseFloat(k); if (!isNaN(v) && v > c && v < o) n++;
    }
    return n;
  }

  function passoverItemsFor(ctx, court) {
    const out = {};
    const add = (item, after) => {
      const n = Math.floor(parseFloat(item)); if (isNaN(n)) return;
      const a = (after != null && after !== "") ? Math.floor(parseFloat(after)) : null;
      if (!(n in out)) out[n] = { after: a }; else if (a != null && out[n].after == null) out[n].after = a;
    };
    const r = (ctx.remarksByCourt || {})[String(court)];
    if (r && r.items) for (const k in r.items) { if (/pass\s*over/i.test(r.items[k])) add(k, null); }
    const pm = ctx.poMarks || {};
    for (const key in pm) { if (!pm[key]) continue; const i = key.indexOf("_"); if (i > 0 && key.slice(0, i) === String(court)) add(key.slice(i + 1), pm[key] && pm[key].after); }
    const bpo = ctx.boardPO || {};
    for (const key in bpo) { if (!bpo[key]) continue; const i = key.indexOf("_"); if (i > 0 && key.slice(0, i) === String(court)) add(key.slice(i + 1), null); }
    return out;
  }

  function poAdjust(ctx, court, curItem, ours, seq, passIdx) {
    const po = passoverItemsFor(ctx, court); const keys = Object.keys(po); if (!keys.length) return 0;
    const useSeq = !!(seq && seq.length);
    const pos = n => { n = Math.floor(parseFloat(n)); if (isNaN(n)) return null; return useSeq ? seq.indexOf(n) : n; };
    const curP = pos(curItem), ourP = pos(ours);
    if (curP == null || ourP == null) return 0;
    if (useSeq && (curP < 0 || ourP < 0)) return 0;
    if (ourP <= curP) return 0;
    const endP = useSeq ? seq.length : Infinity;
    const ourN = Math.floor(parseFloat(ours));
    let delta = 0;
    for (const k of keys) {
      if (parseInt(k, 10) === ourN) continue;
      const xp = pos(k); if (xp == null || (useSeq && xp < 0)) continue;
      let rp;
      if (po[k].after != null) { const ap = pos(po[k].after); rp = (ap != null && !(useSeq && ap < 0)) ? ap + 1 : endP; }
      else rp = (useSeq && passIdx != null && passIdx > curP) ? passIdx : endP;
      const aheadOrig = xp > curP && xp < ourP;
      const recallAhead = rp > curP && rp < ourP;
      if (aheadOrig && !recallAhead) delta--;
      else if (!aheadOrig && recallAhead) delta++;
    }
    return delta;
  }
  // When passovers are taken at the END of the board (no sequence), ours is recalled
  // after every other passed-over matter with a lower item number (reached earlier).
  function passoversBeforeOurs(ctx, court, ours) {
    const po = passoverItemsFor(ctx, court); const ourN = Math.floor(parseFloat(ours));
    if (isNaN(ourN)) return 0;
    let n = 0; for (const k in po) { const kn = parseInt(k, 10); if (!isNaN(kn) && kn < ourN) n++; }
    return n;
  }
  // Has this court recalled ANY previously passed-over item today? Direct evidence the court
  // is actively working its passover queue rather than saving recalls for the very end —
  // classify() uses this to choose which of two estimates for OUR OWN passed-over matter to
  // trust (see the "mark" branch below).
  function hasRecalledPO(ctx, court) {
    const rp = ctx.recalledPO || {}; const prefix = String(court) + "_";
    for (const k in rp) { if (rp[k] && k.indexOf(prefix) === 0) return true; }
    return false;
  }

  const doneOf = (ctx, court, item) => (ctx.doneMarks || {})[poKey(court, item)] || null;
  const poFor = (ctx, court, item) => (ctx.poMarks || {})[poKey(court, item)] || null;
  const boardPOhas = (ctx, court, item) => !!(ctx.boardPO || {})[poKey(court, item)];

  const miscTotalFor = (ctx, court) => { const v = (ctx.miscTotalByCourt || {})[String(court)]; return (v == null ? null : v); };

  function onRegularList(ctx, court, miscTotal) {
    const bc = (ctx.boardByCourt || {})[court]; const cur = bc ? parseInt(bc.item, 10) : NaN;
    if (isNaN(cur)) return false;
    if (miscTotal == null) return false;
    if (cur > miscTotal + 2) return true;
    const hi = (ctx.itemHi || {})[court] || 0;
    if (hi >= miscTotal - 3 && cur >= REG_BASE && cur < hi - 5) return true;
    return false;
  }

  // ---- the classifier — faithful port of board.html classify(e,bc) ----
  function classify(e, bc, ctx) {
    ctx = ctx || {};
    const ours = e.itemNo;
    const dn = doneOf(ctx, e.courtNo, ours);
    if (dn) return { tier: "passed", label: dn.v === "att" ? "over — attended" : "over — not attended", short: dn.v === "att" ? "over ✓" : "over ✗", over: true, done: true };
    if (!bc) return { tier: "unknown", label: "court not on the board", short: "—" };
    const seqTxt = (bc.sequence && bc.sequence.trim()) ? bc.sequence : ((ctx.seqByCourt || {})[String(e.courtNo)] || "");
    if (/not in session/i.test(bc.status || "")) {
      const pg = preStartGap(seqTxt, ours);
      if (pg != null) return preStartResult(pg);
      return { tier: "idle", label: "court not sitting", short: "not sitting" };
    }
    if (isMentioning(ours)) {
      if ((ctx.nowMins || 0) > MENT_END) return { tier: "passed", label: "mentioning — over", short: "over", ment: true };
      return { tier: "soon", label: "mentioning — watch", short: "watch", gap: 0, ment: true };
    }
    const curBoardNum = parseInt(bc.item, 10);
    const oursNum = parseFloat(ours);
    const oursSingle = oursNum >= 1600 && oursNum < 1700, oursChamber = oursNum >= 1700 && oursNum < 1800;
    if (oursSingle || oursChamber) {
      const inPhase = (oursSingle && curBoardNum >= 1600 && curBoardNum < 1700) || (oursChamber && curBoardNum >= 1700 && curBoardNum < 1800);
      if (inPhase) {
        const g = Math.floor(oursNum) - Math.floor(curBoardNum);
        if (g < 0) return { tier: "passed", label: "matter is over", short: "over", gap: g };
        if (g <= 1) return { tier: "now", label: g === 0 ? "ITEM ON NOW" : "NEXT — get in", short: g === 0 ? "NOW" : "NEXT", gap: g };
        if (g <= 4) return { tier: "soon", label: "~" + g + " items away", short: g + " away", gap: g };
        return { tier: "later", label: g + " items away", short: g + " away", gap: g };
      }
      return { tier: "later", label: (oursSingle ? "Single Judge" : "Chamber Judge") + " list — after the board", short: "after board", reg: true };
    }
    if (curBoardNum >= 800 && curBoardNum < 900) return { tier: "soon", label: "mentioning is on", short: "mentioning", ment: true };
    if (curBoardNum >= 1500 && curBoardNum < 1600) return { tier: "soon", label: "pronouncement is on", short: "pronouncement" };
    if (curBoardNum >= 1600 && curBoardNum < 1700) return { tier: "soon", label: "Single Judge matters on", short: "single judge" };
    if (curBoardNum >= 1700 && curBoardNum < 1800) return { tier: "soon", label: "Chamber Judge matters on", short: "chamber" };
    if (isOver(ctx, e.courtNo, ours)) return { tier: "passed", label: "matter is over", short: "over", over: true };
    const { seq, passIdx } = seqInfo(seqTxt);
    const curPos = seq.length ? seq.indexOf(parseInt(bc.item, 10)) : -1;
    const mark = poFor(ctx, e.courtNo, ours)
      || (isPassOver(ctx, e.courtNo, ours) ? { mode: "detail" } : null)
      || (boardPOhas(ctx, e.courtNo, ours) ? { mode: "slot" } : null);
    if (mark) {
      let gap = null, tail = "";
      if (mark.mode === "after" && mark.after) {
        if (seq.length) { const tp = seq.indexOf(parseInt(mark.after, 10)); if (tp >= 0 && curPos >= 0) gap = Math.max(0, tp - curPos + 1); }
        else { const cur = parseInt(bc.item, 10), tp = parseInt(mark.after, 10); if (!isNaN(cur) && !isNaN(tp)) gap = Math.max(0, tp - cur + 1); }
        if (gap != null) tail = " · taken after item " + String(mark.after);
      } else if (seq.length && curPos >= 0) {
        const tp = (passIdx != null && passIdx > curPos) ? passIdx : seq.length - 1;
        gap = Math.max(0, tp - curPos);
      }
      // No sequence, no explicit recall point: two different estimates, chosen by whether we
      // have actual evidence of how this court is handling recalls today.
      //
      // Once the court has recalled at least one OTHER passed-over item today (hasRecalledPO),
      // that's direct proof it's already working its passover queue interleaved with fresh
      // business, not saving them for later — so rank purely by how many other still-
      // outstanding passovers are ahead of ours (owner: "once passovers cases are taken up the
      // app is failing to see sequence of passovers and failing to calculate how far our case
      // which was 4th passover in line is"). passoversBeforeOurs() only counts items STILL in
      // recalledPO/boardPO's live-observed set, so as each one gets recalled in turn it drops
      // out and this count — and therefore our own gap — shrinks in step, the same way any
      // other "N away" queue does elsewhere in this file.
      //
      // Before any recall has been observed for this court today, there's no evidence either
      // way, so fall back to the original assumption: recalls wait for the rest of the list.
      // Getting this wrong in THAT direction is the safer failure — it under-promises rather
      // than telling someone their matter is closer than it is.
      if (gap == null) {
        if (hasRecalledPO(ctx, e.courtNo)) {
          gap = passoversBeforeOurs(ctx, e.courtNo, ours); tail = " · in the passover queue";
        } else {
          const total = miscTotalFor(ctx, e.courtNo), cur = parseInt(bc.item, 10);
          if (total != null && !isNaN(cur)) { gap = Math.max(0, total - cur) + passoversBeforeOurs(ctx, e.courtNo, ours); tail = " · taken at end"; }
        }
      }
      if (gap == null) return { tier: "later", label: "passed over — awaiting its turn", short: "passed over", po: true };
      if (gap <= 0) return { tier: "now", label: "passed over — item on now", short: "NOW", gap, po: true };
      if (gap === 1) return { tier: "now", label: "passed over — next", short: "NEXT", gap, po: true };
      if (gap <= 4) return { tier: "soon", label: "~" + gap + " items away · passed over" + tail, short: gap + " away", gap, po: true };
      return { tier: "later", label: gap + " items away · passed over" + tail, short: gap + " away", gap, po: true };
    }
    if (/^reg/i.test((e.listType || "").trim())) {
      const miscTotal = miscTotalFor(ctx, e.courtNo);
      if (!onRegularList(ctx, e.courtNo, miscTotal)) {
        const regRank = (Math.floor(oursNum) >= REG_BASE) ? (Math.floor(oursNum) - (REG_BASE - 1)) : Math.max(1, Math.floor(oursNum) || 1);
        if (miscTotal == null && !seq.length)
          return { tier: "later", label: "Regular list — after the Miscellaneous list", short: "after Misc", reg: true };
        const cur = parseInt(bc.item, 10);
        // miscDone approximates "how far into Misc has the court actually gotten" — but once
        // recalls are happening, the board's CURRENT item can be a low-numbered passover being
        // recalled right now, which is a temporary DIP, not real regression. Using cur alone
        // there would read that dip as "only just started Misc" and wildly overstate what's
        // left (owner's report: Court 8 showing 21 away with only three passovers and three
        // Regular matters actually outstanding — 21 is explained exactly by this: cur reading
        // a recalled low item while the court had genuinely already reached item ~97+ of a
        // ~100 Misc list). itemHi (the highest raw item any poll has seen at this court today)
        // never regresses on a recall the way cur does — same signal onRegularList() already
        // trusts for its own "has this court moved past Misc" call — so take whichever is
        // higher.
        const hi = (ctx.itemHi || {})[e.courtNo] || 0;
        const miscDone = (seq.length && curPos >= 0) ? curPos + 1 : Math.max(isNaN(cur) ? 0 : cur, hi);
        const miscLeft = Math.max(0, (miscTotal != null ? miscTotal : seq.length) - miscDone);
        // Misc's own outstanding passovers are still Misc business, not yet disposed, and
        // Misc must finish before Regular starts — so they count toward the gap too (owner:
        // "miscellaneous list comes first before the regular list and so also any passover
        // from the miscellaneous list comes first before regular list ... unless there is a
        // specific sequence provides for otherwise"). Concrete worked example that shaped
        // this: Court 8, item 31 current, Misc total 35, six outstanding Misc passovers, our
        // matter is Regular #104 (regRank 4) — expected gap = 6 (passovers) + 4 (Misc left:
        // 32-35) + 3 (Regular ahead: 101-103) = 13.
        //
        // Only passovers AT OR BEHIND the court's REACH so far count here — one still ahead of
        // that (item > miscDone) is already inside miscLeft above (it hasn't been reached OR
        // skipped yet from our vantage point), so adding it again would double it. Boundary is
        // miscDone (== max(cur,hi)), not cur alone, for the same reason miscDone itself uses
        // it: a passover with item number between a temporary recall dip and the court's real
        // peak was genuinely already reached and skipped, and using cur here would silently
        // drop it from the gap entirely — not double-counted, just gone.
        //
        // The exception: if the announced sequence explicitly places Regular items BEFORE its
        // mention of passovers (i.e. the court is saying "101-120 first, passovers after"),
        // that overrides the default — those passovers are no longer Misc-first business.
        const poException = seq.length && passIdx != null && seq.slice(0, passIdx).some(n => n >= REG_BASE);
        let miscPOLeft = 0;
        if (!poException) {
          const po = passoverItemsFor(ctx, e.courtNo);
          const miscCeil = miscTotal != null ? miscTotal : (REG_BASE - 1);
          for (const k in po) { const n = parseInt(k, 10); if (!isNaN(n) && n <= miscCeil && n <= miscDone) miscPOLeft++; }
        }
        const gap = miscLeft + miscPOLeft + (regRank - 1);
        const detail = (miscLeft > 0 || miscPOLeft > 0)
          ? "Misc: " + miscLeft + " to go" + (miscPOLeft ? " · " + miscPOLeft + " passover" + (miscPOLeft === 1 ? "" : "s") : "")
          : "Misc done";
        if (gap <= 1) return { tier: "now", label: "Regular — get in now", short: "NOW", gap, reg: true };
        if (gap <= 4) return { tier: "soon", label: "Regular — ~" + gap + " away · " + detail, short: gap + " away", gap, reg: true };
        return { tier: "later", label: "Regular — ~" + gap + " away · " + detail, short: gap + " away", gap, reg: true };
      }
    }
    let gap = null, approx = false;
    if (seq.length) { const op = orderPos(seq, ours), cp = orderPos(seq, bc.item); if (op != null && cp != null) gap = op - cp; }
    if (gap == null) { const c = parseFloat(bc.item); if (!isNaN(c)) { gap = Math.floor(oursNum) - Math.floor(c); approx = true; } }
    if (gap != null && gap > 0) { const done = overAhead(ctx, e.courtNo, bc.item, ours); if (done > 0) gap = Math.max(0, gap - done); }
    let poNote = "";
    if (gap != null) { const pa = poAdjust(ctx, e.courtNo, bc.item, ours, seq, passIdx); if (pa) { gap = Math.max(0, gap + pa); poNote = pa < 0 ? " · " + (-pa) + " passed over ahead" : " · " + pa + " recalled first"; } }
    if (gap == null) { const pg = preStartGap(seqTxt, ours); if (pg != null) return preStartResult(pg); }
    if (gap == null) return { tier: "unknown", label: "position unclear", short: "—" };
    if (gap < 0) return { tier: "passed", label: "matter is over", short: "over", gap, approx };
    if (gap <= 1) return { tier: "now", label: gap === 0 ? "ITEM ON NOW" : "NEXT — get in", short: gap === 0 ? "NOW" : "NEXT", gap, approx, poNote };
    if (gap <= 4) return { tier: "soon", label: "~" + gap + " items away" + poNote, short: gap + " away", gap, approx, poNote };
    return { tier: "later", label: gap + " items away" + poNote, short: gap + " away", gap, approx, poNote };
  }

  const API = { classify, seqInfo, orderPos, parseSequenceLine, preStartGap, preStartResult, isMentioning, MENT_END, REG_BASE, passoverItemsFor, detailRemark };
  root.BoardEngine = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
/* <<< END board-engine.js <<< */
// The worker's own name for it. board-engine.js exports the full API as self.BoardEngine;
// crTick() calls self.CRBoardEngine.classify(), so alias rather than re-declare — that way
// there is exactly one implementation in this file and no second one to drift.
self.CRBoardEngine = self.BoardEngine;

// ---- the scheduled tick itself ----
const crUsable = m => m && m.court && m.item && /^\d+$/.test(String(m.court)) && +m.court>=1 && +m.court<=17;
async function crTick(env){
  if(!env.CR_SUBS || !env.CR_VAPID_PUBLIC || !env.CR_VAPID_PRIVATE || !env.CR_FIRESTORE_SA_KEY) return;   // not configured yet — inert

  const subsList = await env.CR_SUBS.list({prefix:"cr:sub:"});
  const uids = [...new Set(subsList.keys.map(k => k.name.split(":")[2]))];
  if(!uids.length) return;

  let boardHtml; try{ boardHtml = await (await upstream(SRC+"?ctype=c")).text(); }catch(_){ return; }
  const board = parseBoardCR(boardHtml).courts;
  const boardByCourt = {}; for(const c of board) if(c.court && !boardByCourt[c.court]) boardByCourt[c.court]=c;

  const todayIST = new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Kolkata'});   // YYYY-MM-DD
  let miscTotalByCourt = {};
  try{
    const cu = await (await fetch("https://courtreach.app/court-updates.json", {cf:{cacheTtl:60}})).json();
    const lists = cu?.by_date?.[todayIST]?.lists?.["Miscellaneous"] || {};
    for(const court in lists){ const rec=lists[court]||{}; let t=parseInt(rec.total,10);
      if(isNaN(t)||t<=0){ const mm=parseInt(rec.main,10), s=parseInt(rec.supp,10); t=isNaN(mm)?NaN:(mm+(isNaN(s)?0:s)); }
      if(!isNaN(t)&&t>0) miscTotalByCourt[String(court)]=t; }
  }catch(_){}

  let token; try{ token = await crFirestoreToken(env); }catch(_){ return; }
  const orgMemberCache = {};   // orgId -> [{id,...}] — several subscribers can share a chamber

  for(const uid of uids){
    const user = await fsGet(token, `users/${uid}`);
    if(!user) continue;
    const myDoc = await fsGet(token, `usermatters/${uid}`);
    let matters = ((myDoc && myDoc.matters) || []).map(m=>({...m, by:uid}));
    if(user.orgId){
      if(!orgMemberCache[user.orgId]) orgMemberCache[user.orgId] = await fsQueryEq(token, "users", "orgId", user.orgId);
      for(const member of orgMemberCache[user.orgId]){
        if(member.id===uid) continue;
        const md = await fsGet(token, `usermatters/${member.id}`);
        (md && md.matters || []).forEach(m=>{ if((m.scope||"chamber")!=="personal") matters.push({...m, by:member.id}); });
      }
    }
    const todays = matters.filter(m => crUsable(m) && (m.date||todayIST)===todayIST);
    if(!todays.length) continue;

    const inrange = [];
    for(const m of todays){
      const bc = boardByCourt[String(m.court)];
      const key = String(m.court)+"_"+String(m.item);
      const doneMarks = (m.status==="over_att") ? {[key]:{v:"att"}} : (m.status==="over_absent") ? {[key]:{v:"abs"}} : {};
      const poMarks = (m.status==="passover") ? {[key]:{mode:"detail"}} : {};
      const k = self.CRBoardEngine.classify({courtNo:String(m.court), itemNo:String(m.item), listType:m.listType||""}, bc,
        { nowMins: nowMinsIST(), boardByCourt, miscTotalByCourt, doneMarks, poMarks });
      if(!k || k.ment || k.done || k.over || k.gap==null || k.preStart) continue;
      if(k.gap<0 || k.gap>7) continue;
      inrange.push({court:m.court, item:m.item, gap:k.gap});
    }
    const closest = {};
    for(const r of inrange){ const c=String(r.court); if(!closest[c]||r.gap<closest[c].gap) closest[c]=r; }
    const finalItems = Object.values(closest);
    if(!finalItems.length) continue;

    let stepped = false;
    for(const r of finalItems){
      const sk = crStateKey(uid, r.court, r.item);
      const prevRaw = await env.CR_SUBS.get(sk);
      const prev = prevRaw!=null ? parseInt(prevRaw,10) : null;
      if(prev===null || r.gap<prev) stepped = true;
      await env.CR_SUBS.put(sk, String(r.gap), {expirationTtl:60*60*20});
    }
    if(!stepped) continue;

    const body = finalItems.length===1
      ? (finalItems[0].gap<=0 ? `Your item ${finalItems[0].item} is on now in Court ${finalItems[0].court}`
         : finalItems[0].gap===1 ? `Next in Court ${finalItems[0].court} — your item ${finalItems[0].item}`
         : `Court ${finalItems[0].court} — your item ${finalItems[0].item} is ~${finalItems[0].gap} away`)
      : finalItems.length + " of your cases are close — " + finalItems.map(r=>"C"+r.court).join(", ");
    const payload = JSON.stringify({title:"CourtReach", body, tag:"cr-reach"});

    const userSubs = await env.CR_SUBS.list({prefix:"cr:sub:"+uid+":"});
    for(const sk of userSubs.keys){
      const rec = await env.CR_SUBS.get(sk.name); if(!rec) continue;
      let sub; try{ sub = JSON.parse(rec).sub; }catch(_){ continue; }
      try{
        const st = await sendPush(sub, payload, env.CR_VAPID_PUBLIC, env.CR_VAPID_PRIVATE, env.CR_VAPID_SUBJECT);
        if(st===404||st===410) await env.CR_SUBS.delete(sk.name);
      }catch(_){}
    }
  }
}
function nowMinsIST(){
  try{ const t=new Date().toLocaleTimeString('en-GB',{timeZone:'Asia/Kolkata',hour12:false,hour:'2-digit',minute:'2-digit'});
    const [h,m]=t.split(':').map(Number); return h*60+m; }catch(e){ const d=new Date(); return d.getUTCHours()*60+d.getUTCMinutes(); }
}
