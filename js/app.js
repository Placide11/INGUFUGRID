const $ = id => document.getElementById(id);
const DT = 1/6;
const EFF = 0.92;

const LOADS0 = [
  ["Cold storage",     6, 1],
  ["Health post",      2, 1],
  ["Water pump",       3, 2],
  ["Barbers & salons", 3, 2],
  ["Shops",            5, 3],
  ["Workshop",         6, 3]
];
const TIER = {1:"essential", 2:"business", 3:"discretionary"};

/* ---------- theme ---------- */
function currentTheme(){
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function isDark(){
  return currentTheme() === "dark";
}
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  try{ localStorage.setItem("ig-theme", t); }catch(e){}
  if (typeof S !== "undefined" && S) draw();
}
$("themeBtn").addEventListener("click", () => {
  applyTheme(isDark() ? "light" : "dark");
});
if (window.matchMedia){
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = e => {
    let saved = null;
    try{ saved = localStorage.getItem("ig-theme"); }catch(err){}
    if (!saved) applyTheme(e.matches ? "dark" : "light");
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/* ---------- sim ---------- */
let S;

function reset(hour = 11){
  S = {
    h: hour,
    soc: +$("cap").value * 0.9,
    grid: true,
    play: true,
    hist: [],
    log: [],
    prevKey: "",
    prevMode: "",
    outHours: 0,
    essHours: 0,
    servedOut: 0,
    unserved: 0,
    imported: 0,
    warned: false,
    cur: null,
    loads: LOADS0.map(l => ({
      n: l[0], kw: l[1], tier: l[2], on: true, kwh: 0, unkwh: 0, live: true
    }))
  };
  log("simulation started · grid connected");
}

function log(m){
  S.log.unshift({ t: clock(), m });
  S.log = S.log.slice(0, 60);
}
function clock(){
  const x = ((S.h % 24) + 24) % 24;
  const hh = Math.floor(x);
  const mm = Math.round((x - hh) * 60) % 60;
  return String(hh).padStart(2,"0") + ":" + String(mm).padStart(2,"0");
}
function solarNow(){
  const x = S.h % 24;
  const shape = Math.max(0, Math.sin(Math.PI * (x - 6) / 12));
  return +$("solar").value * shape * (1 - +$("cloud").value / 100);
}

function step(){
  const cap     = +$("cap").value;
  const strat   = +$("strat").value;
  const reserve = cap * (strat === 3 ? 0.10 : 0.20);
  const maxP    = cap * 0.5;

  const solar   = solarNow();
  const active  = S.loads.filter(l => l.on);
  const demand  = active.reduce((a,l) => a + l.kw, 0);

  let served = 0, batt = 0, imported = 0, curtailed = 0;

  if (S.grid){
    active.forEach(l => l.live = true);
    served = demand;
    const net = solar - demand;
    if (net >= 0){
      const charge = Math.min(net, maxP, (cap - S.soc) / (DT * EFF));
      S.soc += charge * DT * EFF;
      batt = -charge;
      curtailed = net - charge;
    } else {
      imported = -net;
      const charge = Math.min(5, (cap - S.soc) / (DT * EFF));
      if (charge > 0){ S.soc += charge * DT * EFF; imported += charge; batt = -charge; }
    }
  } else {
    const discharge = Math.max(0, Math.min(maxP, (S.soc - reserve) * EFF / DT));
    let budget = solar + discharge;

    const ordered = [...active].sort((a,b) => a.tier - b.tier);
    ordered.forEach(l => {
      if (l.tier <= strat && l.kw <= budget + 1e-9){
        l.live = true; budget -= l.kw; served += l.kw;
      } else {
        l.live = false;
      }
    });
    S.loads.sort((a,b) =>
      LOADS0.findIndex(x => x[0] === a.n) - LOADS0.findIndex(x => x[0] === b.n));

    if (served > solar){
      batt = served - solar;
      S.soc -= batt / EFF * DT;
    } else {
      const charge = Math.min(solar - served, maxP, (cap - S.soc) / (DT * EFF));
      S.soc += charge * DT * EFF;
      batt = -charge;
      curtailed = solar - served - charge;
    }
    S.outHours += DT;
    S.servedOut += served * DT;
    if (active.filter(l => l.tier === 1).every(l => l.live)) S.essHours += DT;
  }

  S.loads.forEach(l => {
    if (!l.on){ l.live = false; return; }
    if (l.live) l.kwh  += l.kw * DT;
    else        l.unkwh += l.kw * DT;
  });
  S.unserved += active.filter(l => !l.live).reduce((a,l) => a + l.kw * DT, 0);
  S.imported += imported * DT;

  const shed = S.loads.filter(l => l.on && !l.live).map(l => l.n);
  const key = (S.grid ? "G" : "O") + shed.join("|");
  if (key !== S.prevKey){
    if (S.grid){
      log(S.prevMode === "O"
        ? "grid restored · reconnect after sync · battery recharging"
        : "grid normal · solar → demand → battery");
    } else {
      const avail = solar + Math.max(0, Math.min(maxP, (S.soc - reserve) * EFF / DT));
      let m = "";
      if (S.prevMode !== "O") m += "outage · islanding requested · ";
      if (shed.length){
        m += `shed ${shed.join(", ")} · supply ${avail.toFixed(1)} kW < demand ${demand} kW · `
           + `${TIER[strat]} policy · reserve ${Math.round(reserve / cap * 100)}%`;
      } else {
        m += "all active loads served from solar + battery";
      }
      log(m);
    }
    S.prevKey = key;
    S.prevMode = S.grid ? "G" : "O";
  }
  if (!S.grid && S.soc <= reserve + 0.5 && !S.warned){
    log("battery at reserve floor · only solar-supported loads remain");
    S.warned = true;
  }
  if (S.grid) S.warned = false;

  S.soc = Math.max(0, Math.min(cap, S.soc));
  S.hist.push([solar, demand, S.soc / cap * 100]);
  S.hist = S.hist.slice(-144);

  S.cur = { solar, demand, served, batt, imported, curtailed, reserve, cap };
  S.h += DT;
}

/* ---------- render ---------- */
function cssv(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawReadout(){
  const c = S.cur || { solar:0, demand:0, served:0, batt:0, imported:0, curtailed:0, reserve:0, cap:+$("cap").value };
  const socPct  = S.soc / c.cap * 100;
  const runtime = (!S.grid && c.batt > 0) ? Math.max(0,(S.soc - c.reserve)*EFF/c.batt) : null;
  const billed  = S.loads.reduce((a,l) => a + l.kwh, 0) * +$("tar").value;
  const protVal = S.servedOut * +$("val").value;

  const items = [
    { l:"battery",       v:socPct.toFixed(0), u:"%",       s:`${S.soc.toFixed(0)} kWh`,
      cls: socPct < 20 ? "bad" : socPct < 40 ? "warn" : "" },
    { l:"runtime",       v: runtime==null ? "—" : runtime.toFixed(1), u:"h",
      s:"at this load" },
    { l:"essential held", v:S.essHours.toFixed(1), u:"h", s:`of ${S.outHours.toFixed(1)} h outage` },
    { l:"served in outage", v:S.servedOut.toFixed(0), u:"kWh", s:"delivered" },
    { l:"unserved",      v:S.unserved.toFixed(0), u:"kWh", s:"demand shed",
      cls: S.unserved > 0 ? "warn" : "" },
    { l:"outage value",  v:Math.round(protVal).toLocaleString(), u:"RWF", s:"protected*" },
    { l:"billed",        v:Math.round(billed).toLocaleString(), u:"RWF", s:"simulated ledger" }
  ];

  $("readout").innerHTML = items.map(it => `
    <div class="m ${it.cls||""}">
      <div class="lbl">${it.l}</div>
      <div class="v">${it.v}<small>${it.u}</small></div>
      <div class="lbl" style="text-transform:none;letter-spacing:0;margin-top:2px">${it.s}</div>
    </div>`).join("");

  $("simclock").textContent = `sim ${clock()}`;
}

function drawFlow(){
  const c = S.cur || { solar:0, demand:0, served:0, batt:0, imported:0, curtailed:0 };
  const svg = $("flowchart");
  const y = 56;

  const cLine2 = cssv("--line-2");
  const cInk   = cssv("--ink");
  const cInk2  = cssv("--ink-2");
  const cInk3  = cssv("--ink-3");
  const cGrn   = cssv("--grn");
  const cAmb   = cssv("--amb");
  const cBlu   = cssv("--blu");
  const cRed   = cssv("--red");

  const node = (x, w, title, big, sub, accent) => `
    <rect x="${x}" y="20" width="${w}" height="72" fill="none" stroke="${cLine2}"/>
    <rect x="${x}" y="20" width="${w}" height="2" fill="${accent}"/>
    <text x="${x+12}" y="42" fill="${cInk3}" font-size="10" letter-spacing="1.5">${title}</text>
    <text x="${x+12}" y="66" fill="${cInk}" font-size="20" font-weight="700">${big}</text>
    <text x="${x+12}" y="82" fill="${cInk2}" font-size="11">${sub}</text>`;

  const arrow = (x1, x2, hot) => `
    <line x1="${x1}" y1="${y}" x2="${x2-6}" y2="${y}" stroke="${hot ? cGrn : cLine2}" stroke-width="1.5"/>
    <polygon points="${x2-6},${y-4} ${x2},${y} ${x2-6},${y+4}" fill="${hot ? cGrn : cLine2}"/>`;

  const solarHot = c.solar > 0.1;
  const battHot  = Math.abs(c.batt) > 0.1;
  const battTxt  = c.batt > 0 ? "−" : c.batt < 0 ? "+" : "0";
  const battSub  = c.batt > 0 ? "discharging" : c.batt < 0 ? "charging" : "idle";
  const gridCol  = S.grid ? cGrn : cRed;

  svg.innerHTML =
    node( 10,150,"SOLAR",    c.solar.toFixed(1), "kW now",     cAmb) +
    arrow(170,220, solarHot) +
    node(230,150,"BATTERY",  battTxt + Math.abs(c.batt).toFixed(1), battSub, cGrn) +
    arrow(390,440, battHot || solarHot) +
    node(450,100,"LOADS",    c.served.toFixed(1), "kW served", cBlu) +
    `<line x1="305" y1="100" x2="305" y2="112" stroke="${gridCol}" stroke-width="1.5" stroke-dasharray="3 2"/>
     <text x="305" y="126" fill="${gridCol}" font-size="10" text-anchor="middle" letter-spacing="1">
       ${S.grid ? "GRID · IMPORT "+c.imported.toFixed(1)+" kW" : "GRID · OFFLINE"}
     </text>`;

  $("readline").innerHTML = `
    <span>demand <b>${c.demand} kW</b></span>
    <span>served <b>${c.served.toFixed(1)} kW</b></span>
    <span>curtailed <b>${c.curtailed.toFixed(1)} kW</b></span>
    <span>reserve <b>${Math.round(c.reserve / (+$("cap").value) * 100)}%</b></span>`;
}

function drawTable(){
  const tar = +$("tar").value;
  const rows = S.loads.map((l,i) => {
    const cls = !l.on ? "o" : l.live ? "p" : "s";
    const label = !l.on ? "off" : l.live ? "powered" : "shed";
    return `
      <tr>
        <td>${l.n}</td>
        <td class="tier">${TIER[l.tier]}</td>
        <td class="r">${l.kw}</td>
        <td><input type="checkbox" ${l.on?"checked":""} onchange="S.loads[${i}].on=this.checked"></td>
        <td><span class="pill ${cls}">${label}</span></td>
        <td class="r">${l.kwh.toFixed(1)}</td>
        <td class="r">${l.unkwh.toFixed(1)}</td>
        <td class="r">${Math.round(l.kwh*tar).toLocaleString()}</td>
      </tr>`;
  }).join("");
  const total = S.loads.reduce((a,l) => a + l.kwh, 0) * tar;
  $("tb").innerHTML = `
    <thead><tr>
      <th>customer</th><th>tier</th><th class="r">kW</th><th>on</th>
      <th>status</th><th class="r">served</th><th class="r">unserved</th><th class="r">bill</th>
    </tr></thead>
    <tbody>${rows}
      <tr class="total">
        <td colspan="7">total billed · simulated ledger</td>
        <td class="r">${Math.round(total).toLocaleString()}</td>
      </tr>
    </tbody>`;
}

function drawLog(){
  $("log").innerHTML = S.log.map(e =>
    `<div class="logrow"><span class="t">${e.t}</span><span class="m">${e.m}</span></div>`).join("");
}

function drawChart(){
  const cLine = cssv("--line");
  const cAmb  = cssv("--amb");
  const cBlu  = cssv("--blu");
  const cGrn  = cssv("--grn");

  const H = S.hist;
  const max = Math.max(20, ...H.map(h => Math.max(h[0], h[1])));
  const path = (idx, scale) =>
    H.map((h,j) => {
      const x = (j/143) * 560;
      const y = 116 - (h[idx]/scale) * 100;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

  $("chart").innerHTML = `
    <line x1="0" y1="116" x2="560" y2="116" stroke="${cLine}"/>
    <line x1="0" y1="66"  x2="560" y2="66"  stroke="${cLine}" stroke-dasharray="2 4"/>
    <line x1="0" y1="16"  x2="560" y2="16"  stroke="${cLine}" stroke-dasharray="2 4"/>
    <polyline fill="none" stroke="${cAmb}" stroke-width="1.4" points="${path(0, max)}"/>
    <polyline fill="none" stroke="${cBlu}" stroke-width="1.4" points="${path(1, max)}"/>
    <polyline fill="none" stroke="${cGrn}" stroke-width="1.4" stroke-dasharray="3 2" points="${path(2, 100)}"/>`;
}

function draw(){
  $("v1").textContent = $("solar").value + " kWp";
  $("v2").textContent = $("cap").value + " kWh";
  $("v3").textContent = $("cloud").value + "%";

  const mode = $("mode");
  mode.textContent = S.grid ? "GRID" : "ISLANDED";
  mode.className = "state " + (S.grid ? "ok" : "no");

  const play = $("play");
  play.textContent = S.play ? "PAUSE" : "PLAY";
  play.className = S.play ? "on" : "";

  const out = $("outage");
  out.textContent = S.grid ? "SIMULATE OUTAGE" : "RESTORE GRID";
  out.className = S.grid ? "stop" : "on";

  drawReadout();
  drawFlow();
  drawChart();
  drawTable();
  drawLog();
}

let timer;
function loop(){
  clearInterval(timer);
  timer = setInterval(() => { if (S.play){ step(); draw(); } }, 700 / +$("speed").value);
}

$("play").onclick    = () => { S.play = !S.play; draw(); };
$("outage").onclick  = () => { S.grid = !S.grid; if (!S.grid) S.loads.forEach(l => l.on = true); draw(); };
$("speed").onchange  = loop;
$("strat").onchange  = () => log("strategy · " + $("strat").selectedOptions[0].text.toLowerCase());
$("rs").onclick      = () => { reset(); draw(); };
$("s1").onclick      = () => { reset(11); $("cloud").value = 75; S.grid = false; draw(); };
$("s2").onclick      = () => { reset(19); $("cloud").value = 10; S.grid = false; draw(); };
["solar","cap","cloud","tar","val"].forEach(id => $(id).oninput = draw);

reset();
step();
draw();
loop();