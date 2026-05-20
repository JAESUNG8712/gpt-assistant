const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const aiRouter     = require("./routes/ai");
const syncRouter   = require("./routes/sync");
const engineRouter = require("./routes/engine");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, "data", "hr_data.json");
const BACKUP_DIR = path.join(__dirname, "data", "backups");
const MAX_BACKUPS = 20;
const MAX_ACTIVITY_LOGS = 1000;

// ── Init data directory ──────────────────────────────────────────────────────
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ── State ────────────────────────────────────────────────────────────────────
let _dataVersion = 0;
let _lastSaved = null;
let _activityLog = [];
let _locks = {};           // { lockKey: { clientId, user, acquiredAt, expiresAt } }
let _sseClients = {};      // { clientId: { res, user, connectedAt } }

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  _lastSaved = new Date().toISOString();
  _dataVersion++;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const fpath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fpath);
      let meta = {};
      try {
        const d = JSON.parse(fs.readFileSync(fpath, "utf8"));
        meta = d._meta || {};
      } catch {}
      return {
        name: f,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        label: meta.label || f,
        type: meta.type || "manual",
        empCount: meta.empCount || 0,
        kpiCount: meta.kpiCount || 0,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function createBackup(data, label = "manual", type = "manual") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `backup_${ts}_${type}.json`;
  const fpath = path.join(BACKUP_DIR, filename);
  const backupData = {
    ...data,
    _meta: {
      label,
      type,
      createdAt: new Date().toISOString(),
      empCount: (data.employees || []).length,
      kpiCount: (data.kpiEntries || []).length,
    },
  };
  fs.writeFileSync(fpath, JSON.stringify(backupData, null, 2), "utf8");

  // Prune oldest if over limit
  const backups = listBackups();
  if (backups.length > MAX_BACKUPS) {
    const toDelete = backups.slice(MAX_BACKUPS);
    for (const b of toDelete) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch {}
    }
  }
  return filename;
}

// Smart merge: prefer newer employee/kpi records by updatedAt
function smartMerge(serverData, clientData) {
  if (!serverData) return clientData;

  const merged = { ...serverData, ...clientData };

  // Merge employees by id, prefer newer updatedAt
  const empMap = {};
  for (const e of (serverData.employees || [])) empMap[e.id] = e;
  for (const e of (clientData.employees || [])) {
    const existing = empMap[e.id];
    if (!existing) { empMap[e.id] = e; continue; }
    const serverTs = existing.updatedAt || existing.createdAt || "";
    const clientTs = e.updatedAt || e.createdAt || "";
    if (clientTs >= serverTs) empMap[e.id] = e;
  }
  merged.employees = Object.values(empMap);

  // Merge kpiEntries by id
  const kpiMap = {};
  for (const k of (serverData.kpiEntries || [])) kpiMap[k.id] = k;
  for (const k of (clientData.kpiEntries || [])) {
    const existing = kpiMap[k.id];
    if (!existing) { kpiMap[k.id] = k; continue; }
    const serverTs = existing.updatedAt || existing.createdAt || "";
    const clientTs = k.updatedAt || k.createdAt || "";
    if (clientTs >= serverTs) kpiMap[k.id] = k;
  }
  merged.kpiEntries = Object.values(kpiMap);

  return merged;
}

function broadcastSSE(eventName, payload, excludeClientId = null) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [cid, client] of Object.entries(_sseClients)) {
    if (cid === excludeClientId) continue;
    try { client.res.write(msg); } catch {}
  }
}

function addActivityLog(entry) {
  _activityLog.unshift({ ...entry, id: Date.now() + Math.random(), ts: new Date().toISOString() });
  if (_activityLog.length > MAX_ACTIVITY_LOGS) _activityLog = _activityLog.slice(0, MAX_ACTIVITY_LOGS);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/ai", aiRouter);
app.use("/sync", syncRouter);
app.use("/engine", engineRouter);

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /status — server health and meta
app.get("/status", (req, res) => {
  const data = loadData();
  res.json({
    ok: true,
    version: _dataVersion,
    meta: {
      lastSaved: _lastSaved,
      empCount: (data?.employees || []).length,
      kpiCount: (data?.kpiEntries || []).length,
    },
    onlineCount: Object.keys(_sseClients).length,
  });
});

// GET /data — return full data
app.get("/data", (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ ok: false, message: "데이터 없음" });
  res.json({ ok: true, data, version: _dataVersion });
});

// POST /save — save data (with smart merge if conflict)
app.post("/save", (req, res) => {
  const clientData = req.body;
  if (!clientData || typeof clientData !== "object") {
    return res.status(400).json({ ok: false, message: "잘못된 데이터" });
  }

  const serverData = loadData();
  let finalData = clientData;
  let merged = false;

  // Detect conflict: server was modified by another client
  if (serverData && clientData._version !== undefined && clientData._version < _dataVersion) {
    finalData = smartMerge(serverData, clientData);
    merged = true;
  }

  finalData._version = _dataVersion + 1;
  saveData(finalData);

  const meta = {
    empCount: (finalData.employees || []).length,
    kpiCount: (finalData.kpiEntries || []).length,
    lastSaved: _lastSaved,
  };

  // Notify other clients
  broadcastSSE("data_updated", { version: _dataVersion, meta }, req.query.clientId);

  res.json({ ok: true, version: _dataVersion, merged, mergedData: merged ? finalData : undefined, meta });
});

// GET /events — SSE stream for real-time sync
app.get("/events", (req, res) => {
  const clientId = req.query.clientId || `client_${Date.now()}`;
  const user = req.query.user || "unknown";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  _sseClients[clientId] = { res, user, connectedAt: new Date().toISOString() };

  // Send welcome event
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, version: _dataVersion })}\n\n`);

  // Notify others user joined
  broadcastSSE("user_online", { clientId, user, action: "join" }, clientId);

  // Heartbeat every 20s
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch { clearInterval(heartbeat); }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    delete _sseClients[clientId];
    broadcastSSE("user_online", { clientId, user, action: "leave" });
  });
});

// GET /online — list online users
app.get("/online", (req, res) => {
  const users = Object.entries(_sseClients).map(([cid, c]) => ({
    clientId: cid,
    user: c.user,
    connectedAt: c.connectedAt,
  }));
  res.json({ ok: true, users });
});

// POST /lock — acquire edit lock
app.post("/lock", (req, res) => {
  const { lockKey, clientId, user, ttlMs = 30000 } = req.body;
  if (!lockKey || !clientId) return res.status(400).json({ ok: false, message: "lockKey, clientId 필요" });

  const existing = _locks[lockKey];
  if (existing && existing.clientId !== clientId && Date.now() < existing.expiresAt) {
    return res.json({ ok: false, lockedBy: existing.user, expiresAt: existing.expiresAt });
  }

  _locks[lockKey] = { clientId, user, acquiredAt: Date.now(), expiresAt: Date.now() + ttlMs };
  broadcastSSE("lock_acquired", { lockKey, user }, clientId);
  res.json({ ok: true, lockKey });
});

// POST /unlock — release lock
app.post("/unlock", (req, res) => {
  const { lockKey, clientId } = req.body;
  if (!lockKey) return res.status(400).json({ ok: false });

  const existing = _locks[lockKey];
  if (existing && existing.clientId === clientId) {
    delete _locks[lockKey];
    broadcastSSE("lock_released", { lockKey });
  }
  res.json({ ok: true });
});

// POST /log — append activity log entry
app.post("/log", (req, res) => {
  const entry = req.body;
  if (!entry) return res.status(400).json({ ok: false });
  addActivityLog(entry);
  res.json({ ok: true });
});

// GET /activity — retrieve activity log
app.get("/activity", (req, res) => {
  const limit = parseInt(req.query.limit) || 300;
  res.json({ ok: true, logs: _activityLog.slice(0, limit) });
});

// GET /backups — list backup files
app.get("/backups", (req, res) => {
  res.json({ ok: true, backups: listBackups() });
});

// POST /restore — restore from a backup
app.post("/restore", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, message: "name 필요" });

  const fpath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(fpath)) return res.status(404).json({ ok: false, message: "백업 없음" });

  try {
    // Backup current state before restore
    const current = loadData();
    if (current) createBackup(current, "복원 전 자동 백업", "before_restore");

    const backupData = JSON.parse(fs.readFileSync(fpath, "utf8"));
    const { _meta, ...restoreData } = backupData;
    restoreData._version = _dataVersion + 1;
    saveData(restoreData);

    broadcastSSE("data_restored", { name, version: _dataVersion });
    res.json({ ok: true, version: _dataVersion });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// POST /backups/create — manually trigger a backup
app.post("/backups/create", (req, res) => {
  const { label = "수동 백업", type = "manual" } = req.body;
  const data = loadData();
  if (!data) return res.status(404).json({ ok: false, message: "데이터 없음" });
  const name = createBackup(data, label, type);
  res.json({ ok: true, name, backups: listBackups() });
});

// ── Fallback SPA ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Auto-import watch (checks sync folder every 30s) ─────────────────────────
const syncService = require('./services/sync');
let _lastImportMtime = null;

function watchSyncFolder() {
  try {
    const file = syncService.IPAD_IMPORT_FILE;
    if (!fs.existsSync(file)) return;
    const mtime = fs.statSync(file).mtime.getTime();
    if (_lastImportMtime !== null && mtime !== _lastImportMtime) {
      console.log('[Sync] iPad 내보내기 파일 변경 감지 → 자동 가져오기 시작');
      syncService.importIPad(file)
        .then(r => console.log(`[Sync] 자동 가져오기 완료: ${r.imported}개`))
        .catch(e => console.error('[Sync] 가져오기 오류:', e.message));
    }
    _lastImportMtime = mtime;
  } catch {}
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, "0.0.0.0", () => {
  const localIPs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) localIPs.push(iface.address);
    }
  }
  console.log("\n=== AI Assistant Server Started ===");
  console.log("PC   : http://localhost:" + PORT + "/ai-chat.html");
  if (localIPs.length > 0) {
    console.log("iPad : http://" + localIPs[0] + ":" + PORT + "/ai-chat.html");
    if (localIPs.length > 1) localIPs.slice(1).forEach(ip => console.log("     : http://" + ip + ":" + PORT + "/ai-chat.html"));
  }
  console.log("Data : " + DATA_FILE);
  console.log("Sync : http://localhost:" + PORT + "/sync.html");
  console.log("===================================\n");
  setInterval(watchSyncFolder, 30000);
  watchSyncFolder();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("[ERROR] Port " + PORT + " is already in use.");
    console.error("        Run: netstat -ano | findstr :" + PORT);
    console.error("        Then stop the process using that port.");
  } else {
    console.error("[ERROR]", err.message);
  }
  process.exit(1);
});
