// expandSequence("... 1 TO 32 37 38 50 51 THEN 33 TO 36 39 TO 49")
//   -> [1,2,...,32,37,38,50,51,33,34,35,36,39,...,49]
// Reads left-to-right; "A TO B" -> inclusive range; bare numbers appended.
// Noise words (SEQUENCE, ITEM, NOS, WITH, THEN, PASSOVER, PO, IF, ANY, FRESH,
// AND, REST, OF, MATTERS, WOULD, BE, AS, WOULD) are ignored.
function expandSequence(text){
  if (!text) return [];
  const toks = text.toUpperCase()
    .replace(/[^0-9A-Z. ]/g," ")
    .split(/\s+/).filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = n => { if (!seen.has(n)){ seen.add(n); out.push(n); } };
  for (let i=0;i<toks.length;i++){
    const t = toks[i];
    const num = t.match(/^(\d+)(?:\.\d+)?$/);          // treat 37.1 as 37 for ordering
    if (!num) continue;
    const a = parseInt(num[1],10);
    // lookahead for "A TO B"
    if (toks[i+1]==="TO" && /^\d+$/.test(toks[i+2]||"")){
      const b = parseInt(toks[i+2],10);
      if (b>=a && b-a<600){ for(let k=a;k<=b;k++) push(k); }
      else push(a);
      i+=2;
    } else push(a);
  }
  return out;
}

// proximity(seqArr, current, ours):
//   how many items (in the declared order) between the one being heard and ours.
//   Returns {gap, of, ourPos, curPos} or null when it can't be placed.
function proximity(seq, current, ours){
  current = parseInt(current,10); ours = Math.floor(parseFloat(ours));
  if (!seq.length || isNaN(current) || isNaN(ours)) return null;
  const curPos = seq.indexOf(current);
  const ourPos = seq.indexOf(ours);
  if (curPos<0 || ourPos<0) return {gap:null, of:seq.length, ourPos, curPos};
  return { gap: ourPos - curPos, of: seq.length, ourPos, curPos };
}

// ---- tests against today's real sequences ----
const cases = [
  ["Ct1","SEQUENCE WOULD BE ITEM NOS. 1 TO 21 WITH 22 23 51 THEN 24 25 46 TO 50", 801, 30],
  ["Ct6","SEQUENCE WOULD BE ITEM NOS. 1 TO 32 37 38 50 51 THEN ITEM NOS. 33 TO 36 39 TO 49", 3, 49],
  ["Ct6-46","SEQUENCE WOULD BE ITEM NOS. 1 TO 32 37 38 50 51 THEN ITEM NOS. 33 TO 36 39 TO 49", 3, 46],
  ["Ct7","sequence item nos. 1 to 38 51 fresh passover then 39 to 50", 1506, 48],
  ["Ct3","SEQ ITEM NOS 1 TO 28 52 34 PASSOVER IF ANY AND THEN REST OF MATTERS", 3, 20],
];
for (const [lbl,seqtext,cur,ours] of cases){
  const seq = expandSequence(seqtext);
  const p = proximity(seq, cur, ours);
  print(`${lbl}: expanded ${seq.length} items; current=${cur} ours=${ours} -> `+
    (p ? (p.gap===null? `current(${cur}) not in seq; ours at pos ${p.ourPos+1}/${p.of}`
                       : `GAP=${p.gap} items (ours pos ${p.ourPos+1}/${p.of}, current pos ${p.curPos+1})`)
        : "n/a"));
  print("   order head: ["+seq.slice(0,14).join(",")+" ...] tail: ["+seq.slice(-6).join(",")+"]");
}
