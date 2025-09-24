const express = require("express");
const fs = require("fs");
const { fork } = require("child_process");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_DIR = path.join(__dirname, "users");
const MAX_USERS = 20;

if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR);

app.use(express.static("public"));
app.use(express.json());

let processes = {}; // UID → bot process

// ✅ Start Bot
app.post("/start-bot", (req, res) => {
  const { appstate, admin } = req.body;

  if (!appstate || !admin) return res.send("❌ AppState or UID missing!");

  const userDir = path.join(USERS_DIR, admin);
  const currentUsers = fs.readdirSync(USERS_DIR).filter(uid =>
    fs.existsSync(path.join(USERS_DIR, uid, "appstate.json"))
  );

  if (!currentUsers.includes(admin) && currentUsers.length >= MAX_USERS) {
    return res.send("❌ Limit reached: Only 20 users allowed.");
  }

  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir);

  try {
    // Save appstate and UID
    fs.writeFileSync(path.join(userDir, "appstate.json"), JSON.stringify(JSON.parse(appstate), null, 2));
    fs.writeFileSync(path.join(userDir, "admin.txt"), admin);

    // Initialize logs
    const logFile = path.join(userDir, "logs.txt");
    fs.writeFileSync(logFile, "📂 Logs started...\n");

    // Kill if already running
    if (processes[admin]) processes[admin].kill();

    // Start bot
    const child = fork("bot.js", [admin]);

    // Pipe stdout and stderr into logs.txt
    child.stdout.on("data", data => {
      fs.appendFileSync(logFile, `[LOG] ${data.toString()}`);
    });

    child.stderr.on("data", data => {
      fs.appendFileSync(logFile, `[ERROR] ${data.toString()}`);
    });

    child.on("exit", code => {
      fs.appendFileSync(logFile, `\n🔴 Bot exited with code ${code}\n`);
      delete processes[admin];
    });

    processes[admin] = child;

    res.send(`✅ Bot started successfully for UID: ${admin}`);
  } catch (err) {
    console.error(err);
    res.send("❌ Invalid AppState JSON or Internal Error.");
  }
});

// ✅ Stop Bot
app.get("/stop-bot", (req, res) => {
  const { uid } = req.query;
  if (!uid || !processes[uid]) return res.send("⚠️ Bot not running.");
  processes[uid].kill();
  delete processes[uid];
  res.send(`🔴 Bot stopped for UID: ${uid}`);
});

// ✅ Logs
app.get("/logs", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.send("❌ UID missing.");
  const logPath = path.join(USERS_DIR, uid, "logs.txt");
  if (!fs.existsSync(logPath)) return res.send("📭 No logs yet.");
  res.send(fs.readFileSync(logPath, "utf8"));
});

app.listen(PORT, () => {
  console.log(`🚀 ANURAG X AROHI panel running at http://localhost:${PORT}`);
});
