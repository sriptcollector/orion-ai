#!/usr/bin/env node
// The 24/7 loop. Wakes every minute, asks each engine "is it your turn yet",
// and otherwise does nothing. Kept separate from bot.mjs on purpose: a browser
// automation crash must never take the Telegram control channel down with it,
// because that channel is how a human fixes the crash.
//
// It never sends anything. It scrapes, it drafts, it notices replies, and it
// pushes those into the approval queue and into Telegram. A human still taps.
import os from "node:os";
import { loadEnv } from "./lib/env.mjs";
import { api, chunk, esc } from "./lib/telegram.mjs";
import { logger } from "./lib/log.mjs";
import { read, write } from "./lib/store.mjs";
import { getSettings, mayAct } from "./lib/settings.mjs";
import * as queue from "./lib/queue.mjs";
import { flushOutbox, alertOnce, toOrion } from "./lib/relay.mjs";
import * as linkedin from "./engines/linkedin.mjs";
import * as imessage from "./engines/imessage.mjs";
import * as socials from "./engines/socials.mjs";

loadEnv();
const log = logger("scheduler");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const tg = TOKEN ? api(TOKEN) : null;
const OWNER = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(",")[0].trim();
const CLIENT = process.env.CLIENT_NAME || os.hostname();

process.on("unhandledRejection", (e) => log("UNHANDLED", String(e?.stack || e)));
process.on("uncaughtException", (e) => log("UNCAUGHT", String(e?.stack || e)));

async function notify(text, extra = {}) {
  if (!tg || !OWNER) return;
  for (const part of chunk(text)) {
    await tg("sendMessage", { chat_id: OWNER, text: part, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }
}

// Every scheduled job is one of these. `everyMin` is read fresh each tick, so a
// settings change from Telegram takes effect without a restart.
const jobs = [
  {
    name: "linkedin-sweep",
    everyMin: () => getSettings().linkedin.everyMinutes,
    jitterMin: 20,                  // never land on a round number
    enabled: () => mayAct("linkedin").ok && linkedin.isLoggedIn(),
    async run() {
      const r = await linkedin.sweep();
      if (r.halted) { await notify(`🚨 <b>LinkedIn halted</b>\n${esc(r.why)}\n\nNothing else will run on LinkedIn until it's cleared.`); return "halted"; }
      if (!r.ok) return `skipped: ${r.why}`;
      if (r.added > 0) {
        await notify(`🔎 <b>${r.added} new leads</b> (${Object.keys(linkedin.allLeads()).length} total). /leads to see them.`);
      }
      return `+${r.added}`;
    },
  },
  {
    name: "imessage-inbox",
    everyMin: () => 3,
    jitterMin: 1,
    enabled: () => imessage.isMac() && getSettings().imessage.enabled,
    async run() {
      const r = await imessage.newReplies();
      if (!r.ok) {
        // A permissions failure here is silent otherwise: replies just never
        // arrive. Say it once rather than never.
        await alertOnce("imessage-read", `Cannot read iMessage on ${CLIENT}: ${r.why}`, 720);
        return `error: ${r.why}`;
      }
      if (!r.messages.length) return "none";
      for (const m of r.messages.slice(0, 8)) {
        await notify(`💬 <b>Reply from ${esc(m.from)}</b>\n<pre>${esc(m.text.slice(0, 600))}</pre>`, {
          reply_markup: { inline_keyboard: [[{ text: "✍️ Draft a reply", callback_data: `rep:${Buffer.from(m.from).toString("base64url")}` }]] },
        });
      }
      return `${r.messages.length} replies`;
    },
  },
  {
    name: "session-health",
    everyMin: () => 6 * 60,
    jitterMin: 45,
    enabled: () => true,
    async run() {
      const dead = [];
      for (const n of socials.platformNames()) {
        if (!socials.isLoggedIn(n)) continue;
        const r = await socials.checkSession(n);
        if (!r.ok) dead.push(`${socials.PLATFORMS[n].label}: ${r.why}`);
      }
      if (dead.length) {
        await notify(`⚠️ <b>Sessions need attention</b>\n${dead.map((d) => "• " + esc(d)).join("\n")}\n\nOn the Mac, re-run the login for each.`);
        await toOrion(`Expired sessions on ${CLIENT}:\n${dead.join("\n")}`, { kind: "alert" });
      }
      return dead.length ? `${dead.length} expired` : "all alive";
    },
  },
  {
    name: "pending-nudge",
    everyMin: () => 4 * 60,
    jitterMin: 30,
    enabled: () => mayAct().ok,
    async run() {
      const p = queue.pending();
      if (p.length < 3) return "quiet";
      await notify(`📥 <b>${p.length} drafts</b> are waiting on your tap. /pending`);
      return `nudged ${p.length}`;
    },
  },
  {
    name: "housekeeping",
    everyMin: () => 12 * 60,
    jitterMin: 60,
    enabled: () => true,
    async run() { queue.prune(); return "pruned"; },
  },
];

const stateKey = "scheduler-state";
const rand = (n) => Math.floor(Math.random() * n);

async function tick() {
  const state = read(stateKey, { last: {}, next: {} });
  const now = Date.now();

  // The relay drains first and unconditionally: a spooled support request must
  // go out even when everything else is paused.
  try { await flushOutbox(); } catch {}

  for (const job of jobs) {
    const due = state.next[job.name] || 0;
    if (now < due) continue;

    // Schedule the NEXT run before running this one, so a job that throws still
    // backs off instead of retrying every single tick.
    const gap = Math.max(1, job.everyMin()) + rand(job.jitterMin || 0);
    state.next[job.name] = now + gap * 60000;
    write(stateKey, state);

    let enabled = false;
    try { enabled = job.enabled(); } catch {}
    if (!enabled) { log(job.name, "skipped (disabled)"); continue; }

    try {
      const t0 = Date.now();
      const result = await job.run();
      state.last[job.name] = { at: new Date().toISOString(), result, ms: Date.now() - t0 };
      log(job.name, "->", String(result), `${Date.now() - t0}ms`);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      state.last[job.name] = { at: new Date().toISOString(), error: msg };
      log(job.name, "ERROR", msg);
      await alertOnce(`job-${job.name}`, `Job ${job.name} failed on ${CLIENT}:\n${msg}`, 240);
    }
    write(stateKey, state);
  }

  write("heartbeat", { at: new Date().toISOString(), pid: process.pid, host: os.hostname() });
}

async function main() {
  log("scheduler up on", os.hostname(), "node", process.version);
  if (!tg || !OWNER) log("WARNING: no Telegram owner configured; findings will queue silently.");
  // Stagger the first run of everything so a restart doesn't fire five jobs at once.
  const state = read(stateKey, { last: {}, next: {} });
  jobs.forEach((j, i) => { if (!state.next[j.name]) state.next[j.name] = Date.now() + (i + 1) * 30000; });
  write(stateKey, state);

  for (;;) {
    try { await tick(); } catch (e) { log("tick error", String(e.stack || e).slice(0, 400)); }
    await new Promise((r) => setTimeout(r, 60000));
  }
}

if (process.argv.includes("--once")) {
  tick().then(() => { console.log(JSON.stringify(read(stateKey, {}), null, 2)); process.exit(0); });
} else {
  main();
}
