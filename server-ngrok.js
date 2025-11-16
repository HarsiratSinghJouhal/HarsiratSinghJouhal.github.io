// server.js — FINAL Crowd Counter Server (single, batch, and event list)
// ---------------------------------------------------------------------

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const cors = require("cors");
const os = require("os");

// ---------------------------------------------------------------------
// IN-MEMORY STORAGE
// ---------------------------------------------------------------------
const memory = {};         // key -> value (counter, idempotency)
const eventsSet = new Set(); // keeps track of known event_ids

const getKey = (k) => memory[k];
const setKey = (k, v) => { memory[k] = String(v); };

const incrKey = (k, d = 1) => setKey(k, (parseInt(memory[k] || "0", 10) + d));
const decrKey = (k, d = 1) => setKey(k, Math.max(0, (parseInt(memory[k] || "0", 10) - d)));

const counterKey = (id) => `counter:${id}`;
const idempKey   = (id) => `idemp:${id}`;

// Ensure event exists in registry
function ensureEvent(eventId) {
  if (!eventId) return;
  if (!eventsSet.has(eventId)) {
    eventsSet.add(eventId);
    setKey(counterKey(eventId), 0);   // initialize counter
  }
}

// ---------------------------------------------------------------------
// EXPRESS / SOCKET.IO SETUP
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 8000;

const app = express();
app.use(cors());
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------

// ROOT
app.get("/", (req, res) => {
  res.send(`
    <h1>Crowd Counter Server</h1>
    <p>Health: <a href="/health">/health</a></p>
    <h3>Routes:</h3>
    <ul>
      <li>GET /v1/events</li>
      <li>POST /v1/events</li>
      <li>GET /v1/counter/:eventId</li>
      <li>POST /v1/counter/incr</li>
      <li>POST /v1/counter/decr</li>
      <li>POST /v1/counters/batch</li>
    </ul>
  `);
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ALL EVENTS LIST
app.get("/v1/events", (req, res) => {
  const events = [];
  eventsSet.forEach(eid => {
    const val = parseInt(getKey(counterKey(eid)) || "0", 10);
    events.push({ event_id: eid, livecount: val });
  });
  res.json({ events });
});

// CREATE NEW EVENT
app.post("/v1/events", (req, res) => {
  const { event_id } = req.body || {};
  if (!event_id) return res.status(400).json({ error: "event_id required" });

  ensureEvent(event_id);
  const val = parseInt(getKey(counterKey(event_id)) || "0", 10);

  io.emit("live_count_update", { event_id, livecount: val, created: true });
  res.json({ event_id, livecount: val });
});

// SINGLE GET COUNT
app.get("/v1/counter/:eventId", (req, res) => {
  const id = req.params.eventId;
  ensureEvent(id);
  const val = parseInt(getKey(counterKey(id)) || "0", 10);
  res.json({ event_id: id, livecount: val });
});

// SINGLE INCREMENT
app.post("/v1/counter/incr", (req, res) => {
  const { event_id, delta = 1, idempotency_key } = req.body || {};
  if (!event_id) return res.status(400).json({ error: "event_id required" });

  ensureEvent(event_id);

  // idempotency
  if (idempotency_key && getKey(idempKey(idempotency_key))) {
    const cur = parseInt(getKey(counterKey(event_id)) || "0", 10);
    return res.json({ event_id, livecount: cur, idempotent: true });
  }

  incrKey(counterKey(event_id), Number(delta));
  if (idempotency_key) setKey(idempKey(idempotency_key), "1");

  const newVal = parseInt(getKey(counterKey(event_id)) || "0", 10);

  io.emit("live_count_update", { event_id, livecount: newVal });
  res.json({ event_id, livecount: newVal });
});

// SINGLE DECREMENT
app.post("/v1/counter/decr", (req, res) => {
  const { event_id, delta = 1, idempotency_key } = req.body || {};
  if (!event_id) return res.status(400).json({ error: "event_id required" });

  ensureEvent(event_id);

  // idempotency
  if (idempotency_key && getKey(idempKey(idempotency_key))) {
    const cur = parseInt(getKey(counterKey(event_id)) || "0", 10);
    return res.json({ event_id, livecount: cur, idempotent: true });
  }

  decrKey(counterKey(event_id), Number(delta));
  if (idempotency_key) setKey(idempKey(idempotency_key), "1");

  const newVal = parseInt(getKey(counterKey(event_id)) || "0", 10);

  io.emit("live_count_update", { event_id, livecount: newVal });
  res.json({ event_id, livecount: newVal });
});

// ---------------------------------------------------------------------
// BATCH UPDATE ROUTE
// ---------------------------------------------------------------------
app.post("/v1/counters/batch", (req, res) => {
  const items = Array.isArray(req.body) ? req.body : null;
  if (!items) return res.status(400).json({ error: "expected JSON array" });

  const results = [];
  const touchedEvents = new Set();

  for (const it of items) {
    const event_id = it && it.event_id;
    const delta = Number(it && it.delta) || 0;
    const idempotency_key = it && it.idempotency_key;

    if (!event_id) {
      results.push({ error: "event_id required", item: it });
      continue;
    }

    ensureEvent(event_id);

    // idempotency
    if (idempotency_key && getKey(idempKey(idempotency_key))) {
      const cur = parseInt(getKey(counterKey(event_id)) || "0", 10);
      results.push({ event_id, livecount: cur, idempotent: true });
      continue;
    }

    // apply delta
    if (delta > 0) {
      incrKey(counterKey(event_id), delta);
    } else if (delta < 0) {
      const current = parseInt(getKey(counterKey(event_id)) || "0", 10);
      const newVal = Math.max(0, current + delta);
      setKey(counterKey(event_id), newVal);
    }

    if (idempotency_key) setKey(idempKey(idempotency_key), "1");

    const finalVal = parseInt(getKey(counterKey(event_id)) || "0", 10);
    results.push({ event_id, livecount: finalVal });
    touchedEvents.add(event_id);
  }

  // broadcast updates
  touchedEvents.forEach(eid => {
    const v = parseInt(getKey(counterKey(eid)) || "0", 10);
    io.emit("live_count_update", { event_id: eid, livecount: v, timestamp: Date.now() });
  });

  res.json({ results });
});

// ---------------------------------------------------------------------
// SOCKET SNAPSHOT
// ---------------------------------------------------------------------
io.on("connection", socket => {
  socket.on("subscribe_all", () => {
    const counts = {};
    eventsSet.forEach(eid => {
      counts[eid] = parseInt(getKey(counterKey(eid)) || "0", 10);
    });
    socket.emit("snapshot", { timestamp: Date.now(), counts });
  });
});

// ---------------------------------------------------------------------
// LAN HELPER + START SERVER
// ---------------------------------------------------------------------
function getLANIP() {
  const nets = os.networkInterfaces();
  for (const name in nets) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const HOSTNAME = os.hostname();
const LAN_IP = getLANIP();

server.listen(PORT, "0.0.0.0", () => {
  console.log("======================================================");
  console.log(" Crowd Counter server running");
  console.log(` Local : http://localhost:${PORT}/`);
  console.log(` LAN   : http://${LAN_IP}:${PORT}/`);
  console.log(" To expose externally: run in another terminal ->");
  console.log("     ngrok http 8000");
  console.log("======================================================");
});
