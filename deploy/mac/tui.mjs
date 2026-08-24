#!/usr/bin/env node
// The branded terminal the client actually sees. Zero dependencies — readline
// and ANSI only — so it runs on a bare Mac before anything is installed.
//
// It does the whole first-run: keys, logins, services, preflight. And it keeps
// a support line open afterwards: "Text Orion" pushes straight into Orion's
// Telegram, so when the client wants a change they ask from right here rather
// than hunting for an email address.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadEnv, setEnv, ROOT, DATA, ENV_PATH } from "./lib/env.mjs";

const execFileP = promisify(execFile);
loadEnv();

const C = {
  x: "\x1b[0m", d: "\x1b[2m", b: "\x1b[1m", i: "\x1b[3m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  gray: "\x1b[90m", white: "\x1b[97m", mag: "\x1b[35m",
};

// Per-client branding. Drop deploy/orion-theme.json next to this file to
// rebrand without touching code.
function loadTheme() {
  for (const p of [path.join(ROOT, "orion-theme.json"), path.join(ROOT, "config", "orion-theme.json")]) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  return {};
}
const T = loadTheme();
const BRAND = T.brand || process.env.CLIENT_NAME || "ORION";
const SUBTITLE = T.subtitle || "A I   A S S I S T A N T";
const WATERMARK = T.watermark || "~ built by Orion Jones ~";
const ACCENT = T.accent || C.cyan;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
const out = (s = "") => console.log(s);
const clear = () => process.stdout.write("\x1b[2J\x1b[H");
const pause = () => ask(`\n${C.d}  press enter${C.x} `);
const rule = (n = 62) => out(`${C.gray}${"─".repeat(n)}${C.x}`);

function banner() {
  clear();
  out();
  out(`  ${ACCENT}${C.b}${BRAND.toUpperCase()}${C.x}`);
  out(`  ${C.d}${SUBTITLE}${C.x}`);
  out();
  rule();
}

const mark = (ok, warn = false) => (ok ? `${C.green}●${C.x}` : warn ? `${C.yellow}●${C.x}` : `${C.red}○${C.x}`);

// ------------------------------------------------------------------ status

async function statusLines() {
  const [{ getSettings }, queue, linkedin, socials, reddit, imessage, relay] = await Promise.all([
    import("./lib/settings.mjs"), import("./lib/queue.mjs"), import("./engines/linkedin.mjs"),
    import("./engines/socials.mjs"), import("./engines/reddit.mjs"), import("./engines/imessage.mjs"),
    import("./lib/relay.mjs"),
  ]);
  const s = getSettings();
  const beat = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, "heartbeat.json"), "utf8")); } catch { return null; }
  })();
  const beatAge = beat ? (Date.now() - new Date(beat.at).getTime()) / 60000 : null;

  const L = [];
  L.push(`  ${mark(!s.paused, s.paused)} System        ${s.paused ? `${C.yellow}paused${C.x}` : `${C.green}running${C.x}`}   ${C.d}active ${s.activeHours[0]}:00-${s.activeHours[1]}:00${C.x}`);
  L.push(`  ${mark(beatAge !== null && beatAge < 5, beatAge !== null)} Scheduler     ${beatAge === null ? `${C.red}never started${C.x}` : beatAge < 5 ? `${C.green}alive${C.x} ${C.d}${beatAge.toFixed(0)}m ago${C.x}` : `${C.yellow}last seen ${beatAge.toFixed(0)}m ago${C.x}`}`);
  L.push("");
  L.push(`  ${mark(!!process.env.DEEPSEEK_API_KEY)} DeepSeek      ${process.env.DEEPSEEK_API_KEY ? "key set" : `${C.red}missing${C.x}`}`);
  L.push(`  ${mark(!!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_ALLOWED_USER_IDS)} Telegram      ${process.env.TELEGRAM_BOT_TOKEN ? (process.env.TELEGRAM_ALLOWED_USER_IDS ? "connected" : `${C.yellow}no allowlist${C.x}`) : `${C.red}missing${C.x}`}`);
  L.push(`  ${mark(linkedin.isLoggedIn(), s.linkedin.halted)} LinkedIn      ${s.linkedin.halted ? `${C.red}HALTED: ${s.linkedin.haltReason.slice(0, 30)}${C.x}` : linkedin.isLoggedIn() ? "signed in" : `${C.yellow}not signed in${C.x}`}`);
  L.push(`  ${mark(reddit.configured())} Reddit        ${reddit.configured() ? "configured" : `${C.yellow}not configured${C.x}`}`);
  L.push(`  ${mark(imessage.isMac())} iMessage      ${imessage.isMac() ? "ready" : `${C.yellow}macOS only${C.x}`}`);
  const on = socials.platformNames().filter((n) => socials.isLoggedIn(n));
  L.push(`  ${mark(on.length > 0, true)} Socials       ${on.length ? on.join(", ") : `${C.yellow}none signed in${C.x}`}`);
  L.push(`  ${mark(relay.relayConfigured())} Support line  ${relay.relayConfigured() ? "connected to Orion" : `${C.yellow}not configured${C.x}`}`);
  L.push("");
  L.push(`  ${C.b}${queue.pending().length}${C.x} drafts waiting for your approval`);
  L.push(`  ${C.b}${Object.keys(linkedin.allLeads()).length}${C.x} leads collected`);
  return L;
}

async function screenStatus() {
  banner();
  out(`  ${C.b}Status${C.x}\n`);
  for (const l of await statusLines()) out(l);
  out();
  rule();
  await pause();
}

// -------------------------------------------------------------------- keys

const KEYS = [
  { key: "CLIENT_NAME", label: "Your name or business", hint: "shows up in Telegram + support texts" },
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "@BotFather -> /newbot", secret: true },
  { key: "TELEGRAM_ALLOWED_USER_IDS", label: "Your Telegram user ID", hint: "@userinfobot tells you the number" },
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API key", hint: "platform.deepseek.com", secret: true },
  { key: "REDDIT_CLIENT_ID", label: "Reddit app ID", hint: "reddit.com/prefs/apps (optional)", optional: true },
  { key: "REDDIT_CLIENT_SECRET", label: "Reddit app secret", hint: "optional", secret: true, optional: true },
  { key: "REDDIT_USERNAME", label: "Reddit username", hint: "optional", optional: true },
  { key: "REDDIT_PASSWORD", label: "Reddit password", hint: "optional; account must NOT have 2FA", secret: true, optional: true },
];

const masked = (v) => (!v ? `${C.red}not set${C.x}` : v.length > 10 ? `${C.green}${v.slice(0, 4)}…${v.slice(-3)}${C.x}` : `${C.green}set${C.x}`);

async function screenKeys() {
  for (;;) {
    banner();
    out(`  ${C.b}Keys & setup${C.x}\n`);
    KEYS.forEach((k, i) => {
      out(`  ${C.b}${String(i + 1).padStart(2)}${C.x}  ${k.label.padEnd(24)} ${masked(process.env[k.key])}`);
      out(`      ${C.d}${k.hint}${C.x}`);
    });
    out();
    rule();
    const a = await ask(`  number to set, or ${C.b}b${C.x} to go back: `);
    if (a.toLowerCase() === "b" || a === "") return;
    const k = KEYS[Number(a) - 1];
    if (!k) continue;
    out(`\n  ${C.d}${k.hint}${C.x}`);
    const v = await ask(`  ${k.label}: `);
    if (v) { setEnv(k.key, v); out(`  ${C.green}saved${C.x}`); await pause(); }
  }
}

// ------------------------------------------------------------------ logins

// Every login is the same shape: run a script that opens a real window and
// waits for a human. Doing it from here means the client never has to find a
// terminal command in a document.
async function runLive(label, args) {
  out(`\n  ${C.d}${label}${C.x}`);
  out(`  ${C.d}A browser window will open. Sign in, then come back here.${C.x}\n`);
  await new Promise((res) => {
    const c = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
    c.on("exit", res);
    c.on("error", (e) => { out(`  ${C.red}${e.message}${C.x}`); res(); });
  });
}

async function screenLogins() {
  const socials = await import("./engines/socials.mjs");
  const linkedin = await import("./engines/linkedin.mjs");
  for (;;) {
    banner();
    out(`  ${C.b}Accounts${C.x}\n`);
    out(`  ${C.d}Sign in once per account. The session is saved on this Mac and`);
    out(`  reused after that. Your passwords are never seen or stored by this app.${C.x}\n`);
    const rows = [["LinkedIn", linkedin.isLoggedIn(), ["engines/linkedin.mjs", "login"]]];
    for (const n of socials.platformNames()) {
      rows.push([socials.PLATFORMS[n].label, socials.isLoggedIn(n), ["engines/socials.mjs", "login", n]]);
    }
    rows.forEach((r, i) => out(`  ${C.b}${i + 1}${C.x}  ${mark(r[1])} ${r[0].padEnd(18)} ${r[1] ? `${C.green}signed in${C.x}` : `${C.d}not signed in${C.x}`}`));
    out();
    rule();
    const a = await ask(`  number to sign in, or ${C.b}b${C.x} to go back: `);
    if (a.toLowerCase() === "b" || a === "") return;
    const row = rows[Number(a) - 1];
    if (!row) continue;
    await runLive(`Signing in to ${row[0]}…`, [path.join(ROOT, row[2][0]), ...row[2].slice(1)]);
    await pause();
  }
}

// ---------------------------------------------------------------- services

async function launchctlLoaded() {
  if (process.platform !== "darwin") return [];
  try {
    const { stdout } = await execFileP("launchctl", ["list"]);
    return ["com.orion.assistant.bot", "com.orion.assistant.scheduler"].filter((l) => stdout.includes(l));
  } catch { return []; }
}

async function screenServices() {
  for (;;) {
    banner();
    const loaded = await launchctlLoaded();
    out(`  ${C.b}Always-on${C.x}\n`);
    out(`  ${mark(loaded.length === 2, loaded.length === 1)} ${loaded.length === 2 ? `${C.green}Installed and running.${C.x} Comes back automatically after a reboot.` : loaded.length ? `${C.yellow}Partly installed${C.x}` : `${C.yellow}Not installed${C.x} — nothing runs when this window closes.`}`);
    out();
    out(`  ${C.b}1${C.x}  Turn on 24/7 mode  ${C.d}(installs background services)${C.x}`);
    out(`  ${C.b}2${C.x}  Turn off 24/7 mode`);
    out(`  ${C.b}3${C.x}  Run in this window ${C.d}(watch it work; stops when you close it)${C.x}`);
    out(`  ${C.b}4${C.x}  Show recent activity`);
    out();
    rule();
    const a = await ask(`  choose, or ${C.b}b${C.x} to go back: `);
    if (a.toLowerCase() === "b" || a === "") return;
    if (a === "1") {
      if (process.platform !== "darwin") { out(`  ${C.yellow}macOS only.${C.x}`); await pause(); continue; }
      await new Promise((res) => spawn("bash", [path.join(ROOT, "launchd", "install-services.sh")], { cwd: ROOT, stdio: "inherit" }).on("exit", res));
      await pause();
    } else if (a === "2") {
      await new Promise((res) => spawn("bash", [path.join(ROOT, "launchd", "uninstall-services.sh")], { cwd: ROOT, stdio: "inherit" }).on("exit", res));
      await pause();
    } else if (a === "3") {
      out(`\n  ${C.d}Starting. Ctrl-C to stop and come back.${C.x}\n`);
      rl.pause();
      await new Promise((res) => spawn(process.execPath, [path.join(ROOT, "start.mjs")], { cwd: ROOT, stdio: "inherit" }).on("exit", res));
      rl.resume();
    } else if (a === "4") {
      banner();
      out(`  ${C.b}Recent activity${C.x}\n`);
      for (const name of ["scheduler", "bot", "linkedin", "socials", "reddit", "imessage"]) {
        const f = path.join(DATA, "logs", `${name}.log`);
        if (!fs.existsSync(f)) continue;
        const tail = fs.readFileSync(f, "utf8").trim().split("\n").slice(-4);
        out(`  ${ACCENT}${name}${C.x}`);
        tail.forEach((l) => out(`    ${C.d}${l.slice(0, 100)}${C.x}`));
        out();
      }
      await pause();
    }
  }
}

// -------------------------------------------------------------- text Orion

async function screenSupport() {
  const { toOrion, relayConfigured } = await import("./lib/relay.mjs");
  banner();
  out(`  ${C.b}Text Orion${C.x}\n`);
  if (!relayConfigured()) {
    out(`  ${C.yellow}The support line isn't set up on this machine yet.${C.x}\n`);
    out(`  Email:  ${C.b}${process.env.ORION_SUPPORT_EMAIL || "orionjones99@gmail.com"}${C.x}`);
    out(`  Phone:  ${C.b}${process.env.ORION_SUPPORT_PHONE || "424-422-5031"}${C.x}`);
    return pause();
  }
  out(`  ${C.d}Goes straight to Orion's phone. Say what you want changed, added,`);
  out(`  or fixed — plain English is fine. He replies in your Telegram.${C.x}\n`);
  out(`  ${C.b}1${C.x}  Ask for a change or a new feature`);
  out(`  ${C.b}2${C.x}  Report something broken`);
  out(`  ${C.b}3${C.x}  Just a question`);
  out();
  const kindPick = await ask(`  choose (or ${C.b}b${C.x} to go back): `);
  if (kindPick.toLowerCase() === "b" || !kindPick) return;
  const kind = { "1": "update", "2": "alert", "3": "help" }[kindPick] || "help";

  out();
  const msg = await ask(`  ${C.b}What do you need?${C.x}\n  > `);
  if (!msg) return;

  // Attach live status to every support message. Half of remote support is
  // asking "what does it say on your screen" — this answers it up front.
  const status = (await statusLines()).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean).join("\n");
  const r = await toOrion(`${msg}\n\n---\nSent from the terminal on ${os.hostname()}\n\n${status}`, { kind });

  out();
  if (r.ok) out(`  ${C.green}Sent.${C.x} Orion has it on his phone. He'll reply in your Telegram.`);
  else if (r.spooled) out(`  ${C.yellow}Saved.${C.x} The connection is down right now — it'll send itself automatically.`);
  else out(`  ${C.red}Couldn't send.${C.x} Email ${process.env.ORION_SUPPORT_EMAIL || "orionjones99@gmail.com"} instead.`);
  await pause();
}

// ------------------------------------------------------------------ checks

async function screenSelftest() {
  banner();
  out(`  ${C.b}Checking everything…${C.x}\n`);
  rl.pause();
  await new Promise((res) => spawn(process.execPath, [path.join(ROOT, "selftest.mjs")], { cwd: ROOT, stdio: "inherit" }).on("exit", res));
  rl.resume();
  await pause();
}

// -------------------------------------------------------------------- main

async function main() {
  if (!fs.existsSync(ENV_PATH) && fs.existsSync(path.join(ROOT, ".env.example"))) {
    fs.copyFileSync(path.join(ROOT, ".env.example"), ENV_PATH);
    loadEnv();
  }

  for (;;) {
    banner();
    const lines = await statusLines();
    for (const l of lines.slice(0, 2)) out(l);
    out();
    out(`  ${C.b}1${C.x}  Status            ${C.d}what's running right now${C.x}`);
    out(`  ${C.b}2${C.x}  Keys & setup      ${C.d}Telegram, DeepSeek, Reddit${C.x}`);
    out(`  ${C.b}3${C.x}  Accounts          ${C.d}sign in to LinkedIn and socials${C.x}`);
    out(`  ${C.b}4${C.x}  Always-on         ${C.d}run 24/7, survive reboots${C.x}`);
    out(`  ${C.b}5${C.x}  Check everything  ${C.d}full preflight${C.x}`);
    out(`  ${C.b}6${C.x}  ${ACCENT}Text Orion${C.x}        ${C.d}ask for a change, or get help${C.x}`);
    out(`  ${C.b}q${C.x}  Quit`);
    out();
    rule();
    out(`  ${C.d}${C.i}${WATERMARK}${C.x}`);
    const a = (await ask(`\n  > `)).toLowerCase();
    if (a === "q" || a === "quit" || a === "exit") break;
    if (a === "1") await screenStatus();
    else if (a === "2") await screenKeys();
    else if (a === "3") await screenLogins();
    else if (a === "4") await screenServices();
    else if (a === "5") await screenSelftest();
    else if (a === "6") await screenSupport();
  }
  clear();
  out(`  ${ACCENT}${BRAND}${C.x} ${C.d}— still running in the background. Reopen anytime with:${C.x} ${C.b}npm run setup${C.x}\n`);
  rl.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
