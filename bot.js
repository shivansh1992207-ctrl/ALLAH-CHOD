const fs = require("fs");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");
let fca = null;

// Try to require a recommended/modern FCA implementation.
// You can change 'nexus-fca' to another package if you prefer (e.g. 'aminul-fca', '@jikey/fcazero', etc).
try {
  fca = require("nexus-fca"); // recommended: Nexus-FCA (install from npm)
} catch (e) {
  console.error("❌ Could not require 'nexus-fca'. Install it: npm i nexus-fca");
  process.exit(1);
}

// === UID ARG ===
const uid = process.argv[2];
if (!uid) {
  console.error("❌ No UID provided to bot-v2.js");
  process.exit(1);
}

const userDir = path.join(__dirname, "users", String(uid));
const appStatePath = path.join(userDir, "appstate.json");
const adminPath = path.join(userDir, "admin.txt");

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// --- Load appstate ---
let appState;
try {
  appState = JSON.parse(fs.readFileSync(appStatePath, "utf-8"));
} catch (e) {
  console.error("❌ Invalid or missing appstate.json");
  process.exit(1);
}

// --- Load Admin UID ---
let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, "utf-8").trim();
} catch (e) {
  console.error("❌ Invalid or missing admin.txt");
  process.exit(1);
}

// Proxy (optional)
const INDIAN_PROXY = process.env.INDIAN_PROXY || null;
let proxyAgent = null;
try {
  if (INDIAN_PROXY) proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch (e) {
  // ignore proxy parse failures
}

// --- Bot State ---
let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;
let antiOutEnabled = false;

// Cache for deleted messages (simple)
const messageCache = new Map();

// helper to extract various message id shapes
function extractMsgId(ev) {
  return (
    ev.messageID ||
    ev.message_id ||
    (ev.message && (ev.message.mid || ev.message.messageID || ev.message.message_id)) ||
    ev.logMessageData?.messageID ||
    ev.logMessageData?.message_id ||
    null
  );
}

// Safe setter utilities: try multiple times, swallow errors but log them
async function safeRetry(fn, desc = "operation", attempts = 2, delayMs = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      if (i > 0) log(`✅ ${desc} succeeded on attempt ${i + 1}`);
      return true;
    } catch (err) {
      log(`⚠️ ${desc} failed attempt ${i + 1}: ${err}`);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  log(`❌ ${desc} failed after ${attempts} attempts`);
  return false;
}

// set nickname in a safe manner
async function setNickSafe(nick, threadID, uidToChange) {
  await safeRetry(async () => {
    // Nexus-FCA style API assumed: client.setNickname(nick, threadID, uid, callback) OR promise
    if (typeof api.setNickname === "function") {
      await new Promise((res, rej) => {
        api.setNickname(nick, threadID, uidToChange, (err) => (err ? rej(err) : res()));
      });
    } else if (typeof api.changeNickname === "function") {
      await new Promise((res) => {
        api.changeNickname(nick, threadID, uidToChange, () => res());
      });
    } else {
      // fallback: try generic api.setProfile for some libs (noop if not supported)
      throw new Error("setNickname/changeNickname not supported by this FCA client");
    }
  }, `SetNick for ${uidToChange} -> "${nick}"`, 3, 700);
}

// set title safe
async function setTitleSafe(title, threadID) {
  await safeRetry(async () => {
    if (typeof api.setTitle === "function") {
      await new Promise((res, rej) => {
        api.setTitle(title, threadID, (err) => (err ? rej(err) : res()));
      });
    } else if (typeof api.setThreadTitle === "function") {
      await new Promise((res) => api.setThreadTitle(threadID, title, () => res()));
    } else {
      throw new Error("setTitle / setThreadTitle not supported by this FCA client");
    }
  }, `SetTitle "${title}"`, 3, 900);
}

function parseMentionTarget(event) {
  try {
    if (event.mentions && typeof event.mentions === "object") {
      const keys = Object.keys(event.mentions);
      if (keys.length > 0) return keys[0];
    }
    if (event.messageReply && event.messageReply.senderID) {
      return String(event.messageReply.senderID);
    }
  } catch {}
  return null;
}

function isGroupThreadInfo(info) {
  try {
    if (!info) return false;
    if (Array.isArray(info.userInfo) && info.userInfo.length > 2) return true;
    if (typeof info.participantIDs === "object" && Object.keys(info.participantIDs).length > 2) return true;
    if (typeof info.participantsCount === "number" && info.participantsCount > 2) return true;
  } catch {}
  return false;
}

// Anti-sleep: keep sending typing occasionally to avoid inactivity (only if group set)
function antiSleepLoop() {
  setInterval(() => {
    if (GROUP_THREAD_ID) {
      try {
        api.sendTypingIndicator(GROUP_THREAD_ID, true);
        setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1200);
        log("💤 Anti-Sleep Triggered");
      } catch (e) { /* ignore */ }
    }
  }, 60000);
}

// Start and login
let api = null;

async function startBot() {
  // Use the client's login / createClient method. Nexus-FCA may accept { appState, agent }.
  try {
    api = await new Promise((resolve, reject) => {
      // adapt to either callback or promise style
      const opts = {
        appState,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0",
        agent: proxyAgent
      };

      // Many FCA forks export a function like login(opts, cb) or createClient(opts). Try both.
      try {
        const maybe = fca(opts, (err, client) => {
          if (err) return reject(err);
          resolve(client);
        });
        // if the call returned a promise-like with then, use it
        if (maybe && typeof maybe.then === "function") {
          maybe.then(client => resolve(client)).catch(err => reject(err));
        }
      } catch (e) {
        // try alternative API
        try {
          if (typeof fca.createClient === "function") {
            fca.createClient(opts).then(resolve).catch(reject);
          } else {
            reject(e);
          }
        } catch (e2) {
          reject(e2);
        }
      }
    });
  } catch (err) {
    console.error("❌ LOGIN FAILED:", err);
    process.exit(1);
  }

  // set some safe options if provider supports them
  try {
    if (api.setOptions) api.setOptions({ listenEvents: true, selfListen: true });
  } catch {}

  log("🤖 BOT ONLINE (v2)");

  antiSleepLoop();

  // periodic save of appState (best-effort)
  setInterval(async () => {
    try {
      const st = api.getAppState ? api.getAppState() : appState;
      fs.writeFileSync(appStatePath, JSON.stringify(st, null, 2));
      log("💾 AppState saved");
    } catch (e) { /* ignore */ }
  }, 10 * 60 * 1000);

  // Listen to events (many FCA forks provide listen/stream/subscribe)
  const listenFn = api.listen || api.listenMqtt || api.streamEvents || api.on;
  if (!listenFn) {
    log("⚠️ This FCA client does not expose a listen() method; event-driven features may not work.");
  }

  // adapt event listener based on API style
  if (typeof api.listenMqtt === "function") {
    api.listenMqtt((err, event) => eventHandler(err, event));
  } else if (typeof api.listen === "function") {
    api.listen((err, event) => eventHandler(err, event));
  } else if (typeof api.on === "function") {
    api.on("event", event => eventHandler(null, event));
  } else {
    log("⚠️ No known listener method found on the FCA client.");
  }
}

// main event handler (keeps logic same as your original features)
async function eventHandler(err, event) {
  if (err) return log("❌ Listen error: " + err);

  const senderID = String(event.senderID || "");
  const threadID = String(event.threadID || "");
  const bodyRaw = event.body || "";
  const body = (bodyRaw || "").toLowerCase();

  const incomingMsgId = extractMsgId(event);
  if (event.type === "message" && incomingMsgId) {
    messageCache[incomingMsgId] = {
      sender: senderID,
      body: bodyRaw,
      ts: Date.now(),
      threadID
    };
    // keep 30m cache
    setTimeout(() => delete messageCache[incomingMsgId], 1000 * 60 * 30);
  }

  // ADMIN HELP
  if (body === "help" && senderID === BOSS_UID) {
    const msg = `
📜 COMMANDS:
🔒 /gclock  → Lock GC name
🧹 /gcremove → Remove GC name + Auto-remove ON
🔐 /nicklock on <nick>  → Lock nickname
🔓 /nicklock off → Unlock nickname
💥 /nickremoveall → Clear all nicks + Auto-remove ON
🛑 /nickremoveoff → Stop auto nick remove
📌 /setnick @user <nick> → Set nick (or reply + /setnick <nick>)
⚙️ /antion → Enable anti-out
🛑 /antioff → Disable anti-out
🕵️ /status → Show bot status
📍 /uid → Show this threadID and your UID
    `;
    return api.sendMessage(msg.trim(), threadID);
  }

  if (body === "/uid") {
    try { await api.sendMessage(`📌 Thread ID: ${threadID}\n👤 Your UID: ${senderID}`, threadID); } catch {}
  }

  // GCLOCK
  if (body.startsWith("/gclock") && senderID === BOSS_UID) {
    const newName = bodyRaw.slice(7).trim();
    if (!newName) return api.sendMessage("❌ Provide a name", threadID);
    GROUP_THREAD_ID = threadID;
    LOCKED_GROUP_NAME = newName;
    gcAutoRemoveEnabled = false;
    await setTitleSafe(newName, threadID);
    return api.sendMessage(`🔒 GC locked as "${newName}"`, threadID);
  }

  if (body === "/gcremove" && senderID === BOSS_UID) {
    await setTitleSafe("", threadID);
    GROUP_THREAD_ID = threadID;
    LOCKED_GROUP_NAME = null;
    gcAutoRemoveEnabled = true;
    return api.sendMessage("🧹 GC name removed. Auto-remove ON", threadID);
  }

  // NICKLOCK
  if (body.startsWith("/nicklock on") && senderID === BOSS_UID) {
    const requested = bodyRaw.split(" ").slice(2).join(" ").trim();
    if (!requested) return api.sendMessage("❌ Provide a nickname", threadID);
    lockedNick = requested;
    nickLockEnabled = true;
    try {
      const info = await api.getThreadInfo(threadID);
      if (info && Array.isArray(info.userInfo)) {
        for (const u of info.userInfo) {
          await setNickSafe(lockedNick, threadID, u.id);
        }
      }
      return api.sendMessage(`🔐 Nickname locked as "${lockedNick}"`, threadID);
    } catch (e) {
      log("❌ Error applying nicklock: " + e);
      return api.sendMessage("❌ Error applying nicklock");
    }
  }

  if (body === "/nicklock off" && senderID === BOSS_UID) {
    nickLockEnabled = false;
    lockedNick = null;
    return api.sendMessage("🔓 NickLock OFF", threadID);
  }

  if (body === "/nickremoveall" && senderID === BOSS_UID) {
    nickRemoveEnabled = true;
    try {
      const info = await api.getThreadInfo(threadID);
      if (info && Array.isArray(info.userInfo)) {
        for (const u of info.userInfo) {
          await setNickSafe("", threadID, u.id);
        }
      }
      return api.sendMessage("💥 All nicknames cleared. Auto-remove ON", threadID);
    } catch (e) {
      log("❌ Error clearing nicks: " + e);
      return api.sendMessage("❌ Error clearing nicks");
    }
  }

  if (body === "/nickremoveoff" && senderID === BOSS_UID) {
    nickRemoveEnabled = false;
    return api.sendMessage("🛑 Auto nick remove OFF", threadID);
  }

  // setnick
  if (body.startsWith("/setnick") && senderID === BOSS_UID) {
    const target = parseMentionTarget(event);
    let requestedNick = bodyRaw.split(" ").slice(1).join(" ").trim();
    if (!target && !event.messageReply) return api.sendMessage("❌ Mention or reply required", threadID);
    if (!requestedNick) return api.sendMessage("❌ Provide nickname", threadID);
    const victimId = target || String(event.messageReply.senderID);
    await setNickSafe(requestedNick, threadID, victimId);
    return api.sendMessage(`✅ Nick set for ${victimId}`, threadID);
  }

  // ANTI-OUT
  if (body === "/antion" && senderID === BOSS_UID) {
    antiOutEnabled = true;
    return api.sendMessage("✅ Anti-Out ENABLED", threadID);
  }
  if (body === "/antioff" && senderID === BOSS_UID) {
    antiOutEnabled = false;
    return api.sendMessage("🛑 Anti-Out DISABLED", threadID);
  }

  if (body === "/status" && senderID === BOSS_UID) {
    const msg = `
BOT STATUS:
• GC Lock: ${LOCKED_GROUP_NAME || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• NickLock: ${nickLockEnabled ? lockedNick : "OFF"}
• NickRemove: ${nickRemoveEnabled ? "ON" : "OFF"}
• Anti-Out: ${antiOutEnabled ? "ON" : "OFF"}
    `;
    return api.sendMessage(msg.trim(), threadID);
  }

  // Event protections & logs (adapt to event fields)
  try {
    // thread name changes
    if (event.logMessageType === "log:thread-name") {
      const changed = event.logMessageData?.name || "";
      if (LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && changed !== LOCKED_GROUP_NAME) {
        await setTitleSafe(LOCKED_GROUP_NAME, threadID);
        log(`🔒 GC name reverted to "${LOCKED_GROUP_NAME}"`);
      } else if (gcAutoRemoveEnabled && changed !== "") {
        await setTitleSafe("", threadID);
        log(`🧹 GC name auto-removed: ${changed}`);
      }
    }

    // nickname changes
    if (event.logMessageType === "log:user-nickname" || event.logMessageType === "log:user-nick") {
      const changedUID = event.logMessageData?.participant_id || event.logMessageData?.participantID;
      const newNick = event.logMessageData?.nickname || "";
      if (nickLockEnabled && lockedNick && newNick !== lockedNick) {
        await setNickSafe(lockedNick, threadID, changedUID);
        log(`🔐 Nick reverted for ${changedUID}`);
      }
      if (nickRemoveEnabled && newNick !== "") {
        await setNickSafe("", threadID, changedUID);
        log(`💥 Nick auto-removed for ${changedUID}`);
      }
    }

    // anti-out handling: when someone removed/left
    if (
      ["log:unsubscribe", "log:remove", "log:remove-participant", "log:user-left"].includes(event.logMessageType)
      || (typeof event.logMessageType === "string" && event.logMessageType.includes("remove"))
    ) {
      const leftUID =
        event.logMessageData?.leftParticipantFbId ||
        event.logMessageData?.leftParticipantId ||
        event.logMessageData?.user_id ||
        event.logMessageData?.actorFbId ||
        event.logMessageData?.participantId ||
        event.logMessageData?.authorId ||
        null;
      if (!leftUID) {
        log("⚠️ Anti-out event but leftUID not found");
      } else {
        log(`⚠️ Detected leave/remove: ${leftUID} in ${threadID} (antiOut=${antiOutEnabled})`);
        if (antiOutEnabled) {
          try {
            const info = await api.getThreadInfo(threadID);
            if (isGroupThreadInfo(info)) {
              await api.addUserToGroup(String(leftUID), threadID);
              await api.sendMessage(`🚨 Anti-Out: Added back ${leftUID}`, threadID);
              log(`🚨 Anti-Out: Added back ${leftUID} to ${threadID}`);
            }
          } catch (e) {
            log("❌ Anti-out addUserToGroup failed: " + e);
          }
        }
      }
    }

    // unsend detection
    const isUnsendEvent =
      event.type === "message_unsend" ||
      event.logMessageType === "log:thread-message-deleted" ||
      event.logMessageType === "log:message_unsend";

    if (isUnsendEvent) {
      try {
        const unsendBy =
          event.senderID ||
          event.logMessageData?.actorFbId ||
          event.logMessageData?.authorId ||
          event.logMessageData?.adminId ||
          null;

        let deletedMessageId =
          extractMsgId(event) || event.logMessageData?.messageID || event.logMessageData?.message_id || null;

        let cached = deletedMessageId ? messageCache[deletedMessageId] : null;
        if (!cached && unsendBy) {
          // search for recent message from same sender
          const now = Date.now();
          let candidate = null;
          for (const [mid, entry] of Object.entries(messageCache)) {
            const item = entry;
            if (String(item.sender) === String(unsendBy) && (now - item.ts) < (1000 * 60 * 30)) {
              if (!candidate || item.ts > candidate.ts) candidate = { mid, entry: item };
            }
          }
          if (candidate) {
            deletedMessageId = candidate.mid;
            cached = candidate.entry;
          }
        }

        if (cached && cached.body && cached.body.trim() !== "") {
          const txt = `🗑️ Deleted message: "${cached.body}"`;
          try { await api.sendMessage(txt, threadID); } catch {}
          log(`🗑️ Unsend by ${unsendBy} in ${threadID} — "${cached.body}"`);
        } else {
          const txt = `🗑️ A message was deleted (content not cached).`;
          try { await api.sendMessage(txt, threadID); } catch {}
          log(`🗑️ Unsend by ${unsendBy} in ${threadID} — content not cached`);
        }
      } catch (e) {
        log("❌ Error handling unsend event: " + e);
      }
    }
  } catch (e) {
    log("❌ Error in event handling: " + e);
  }
}

// Start
startBot().catch(err => {
  console.error("❌ startBot error:", err);
  process.exit(1);
});
