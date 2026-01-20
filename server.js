import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== REQUIRED ENV =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;           // your webhook verify token
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; // page token with IG perms
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;       // dashboard password


// ===== SIMPLE STORAGE (JSON FILE) =====
const DATA_FILE = "./data.json";

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      dm_text: "Thanks for commenting ✅ Here’s the link: https://yourlink.com",
      sent_keys: {}, // { "mediaId:fromId": timestamp }
      logs: []       // recent activity
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function addLog(data, type, msg, extra = {}) {
  data.logs.unshift({
    time: new Date().toISOString(),
    type,
    msg,
    ...extra
  });
  // keep last 200 logs
  data.logs = data.logs.slice(0, 200);
}

let DB = loadData();

// ===== MIDDLEWARE =====
app.use(express.json());

// ===== META WEBHOOK VERIFY (GET) =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== SEND PRIVATE REPLY (DM) =====
async function sendPrivateReply(comment_id, message) {
  // Private replies endpoint
  const url = `https://graph.facebook.com/v20.0/${comment_id}/private_replies`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      access_token: PAGE_ACCESS_TOKEN
    })
  });

  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}

// ===== WEBHOOK RECEIVE (POST) =====
app.post("/webhook", async (req, res) => {
  // always acknowledge quickly
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "instagram") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Typical comment payload fields:
        const comment_id = value.id;
        const media_id = value.media?.id;
        const from_id = value.from?.id;

        if (!comment_id || !media_id || !from_id) continue;

        // ANTI-SPAM: only once per user per post
        const key = `${media_id}:${from_id}`;
        if (DB.sent_keys[key]) {
          addLog(DB, "skip", "Already messaged for this post", { key });
          continue;
        }

        // Send DM to EVERY comment
        const message = DB.dm_text || "Thanks for commenting ✅";
        await sendPrivateReply(comment_id, message);

        DB.sent_keys[key] = Date.now();
        addLog(DB, "sent", "DM sent via private reply", { key, comment_id });

        saveData(DB);
      }
    }
  } catch (err) {
    addLog(DB, "error", "Webhook processing failed", { error: String(err?.message || err) });
    saveData(DB);
  }
});

// ===== WEBSITE / DASHBOARD =====
function requireAuth(req, res) {
  const pass = req.query.pass || req.headers["x-admin-pass"];
  if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) {
    res.status(401).send("Unauthorized. Add ?pass=YOUR_PASSWORD");
    return false;
  }
  return true;
}

app.get("/", (req, res) => {
  res.send(`✅ IG Comment Auto-DM is running.
- Webhook: /webhook
- Dashboard: /admin?pass=YOUR_PASSWORD`);
});

app.get("/admin", (req, res) => {
  if (!requireAuth(req, res)) return;

  const safeText = (DB.dm_text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const logsHtml = (DB.logs || [])
    .map(l => `<li><b>${l.type}</b> — ${l.time}<br/>${l.msg}<br/><small>${JSON.stringify(l)}</small></li>`)
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>IG Auto DM Dashboard</title>
        <style>
          body { font-family: Arial; padding: 16px; max-width: 900px; margin: auto; }
          textarea { width: 100%; height: 120px; padding: 10px; font-size: 16px; }
          button { padding: 10px 14px; font-size: 16px; cursor: pointer; }
          .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; margin: 12px 0; }
          ul { padding-left: 18px; }
          li { margin: 12px 0; }
          small { color: #666; }
        </style>
      </head>
      <body>
        <h2>Instagram Comment ➜ Auto DM</h2>

        <div class="card">
          <h3>DM Message (sent to everyone who comments)</h3>
          <form method="POST" action="/admin/save?pass=${encodeURIComponent(req.query.pass)}">
            <textarea name="dm_text">${safeText}</textarea>
            <br/><br/>
            <button type="submit">Save Message</button>
          </form>
          <p><small>Anti-spam: only once per user per post.</small></p>
        </div>

        <div class="card">
          <h3>Recent Logs</h3>
          <ul>${logsHtml || "<li>No logs yet</li>"}</ul>
        </div>
      </body>
    </html>
  `);
});

// parse form without extra libs
app.use(express.urlencoded({ extended: true }));

app.post("/admin/save", (req, res) => {
  if (!requireAuth(req, res)) return;

  const dm_text = (req.body.dm_text || "").trim();
  DB.dm_text = dm_text.length ? dm_text : DB.dm_text;
  addLog(DB, "config", "DM text updated");
  saveData(DB);

  res.redirect(`/admin?pass=${encodeURIComponent(req.query.pass)}`);
});

app.post("/admin/reset", (req, res) => {
  if (!requireAuth(req, res)) return;

  DB.sent_keys = {};
  addLog(DB, "config", "sent_keys reset");
  saveData(DB);

  res.send("Reset done.");
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
