const fs = require("fs");
const path = require("path");
const HttpsProxyAgent = require("https-proxy-agent");
const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);

// === UID ARG ===
const uid = process.argv[2];
if (!uid) {
  console.error("❌ No UID provided to bot.js");
  process.exit(1);
}

const userDir = path.join(__dirname, "users", String(uid));
const appStatePath = path.join(userDir, "appstate.json");
const adminPath = path.join(userDir, "admin.txt");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Load appstate ---
let appState;
try {
  appState = JSON.parse(fs.readFileSync(appStatePath, "utf-8"));
} catch (e) {
  console.error("❌ Invalid appstate.json");
  process.exit(1);
}

// --- Load Admin UID ---
let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, "utf-8").trim();
} catch (e) {
  console.error("❌ Invalid admin.txt");
  process.exit(1);
}

// Proxy (optional)
const INDIAN_PROXY = process.env.INDIAN_PROXY || null; // set env if needed
let proxyAgent = null;
try {
  if (INDIAN_PROXY) proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch (e) {}

let api = null;

// State
let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;
let antiOutEnabled = false;

// === Cache for deleted messages ===
// store { messageID: { sender, body, ts, threadID } }
const messageCache = {};

// helper to extract message id robustly
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

async function setNickSafe(nick, threadID, uidToChange) {
  return new Promise(async (resolve) => {
    try {
      await new Promise((r) =>
        api.changeNickname(nick, threadID, uidToChange, (err) => {
          if (err) log(`❌ Nick change failed for ${uidToChange}: ${err}`);
          r();
        })
      );
      setTimeout(() => {
        try {
          api.changeNickname(nick, threadID, uidToChange, (err) => {
            if (!err) log(`🔐 Nick enforced for ${uidToChange}`);
            resolve();
          });
        } catch {
          resolve();
        }
      }, 800);
    } catch {
      resolve();
    }
  });
}

async function setTitleSafe(title, threadID) {
  try {
    await new Promise((r) =>
      api.setTitle(title, threadID, (err) => {
        if (err) log("❌ setTitle failed: " + err);
        r();
      })
    );
    setTimeout(() => {
      try {
        api.setTitle(title, threadID, (err) => {
          if (!err) log("🔒 GC Title enforced");
        });
      } catch {}
    }, 900);
  } catch {}
}

function parseMentionTarget(event) {
  try {
    // if mentions is object with keys = uids
    if (event.mentions && typeof event.mentions === "object") {
      const keys = Object.keys(event.mentions);
      if (keys.length > 0) return keys[0];
    }
    // message reply
    if (event.messageReply && event.messageReply.senderID) {
      return String(event.messageReply.senderID);
    }
  } catch {}
  return null;
}

// helper: detect whether a thread is group-like
function isGroupThreadInfo(info) {
  try {
    if (!info) return false;
    if (Array.isArray(info.userInfo) && info.userInfo.length > 2) return true;
    if (typeof info.participantIDs === "object" && Object.keys(info.participantIDs).length > 2) return true;
    if (typeof info.participantsCount === "number" && info.participantsCount > 2) return true;
  } catch {}
  return false;
}

// Start
function startBot() {
  login(
    {
      appState,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0",
      agent: proxyAgent,
    },
    (err, a) => {
      if (err) {
        console.error("❌ LOGIN FAILED: " + err);
        process.exit(1);
      }

      api = a;
      api.setOptions({ listenEvents: true, selfListen: true });

      log("🤖 BOT ONLINE");

      // Anti-sleep (keeps presence active)
      setInterval(() => {
        if (GROUP_THREAD_ID) {
          try {
            api.sendTypingIndicator(GROUP_THREAD_ID, true);
            setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
            log("💤 Anti-Sleep Triggered");
          } catch {}
        }
      }, 300000);

      // Save appstate periodically
      setInterval(() => {
        try {
          const st = api.getAppState ? api.getAppState() : appState;
          fs.writeFileSync(appStatePath, JSON.stringify(st, null, 2));
          log("💾 AppState saved");
        } catch {}
      }, 600000);

      // Listen
      api.listenMqtt(async (err, event) => {
        if (err) return log("❌ Listen error: " + err);

        const senderID = String(event.senderID || "");
        const threadID = String(event.threadID || "");
        const bodyRaw = event.body || "";
        const body = (bodyRaw || "").toLowerCase();

        // ----- Cache incoming messages for unsend detection -----
        const incomingMsgId = extractMsgId(event);
        if (event.type === "message" && incomingMsgId) {
          messageCache[incomingMsgId] = {
            sender: senderID,
            body: bodyRaw,
            ts: Date.now(),
            threadID
          };
          // keep cache for 30 minutes
          setTimeout(() => delete messageCache[incomingMsgId], 1000 * 60 * 30);
        }

        // ----- Commands (admin only) -----
        if (body === "help" && senderID === BOSS_UID) {
          const msg = `
📜 COMMANDS:
🔒 /gclock <name> → Lock GC name
🧹 /gcremove → Remove GC name + Auto-remove ON
🔐 /nicklock on <nick> → Lock nickname
🔓 /nicklock off → Unlock nickname
💥 /nickremoveall → Clear all nicks + Auto-remove
🛑 /nickremoveoff → Stop auto nick remove
📌 /setnick @user <nick> → Set nick (or reply + /setnick <nick>)
⚙️ /antion → Enable anti-out
🛑 /antioff → Disable anti-out
🕵️ /status → Show bot status
📍 /uid → Show this threadID and your UID`;
          return api.sendMessage(msg.trim(), threadID);
        }

        // --------- NEW: /uid command (works in group & personal) ----------
        if (body === "/uid") {
          try {
            // send in same thread (works for group & personal)
            await api.sendMessage(`📌 Thread ID: ${threadID}\n👤 Your UID: ${senderID}`, threadID);
          } catch (e) {
            log("❌ /uid send failed: " + e);
          }
          // continue processing other events
          if (!event.type) return;
        }

        // /gclock
        if (body.startsWith("/gclock") && senderID === BOSS_UID) {
          const newName = bodyRaw.slice(7).trim();
          if (!newName) return api.sendMessage("❌ Provide a name", threadID);
          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = newName;
          gcAutoRemoveEnabled = false;
          await setTitleSafe(newName, threadID);
          return api.sendMessage(`🔒 GC locked as "${newName}"`, threadID);
        }

        // /gcremove
        if (body === "/gcremove" && senderID === BOSS_UID) {
          await setTitleSafe("", threadID);
          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = null;
          gcAutoRemoveEnabled = true;
          return api.sendMessage("🧹 GC name removed. Auto-remove ON", threadID);
        }

        // /nicklock on
        if (body.startsWith("/nicklock on") && senderID === BOSS_UID) {
          const requested = bodyRaw.split(" ").slice(2).join(" ").trim();
          if (!requested) return api.sendMessage("❌ Provide a nickname", threadID);
          lockedNick = `${requested} — Locked by ANURAG MISHRA`;
          nickLockEnabled = true;
          try {
            const info = await api.getThreadInfo(threadID);
            for (const u of info.userInfo) {
              await setNickSafe(lockedNick, threadID, u.id);
            }
            log(`🔐 NickLock applied: ${lockedNick}`);
            return api.sendMessage(`🔐 Nickname locked as "${lockedNick}"`, threadID);
          } catch (e) {
            log("❌ Error applying nicklock: " + e);
            return api.sendMessage("❌ Error applying nicklock");
          }
        }

        // /nicklock off
        if (body === "/nicklock off" && senderID === BOSS_UID) {
          nickLockEnabled = false;
          lockedNick = null;
          return api.sendMessage("🔓 NickLock OFF", threadID);
        }

        // /nickremoveall
        if (body === "/nickremoveall" && senderID === BOSS_UID) {
          nickRemoveEnabled = true;
          try {
            const info = await api.getThreadInfo(threadID);
            for (const u of info.userInfo) {
              await setNickSafe("", threadID, u.id);
            }
            return api.sendMessage("💥 All nicknames cleared. Auto-remove ON", threadID);
          } catch (e) {
            log("❌ Error clearing nicks: " + e);
            return api.sendMessage("❌ Error clearing nicks");
          }
        }

        // /nickremoveoff
        if (body === "/nickremoveoff" && senderID === BOSS_UID) {
          nickRemoveEnabled = false;
          return api.sendMessage("🛑 Auto nick remove OFF", threadID);
        }

        // /setnick (mention or reply)
        if (body.startsWith("/setnick") && senderID === BOSS_UID) {
          const target = parseMentionTarget(event);
          let requestedNick = bodyRaw.split(" ").slice(1).join(" ").trim();
          if (event.mentions) {
            // remove mention display name from raw text (best-effort)
            const mentionNames = Object.values(event.mentions).map(v => (typeof v === 'string' ? v : (v.name || ''))).filter(Boolean);
            if (mentionNames.length > 0) requestedNick = requestedNick.replace(mentionNames[0], "").trim();
          }
          if (!target && !event.messageReply) return api.sendMessage("❌ Mention or reply required", threadID);
          if (!requestedNick) return api.sendMessage("❌ Provide nickname", threadID);
          const victimId = target || String(event.messageReply.senderID);
          const finalNick = `${requestedNick} — Locked by ANURAG MISHRA`;
          await setNickSafe(finalNick, threadID, victimId);
          return api.sendMessage(`✅ Nick set for ${victimId}`, threadID);
        }

        // /antion
        if (body === "/antion" && senderID === BOSS_UID) {
          antiOutEnabled = true;
          return api.sendMessage("✅ Anti-Out ENABLED", threadID);
        }

        // /antioff
        if (body === "/antioff" && senderID === BOSS_UID) {
          antiOutEnabled = false;
          return api.sendMessage("🛑 Anti-Out DISABLED", threadID);
        }

        // /status
        if (body === "/status" && senderID === BOSS_UID) {
          const msg = `
BOT STATUS:
• GC Lock: ${LOCKED_GROUP_NAME || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• NickLock: ${nickLockEnabled ? lockedNick : "OFF"}
• NickRemove: ${nickRemoveEnabled ? "ON" : "OFF"}
• Anti-Out: ${antiOutEnabled ? "ON" : "OFF"}`;
          return api.sendMessage(msg.trim(), threadID);
        }

        // ----- Protections & Event handlers -----

        // thread name changed
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

        // nickname changed
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

        // user removed/left (anti-out) — **ROBUST FIXED**: try multiple fields, detect group, notify admin on failure
        if (
          ["log:unsubscribe", "log:remove", "log:remove-participant", "log:user-left"].includes(event.logMessageType)
          || event.logMessageType?.includes("remove")
        ) {
          try {
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
              log(`⚠️ Detected leave/remove: ${leftUID} in ${threadID} (antiOutEnabled=${antiOutEnabled})`);

              // If antiOut not enabled, just notify admin (don't auto-add)
              if (!antiOutEnabled) {
                try { await api.sendMessage(`⚠️ ${leftUID} left group ${threadID} (anti-out disabled)`, BOSS_UID); } catch {}
              } else {
                // Ensure it's a group before adding
                let isGroup = false;
                try {
                  const info = await api.getThreadInfo(threadID);
                  isGroup = isGroupThreadInfo(info);
                } catch (e) {
                  // fallback: treat long threadIDs as group (best-effort)
                  isGroup = (String(threadID).length > 10);
                }

                if (!isGroup) {
                  log("ℹ️ Not a group thread — skipping addUserToGroup");
                  try { await api.sendMessage(`⚠️ ${leftUID} left personal chat ${threadID}`, BOSS_UID); } catch {}
                } else {
                  try {
                    await api.addUserToGroup(String(leftUID), threadID);
                    await api.sendMessage(`🚨 Anti-Out: Added back ${leftUID}`, threadID);
                    log(`🚨 Anti-Out: Added back ${leftUID} to ${threadID}`);
                  } catch (e) {
                    log("❌ Anti-out addUserToGroup failed: " + e);
                    // notify admin with brief error
                    try {
                      await api.sendMessage(`❌ Anti-Out failed to add ${leftUID} back to ${threadID}. Check bot permissions.`, BOSS_UID);
                    } catch (ee) { log("❌ Notify admin failed: " + ee); }
                  }
                }
              }
            }
          } catch (e) {
            log("❌ Error handling anti-out event: " + e);
          }
        }

        // ===== Unsend / deleted message detection (now shows only text if cached) =====
        const isUnsendEvent =
          event.type === "message_unsend" ||
          event.logMessageType === "log:thread-message-deleted" ||
          event.logMessageType === "log:message_unsend" ||
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

            // fallback: try find most recent cached message by same sender (last 30 min)
            if (!cached && unsendBy) {
              let candidate = null;
              const now = Date.now();
              for (const [mid, entry] of Object.entries(messageCache)) {
                if (String(entry.sender) === String(unsendBy) && (now - entry.ts) < (1000 * 60 * 30)) {
                  if (!candidate || entry.ts > candidate.entry.ts) candidate = { mid, entry };
                }
              }
              if (candidate) {
                deletedMessageId = candidate.mid;
                cached = candidate.entry;
              }
            }

            // SEND ONLY TEXT (no messageID printed)
            if (cached && cached.body && cached.body.trim() !== "") {
              const txt = `🗑️ Deleted message: "${cached.body}"`;
              try { await api.sendMessage(txt, threadID); } catch (e) { log("❌ send failed unsend text: " + e); }
              log(`🗑️ Unsend by ${unsendBy} in ${threadID} — "${cached.body}"`);
            } else {
              const txt = `🗑️ A message was deleted (content not cached).`;
              try { await api.sendMessage(txt, threadID); } catch (e) { log("❌ send failed unsend generic: " + e); }
              log(`🗑️ Unsend by ${unsendBy} in ${threadID} — content not cached`);
            }
          } catch (e) {
            log("❌ Error handling unsend event: " + e);
          }
        }

      }); // end listenMqtt
    }
  );
}

startBot();
