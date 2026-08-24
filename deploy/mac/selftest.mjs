#!/usr/bin/env node
// Preflight. Run this on the Mac before declaring the install done.
//
// Every check is written to answer one question: "would this actually work at
// 3am with nobody watching?" So it prefers live calls over presence checks — a
// DEEPSEEK_API_KEY that exists but is revoked passes the wrong kind of test.
//
//   node selftest.mjs              everything, read-only
//   node selftest.mjs --send +1310…  also sends one real test iMessage
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv, ROOT, DATA } from "./lib/env.mjs";

const execFileP = promisify(execFile);
loadEnv();

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m", c: "\x1b[36m" };
const results = [];
let group = "";

const G = (name) => { group = name; console.log(`\n${C.b}${C.c}${name}${C.x}`); };

async function check(label, fn, { fix = "", optional = false } = {}) {
  process.stdout.write(`  ${label} … `);
  try {
    const r = await fn();
    if (r === true || r === undefined) { console.log(`${C.g}pass${C.x}`); results.push({ group, label, ok: true }); return true; }
    if (r && r.warn) { console.log(`${C.y}${r.warn}${C.x}`); results.push({ group, label, warn: true, note: r.warn, fix: r.fix || fix }); return false; }
    console.log(`${C.g}pass${C.x} ${C.d}${r}${C.x}`);
    results.push({ group, label, ok: true, note: String(r) });
    return true;
  } catch (e) {
    const msg = String(e.message || e).split("\n")[0].slice(0, 160);
    console.log(`${optional ? C.y + "skip" : C.r + "FAIL"}${C.x} ${C.d}${msg}${C.x}`);
    results.push({ group, label, ok: false, optional, note: msg, fix });
    return false;
  }
}

// Run the binary itself rather than shelling out to `command -v` — it proves
// the thing is both present AND executable, and works the same on any platform.
const version = async (bin, flag = "--version") => (await execFileP(bin, [flag], { timeout: 10000 })).stdout.trim();

// ---------------------------------------------------------------------------

G("Machine");

await check("node 20 or newer", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`node ${process.versions.node} is too old`);
  return `node ${process.versions.node}`;
}, { fix: "brew install node   (or download from nodejs.org)" });

await check("running on macOS", () => {
  if (process.platform !== "darwin") return { warn: `this is ${process.platform}, not macOS — iMessage checks will not apply`, fix: "Run the real preflight on the Mac Mini." };
  return `${os.platform()} ${os.release()}`;
});

await check("data directory writable", () => {
  const probe = path.join(DATA, ".probe");
  writeFileSync(probe, "ok");
  unlinkSync(probe);
  return DATA;
}, { fix: `chmod -R u+w ${DATA}` });

await check("sqlite3 available (reads the iMessage database)", async () => {
  return (await version("sqlite3")).split(" ")[0];
}, { fix: "sqlite3 ships with macOS. If missing: brew install sqlite" });

// ---------------------------------------------------------------------------

G("Configuration");

await check(".env exists", () => {
  if (!existsSync(path.join(ROOT, ".env"))) throw new Error("no .env — run: npm run setup");
  return true;
}, { fix: "npm run setup" });

await check("client name set", () => {
  if (!process.env.CLIENT_NAME) return { warn: "not set — support texts will say the hostname instead", fix: "npm run setup, or set CLIENT_NAME in .env" };
  return process.env.CLIENT_NAME;
});

await check("business brief written", async () => {
  const { brief } = await import("./lib/draft.mjs");
  const t = brief();
  if (!t || t.length < 40) return { warn: "empty or very short — every draft will be generic", fix: "In Telegram: /brief <what the business does, who it sells to, what makes it different>" };
  return `${t.length} chars`;
});

await check("LinkedIn searches configured", async () => {
  const { targets } = await import("./engines/linkedin.mjs");
  const n = (targets().linkedin?.searches || []).length;
  if (!n) return { warn: "none — the 24/7 sweep will do nothing", fix: "In Telegram: /target head of marketing fintech" };
  return `${n} searches`;
});

// ---------------------------------------------------------------------------

G("Telegram control channel");

let botName = null;
await check("bot token valid", async () => {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const j = await (await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)).json();
  if (!j.ok) throw new Error(j.description || "getMe failed");
  botName = j.result.username;
  return `@${j.result.username}`;
}, { fix: "Get a token from @BotFather, then: npm run setup" });

await check("allowlist set (bot is not open to the world)", () => {
  const ids = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(",").filter((s) => s.trim());
  if (!ids.length) throw new Error("TELEGRAM_ALLOWED_USER_IDS is empty — nobody can use the bot");
  return `${ids.length} user(s)`;
}, { fix: "Message @userinfobot to get your numeric ID, then: npm run setup" });

await check("can deliver a message to the owner", async () => {
  const owner = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(",")[0].trim();
  if (!owner || !process.env.TELEGRAM_BOT_TOKEN) throw new Error("not configured");
  const j = await (await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: owner, text: "✅ Selftest: your assistant can reach you here." }),
  })).json();
  if (!j.ok) {
    if (/chat not found/i.test(j.description || "")) throw new Error(`chat not found — open Telegram and send @${botName || "the bot"} any message first`);
    throw new Error(j.description);
  }
  return "delivered";
}, { fix: "Open Telegram, find the bot, press Start, then re-run this." });

// ---------------------------------------------------------------------------

G("DeepSeek (writes every message)");

await check("API key works", async () => {
  const { deepseek } = await import("./lib/deepseek.mjs");
  const r = await deepseek([{ role: "user", content: "Reply with exactly: OK" }], { max_tokens: 10, temperature: 0 });
  if (!/ok/i.test(r)) throw new Error(`unexpected reply: ${r.slice(0, 60)}`);
  return "live";
}, { fix: "Get a key at platform.deepseek.com, then: npm run setup" });

await check("can write a real draft", async () => {
  const { imessageDraft } = await import("./lib/draft.mjs");
  const t = await imessageDraft({ name: "Sam Rivera", headline: "Head of Ops at a 40-person logistics company" }, { angle: "test" });
  if (!t || t.length < 20) throw new Error("draft came back empty");
  return `"${t.slice(0, 60)}…"`;
});

// ---------------------------------------------------------------------------

G("iMessage");

if (process.platform === "darwin") {
  await check("Messages.app installed", () => {
    if (!existsSync("/System/Applications/Messages.app") && !existsSync("/Applications/Messages.app")) throw new Error("Messages.app not found");
    return true;
  });

  await check("chat.db readable (Full Disk Access)", async () => {
    const { recent } = await import("./engines/imessage.mjs");
    const r = await recent({ sinceMs: Date.now() - 7 * 24 * 3600 * 1000, limit: 5 });
    if (!r.ok) throw new Error(r.why);
    return `${r.messages.length} recent messages visible`;
  }, { fix: "System Settings > Privacy & Security > Full Disk Access > + > add Terminal (and iTerm if used). Then QUIT and reopen Terminal." });

  await check("Automation permission for Messages", async () => {
    // Reading a property is enough to trigger (or fail) the same TCC prompt a
    // send would, without sending anything to anyone.
    try {
      await execFileP("osascript", ["-e", 'tell application "Messages" to get name'], { timeout: 15000 });
      return "granted";
    } catch (e) {
      const m = String(e.stderr || e.message);
      if (/not authori|1743|Not allowed/i.test(m)) throw new Error("macOS is blocking Automation");
      throw new Error(m.split("\n")[0].slice(0, 120));
    }
  }, { fix: "System Settings > Privacy & Security > Automation > Terminal > enable Messages. If it is not listed, run this test again to trigger the prompt." });

  await check("signed in to iMessage", async () => {
    const { stdout } = await execFileP("osascript", ["-e", 'tell application "Messages" to get name of every service whose service type = iMessage'], { timeout: 15000 });
    if (!stdout.trim()) return { warn: "no iMessage account active", fix: "Open Messages.app and sign in with the Apple ID." };
    return stdout.trim();
  }, { optional: true });
} else {
  console.log(`  ${C.d}(skipped — not macOS)${C.x}`);
}

// ---------------------------------------------------------------------------

G("Headless browser");

await check("Playwright installed", async () => {
  const { chromium } = await import("./lib/browser.mjs");
  await chromium();
  return "module present";
}, { fix: "npm install && npx playwright install chromium" });

await check("a browser actually launches", async () => {
  const { chromium } = await import("./lib/browser.mjs");
  const cr = await chromium();
  const b = await cr.launch({ headless: true });
  const v = b.version();
  await b.close();
  return `chromium ${v}`;
}, { fix: "npx playwright install chromium" });

await check("LinkedIn session saved", async () => {
  const { isLoggedIn } = await import("./engines/linkedin.mjs");
  if (!isLoggedIn()) return { warn: "not logged in — scraping will not run", fix: "node engines/linkedin.mjs login   (opens a window; sign in once)" };
  return "saved";
});

await check("social sessions saved", async () => {
  const s = await import("./engines/socials.mjs");
  const on = s.platformNames().filter((n) => s.isLoggedIn(n));
  if (!on.length) return { warn: "none saved — posting will not run", fix: "node engines/socials.mjs login x   (repeat per platform)" };
  return on.join(", ");
});

// ---------------------------------------------------------------------------

G("Reddit");

await check("credentials work", async () => {
  const r = await import("./engines/reddit.mjs");
  if (!r.configured()) return { warn: "not configured — /reddit will be unavailable", fix: "reddit.com/prefs/apps > create a 'script' app, then: npm run setup" };
  const me = await r.me();
  return `u/${me.name}, ${me.karma} karma`;
}, { fix: "If this says invalid_grant, the account has 2FA on. Password login cannot pass 2FA — use a dedicated posting account." });

// ---------------------------------------------------------------------------

G("Support relay to Orion");

await check("relay configured", async () => {
  const { relayConfigured } = await import("./lib/relay.mjs");
  if (!relayConfigured()) return { warn: "not set — the client cannot text Orion from the TUI or /orion", fix: "Set ORION_RELAY_BOT_TOKEN and ORION_TELEGRAM_CHAT_ID in .env" };
  return "configured";
});

await check("relay delivers", async () => {
  const { relayConfigured, toOrion } = await import("./lib/relay.mjs");
  if (!relayConfigured()) return { warn: "skipped — not configured" };
  const r = await toOrion("Selftest from the install. If you see this, the support channel works.", { kind: "update" });
  if (!r.ok) throw new Error(r.description || "send failed");
  return "delivered to Orion";
});

await check("Orion has admin on this bot", () => {
  if (!process.env.ORION_ADMIN_TELEGRAM_IDS) return { warn: "not set — Orion cannot run /diag or /logs remotely", fix: "Set ORION_ADMIN_TELEGRAM_IDS in .env" };
  return process.env.ORION_ADMIN_TELEGRAM_IDS;
});

// ---------------------------------------------------------------------------

G("Wiring");

await check("approval queue round-trips", async () => {
  const q = await import("./lib/queue.mjs");
  const item = q.enqueue({ kind: "social", title: "selftest", preview: "selftest", payload: { platform: "x", text: "selftest" } });
  const got = q.getItem(item.id);
  if (!got || got.status !== "pending") throw new Error("item did not persist as pending");
  q.setStatus(item.id, "skipped", "selftest");
  if (q.getItem(item.id).status !== "skipped") throw new Error("status did not persist");
  return "ok";
});

await check("caps and pacing enforced", async () => {
  const { mayAct, getSettings } = await import("./lib/settings.mjs");
  const s = getSettings();
  if (s.autoSend) return { warn: "AUTO-SEND IS ON — drafts will go out without a tap", fix: "In Telegram: /pause, or set autoSend false" };
  const gate = mayAct("linkedin");
  return gate.ok ? "engines allowed to act now" : `engines currently held: ${gate.why}`;
});

await check("launchd services installed", async () => {
  if (process.platform !== "darwin") return { warn: "skipped — not macOS" };
  try {
    const { stdout } = await execFileP("launchctl", ["list"]);
    const on = ["com.orion.assistant.bot", "com.orion.assistant.scheduler"].filter((l) => stdout.includes(l));
    if (!on.length) return { warn: "not installed — nothing runs after a reboot", fix: "npm run install:service" };
    if (on.length === 1) return { warn: `only ${on[0]} is loaded`, fix: "npm run install:service" };
    return "both loaded";
  } catch (e) { throw new Error("launchctl failed: " + e.message); }
});

// --------------------------------------------------------------- optional send

const sendIdx = process.argv.indexOf("--send");
if (sendIdx > -1 && process.argv[sendIdx + 1]) {
  G("Live send test");
  const to = process.argv[sendIdx + 1];
  await check(`send a real iMessage to ${to}`, async () => {
    const { send } = await import("./engines/imessage.mjs");
    const r = await send(to, "Test from your new assistant. Everything is wired up. You can ignore this.");
    if (!r.ok) throw new Error(r.why);
    return "sent — check the phone";
  });
}

// ---------------------------------------------------------------------- report

const pass = results.filter((r) => r.ok).length;
const warn = results.filter((r) => r.warn).length;
const fail = results.filter((r) => r.ok === false && !r.optional && !r.warn).length;

console.log(`\n${C.b}${"─".repeat(58)}${C.x}`);
console.log(`${C.b}${pass} passed${C.x}   ${warn ? C.y : C.d}${warn} need attention${C.x}   ${fail ? C.r : C.d}${fail} failed${C.x}`);

const todo = results.filter((r) => (r.warn || (r.ok === false && !r.optional)) && r.fix);
if (todo.length) {
  console.log(`\n${C.b}What's left${C.x}`);
  for (const t of todo) {
    console.log(`\n  ${fail && t.ok === false ? C.r + "✗" : C.y + "!"}${C.x} ${C.b}${t.label}${C.x} ${C.d}(${t.group})${C.x}`);
    if (t.note) console.log(`    ${C.d}${t.note}${C.x}`);
    console.log(`    ${C.c}→ ${t.fix}${C.x}`);
  }
} else {
  console.log(`\n  ${C.g}Nothing left. This install is ready.${C.x}`);
}
console.log();
process.exit(fail ? 1 : 0);
