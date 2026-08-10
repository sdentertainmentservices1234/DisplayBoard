#!/usr/bin/env python3
"""Regenerate board-dev/board-test.html — the war-room test build — from board.html.

DEMO=true + an in-memory seed + the saved live SC board sample (so the parser and
proximity overlay run against real board HTML without touching the SC site).
The seeded day sheet is crafted to exercise every proximity tier: NOW, soon,
watch (mentioning), later, idle (court not sitting), passed, unknown.
Run after editing board.html:  python3 make-board-test.py
Written into board-dev/ so the relative board-sample fetch resolves.
"""
html = open("board.html").read()

SEED = '''function seedDemo(db){
  const n=db.now;
  const people=[
    ["u_senior","Shyam Divan","senior","sd@chamber.in","Senior Advocate"],
    ["u_admin","Adith Deshmukh","admin","adithdeshmukh@gmail.com","Advocate-on-Record"],
    ["u_clerk","Staff","clerk","clerk@chamber.in","Clerk"],
    ["u_yash","Yashvardhan S.","junior","yash@chamber.in","Advocate"],
    ["u_shaishir","Shaishir","junior","shaishir@chamber.in","Advocate"],
    ["u_anshula","Anshula L.","junior","anshula@chamber.in","Advocate"],
    ["u_rishit","Rishit V.","junior","rishit@chamber.in","Advocate"],
    // a STANDALONE self-registrant (external AoR) — role "user", their own office
    ["u_aor","Rohan Mehta","user","rohan@ext.in","Advocate-on-Record"],
  ];
  people.forEach(([uid,name,role,email,designation])=>db.set("users/"+uid,{name,email,role,designation,office:name,phone:"9820011234",active:true}));

  const D=todayISO();
  // Items chosen to hit each tier against the saved board sample (2026-07-13):
  //  Ct6 on item 3 (seq present) · Ct3 on 3 · Ct10 on 4 · Ct7 on 1506 · Ct13 not sitting · Ct14 on 3
  const entries=[
    {courtNo:"6", itemNo:"4",  caseTitle:"Mahabanoo & Anr. vs Kalikund Developers & Ors.", time:"10:30", bench:"J.B. Pardiwala, K.V. Chandran", counsel:"Somiran Sharma", juniorUids:["u_yash","u_shaishir"], confTime:"6:30 pm"},
    {courtNo:"3", itemNo:"6",  caseTitle:"Test Soon Matter vs State (sample)", time:"10:30", bench:"Vikram Nath, Sandeep Mehta", counsel:"Karanjawala & Co.", juniorUids:["u_anshula"]},
    {courtNo:"5", itemNo:"6",  caseTitle:"Test Adjacent Matter vs Union (sample)", time:"10:30", bench:"", counsel:"", juniorUids:["u_rishit"]},
    {courtNo:"6", itemNo:"49", caseTitle:"Jyoti Builders vs Chief Executive Officer & Ors.", time:"10:30", bench:"J.B. Pardiwala, K.V. Chandran", counsel:"Anish Agarwal", juniorUids:["u_yash"], confTime:"5:00 pm"},
    {courtNo:"7", itemNo:"MM", caseTitle:"Kotak Mahindra Trustee Co. Ltd. vs SEBI", time:"10:30", bench:"Dipankar Datta, Sheel Nagu", counsel:"Mahesh Agarwal", juniorUids:["u_anshula"]},
    {courtNo:"13",itemNo:"48", caseTitle:"M/s Chandler & Price India vs M.Z.S. Da Piedade Vas & Ors.", time:"10:30", bench:"P.K. Mishra, Chandrasekhar", counsel:"Wadia Ghandy", juniorUids:["u_rishit"]},
    {courtNo:"14",itemNo:"2",  caseTitle:"Test Passed Matter vs State (sample)", time:"10:30", bench:"", counsel:"", juniorUids:["u_shaishir"]},
    {courtNo:"1", itemNo:"12", caseTitle:"Sugandha Hiemath & Ors. vs Babasaheb N. Kalyani & Ors.", time:"10:30", bench:"C.J.I., Joymala Bagchi, V. Mohana", counsel:"Karanjawala & Co.", juniorUids:["u_yash"]},
    {courtNo:"2", itemNo:"101", listType:"Regular", caseTitle:"Test Regular Matter vs Union of India (regular list)", time:"10:30", bench:"Surya Kant, N.K. Singh", counsel:"AZB & Partners", juniorUids:["u_rishit"]},
    {courtNo:"21",itemNo:"2",  caseTitle:"Test Registrar Matter vs State (must NOT show as a board island)", time:"10:30", bench:"Registrar", counsel:"", juniorUids:["u_yash"]},
  ];
  db.set("daysheets/"+D,{date:D,updatedAt:n(),updatedBy:"u_clerk",entries,conferences:[]});

  // Live remark column (only some benches publish it; in prod the relay parses it
  // per court). Demo: Court 3 has passed our item 6 over (PASS OVER -> PO + shown
  // in the Passovers section); Court 5 has finished item 5 out of turn (OVER), so
  // our item 6 is discounted from ~2-away to NEXT — over items are never listed.
  remarksByCourt["3"]={at:Date.now(),items:{"6":"PASS OVER"}};
  remarksByCourt["5"]={at:Date.now(),items:{"5":"OVER"}};

  // Senior last marked in Court 6 40 min ago -> stale -> the app should INFER.
  db.set("config/live",{court:{court:"6",at:{_t:Date.now()-40*60000},by:"u_yash"},conf:null});

  db.set("messages/m1",{by:"u_yash",name:"Yashvardhan S.",text:"Court 6 is moving slowly, still on item 3.",at:{_t:Date.now()-9*60000}});
  db.set("messages/m2",{by:"u_anshula",name:"Anshula L.",text:"I'm outside Court 3, will signal when our item is called.",at:{_t:Date.now()-4*60000}});

  // BRIEFING FEATURE demo. u_aor ("Rohan") is an external AoR briefing the senior:
  // his OWN board = his usermatter (Ct4/5); the senior's board = the chamber day sheet.
  db.set("usermatters/u_aor",{matters:[{id:"mo1",court:"4",item:"5",title:"My SLP v. State of Karnataka"}],updatedAt:n()});
  // Several AoRs tracking the senior — the team's Briefing inbox (eight-AoR handling):
  //  bl_a Rohan (Ct6/4), bl_c Meera (Ct1/12), bl_d Arjun (Ct14/3) approved; bl_b Priya pending.
  db.set("brieflinks/bl_a",{aorUid:"u_aor",aorName:"Rohan Mehta",aorDesig:"Advocate-on-Record",
    court:"6",item:"4",date:D,title:"Mahabanoo v. Kalikund",note:"Briefing on the SLP",status:"approved",at:{_t:Date.now()-30*60000},decidedBy:"u_clerk",
    matters:[{court:"6",item:"4",date:D,listType:"Miscellaneous",party:"Petitioner",title:"Mahabanoo v. Kalikund",bench:"J.B. Pardiwala, K.V. Chandran",aor:""},
             {court:"1",item:"12",date:D,listType:"Miscellaneous",party:"Respondent",title:"Sugandha v. Babasaheb",bench:"C.J.I., Joymala Bagchi, V. Mohana",aor:""}]});
  db.set("brieflinks/bl_c",{aorUid:"u_aor2",aorName:"Meera Krishnan",aorDesig:"Advocate",
    court:"1",item:"12",date:D,title:"Sugandha v. Babasaheb",note:"",status:"approved",at:{_t:Date.now()-50*60000},decidedBy:"u_clerk"});
  db.set("brieflinks/bl_d",{aorUid:"u_aor3",aorName:"Arjun Rao",aorDesig:"Senior Advocate",
    court:"14",item:"3",date:D,title:"Rao v. Union of India",note:"",status:"approved",at:{_t:Date.now()-70*60000},decidedBy:"u_clerk"});
  db.set("brieflinks/bl_b",{aorUid:"u_aor4",aorName:"Priya Nair",aorDesig:"Advocate",
    court:"3",item:"6",date:D,title:"Nair v. State of Maharashtra",note:"Reaching after lunch",status:"pending",at:{_t:Date.now()-6*60000}});
  // per-thread messages (name only, no designation)
  db.set("briefmsgs/bm1",{linkId:"bl_a",by:"u_aor",name:"Rohan Mehta",text:"My matter is next — please come.",at:{_t:Date.now()-6*60000}});
  db.set("briefmsgs/bm2",{linkId:"bl_a",by:"u_clerk",name:"Staff",text:"He's wrapping up Court 6, will come across.",at:{_t:Date.now()-4*60000}});
  db.set("briefmsgs/bm3",{linkId:"bl_c",by:"u_aor2",name:"Meera Krishnan",text:"Is he reaching my Court 1 item soon?",at:{_t:Date.now()-8*60000}});
}'''

# swap the empty stub for the real seed
stub = "function seedDemo(db){}"
assert stub in html, "seed stub not found"
html = html.replace(stub, SEED, 1)

html = html.replace("const DEMO = false;", "const DEMO = true;", 1)
html = html.replace('const BOARD_SAMPLE = null;',
                    'const BOARD_SAMPLE = "./get_board_sample_2026-07-13.html";', 1)

open("board-dev/board-test.html", "w").write(html)
print("board-dev/board-test.html regenerated:", len(html), "bytes")
