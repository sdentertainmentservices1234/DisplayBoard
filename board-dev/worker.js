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
        try{ const st = await sendPush(sub, payload, env); if(st===404||st===410) await KV.delete(k.name); else if(st>=200&&st<300) sent++; }catch(_){}
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
async function vapidAuth(endpoint, env){
  const aud = new URL(endpoint).origin;
  const enc = o => bytesToB64u(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = enc({typ:"JWT", alg:"ES256"}) + "." + enc({aud, exp:Math.floor(Date.now()/1000)+12*3600, sub:env.VAPID_SUBJECT||"mailto:admin@sdchamber"});
  const pub = b64uToBytes(env.VAPID_PUBLIC);                       // 65: 0x04 x(32) y(32)
  const jwk = { kty:"EC", crv:"P-256", x:bytesToB64u(pub.slice(1,33)), y:bytesToB64u(pub.slice(33,65)), d:env.VAPID_PRIVATE, ext:true };
  const key = await crypto.subtle.importKey("jwk", jwk, {name:"ECDSA", namedCurve:"P-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"}, key, new TextEncoder().encode(signingInput));
  return "vapid t=" + signingInput + "." + bytesToB64u(new Uint8Array(sig)) + ", k=" + env.VAPID_PUBLIC;
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
async function sendPush(sub, payload, env){
  const body = await encryptPayload(sub, payload);
  const res = await fetch(sub.endpoint, { method:"POST", headers:{
    "Authorization": await vapidAuth(sub.endpoint, env),
    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
    "TTL": "1800" }, body });
  return res.status;                                              // 201 ok · 404/410 gone
}
