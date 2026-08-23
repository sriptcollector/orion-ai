#!/usr/bin/env node
// Orion AI — branded setup TUI. Zero dependencies (readline + ANSI), so it runs
// on any client machine the one-shot installer touches. It guides a client
// through Telegram + API key setup, shows live status, and has a Request Help
// action that reaches Orion. Everything writes to ./.env, merged, never clobbered.
//
//   node deploy/orion-setup.mjs
//
// Config knobs (env): ORION_SUPPORT_EMAIL, ORION_SUPPORT_PHONE, ORION_ENV_PATH.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  gray: "\x1b[90m", white: "\x1b[97m", magenta: "\x1b[35m",
};
const ENV_PATH = process.env.ORION_ENV_PATH || path.resolve(process.cwd(), ".env");

// Per-client theming + config. Drop a deploy/orion-theme.json in a client bundle
// to rebrand and set the support contact / key list without touching code:
//   { "subtitle":"ACME AI", "watermark":"~ built for ACME by Orion ~",
//     "supportEmail":"help@orion-jones.com", "supportPhone":"424-422-5031",
//     "startCommand":"npm start",
//     "keys":[{ "key":"RESEND_API_KEY","label":"Resend","hint":"resend.com","secret":true }] }
function loadTheme() {
  for (const p of [process.env.ORION_THEME_PATH, path.resolve(process.cwd(), "deploy", "orion-theme.json"), path.resolve(process.cwd(), "orion-theme.json")]) {
    try { if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  return {};
}
const THEME = loadTheme();
const SUPPORT_EMAIL = process.env.ORION_SUPPORT_EMAIL || THEME.supportEmail || "orionjones99@gmail.com";
const SUPPORT_PHONE = process.env.ORION_SUPPORT_PHONE || THEME.supportPhone || "424-422-5031";
const START_COMMAND = THEME.startCommand || "npm start";
const SUBTITLE = THEME.subtitle || "A I   S Y S T E M S";
const WATERMARK = THEME.watermark || "~ powered by Orion Jones ~";
const CLIENT_NAME = THEME.clientName || "";
const BOOK_URL = THEME.bookUrl || "https://book.orion-jones.com";
const PROJECTS = Array.isArray(THEME.projects) ? THEME.projects : [];   // [{name,status}]
const ROUTINES = Array.isArray(THEME.routines) ? THEME.routines : [];   // [{name,schedule}]

// Custom accent color per client (hex -> ANSI truecolor). Falls back to cyan.
function hexAnsi(hex, fg = true) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return fg ? C.cyan : C.magenta;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  return `\x1b[${fg ? 38 : 48};2;${r};${g};${b}m`;
}
const ACCENT = hexAnsi(THEME.accent);

// Licensing / anti-sharing. A client bundle carries an expected key (THEME.license)
// and, once activated, binds to THIS machine (a hash of the hostname). Copying the
// folder to another computer fails the machine check and must be re-activated with
// the key, which only the issuer (Orion) hands out. Real online validation against
// THEME.licenseServer is the phase-2 hardening; this stops casual folder-sharing.
import os from "node:os";
import crypto from "node:crypto";
const LICENSE_FILE = path.resolve(process.cwd(), ".license");
const machineId = () => crypto.createHash("sha256").update(os.hostname() + "|" + (os.userInfo().username || "")).digest("hex").slice(0, 16);

// The keys a client can configure. Overridable per client via the theme file.
const KEYS = Array.isArray(THEME.keys) && THEME.keys.length ? THEME.keys : [
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "from @BotFather", secret: true },
  { key: "TELEGRAM_ALLOWED_USER_IDS", label: "Your Telegram user id", hint: "from @userinfobot" },
  { key: "OPENAI_API_KEY", label: "OpenAI API key", hint: "platform.openai.com", secret: true },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic (Claude) API key", hint: "console.anthropic.com", secret: true },
  { key: "RESEND_API_KEY", label: "Resend email key", hint: "resend.com", secret: true },
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API key", hint: "platform.deepseek.com", secret: true },
];

// Cheap format sanity checks per key, so "Test my setup" can flag an obviously
// wrong paste before the client wonders why nothing works.
const KEY_SHAPE = {
  TELEGRAM_ALLOWED_USER_IDS: (v) => /^\d{5,}/.test(v) || "should be a numeric id",
  OPENAI_API_KEY: (v) => /^sk-/.test(v) || "usually starts with sk-",
  ANTHROPIC_API_KEY: (v) => /^sk-ant-/.test(v) || "usually starts with sk-ant-",
  RESEND_API_KEY: (v) => /^re_/.test(v) || "usually starts with re_",
  DEEPSEEK_API_KEY: (v) => /^sk-/.test(v) || "usually starts with sk-",
};

// ---- .env read/write (merge, never clobber a filled value blindly) -----------
function readEnv() {
  const map = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) map[m[1]] = m[2];
    }
  } catch {}
  return map;
}
function setEnv(key, value) {
  let text = "";
  try { text = fs.readFileSync(ENV_PATH, "utf8"); } catch {}
  const re = new RegExp(`^\\s*${key}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, `${key}=${value}`);
  else text = (text.replace(/\s*$/, "") + `\n${key}=${value}`).replace(/^\n/, "");
  fs.writeFileSync(ENV_PATH, text.replace(/\s*$/, "") + "\n");
}

// ---- UI helpers --------------------------------------------------------------
const W = 60;
const clear = () => process.stdout.write("\x1b[2J\x1b[H");
const mask = (v) => (v ? "•".repeat(Math.min(8, v.length)) + (v.length > 8 ? "…" : "") : "");
function banner() {
  const art = [
    "  ___  ____  ___ ___  _  _ ",
    " / _ \\|  _ \\|_ _/ _ \\| \\| |",
    "| (_) | |_) || | (_) | .` |",
    " \\___/|_| \\_\\___\\___/|_|\\_|",
  ];
  process.stdout.write(ACCENT + C.bold + art.join("\n") + C.reset + "\n");
  process.stdout.write(C.gray + "    " + SUBTITLE + C.reset + "\n");
  if (CLIENT_NAME) process.stdout.write(ACCENT + C.bold + "  Welcome, " + CLIENT_NAME + C.reset + "\n");
  // Watermark line, faint, on every screen.
  process.stdout.write(C.dim + C.magenta + ("  " + WATERMARK).padEnd(W) + C.reset + "\n");
  process.stdout.write(ACCENT + "─".repeat(W) + C.reset + "\n");
}

function rl() { return readline.createInterface({ input: process.stdin, output: process.stdout }); }
const ask = (q) => new Promise((res) => { const i = rl(); i.question(q, (a) => { i.close(); res(a.trim()); }); });

// ---- Screens -----------------------------------------------------------------
// Gate the app on a valid, machine-bound license before anything else.
async function licenseGate() {
  if (!THEME.license) return true; // unlicensed build (dev) -> open
  let lic = null;
  try { lic = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf8")); } catch {}
  if (lic && lic.key === THEME.license && lic.machine === machineId()) return true;
  clear(); banner();
  console.log(`${C.white}${C.bold}  Activate this software${C.reset}\n`);
  if (lic && lic.machine !== machineId()) console.log(`  ${C.yellow}This copy was activated on another computer. Re-enter your key to move it here.${C.reset}\n`);
  console.log(`  ${C.gray}Enter the license key Orion gave you. It locks to this machine,${C.reset}`);
  console.log(`  ${C.gray}so the software can't be shared by copying the folder.${C.reset}\n`);
  for (let tries = 0; tries < 3; tries++) {
    const key = await ask(`  License key: `);
    if (key === THEME.license) {
      fs.writeFileSync(LICENSE_FILE, JSON.stringify({ key, machine: machineId(), activatedAt: new Date().toISOString() }, null, 2));
      console.log(C.green + "\n  Activated on this machine. Thanks!" + C.reset);
      await ask(C.gray + "  enter to continue" + C.reset);
      return true;
    }
    console.log(C.red + "  That key doesn't match. " + (2 - tries) + " tries left." + C.reset);
  }
  console.log(C.red + "\n  Could not activate. Contact Orion: " + SUPPORT_EMAIL + C.reset);
  return false;
}

function dashboard() {
  clear(); banner();
  console.log(`${C.white}${C.bold}  Dashboard${C.reset}\n`);
  console.log(`  ${C.gray}Your projects${C.reset}`);
  if (PROJECTS.length) for (const p of PROJECTS) {
    const s = /live|done|active|green/i.test(p.status || "") ? C.green + "●" : /build|progress|wip/i.test(p.status || "") ? C.yellow + "●" : C.gray + "○";
    console.log(`   ${s} ${C.reset}${p.name}  ${C.gray}${p.status || ""}${C.reset}`);
  } else console.log(`   ${C.gray}(none yet — Orion will add these)${C.reset}`);
  console.log(`\n  ${C.gray}Routines${C.reset}`);
  if (ROUTINES.length) for (const r of ROUTINES) console.log(`   ${ACCENT}•${C.reset} ${r.name}  ${C.gray}${r.schedule || ""}${C.reset}`);
  else console.log(`   ${C.gray}(none yet)${C.reset}`);
}

async function bookScreen() {
  clear(); banner();
  console.log(`${C.white}${C.bold}  Book a session with Orion${C.reset}\n`);
  console.log(`  ${C.cyan}1${C.reset}) Open the booking page  ${C.gray}${BOOK_URL}${C.reset}`);
  console.log(`  ${C.cyan}2${C.reset}) Email to schedule      ${C.gray}${SUPPORT_EMAIL}${C.reset}`);
  console.log(`  ${C.cyan}b${C.reset}) Back\n`);
  const c = (await ask(`${C.gray}choose ▸ ${C.reset}`)).toLowerCase();
  if (c === "1") { openExternal(BOOK_URL); console.log(`\n  ${C.gray}Opening ${BOOK_URL}…${C.reset}`); await ask(C.gray + "  enter" + C.reset); }
  else if (c === "2") { openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Booking a session")}`); await ask(C.gray + "  enter" + C.reset); }
}

async function mainMenu() {
  for (;;) {
    dashboard();
    const env = readEnv();
    const tgOk = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_IDS;
    const keyCount = KEYS.filter((k) => env[k.key]).length;
    console.log(`\n${ACCENT}${C.bold}  Menu${C.reset}\n`);
    console.log(`  ${ACCENT}1${C.reset}) Telegram messaging   ${tgOk ? C.green + "✓ configured" : C.yellow + "not set"}${C.reset}`);
    console.log(`  ${ACCENT}2${C.reset}) API keys             ${C.gray}${keyCount}/${KEYS.length} set${C.reset}`);
    console.log(`  ${ACCENT}3${C.reset}) Status`);
    console.log(`  ${ACCENT}4${C.reset}) Test my setup`);
    console.log(`  ${ACCENT}5${C.reset}) Start services`);
    console.log(`  ${ACCENT}6${C.reset}) ${C.magenta}Book a session${C.reset}`);
    console.log(`  ${ACCENT}7${C.reset}) ${C.magenta}Contact Orion${C.reset}`);
    console.log(`  ${ACCENT}q${C.reset}) Save & quit\n`);
    const c = (await ask(`${C.gray}choose ▸ ${C.reset}`)).toLowerCase();
    if (c === "1") await telegramSetup();
    else if (c === "2") await keysSetup();
    else if (c === "3") await statusScreen();
    else if (c === "4") await testScreen();
    else if (c === "5") await startScreen();
    else if (c === "6") await bookScreen();
    else if (c === "7") await helpScreen();
    else if (c === "q" || c === "") { clear(); console.log(C.green + "Saved to " + ENV_PATH + ". You're set." + C.reset); return; }
  }
}

async function telegramSetup() {
  clear(); banner();
  console.log(`${C.white}${C.bold}  Telegram messaging (like Hermes)${C.reset}\n`);
  console.log(`  ${C.gray}1. Open @BotFather, /newbot, copy the token.${C.reset}`);
  console.log(`  ${C.gray}2. Open @userinfobot to get your numeric user id.${C.reset}\n`);
  const tok = await ask(`  Bot token ${C.gray}(enter to skip)${C.reset}: `);
  if (tok) setEnv("TELEGRAM_BOT_TOKEN", tok);
  const uid = await ask(`  Your Telegram user id: `);
  if (uid) setEnv("TELEGRAM_ALLOWED_USER_IDS", uid);
  console.log(C.green + "\n  Saved. " + C.reset);
  await ask(C.gray + "  enter to go back" + C.reset);
}

async function keysSetup() {
  for (;;) {
    clear(); banner();
    const env = readEnv();
    console.log(`${C.white}${C.bold}  API keys${C.reset}  ${C.gray}(pick a number to set, b to go back)${C.reset}\n`);
    KEYS.forEach((k, i) => {
      const cur = env[k.key] ? C.green + (k.secret ? mask(env[k.key]) : env[k.key]) : C.yellow + "— not set —";
      console.log(`  ${C.cyan}${i + 1}${C.reset}) ${k.label.padEnd(26)} ${cur}${C.reset}  ${C.gray}${k.hint}${C.reset}`);
    });
    const c = (await ask(`\n${C.gray}choose ▸ ${C.reset}`)).toLowerCase();
    if (c === "b" || c === "") return;
    const idx = Number(c) - 1;
    if (KEYS[idx]) {
      const v = await ask(`  ${KEYS[idx].label} = `);
      if (v) { setEnv(KEYS[idx].key, v); console.log(C.green + "  saved" + C.reset); await ask(C.gray + "  enter" + C.reset); }
    }
  }
}

async function statusScreen() {
  clear(); banner();
  const env = readEnv();
  console.log(`${C.white}${C.bold}  Status${C.reset}\n`);
  const row = (label, ok) => console.log(`  ${ok ? C.green + "●" : C.red + "○"} ${C.reset}${label}`);
  row("Telegram messaging", env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_IDS);
  for (const k of KEYS) if (k.key.startsWith("TELEGRAM")) continue; else row(k.label, !!env[k.key]);
  console.log(`\n  ${C.gray}config: ${ENV_PATH}${C.reset}`);
  await ask(C.gray + "\n  enter to go back" + C.reset);
}

async function testScreen() {
  clear(); banner();
  console.log(`${C.white}${C.bold}  Test my setup${C.reset}\n`);
  const env = readEnv();
  const line = (ok, label, note = "") => console.log(`  ${ok ? C.green + "✓" : C.red + "✗"} ${C.reset}${label}${note ? C.gray + "  " + note + C.reset : ""}`);

  // Telegram: prove the token is real (getMe) and actually deliver a test message.
  if (env.TELEGRAM_BOT_TOKEN) {
    process.stdout.write(`  ${C.gray}checking Telegram…${C.reset}\r`);
    try {
      const me = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`).then((r) => r.json());
      if (me.ok) {
        line(true, `Telegram bot`, "@" + me.result.username);
        if (env.TELEGRAM_ALLOWED_USER_IDS) {
          const chat = String(env.TELEGRAM_ALLOWED_USER_IDS).split(",")[0].trim();
          const sent = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text: "✅ Orion AI setup test — messaging works." }),
          }).then((r) => r.json());
          line(sent.ok, `Test message to your Telegram`, sent.ok ? "check your phone" : (sent.description || "failed"));
        } else line(false, "Your Telegram user id", "not set");
      } else line(false, "Telegram bot token", me.description || "invalid");
    } catch (e) { line(false, "Telegram", "no network: " + String(e.message).slice(0, 40)); }
  } else line(false, "Telegram bot token", "not set");

  // API keys: format sanity, not a live call (avoids surprise charges on a test).
  for (const k of KEYS) {
    if (k.key.startsWith("TELEGRAM")) continue;
    if (!env[k.key]) { line(false, k.label, "not set"); continue; }
    const check = KEY_SHAPE[k.key] ? KEY_SHAPE[k.key](env[k.key]) : true;
    line(check === true, k.label, check === true ? "looks right" : check);
  }
  await ask(C.gray + "\n  enter to go back" + C.reset);
}

async function startScreen() {
  clear(); banner();
  console.log(`${C.white}${C.bold}  Start services${C.reset}\n`);
  console.log(`  Runs ${C.cyan}${START_COMMAND}${C.reset} in this folder.\n`);
  const go = (await ask(`  Start now? ${C.gray}(y/N)${C.reset} `)).toLowerCase();
  if (go !== "y") return;
  console.log(`\n  ${C.gray}launching…${C.reset}`);
  try {
    const [cmd, ...rest] = START_COMMAND.split(" ");
    const bin = process.platform === "win32" ? cmd + ".cmd" : cmd;
    const child = spawn(bin, rest, { cwd: process.cwd(), detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.unref();
    console.log(C.green + "  started in the background." + C.reset);
  } catch (e) { console.log(C.red + "  could not start: " + e.message + C.reset); }
  await ask(C.gray + "\n  enter to go back" + C.reset);
}

async function helpScreen() {
  clear(); banner();
  console.log(`${C.white}${C.bold}  Request help${C.reset}\n`);
  console.log(`  Reach Orion directly:\n`);
  console.log(`  ${C.cyan}1${C.reset}) Email  ${C.white}${SUPPORT_EMAIL}${C.reset}`);
  console.log(`  ${C.cyan}2${C.reset}) Call   ${C.white}${SUPPORT_PHONE}${C.reset}`);
  console.log(`  ${C.cyan}b${C.reset}) Back\n`);
  const c = (await ask(`${C.gray}choose ▸ ${C.reset}`)).toLowerCase();
  if (c === "1") {
    console.log(`\n  ${C.gray}Opening your email to ${SUPPORT_EMAIL}…${C.reset}`);
    openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Help with my Orion AI setup")}`);
    console.log(`  ${C.gray}If nothing opened, just email ${SUPPORT_EMAIL} directly.${C.reset}`);
  } else if (c === "2") {
    console.log(`\n  ${C.gray}Opening your dialer…${C.reset}`);
    openExternal(`tel:${SUPPORT_PHONE.replace(/[^0-9+]/g, "")}`);
    console.log(`  ${C.gray}Or call ${SUPPORT_PHONE} directly.${C.reset}`);
  } else return;
  await ask(C.gray + "\n  enter to go back" + C.reset);
}

// Open a mailto:/tel: with the OS default handler, cross-platform, best-effort.
function openExternal(uri) {
  try {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", uri]]
      : process.platform === "darwin" ? ["open", [uri]]
      : ["xdg-open", [uri]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

// Non-interactive guard: if there's no TTY, print how to run it rather than hang.
if (!process.stdin.isTTY) {
  banner();
  console.log(C.gray + "  Run this in a terminal to configure: node deploy/orion-setup.mjs" + C.reset);
  process.exit(0);
}
licenseGate().then((ok) => ok ? mainMenu() : null).then(() => process.exit(0));
