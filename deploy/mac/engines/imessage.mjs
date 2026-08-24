// iMessage engine — sends through the Mac's own Messages.app, and reads the
// local chat.db to notice replies.
//
// This is the highest-consequence engine in the bundle: everything it sends
// goes out under the owner's real phone number, to a real person, with no undo.
// So it never sends on its own initiative — other engines draft into the
// approval queue, and only bot.mjs, after a human taps the approve button,
// calls send() here.
//
// Requires, once, on the Mac:
//   - Messages.app signed in to iCloud
//   - Automation permission: whatever app runs node may control Messages
//   - Full Disk Access for that same app, to read ~/Library/Messages/chat.db
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/log.mjs";
import { read, write } from "../lib/store.mjs";

const execFileP = promisify(execFile);
const log = logger("imessage");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "applescript", "send-imessage.applescript");
const CHAT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");

export const isMac = () => process.platform === "darwin";

// Accept +1XXXXXXXXXX, a bare 10-digit US number, or an Apple ID email. A number
// Messages cannot resolve fails silently in AppleScript, so reject the garbage
// here rather than reporting a send that never actually happened.
export function normalizeRecipient(raw) {
  const s = String(raw || "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { ok: true, id: s, kind: "email" };
  const digits = s.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return { ok: true, id: digits, kind: "phone" };
  if (/^\d{10}$/.test(digits)) return { ok: true, id: "+1" + digits, kind: "phone" };
  if (/^1\d{10}$/.test(digits)) return { ok: true, id: "+" + digits, kind: "phone" };
  return { ok: false, why: '"' + raw + '" is not a valid phone number or Apple ID' };
}

export async function send(recipient, body, { service = "iMessage" } = {}) {
  if (!isMac()) return { ok: false, why: "iMessage only works on macOS" };
  const r = normalizeRecipient(recipient);
  if (!r.ok) return { ok: false, why: r.why };
  if (!String(body || "").trim()) return { ok: false, why: "empty message" };

  try {
    await execFileP("osascript", [SCRIPT, r.id, String(body), service], { timeout: 30000 });
    log("sent", r.id, JSON.stringify(String(body).slice(0, 80)));
    return { ok: true, to: r.id };
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    log("send FAILED", r.id, msg.slice(0, 300));
    // The two failures worth naming precisely, because both are a permission
    // dialog nobody clicked rather than anything wrong with the message.
    if (/not authori[sz]ed|1743|Not allowed to send Apple events/i.test(msg)) {
      return { ok: false, why: "macOS blocked Automation. System Settings > Privacy & Security > Automation > allow Terminal to control Messages, then retry." };
    }
    if (/Can.t get buddy|invalid|-1728/i.test(msg)) {
      return { ok: false, why: "Messages could not resolve " + r.id + ". If they are not on iMessage, retry with service SMS (needs an iPhone paired for Text Message Forwarding)." };
    }
    return { ok: false, why: msg.slice(0, 300) };
  }
}

// Apple stores dates as nanoseconds since 2001-01-01.
const APPLE_EPOCH = 978307200;
const toAppleNs = (ms) => Math.round((ms / 1000 - APPLE_EPOCH) * 1e9);
const SEP = "";   // unit separator: cannot appear in a message body

// On recent macOS many rows have message.text NULL and the body inside an
// archived NSAttributedString blob. Pull the readable string back out of it.
function fromAttributedBody(hex) {
  if (!hex) return "";
  try {
    const s = Buffer.from(hex, "hex").toString("utf8");
    const m = s.match(/NSString\x01\x94\x84\x01\+([\s\S]*?)\x86/);
    if (m) return m[1].trim();
    const printable = s.match(/[\x20-\x7E]{4,}/g) || [];
    return (printable.find((p) => !/^(NS|__|streamtyped|bplist|iI|kIM)/.test(p)) || "").trim();
  } catch { return ""; }
}

// Read recent messages. chat.db is live and locked while Messages runs, so work
// off a copy — reads against the live file intermittently return "database is
// locked", which would make reply detection flaky rather than loudly broken.
export async function recent({ sinceMs = Date.now() - 24 * 3600 * 1000, limit = 100 } = {}) {
  if (!isMac()) return { ok: false, why: "macOS only", messages: [] };
  if (!existsSync(CHAT_DB)) return { ok: false, why: "chat.db not found - is Messages signed in?", messages: [] };

  let tmpDir = "";
  try {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "orion-msg-"));
    const copy = path.join(tmpDir, "chat.db");
    copyFileSync(CHAT_DB, copy);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(CHAT_DB + ext)) { try { copyFileSync(CHAT_DB + ext, copy + ext); } catch {} }
    }
    const sql = "SELECT m.ROWID, IFNULL(h.id,''), m.is_from_me, m.date, REPLACE(IFNULL(m.text,''), char(10), ' '), IFNULL(hex(m.attributedBody),'') " +
                "FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID " +
                "WHERE m.date > " + toAppleNs(sinceMs) + " " +
                "ORDER BY m.date DESC LIMIT " + Math.max(1, Math.min(500, limit)) + ";";
    const { stdout } = await execFileP("sqlite3", ["-separator", SEP, copy, sql], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const messages = stdout.split("\n").filter(Boolean).map((line) => {
      const [rowid, handle, fromMe, date, text, attr] = line.split(SEP);
      return {
        id: Number(rowid),
        from: handle,
        fromMe: fromMe === "1",
        at: new Date((Number(date) / 1e9 + APPLE_EPOCH) * 1000).toISOString(),
        text: text || fromAttributedBody(attr),
      };
    }).filter((m) => m.text);
    return { ok: true, messages };
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    if (/unable to open|authorization denied|operation not permitted/i.test(msg)) {
      return { ok: false, why: "macOS blocked reading chat.db. System Settings > Privacy & Security > Full Disk Access > add Terminal, then restart Terminal.", messages: [] };
    }
    return { ok: false, why: msg.slice(0, 300), messages: [] };
  } finally { if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} } }
}

// Inbound messages not yet reported. Watermarked by ROWID so a reply surfaces
// exactly once, even across restarts.
export async function newReplies() {
  const mark = read("imessage-watermark", { rowid: 0 });
  const res = await recent({ sinceMs: Date.now() - 6 * 3600 * 1000, limit: 200 });
  if (!res.ok) return res;
  const fresh = res.messages.filter((m) => !m.fromMe && m.id > (mark.rowid || 0));
  const maxRow = res.messages.reduce((a, m) => Math.max(a, m.id), mark.rowid || 0);
  write("imessage-watermark", { rowid: maxRow });
  return { ok: true, messages: fresh.reverse() };
}
