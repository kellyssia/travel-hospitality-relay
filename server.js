const express = require("express");
const cors = require("cors");
const multer = require("multer");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const app = express();

// IMPORTANT on Render / proxies: makes req.protocol honor X-Forwarded-Proto
app.set("trust proxy", 1);

// --- Config ---
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || "6");
const PHOTO_TTL_MINUTES = Number(process.env.PHOTO_TTL_MINUTES || "30");

function getFirstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function summarizeForError(text, max = 500) {
  if (!text) return "";
  const compact = String(text).replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

async function getSalesforceSession() {
  const directAccessToken = getFirstEnv("SF_ACCESS_TOKEN", "SALESFORCE_ACCESS_TOKEN");
  const directInstanceUrl = getFirstEnv("SF_INSTANCE_URL", "SALESFORCE_INSTANCE_URL");
  if (directAccessToken && directInstanceUrl) {
    return { accessToken: directAccessToken, instanceUrl: directInstanceUrl };
  }

  const loginUrl = getFirstEnv("SF_LOGIN_URL", "SALESFORCE_LOGIN_URL") || "https://login.salesforce.com";
  const clientId = getFirstEnv("SF_CLIENT_ID", "SALESFORCE_CLIENT_ID");
  const clientSecret = getFirstEnv("SF_CLIENT_SECRET", "SALESFORCE_CLIENT_SECRET");
  const username = getFirstEnv("SF_USERNAME", "SALESFORCE_USERNAME");
  const password = getFirstEnv("SF_PASSWORD", "SALESFORCE_PASSWORD");
  const securityToken = getFirstEnv("SF_SECURITY_TOKEN", "SALESFORCE_SECURITY_TOKEN");

  const missing = [];
  if (!clientId) missing.push("SF_CLIENT_ID/SALESFORCE_CLIENT_ID");
  if (!clientSecret) missing.push("SF_CLIENT_SECRET/SALESFORCE_CLIENT_SECRET");
  if (!username) missing.push("SF_USERNAME/SALESFORCE_USERNAME");
  if (!password) missing.push("SF_PASSWORD/SALESFORCE_PASSWORD");
  if (missing.length) {
    throw new Error(`Missing Salesforce auth env vars: ${missing.join(", ")}`);
  }

  const tokenEndpoint = `${loginUrl.replace(/\/$/, "")}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password: `${password}${securityToken}`
  });

  const authResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const authText = await authResponse.text();
  if (!authResponse.ok) {
    throw new Error(`Salesforce auth failed (${authResponse.status}): ${summarizeForError(authText)}`);
  }

  let authJson;
  try {
    authJson = authText ? JSON.parse(authText) : {};
  } catch {
    throw new Error("Salesforce auth returned invalid JSON.");
  }

  if (!authJson.access_token || !authJson.instance_url) {
    throw new Error("Salesforce auth response missing access_token or instance_url.");
  }

  return {
    accessToken: authJson.access_token,
    instanceUrl: authJson.instance_url
  };
}

// Allow audience + monitor sites (or be permissive for demo)
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

// Ensure uploads folder exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve uploaded images
app.use("/uploads", express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
  }
}));

// Health check (Render)
app.get("/", (req, res) => {
  res.status(200).send("Relay is up ✅");
});

app.get("/demo-config", async (req, res) => {
  const demoKeyRaw = typeof req.query.demoKey === "string" ? req.query.demoKey : "";
  const demoKey = demoKeyRaw.trim() || "KERZNER";

  try {
    const { accessToken, instanceUrl } = await getSalesforceSession();
    const endpoint = `${instanceUrl.replace(/\/$/, "")}/services/apexrest/demo-config?demoKey=${encodeURIComponent(demoKey)}`;

    const sfResponse = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    const sfText = await sfResponse.text();
    if (!sfResponse.ok) {
      return res.status(500).json({
        error: "Failed to fetch demo config from Salesforce.",
        status: sfResponse.status,
        detail: summarizeForError(sfText)
      });
    }

    let payload;
    try {
      payload = sfText ? JSON.parse(sfText) : {};
    } catch {
      return res.status(500).json({
        error: "Salesforce demo-config response was not valid JSON.",
        detail: summarizeForError(sfText)
      });
    }

    return res.json(payload);
  } catch (err) {
    console.error("Demo config proxy error:", err);
    return res.status(500).json({
      error: "Demo config proxy failed.",
      detail: err && err.message ? err.message : String(err)
    });
  }
});

// --- Multer config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const sessionId = (req.body && req.body.sessionId) ? String(req.body.sessionId) : "unknown";
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

    const ext = (() => {
      const original = file.originalname || "";
      const fromName = path.extname(original).toLowerCase();
      if (fromName && fromName.length <= 6) return fromName;
      if (file.mimetype === "image/png") return ".png";
      if (file.mimetype === "image/webp") return ".webp";
      return ".jpg";
    })();

    const stamp = Date.now();
    const rand = Math.random().toString(16).slice(2);
    cb(null, `${safeSession}_${stamp}_${rand}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image uploads are allowed."));
    }
    cb(null, true);
  }
});

// --- Upload endpoint ---
app.post("/upload", upload.single("photo"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.get("host");
    const photoUrl = `${proto}://${host}/uploads/${encodeURIComponent(req.file.filename)}`;

    res.json({ photoUrl });
  } catch (err) {
    res.status(500).json({ error: "Upload failed.", detail: String(err && err.message ? err.message : err) });
  }
});

// --- Create HTTP server so WS and Express share port ---
const server = http.createServer(app);

// --- WebSocket relay ---
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function broadcast(data, exceptWs = null) {
  const msg = typeof data === "string" ? data : JSON.stringify(data);
  for (const ws of clients) {
    if (ws !== exceptWs && ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

wss.on("connection", (ws, req) => {
  clients.add(ws);

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    const text = buf.toString("utf8");
    const payload = safeJsonParse(text);

    if (!payload) return;

    payload.serverTs = new Date().toISOString();

    broadcast(payload, null);
  });

  ws.on("close", () => {
    clients.delete(ws);
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

// Keepalive / cleanup dead sockets (important on hosted services)
const interval = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

wss.on("close", () => clearInterval(interval));

// --- Photo cleanup job (TTL-based) ---
function purgeOldPhotos() {
  const now = Date.now();
  const ttlMs = PHOTO_TTL_MINUTES * 60 * 1000;

  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;

    files.forEach((file) => {
      const fullPath = path.join(UPLOAD_DIR, file);
      fs.stat(fullPath, (err2, stat) => {
        if (err2 || !stat) return;
        const age = now - stat.mtimeMs;
        if (age > ttlMs) {
          fs.unlink(fullPath, () => {});
        }
      });
    });
  });
}

setInterval(purgeOldPhotos, 5 * 60 * 1000);

// --- Start ---
server.listen(PORT, () => {
  console.log(`Relay listening on port ${PORT}`);
  console.log(`WS: ws://localhost:${PORT}/ws`);
  console.log(`Upload: http://localhost:${PORT}/upload`);
});
