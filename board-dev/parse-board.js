// parseBoard(htmlText) -> { fetchedLabel, courts: [{court, item, status, caseNo, title, advocates, sequence}] }
// Tolerant of the SC board's HTML: one <tr class="record"> per court row.
function parseBoard(html){
  const stripTags = s => s.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&").replace(/&#039;|&apos;/g,"'").replace(/&quot;/g,'"')
    .replace(/&gt;/g,">").replace(/&lt;/g,"<").replace(/\s+/g," ").trim();
  const rows = html.split(/<tr class="record">/i).slice(1);
  const courts = [];
  for (let raw of rows){
    raw = raw.split(/<\/tr>/i)[0];
    // court number: the primary button, else the _N suffix on a cell id
    let court = "";
    let m = raw.match(/btn-primary[^>]*>\s*([0-9]+)/i);
    if (m) court = m[1];
    if (!court){ const im = raw.match(/id="cl_(\d+)"/i); if (im) court = im[1]; }
    // status cell cl_N: "801 Hearing" | "Not in Session" | "3 Hearing"
    const cl = raw.match(/id="cl_\d+"[^>]*>(.*?)<\/td>/is);
    const cltext = cl ? stripTags(cl[1]) : "";
    let item = "", status = cltext;
    const im2 = cltext.match(/^(\d+(?:\.\d+)?)\s+(.*)$/);
    if (im2){ item = im2[1]; status = im2[2].trim(); }
    // case no / title / advocates
    const cn = raw.match(/id="cn_\d+"[^>]*>(.*?)<\/td>/is);
    const cz = raw.match(/id="cnbz_\d+"[^>]*>(.*?)<\/td>/is);
    const az = raw.match(/id="cncz_\d+"[^>]*>(.*?)<\/td>/is);
    // declared sequence: the tooltip on the message cell
    const seqm = raw.match(/title="([^"]*(?:SEQUENCE|SEQ|sequence)[^"]*)"/i);
    courts.push({
      court,
      item,
      status,                                   // "Hearing" | "Not in Session" | ""
      caseNo: cn ? stripTags(cn[1]) : "",
      title: cz ? stripTags(cz[1]) : "",
      advocates: az ? stripTags(az[1]) : "",
      sequence: seqm ? stripTags(seqm[1]) : "",
    });
  }
  return { courts };
}

// ---- test against the saved live sample ----
function readFileSync(p){ return read(p); }              // jsc global
const sample = readFile("get_board_sample_2026-07-13.html");
const parsed = parseBoard(sample);
print("courts parsed: " + parsed.courts.length);
for (const c of parsed.courts){
  print(`Ct ${c.court}: item=${c.item||"-"} [${c.status}] | ${c.caseNo} | ${c.title.slice(0,34)} | seq:${c.sequence?c.sequence.slice(0,46):"none"}`);
}
