// Support relay: the client's machine texting Orion.
//
// Two directions, both deliberate:
//   client -> Orion   the TUI's "Request an update" and the bot's /orion command
//                     push straight into Orion's Telegram, tagged with which
//                     client machine sent it.
//   Orion -> client   Orion's own Telegram user ID is an admin on the client's
//                     bot, so he just DMs that bot to answer, check /status, or
//                     run /diag remotely. Nothing on this machine ever polls
//                     Orion's bot, so one client's box can never read another
//                     client's support traffic.
//
// If the Mac is offline or Telegram is down the message is spooled to disk and
// retried by the scheduler. A support request must not be able to vanish.
import os from "node:os";
import { api } from "./telegram.mjs";
import { read, write } from "./store.mjs";
import { loadEnv } from "./env.mjs";
loadEnv();

const CLIENT = () => process.env.CLIENT_NAME || os.hostname();
const TOKEN = () => process.env.ORION_RELAY_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT = () => process.env.ORION_TELEGRAM_CHAT_ID;

export const relayConfigured = () => !!(TOKEN() && CHAT());

export function isAdmin(userId) {
  const ids = String(process.env.ORION_ADMIN_TELEGRAM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(String(userId));
}

async function push(text) {
  if (!relayConfigured()) return { ok: false, description: "relay not configured" };
  return api(TOKEN())("sendMessage", {
    chat_id: CHAT(),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// kind is just a label that shows up in Orion's Telegram: help | update | alert | reply
export async function toOrion(message, { kind = "help", from = "" } = {}) {
  const icon = { help: "🆘", update: "🛠", alert: "🚨", reply: "💬" }[kind] || "📨";
  const text = `${icon} <b>${kind.toUpperCase()}</b> from <b>${CLIENT()}</b>${from ? ` (${from})` : ""}\n` +
               `<i>${new Date().toLocaleString()}</i>\n\n${message}`;
  const res = await push(text);
  if (!res.ok) {
    spool(text);
    return { ok: false, spooled: true, description: res.description };
  }
  return { ok: true };
}

const OUTBOX = "relay-outbox";
function spool(text) {
  const box = read(OUTBOX, []);
  box.push({ text, at: new Date().toISOString(), tries: 0 });
  write(OUTBOX, box.slice(-200));
}

// Called on every scheduler tick. Drains what it can, keeps what it can't, and
// gives up on an item after 20 failures so a permanently bad token doesn't
// build an infinite backlog.
export async function flushOutbox() {
  const box = read(OUTBOX, []);
  if (!box.length || !relayConfigured()) return { sent: 0, left: box.length };
  const left = [];
  let sent = 0;
  for (const item of box) {
    const res = await push(item.text);
    if (res.ok) sent++;
    else if (item.tries < 20) left.push({ ...item, tries: item.tries + 1 });
  }
  write(OUTBOX, left);
  return { sent, left: left.length };
}

// One-shot alerts that must not spam. Same key won't re-fire within `withinMin`.
export async function alertOnce(key, message, withinMin = 180) {
  const seen = read("relay-alerts", {});
  const last = seen[key] ? new Date(seen[key]).getTime() : 0;
  if (Date.now() - last < withinMin * 60000) return { ok: true, skipped: true };
  seen[key] = new Date().toISOString();
  write("relay-alerts", seen);
  return toOrion(message, { kind: "alert" });
}
