const NOW = 16;            // abhi 4 PM (hours absolute: 16, 17, ... 40)
const CONSUMPTION = 0.18;  // kWh per km
const RESERVE = 0.15;      // 15% extra battery safety
const AGENT_LIST = ["Fleet", "Battery", "Route", "Price", "Charger", "Optimization"];
const EVENT_NAMES = {
  price: "Night tariff jumps",
  charger: "Charger CH-1 failed",
  battery: "EV-05 battery dropped",
  trip: "EV-03 emergency trip",
  newev: "New EV arrived"
};

let vehicles, chargers, priceMult;
let currentPlan = null;
let changedIds = [];
let runId = 0;             // purane animations ko rokne ke liye

function loadData() {
  vehicles = [
    { id: "EV-01", capacity: 40, soc: 0.20, health: 0.95, tripHour: 20, tripKm: 80,  priority: 3 },
    { id: "EV-02", capacity: 60, soc: 0.60, health: 0.92, tripHour: 30, tripKm: 120, priority: 1 },
    { id: "EV-03", capacity: 30, soc: 0.35, health: 0.90, tripHour: 22, tripKm: 50,  priority: 2 },
    { id: "EV-04", capacity: 40, soc: 0.15, health: 0.88, tripHour: 19, tripKm: 60,  priority: 3 },
    { id: "EV-05", capacity: 60, soc: 0.80, health: 0.97, tripHour: 34, tripKm: 90,  priority: 1 },
    { id: "EV-06", capacity: 40, soc: 0.45, health: 0.94, tripHour: 26, tripKm: 70,  priority: 2 },
    { id: "EV-07", capacity: 30, soc: 0.25, health: 0.91, tripHour: 21, tripKm: 40,  priority: 2 },
    { id: "EV-08", capacity: 60, soc: 0.30, health: 0.96, tripHour: 28, tripKm: 110, priority: 3 }
  ];
  chargers = [
    { id: "CH-1", kw: 60, up: true },
    { id: "CH-2", kw: 40, up: true },
    { id: "CH-3", kw: 30, up: true }
  ];
  priceMult = 1;
}

// Electricity price (Rs/kWh) for an hour
function price(hour) {
  const h = hour % 24;
  let base;
  if (h < 6) base = 6;
  else if (h < 10) base = 9;
  else if (h < 18) base = 7;
  else if (h < 22) base = 13;
  else base = 8;

  // Night tariff jump event: raat ke sasti hours mehnge ho jaate hain
  if (priceMult > 1 && h < 6) base = base * 2.5;
  return base;
}

function clock(hour) {
  return String(hour % 24).padStart(2, "0") + ":00";
}

// ---------- 2. ENERGY CALCULATIONS ----------
function targetSoc(v) {
  const usable = v.capacity * v.health;
  return Math.min(1, (v.tripKm * CONSUMPTION * 1.1) / usable + RESERVE);
}

function energyNeeded(v) {
  return Math.max(0, (targetSoc(v) - v.soc) * v.capacity);
}

// ---------- 3. OPTIMIZER ----------
function optimize() {
  const live = chargers.filter(c => c.up);

  if (live.length === 0) {
    return { schedule: [], totalCost: 0, naiveCost: 0, atRisk: vehicles.map(v => v.id), avgKw: 0 };
  }

  const avgKw = live.reduce((sum, c) => sum + c.kw, 0) / live.length;
  const n = live.length;

  const used = {};       // optimized plan: har hour mein kitne chargers busy
  const usedNaive = {};  // naive plan ke liye
  for (let h = NOW; h < NOW + 48; h++) { used[h] = 0; usedNaive[h] = 0; }

  const jobs = [];
  for (const v of vehicles) {
    const e = energyNeeded(v);
    if (e < 0.5) continue;                       // charging ki zarurat nahi
    const hrs = Math.ceil(e / avgKw);
    const slack = (v.tripHour - NOW) - hrs;      // kitna time bacha
    jobs.push({ v, e, hrs, slack });
  }

  // urgent pehle: high priority, phir kam slack
  jobs.sort((a, b) => b.v.priority - a.v.priority || a.slack - b.slack);

  const schedule = [];
  const atRisk = [];
  let totalCost = 0;
  let naiveCost = 0;

  for (const j of jobs) {
    const window = [];
    for (let h = NOW; h < j.v.tripHour; h++) {
      if (used[h] < n) window.push(h);
    }

    const feasible = window.length >= j.hrs;
    let chosen;
       if (feasible) {
      chosen = [...window].sort((a, b) => price(a) - price(b) || a - b).slice(0, j.hrs);
    } else {
      atRisk.push(j.v.id);
      chosen = window.slice(0, j.hrs);
    }
    chosen.sort((a, b) => a - b);
    chosen.forEach(h => used[h]++);

    const avgPrice = chosen.length ? chosen.reduce((s, h) => s + price(h), 0) / chosen.length : 0;
    const cost = j.e * avgPrice;
    totalCost += cost;

    // naive plan: abhi se lagatar charge
    let placed = 0, naiveSum = 0;
    for (let h = NOW; placed < j.hrs && h < NOW + 48; h++) {
      if (usedNaive[h] < n) { usedNaive[h]++; naiveSum += price(h); placed++; }
    }
    naiveCost += j.e * (naiveSum / Math.max(j.hrs, 1));

    schedule.push({
      id: j.v.id, slots: chosen, energy: j.e, target: targetSoc(j.v),
      cost, feasible, slack: j.slack, hrs: j.hrs, tripHour: j.v.tripHour, priority: j.v.priority
    });
  }

  return { schedule, totalCost, naiveCost, atRisk, avgKw };
}

// ---------- 4. AGENTS ----------
const agents = {
  Fleet: () => vehicles.length + " vehicles tracked",

  Price: () => {
    const all = [];
    for (let h = 0; h < 24; h++) all.push(price(h));
    return "Peak Rs " + Math.max(...all).toFixed(1) + ", cheapest Rs " + Math.min(...all).toFixed(1) + " per kWh";
  },

  Charger: () => {
    const up = chargers.filter(c => c.up);
    const kw = up.reduce((s, c) => s + c.kw, 0);
    return up.length + " of " + chargers.length + " chargers working, " + kw + " kW total";
  },

  Battery: () => {
    const crit = vehicles.filter(v => v.soc < 0.2).map(v => v.id);
    return crit.length + " critical (below 20%): " + (crit.join(", ") || "none");
  },

  Route: () => {
    const urgent = vehicles.filter(v => v.tripHour - NOW <= 6 && v.priority === 3).map(v => v.id);
    return urgent.length + " urgent high-priority trips: " + (urgent.join(", ") || "none");
  }
};

// Orchestrator: event ke hisaab se kaun se agents chalein
const routing = {
  price:   ["Price", "Optimization"],
  charger: ["Charger", "Optimization"],
  battery: ["Battery", "Route", "Optimization"],
  trip:    ["Route", "Battery", "Optimization"],
  newev:   ["Fleet", "Battery", "Optimization"]
};

// ---------- 5. EVENTS ----------
function applyEvent(name) {
  if (name === "price") priceMult = 1.4;
  if (name === "charger") chargers[0].up = false;
  if (name === "battery") vehicles.find(v => v.id === "EV-05").soc = 0.12;
  if (name === "trip") {
    const v = vehicles.find(v => v.id === "EV-03");
    v.tripHour = NOW + 2;
    v.priority = 3;
    v.tripKm = 100;
  }
  if (name === "newev") {
    if (!vehicles.find(v => v.id === "EV-09")) {
      vehicles.push({ id: "EV-09", capacity: 40, soc: 0.10, health: 0.93, tripHour: 20, tripKm: 90, priority: 3 });
    }
  }
}

// Hub aur scene ka status badalna
function setHub(thinking, text) {
  document.getElementById("hub").className = thinking ? "hub thinking" : "hub";
  document.getElementById("hubStatus").textContent = text;
  document.getElementById("scene").className = thinking ? "scene busy" : "scene";
}
// Text ko typewriter jaise type karna
function typeText(el, text, id) {
  let i = 0;
  function tick() {
    if (id !== runId) { el.textContent = text; return; }
    i++;
    el.textContent = text.slice(0, i);
    if (i < text.length) setTimeout(tick, 14);
  }
  tick();
}

function runEvent(name) {
  runId++;
  const my = runId;

  const oldPlan = optimize();
  applyEvent(name);
  const newPlan = optimize();

  // kaun si vehicles ka schedule badla
  changedIds = [];
  for (const s of newPlan.schedule) {
    const o = oldPlan.schedule.find(x => x.id === s.id);
    if (!o || o.slots.join() !== s.slots.join()) changedIds.push(s.id);
  }

  const box = document.getElementById("agents");
  box.innerHTML = "";
  const list = routing[name];
  const STEP = 1100;   // har agent ke beech milliseconds

  setHub(true, "Event: " + EVENT_NAMES[name] + ". Choosing which agents to run...");
  drawPipeline(null, [], true);

  list.forEach((agentName, i) => {
    setTimeout(() => {
      if (my !== runId) return;
      drawPipeline(agentName, list.slice(0, i), true);
      setHub(true, agentName + " Agent is working...");

      let text;
      if (agentName === "Optimization") {
        const diff = newPlan.totalCost - oldPlan.totalCost;
        text = "New plan Rs " + newPlan.totalCost.toFixed(0) + " (" + (diff >= 0 ? "+" : "") + diff.toFixed(0) +
               "), " + changedIds.length + " schedules changed, " + newPlan.atRisk.length + " at risk";
      } else {
        text = agents[agentName]();
      }

      const div = document.createElement("div");
      div.className = "step";
      div.innerHTML = "<b>" + agentName + " Agent</b><br><span></span>";
      box.appendChild(div);
      typeText(div.querySelector("span"), text, my);
    }, (i + 1) * STEP);
  });

  // sab agents ke baad
  setTimeout(() => {
    if (my !== runId) return;
    drawPipeline(null, list, false);
    setHub(false, "Plan updated: " + changedIds.length + " schedules changed, " + newPlan.atRisk.length + " trips at risk.");
  }, (list.length + 1) * STEP);

  currentPlan = newPlan;
  document.getElementById("why").innerHTML = "Click a vehicle in the plan.";
  render();
}

function resetAll() {
  runId++;
  loadData();
  changedIds = [];
  document.getElementById("agents").innerHTML = "No event yet.";
  document.getElementById("why").innerHTML = "Click a vehicle in the plan.";
  currentPlan = optimize();
  setHub(false, "Idle. Watching the fleet.");
  drawPipeline(null, [], false);
  render();
}

// ---------- 6. SCREEN PAR DIKHANA ----------
function render() {
  const p = currentPlan;
  const saved = Math.max(0, p.naiveCost - p.totalCost);
  const pct = p.naiveCost ? (saved / p.naiveCost * 100).toFixed(0) : 0;

  document.getElementById("summary").innerHTML =
    '<div class="card"><b>' + vehicles.length + '</b><span>EVs in fleet</span></div>' +
    '<div class="card"><b>Rs ' + p.totalCost.toFixed(0) + '</b><span>plan cost</span></div>' +
    '<div class="card"><b>Rs ' + saved.toFixed(0) + ' (' + pct + '%)</b><span>saved vs charge-now</span></div>' +
    '<div class="card"><b>' + p.atRisk.length + '</b><span>trips at risk</span></div>';

  // charging plan table
  let html = "<table><tr><th>EV</th><th>Charge hours</th><th>Energy</th><th>Cost</th><th>Status</th></tr>";
  for (const s of p.schedule) {
    const status = s.feasible ? '<span class="ok">On time</span>' : '<span class="risk">AT RISK</span>';
    html += '<tr class="click ' + (changedIds.includes(s.id) ? "changed" : "") + '" onclick="showWhy(\'' + s.id + '\')">' +
      "<td><b>" + s.id + "</b></td><td>" + s.slots.map(clock).join(", ") + "</td>" +
      "<td>" + s.energy.toFixed(1) + " kWh</td><td>Rs " + s.cost.toFixed(0) + "</td><td>" + status + "</td></tr>";
  }
  html += "</table>";
  document.getElementById("plan").innerHTML = html;

  // fleet table (battery bars ke saath)
  let f = "<table><tr><th>EV</th><th>Battery</th><th>Health</th><th>Trip</th><th>Priority</th></tr>";
  for (const v of vehicles) {
    const color = v.soc < 0.2 ? "#ff5d8f" : v.soc < 0.4 ? "#ffb020" : "#22d3a0";
    f += "<tr><td>" + v.id + "</td>" +
      '<td><span class="bar"><i style="width:' + (v.soc * 100) + "%;background:" + color + '"></i></span>' + Math.round(v.soc * 100) + "%</td>" +
      "<td>" + Math.round(v.health * 100) + "%</td>" +
      "<td>" + v.tripKm + " km at " + clock(v.tripHour) + "</td><td>" + ["", "Low", "Medium", "High"][v.priority] + "</td></tr>";
  }
  f += "</table>";
  document.getElementById("fleet").innerHTML = f;

  drawPrice();
  drawTimeline();
  drawBanner();
  drawExtras();
  drawBays();
}

function drawPrice() {
  let max = 0;
  for (let h = 0; h < 24; h++) max = Math.max(max, price(h));

  let html = "";
  for (let h = 0; h < 24; h++) {
    const p = price(h);
    html += '<div class="' + (p >= 13 ? "peak" : "") + '" style="height:' + (p / max * 100) + '%" title="' + h + ':00 Rs ' + p.toFixed(1) + '"></div>';
  }
  document.getElementById("priceChart").innerHTML = html;
}

function drawTimeline() {
  let html = '<table class="tl"><tr><th></th>';
  for (let h = NOW; h < NOW + 24; h++) html += "<th>" + (h % 24) + "</th>";
  html += "</tr>";

  for (const s of currentPlan.schedule) {
    html += "<tr><th>" + s.id + "</th>";
    for (let h = NOW; h < NOW + 24; h++) {
      let cls = "cell";
      if (s.slots.includes(h)) {
        cls += !s.feasible ? " bad" : price(h) >= 13 ? " peak" : " on";
      }
      html += '<td><div class="' + cls + '"></div></td>';
    }
    html += "</tr>";
  }
  html += "</table>";
  document.getElementById("timeline").innerHTML = html;
}

function drawBanner() {
  const p = currentPlan;
  const el = document.getElementById("banner");
  if (p.atRisk.length > 0) {
    el.className = "banner bad";
    el.innerHTML = "ALERT: " + p.atRisk.length + " trip(s) at risk: " + p.atRisk.join(", ") + ". Manager action needed.";
  } else {
    el.className = "banner good";
    el.innerHTML = "All " + vehicles.length + " vehicles will be ready on time.";
  }
}

function drawExtras() {
  const p = currentPlan;
  const total = vehicles.length;
  const pct = total ? Math.round((total - p.atRisk.length) / total * 100) : 0;
  const max = Math.max(p.naiveCost, p.totalCost, 1);

  document.getElementById("extras").innerHTML =
    '<div class="extrasRow">' +
      '<div class="ring" style="background:conic-gradient(#22d3a0 ' + (pct * 3.6) + 'deg, #ff5d8f 0)"><span>' + pct + '%</span></div>' +
      '<div class="bars">' +
        '<div>Charge-now plan: <b>Rs ' + p.naiveCost.toFixed(0) + '</b></div>' +
        '<div class="hb"><i style="width:' + (p.naiveCost / max * 100) + '%;background:#ff5d8f"></i></div>' +
        '<div>EV-FLOW plan: <b>Rs ' + p.totalCost.toFixed(0) + '</b></div>' +
        '<div class="hb"><i style="width:' + (p.totalCost / max * 100) + '%;background:#22d3a0"></i></div>' +
      '</div>' +
    '</div>' +
    '<div class="mut">Ring shows trips ready on time.</div>';
}

function drawBays() {
  const h = Number(document.getElementById("hourSlider").value);
  document.getElementById("hourLabel").innerHTML =
    "<b>" + clock(h) + "</b> | price Rs " + price(h).toFixed(1) + " per kWh";

  const live = chargers.filter(c => c.up);
  const charging = currentPlan.schedule.filter(s => s.slots.includes(h)).map(s => s.id);

  let html = "";
  for (const c of chargers) {
    if (!c.up) {
      html += '<div class="bay off"><b>' + c.id + '</b><br>' + c.kw + ' kW<br>OFFLINE</div>';
    } else {
      const ev = charging[live.indexOf(c)];
      if (ev) html += '<div class="bay busy"><b>' + c.id + '</b><br>' + c.kw + ' kW<br>' + ev + '</div>';
      else html += '<div class="bay free"><b>' + c.id + '</b><br>' + c.kw + ' kW<br>free</div>';
    }
  }
  document.getElementById("bays").innerHTML = html;
}

// active = abhi kaam karta agent, done = ho chuke agents, flowing = arrows blink karein ya nahi
function drawPipeline(active, done, flowing) {
  let html = '<span class="node brain">AI Orchestrator</span>';
  let activeSeen = false;
  for (const a of AGENT_LIST) {
    let cls = "node";
    let arrowCls = "arrow";
    if (a === active) {
      cls += " active";
      activeSeen = true;
      if (flowing) arrowCls += " live";
    } else if (done.includes(a)) {
      cls += " done";
    }
    html += '<span class="' + arrowCls + '">&#9654;</span><span class="' + cls + '">' + a + '</span>';
  }
  document.getElementById("pipeline").innerHTML = html;
}

function showWhy(id) {
  const s = currentPlan.schedule.find(x => x.id === id);
  const v = vehicles.find(x => x.id === id);
  let confidence = 100;
  if (!s.feasible) confidence -= 60;
  if (s.slack <= 2) confidence -= 10;

  let reason;
  if (!s.feasible) reason = "Cannot finish before departure with available chargers, so it charges as early as possible. Manager action needed.";
  else if (s.slack <= 1) reason = "Very little spare time, so it is scheduled early to protect the trip.";
  else reason = "Flexible departure, so charging is moved to the cheapest price hours.";

  document.getElementById("why").innerHTML =
    "<b>" + id + "</b><br>" +
    "Battery now: " + Math.round(v.soc * 100) + "% (health " + Math.round(v.health * 100) + "%)<br>" +
      "Trip: " + v.tripKm + " km, departs " + clock(v.tripHour) + "<br>" +
    "Target battery: " + Math.round(s.target * 100) + "% (" + s.energy.toFixed(1) + " kWh needed)<br>" +
    "Charging time: " + s.hrs + " h at " + currentPlan.avgKw.toFixed(0) + " kW<br>" +
    "Spare time: " + s.slack + " h<br>" +
    "Chosen hours: " + s.slots.map(clock).join(", ") + "<br>" +
    "Cost: Rs " + s.cost.toFixed(0) + "<br>" +
    "Confidence: " + confidence + "%<br><br>" + reason;
}

// ---------- START ----------
loadData();
currentPlan = optimize();
setHub(false, "Idle. Watching the fleet.");
drawPipeline(null, [], false);
render();
