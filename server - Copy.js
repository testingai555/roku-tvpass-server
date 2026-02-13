import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import { spawn } from "child_process";

/* ================= CONFIG ================= */
const PORT_UI = 3000;
const PORT_API = 8081;

const DATA_DIR = path.join(process.cwd(), "data");
const AS_FILE = path.join(DATA_DIR, "as.json");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");
const EPG_DIR = path.join(DATA_DIR, "epg");
const CHANNELS_BACKUP_DIR = path.join(DATA_DIR, "channels.backups");

const AUTO_REFRESH_MIN = 120;

/* ================= DIR SETUP ================= */
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EPG_DIR, { recursive: true });
fs.mkdirSync(CHANNELS_BACKUP_DIR, { recursive: true });

/* ================= APP ================= */
const uiApp = express();
const apiApp = express();

uiApp.use(cors());
uiApp.use(express.json());

apiApp.use(cors());
apiApp.use(express.json());

/* ================= STATE ================= */
let sseClients = [];
let epgLogs = [];

/* ================= UTILS ================= */
function slugify(str) {
  return (str || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function log(msg) {
  const time = new Date().toISOString();
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  epgLogs.push(entry);
  if (epgLogs.length > 1000) epgLogs.shift();

  sseClients.forEach(res => res.write(`data: ${entry}\n\n`));
}

/* ================= CHANNEL BACKUP ================= */
function backupChannelsFile() {
  if (!fs.existsSync(CHANNELS_FILE)) return;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(
    CHANNELS_BACKUP_DIR,
    `channels.${ts}.json`
  );

  fs.copyFileSync(CHANNELS_FILE, backupFile);
  log(`📦 Backup created: ${path.basename(backupFile)}`);
}

/* ================= ROLLBACK CLEANUP ================= */
function cleanupOldRollbacks() {
  const now = Date.now();
  const files = fs.readdirSync(CHANNELS_BACKUP_DIR)
    .filter(f => f.startsWith("channels.") && f.endsWith(".json"));

  let deletedFiles = [];

  files.forEach(f => {
    const filePath = path.join(CHANNELS_BACKUP_DIR, f);
    const stats = fs.statSync(filePath);
    const age = now - stats.mtimeMs; // age in ms
    if (age > 24 * 60 * 60 * 1000) { // older than 24 hours
      fs.unlinkSync(filePath);
      deletedFiles.push(f);
    }
  });

  if (deletedFiles.length > 0) {
    log(`🗑 Automatic cleanup: deleted ${deletedFiles.length} old rollback file(s)`);
  }
}

/* ================= EPG ================= */
function parseTimestamp(ts) {
  if (!ts) return null;
  const n = parseInt(ts);
  if (!isNaN(n)) {
    if (n > 1e9 && n < 1e12) return new Date(n * 1000);
    if (n > 1e12) return new Date(n);
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function getTodaysAndFutureEpgData(channelId, raw) {
  const now = new Date();
  const programs = (raw.programs || [])
    .map(p => {
      const start = parseTimestamp(p.start_time);
      const end = parseTimestamp(p.end_time) ||
        new Date(start.getTime() + 3600000);
      return {
        title: p.title || "Unknown",
        start: start.toISOString(),
        end: end.toISOString(),
        description: p.description || ""
      };
    })
    .filter(p => new Date(p.end) >= now)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  return { channel: channelId, programs };
}

function loadEpgData(id) {
  const file = path.join(EPG_DIR, `${slugify(id)}.json`);
  if (!fs.existsSync(file)) throw new Error("EPG not found");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/* ================= PYTHON SCRAPER ================= */
async function runPythonFetchEPG(channelId = null) {
  return new Promise(resolve => {
    const args = channelId ? [channelId] : [];
    const py = spawn("python", ["fetch_epg5.py", ...args]);

    py.stdout.on("data", d => log(`[PY] ${d.toString().trim()}`));
    py.stderr.on("data", d => log(`[PY ERR] ${d.toString().trim()}`));
    py.on("close", resolve);
  });
}

async function refreshChannels(target = null) {
  backupChannelsFile();
  await runPythonFetchEPG(target);
}

/* ================= UI ROUTES ================= */
uiApp.get("/", (req, res) => {
  const channels = fs.existsSync(CHANNELS_FILE)
    ? JSON.parse(fs.readFileSync(CHANNELS_FILE))
    : [];

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>IPTV Server</title>
<style>
body{font-family:Arial;background:#111;color:#eee;padding:20px}
.channel{padding:8px;border-bottom:1px solid #333}
button,select{margin:5px;padding:6px 10px}
#log{background:#000;padding:10px;height:400px;overflow:auto;margin-top:10px}
</style>
</head>
<body>
<h1>📡 IPTV Server</h1>

<a href="/channel-list.json">Channels</a> |
<a href="/playlist.m3u">Playlist</a>

<br><br>

<button onclick="refreshAll()">🔁 Refresh ALL</button>
<button onclick="clearLog()">🧹 Clear Log</button>

<br><br>

<select id="rollbackSelect">
<option value="">⏪ Rollback channels.json…</option>
</select>
<button onclick="rollback()">Restore</button>

<div id="log"></div>

${channels.map(c => `
<div class="channel">
${c.name}
<button onclick="refreshOne('${c.id}')">🔄</button>
</div>`).join("")}

<script>
const logDiv = document.getElementById("log");
const es = new EventSource("/events");
es.onmessage = e => logDiv.innerHTML = e.data + "<br>" + logDiv.innerHTML;

function refreshAll() {
  fetch("/api/scraper/refresh", { method: "POST" });
}
function refreshOne(id) {
  fetch("/api/scraper/refresh/" + id, { method: "POST" });
}
function clearLog() { logDiv.innerHTML = ""; }

async function loadRollbackList() {
  const r = await fetch("/api/channels/rollback/list");
  const files = await r.json();
  const sel = document.getElementById("rollbackSelect");
  sel.innerHTML = '<option value="">⏪ Rollback channels.json…</option>';
  files.forEach(f => {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    sel.appendChild(o);
  });
}

async function rollback() {
  const sel = document.getElementById("rollbackSelect");
  if (!sel.value) return;
  if (!confirm("Rollback to " + sel.value + "?")) return;
  await fetch("/api/channels/rollback/" + sel.value, { method: "POST" });
  loadRollbackList();
}

loadRollbackList();
</script>
</body>
</html>`);
});

uiApp.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  sseClients.push(res);
  req.on("close", () => sseClients = sseClients.filter(c => c !== res));
});

/* ================= SCRAPER ROUTES (LOCAL) ================= */
uiApp.post("/api/scraper/refresh", async (req, res) => {
  await refreshChannels();
  res.json({ started: true });
});

uiApp.post("/api/scraper/refresh/:id", async (req, res) => {
  await refreshChannels(req.params.id);
  res.json({ started: true });
});

/* ================= API PROXY (FIXED) ================= */
uiApp.use("/api", async (req, res) => {
  try {
    const targetUrl =
      `http://localhost:${PORT_API}` +
      req.originalUrl.replace(/^\/api/, "");

    const r = await fetch(targetUrl, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "GET" ? undefined : JSON.stringify(req.body)
    });

    const text = await r.text();
    res.status(r.status).send(text);
  } catch {
    res.status(500).send("API proxy error");
  }
});

/* ================= API SERVER ================= */
apiApp.get("/channel-list.json", (req, res) => {
  res.json(fs.existsSync(CHANNELS_FILE)
    ? JSON.parse(fs.readFileSync(CHANNELS_FILE))
    : []);
});

apiApp.get("/channels/rollback/list", (req, res) => {
  const files = fs.readdirSync(CHANNELS_BACKUP_DIR)
    .filter(f => f.startsWith("channels.") && f.endsWith(".json"))
    .sort()
    .reverse();
  res.json(files);
});

apiApp.post("/channels/rollback/:file", (req, res) => {
  const src = path.join(CHANNELS_BACKUP_DIR, req.params.file);
  if (!fs.existsSync(src)) return res.sendStatus(404);
  backupChannelsFile();
  fs.copyFileSync(src, CHANNELS_FILE);
  log(`⏪ Rolled back → ${req.params.file}`);
  res.json({ restored: true });
});

/* ================= AUTO ================= */
if (AUTO_REFRESH_MIN > 0) {
  setInterval(refreshChannels, AUTO_REFRESH_MIN * 60000);
}

// Automatic rollback cleanup every 24 hours
setInterval(cleanupOldRollbacks, 24 * 60 * 60 * 1000); // 24 hours in ms
cleanupOldRollbacks(); // Run once immediately on server start

/* ================= START ================= */
uiApp.listen(PORT_UI, () => log(`📡 UI http://localhost:${PORT_UI}`));
apiApp.listen(PORT_API, () => log(`📡 API http://localhost:${PORT_API}`));

