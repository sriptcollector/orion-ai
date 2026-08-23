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
import os from "node:os";
import crypto from "node:crypto";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", italic: "\x1b[3m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  gray: "\x1b[90m", white: "\x1b[97m", magenta: "\x1b[35m",
};
const ENV_PATH = process.env.ORION_ENV_PATH || path.resolve(process.cwd(), ".env");

// Per-client theming + config. Drop a deploy/orion-theme.json in a client bundle
// to rebrand and set the support contact / key list without touching code:
//   { "subtitle":"ACME AI", "watermark":"~ built for ACME by Orion ~",
//     "supportEmail":"help@orion-jones.com", "supportPhone":"424-422-5031",
//     "startCommand":"npm start",
//     "updates":[{ "date":"2026-08-22","text":"Nightly backups are now live." }],
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
let UPDATES = Array.isArray(THEME.updates) ? THEME.updates : [];        // [{date,text}]
// Live patch notes: the terminal fetches a feed Orion controls, so an update he
// publishes shows up in every client's terminal without a reinstall. Falls back
// to the bundled theme.updates if offline. Override the URL via theme.updatesUrl.
const UPDATES_URL = THEME.updatesUrl || "https://raw.githubusercontent.com/sriptcollector/orion-ai/main/deploy/updates.json";
async function fetchRemoteUpdates() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(UPDATES_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return;
    const remote = await r.json();
    const list = Array.isArray(remote) ? remote : (Array.isArray(remote?.updates) ? remote.updates : []);
    if (list.length) {
      const seen = new Set();
      UPDATES = [...list, ...UPDATES]
        .filter((u) => u && u.text && !seen.has(u.date + u.text) && seen.add(u.date + u.text))
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    }
  } catch {}
}

// Live AI-news feed + a lightweight stock watchlist for the News & markets screen.
// The bundled deploy/news.json seeds content immediately; the live NEWS_URL feed
// overrides it the same way UPDATES_URL overrides theme.updates. Tickers come from
// the free Yahoo Finance chart endpoint (no key), each fetch independently guarded.
function loadNews() {
  for (const p of [path.resolve(process.cwd(), "deploy", "news.json"), path.resolve(process.cwd(), "news.json")]) {
    try { if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(j)) return j; } } catch {}
  }
  return Array.isArray(THEME.news) ? THEME.news : [];
}
let NEWS = loadNews();                                   // [{date,title,source?}]
const NEWS_URL = THEME.newsUrl || "https://raw.githubusercontent.com/sriptcollector/orion-ai/main/deploy/news.json";
const TICKERS = Array.isArray(THEME.tickers) && THEME.tickers.length ? THEME.tickers : ["AAPL", "NVDA", "MSFT", "MNKD"];
async function fetchNews() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(NEWS_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return;
    const remote = await r.json();
    const list = Array.isArray(remote) ? remote : (Array.isArray(remote?.news) ? remote.news : []);
    if (list.length) {
      const seen = new Set();
      NEWS = [...list, ...NEWS]
        .filter((n) => n && n.title && !seen.has(n.date + n.title) && seen.add(n.date + n.title))
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    }
  } catch {}
}
// One symbol, its own timeout + try/catch so a single failure never breaks the row.
async function fetchQuote(symbol) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { symbol, ok: false };
    const j = await r.json();
    const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") return { symbol, ok: false };
    const price = meta.regularMarketPrice;
    const prev = typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose : meta.previousClose;
    const pct = (typeof prev === "number" && prev) ? ((price - prev) / prev) * 100 : null;
    return { symbol, ok: true, price, pct };
  } catch { return { symbol, ok: false }; }
}

// Custom accent color per client (hex -> ANSI truecolor). Falls back to cyan.
function parseHex(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return null;
  return [1, 2, 3].map((i) => parseInt(m[i], 16));
}
function rgbAnsi(rgb, fg = true) {
  if (!rgb) return fg ? C.cyan : C.magenta;
  const [r, g, b] = rgb;
  return `\x1b[${fg ? 38 : 48};2;${r};${g};${b}m`;
}
const ACCENT_RGB = parseHex(THEME.accent);
const ACCENT = rgbAnsi(ACCENT_RGB);
// A refined color system derived from the accent: a softened tint for borders and
// rules so panels feel cohesive rather than shouting the accent everywhere.
const ACCENT_SOFT = ACCENT_RGB ? rgbAnsi(ACCENT_RGB.map((c) => Math.round(c * 0.55 + 12))) : C.gray;

// Licensing / anti-sharing. A client bundle carries an expected key (THEME.license)
// and, once activated, binds to THIS machine (a hash of the hostname). Copying the
// folder to another computer fails the machine check and must be re-activated with
// the key, which only the issuer (Orion) hands out. Real online validation against
// THEME.licenseServer is the phase-2 hardening; this stops casual folder-sharing.
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
const W = 62;                                   // frame width (outer)
const clear = () => process.stdout.write("\x1b[2J\x1b[H");
const mask = (v) => (v ? "•".repeat(Math.min(8, v.length)) + (v.length > 8 ? "…" : "") : "");
// Visible length + padding that ignore ANSI escape sequences, so boxes align.
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const visLen = (s) => [...stripAnsi(s)].length;
function padV(s, n) { const pad = n - visLen(s); return pad > 0 ? s + " ".repeat(pad) : s; }
function truncV(s, n) {
  if (visLen(s) <= n) return s;
  // Trim visible chars while preserving trailing reset.
  let out = "", count = 0, i = 0, raw = String(s);
  while (i < raw.length && count < n - 1) {
    if (raw[i] === "\x1b") { const m = /^\x1b\[[0-9;]*m/.exec(raw.slice(i)); if (m) { out += m[0]; i += m[0].length; continue; } }
    out += raw[i]; count++; i++;
  }
  return out + "…";
}

const B = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
// Draw a titled, rounded panel. `lines` are pre-colored content strings.
function panel(lines, { title = "", color = ACCENT_SOFT, width = W } = {}) {
  const inner = width - 2;                       // chars between the vertical bars
  const out = [];
  let top;
  if (title) {
    const seg = `${B.h} ${C.reset}${C.bold}${C.white}${title}${C.reset}${color} `;
    const used = visLen(`${B.h} ${title} `);
    top = color + B.tl + seg + B.h.repeat(Math.max(0, inner - used)) + B.tr + C.reset;
  } else {
    top = color + B.tl + B.h.repeat(inner) + B.tr + C.reset;
  }
  out.push(top);
  for (const ln of lines) {
    const body = truncV(ln, inner - 2);
    out.push(`${color}${B.v}${C.reset} ${padV(body, inner - 2)} ${color}${B.v}${C.reset}`);
  }
  out.push(color + B.bl + B.h.repeat(inner) + B.br + C.reset);
  return out;
}
const printPanel = (lines, opts) => process.stdout.write(panel(lines, opts).join("\n") + "\n");

// A tasteful spinner for network work. Returns a stop() that clears the line.
function startSpinner(label) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  process.stdout.write("\x1b[?25l");
  const t = setInterval(() => {
    process.stdout.write(`\r  ${ACCENT}${frames[i++ % frames.length]}${C.reset} ${C.gray}${label}${C.reset}   `);
  }, 80);
  return () => { clearInterval(t); process.stdout.write("\r\x1b[K\x1b[?25h"); };
}

function nowStamp() {
  const d = new Date();
  try {
    const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${day} · ${time}`;
  } catch { return d.toString().slice(0, 21); }
}

function banner() {
  const art = [
    "  ___  ____  ___ ___  _  _ ",
    " / _ \\|  _ \\|_ _/ _ \\| \\| |",
    "| (_) | |_) || | (_) | .` |",
    " \\___/|_| \\_\\___\\___/|_|\\_|",
  ];
  process.stdout.write("\n" + ACCENT + C.bold + art.join("\n") + C.reset + "\n");
  process.stdout.write("    " + ACCENT_SOFT + SUBTITLE + C.reset + "\n");
  if (CLIENT_NAME) process.stdout.write("    " + C.white + C.bold + "Welcome, " + CLIENT_NAME + C.reset + "\n");
  process.stdout.write("    " + C.dim + C.magenta + WATERMARK + C.reset + "\n\n");
}

// Section header used inside screens (not a full box) for lightweight hierarchy.
function header(title, sub = "") {
  process.stdout.write(`  ${ACCENT}${C.bold}${title}${C.reset}${sub ? "   " + C.gray + sub + C.reset : ""}\n\n`);
}
// Persistent footer hint bar — keeps navigation always in view.
function footer(hint) {
  process.stdout.write("\n  " + ACCENT_SOFT + B.h.repeat(W - 2) + C.reset + "\n");
  process.stdout.write("  " + C.gray + hint + C.reset + "\n");
}

function rl() { return readline.createInterface({ input: process.stdin, output: process.stdout }); }
const ask = (q) => new Promise((res) => { const i = rl(); i.question(q, (a) => { i.close(); res(a.trim()); }); });
const prompt = (label = "choose") => ask(`  ${ACCENT}▸${C.reset} ${C.gray}${label}${C.reset} `);
const pause = () => ask(`  ${C.gray}press enter to go back${C.reset}`);

// ---- Screens -----------------------------------------------------------------
// Gate the app on a valid, machine-bound license before anything else.
async function licenseGate() {
  if (!THEME.license) return true; // unlicensed build (dev) -> open
  let lic = null;
  try { lic = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf8")); } catch {}
  if (lic && lic.key === THEME.license && lic.machine === machineId()) return true;
  clear(); banner();
  header("Activate this software");
  if (lic && lic.machine !== machineId()) console.log(`  ${C.yellow}This copy was activated on another computer. Re-enter your key to move it here.${C.reset}\n`);
  console.log(`  ${C.gray}Enter the license key Orion gave you. It locks to this machine,${C.reset}`);
  console.log(`  ${C.gray}so the software can't be shared by copying the folder.${C.reset}\n`);
  for (let tries = 0; tries < 3; tries++) {
    const key = await ask(`  License key: `);
    if (key === THEME.license) {
      fs.writeFileSync(LICENSE_FILE, JSON.stringify({ key, machine: machineId(), activatedAt: new Date().toISOString() }, null, 2));
      console.log(C.green + "\n  ✓ Activated on this machine. Thanks!" + C.reset);
      await ask(`  ${C.gray}press enter to continue${C.reset}`);
      return true;
    }
    console.log(C.red + "  ✗ That key doesn't match. " + (2 - tries) + " tries left." + C.reset);
  }
  console.log(C.red + "\n  Could not activate. Contact Orion: " + SUPPORT_EMAIL + C.reset);
  return false;
}

// Colored status dot for a project row.
function projectDot(status) {
  if (/live|done|active|green/i.test(status || "")) return C.green + "●" + C.reset;
  if (/build|progress|wip/i.test(status || "")) return C.yellow + "●" + C.reset;
  return C.gray + "○" + C.reset;
}

function dashboard(env) {
  clear(); banner();

  const tgOk = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_IDS;
  const keyCount = KEYS.filter((k) => env[k.key]).length;
  const liveCount = PROJECTS.filter((p) => /live|done|active|green/i.test(p.status || "")).length;
  const svc = PROJECTS.length ? `${liveCount}/${PROJECTS.length} live` : (tgOk ? "messaging ready" : "not configured");
  const dot = (tgOk && keyCount) ? C.green + "●" : keyCount ? C.yellow + "●" : C.red + "●";

  // Header panel: live clock + a one-line system summary.
  printPanel([
    `${C.white}${nowStamp()}${C.reset}`,
    `${dot}${C.reset}  ${C.gray}services${C.reset} ${svc}   ${C.gray}·${C.reset}   ${C.gray}keys${C.reset} ${keyCount}/${KEYS.length}   ${C.gray}·${C.reset}   ${C.gray}telegram${C.reset} ${tgOk ? C.green + "on" + C.reset : C.yellow + "off" + C.reset}`,
  ], { title: `Dashboard${CLIENT_NAME ? " — " + CLIENT_NAME : ""}` });
  console.log("");

  // Projects panel.
  const projLines = PROJECTS.length
    ? PROJECTS.map((p) => `${projectDot(p.status)} ${padV(C.white + p.name + C.reset, 22)} ${C.gray}${p.status || ""}${C.reset}`)
    : [`${C.gray}No projects yet — Orion will add these for you.${C.reset}`];
  printPanel(projLines, { title: "Projects" });
  console.log("");

  // Routines panel.
  const routineLines = ROUTINES.length
    ? ROUTINES.map((r) => `${ACCENT}•${C.reset} ${padV(C.white + r.name + C.reset, 22)} ${C.gray}${r.schedule || ""}${C.reset}`)
    : [`${C.gray}No routines scheduled yet.${C.reset}`];
  printPanel(routineLines, { title: "Routines" });

  // What's new — only when the theme provides updates.
  if (UPDATES.length) {
    console.log("");
    const updLines = UPDATES.slice(0, 4).map((u) => `${ACCENT_SOFT}${u.date || ""}${C.reset}  ${C.white}${u.text || ""}${C.reset}`);
    printPanel(updLines, { title: "What's new" });
  }
}

async function bookScreen() {
  clear(); banner();
  header("Book a session with Orion");
  console.log(`  ${ACCENT}1${C.reset}  Open the booking page   ${C.gray}${BOOK_URL}${C.reset}`);
  console.log(`  ${ACCENT}2${C.reset}  Email to schedule       ${C.gray}${SUPPORT_EMAIL}${C.reset}`);
  footer("1–2 choose · b back");
  const c = (await prompt()).toLowerCase();
  if (c === "1") { openExternal(BOOK_URL); console.log(`\n  ${C.gray}Opening ${BOOK_URL}…${C.reset}`); await pause(); }
  else if (c === "2") { openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Booking a session")}`); console.log(`\n  ${C.gray}Opening your email…${C.reset}`); await pause(); }
}

// News & markets: a live AI-headline feed + a small stock watchlist. Both use the
// same fetch-with-timeout + graceful-fallback pattern as fetchRemoteUpdates, and
// the quotes run in parallel so the screen never feels slow.
async function newsScreen() {
  clear(); banner();
  header("News & markets", "AI headlines + your watchlist");
  const stop = startSpinner("fetching the latest…");
  await fetchNews();
  const quotes = await Promise.all(TICKERS.map(fetchQuote));
  stop();

  // AI NEWS panel — latest ~5, with a clean empty state when the feed is offline.
  const newsLines = NEWS.length
    ? NEWS.slice(0, 5).map((n) => `${ACCENT_SOFT}${n.date || ""}${C.reset}  ${C.white}${n.title || ""}${C.reset}${n.source ? "  " + C.gray + n.source + C.reset : ""}`)
    : [`${C.gray}News is offline right now — check back in a bit.${C.reset}`];
  printPanel(newsLines, { title: "AI news" });
  console.log("");

  // STOCKS panel — one right-aligned row per symbol, green up / red down, and a
  // dim "—" for any ticker that failed so one bad fetch never breaks the panel.
  const inner = W - 6;                            // usable content width inside the box
  const stockLines = quotes.map((q) => {
    const symTag = `${ACCENT}${C.bold}${q.symbol}${C.reset}`;
    let right;
    if (!q.ok) right = `${C.gray}—${C.reset}`;
    else {
      const price = `${C.white}$${q.price.toFixed(2)}${C.reset}`;
      let move;
      if (q.pct == null) move = `${C.gray}—${C.reset}`;
      else {
        const up = q.pct >= 0;
        move = `${up ? C.green : C.red}${up ? "▲" : "▼"} ${up ? "+" : "−"}${Math.abs(q.pct).toFixed(2)}%${C.reset}`;
      }
      right = `${price}   ${padV(move, 10)}`;
    }
    const gap = inner - visLen(symTag) - visLen(right);
    return symTag + " ".repeat(Math.max(1, gap)) + right;
  });
  printPanel(stockLines, { title: "Stocks" });
  footer("enter back");
  await pause();
}

// Crypto trading is a locked, premium add-on — this screen sells it and routes the
// client to Orion to unlock it. It intentionally implements no trading itself.
async function cryptoScreen() {
  clear(); banner();
  header("Crypto trading", `${C.yellow}🔒 Premium add-on${C.reset}`);
  printPanel([
    `${C.white}${C.bold}Automated crypto trading${C.reset}`,
    ``,
    `${C.gray}A hands-off engine that watches the market around the clock${C.reset}`,
    `${C.gray}and trades a strategy Orion tunes to your risk appetite —${C.reset}`,
    `${C.gray}dollar-cost averaging, momentum entries, and stop-loss${C.reset}`,
    `${C.gray}protection, all running quietly in the background.${C.reset}`,
    ``,
    `${ACCENT}•${C.reset} ${C.white}24/7 automated execution${C.reset}`,
    `${ACCENT}•${C.reset} ${C.white}Risk limits + stop-loss you set${C.reset}`,
    `${ACCENT}•${C.reset} ${C.white}Weekly performance reports to your phone${C.reset}`,
    ``,
    `${C.yellow}🔒 Premium — Orion installs and configures this for you.${C.reset}`,
  ], { title: "Crypto trading — Premium", color: rgbAnsi([201, 162, 39]) });
  console.log("");
  console.log(`  ${ACCENT}1${C.reset}  Email to unlock   ${C.white}${SUPPORT_EMAIL}${C.reset}`);
  console.log(`  ${ACCENT}2${C.reset}  Call to unlock    ${C.white}${SUPPORT_PHONE}${C.reset}`);
  footer("1–2 unlock · b back");
  const c = (await prompt()).toLowerCase();
  if (c === "1") {
    console.log(`\n  ${C.gray}Opening your email to ${SUPPORT_EMAIL}…${C.reset}`);
    openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Unlock crypto trading")}`);
    console.log(`  ${C.gray}If nothing opened, just email ${SUPPORT_EMAIL} directly.${C.reset}`);
    await pause();
  } else if (c === "2") {
    console.log(`\n  ${C.gray}Opening your dialer…${C.reset}`);
    openExternal(`tel:${SUPPORT_PHONE.replace(/[^0-9+]/g, "")}`);
    console.log(`  ${C.gray}Or call ${SUPPORT_PHONE} directly.${C.reset}`);
    await pause();
  }
}

// Where the terminal keeps the client's one-time consent to let the agent act.
const AGENT_CONSENT_FILE = path.resolve(process.cwd(), ".agent-consent");
const claudeBin = () => (process.platform === "win32" ? "claude.cmd" : "claude");

// Run one Claude Code turn headlessly and return its text result. The agent has
// the FULL capabilities of Claude Code (read/write files, run commands, tools)
// scoped to this folder. That power is gated behind a one-time consent below.
function runClaude(taskText) {
  return new Promise((resolve) => {
    let buf = "", err = "";
    let child;
    try {
      child = spawn(claudeBin(), ["-p", taskText, "--output-format", "json", "--dangerously-skip-permissions"],
        { cwd: process.cwd(), shell: process.platform === "win32", windowsHide: true });
    } catch (e) { return resolve({ ok: false, why: "could not launch Claude Code: " + e.message }); }
    child.on("error", (e) => resolve({ ok: false, why: e.code === "ENOENT" ? "missing" : e.message }));
    child.stdout.on("data", (d) => (buf += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      try { const j = JSON.parse(buf); resolve({ ok: true, result: j.result || "(no reply)" }); }
      catch { resolve({ ok: false, why: (err || buf || "no output").slice(0, 200) }); }
    });
  });
}

// The flagship: a full Claude Code agent inside the branded terminal.
async function agentScreen() {
  clear(); banner();
  header("Ask the agent");
  console.log(`  ${C.gray}Your AI agent, with the full power of Claude Code — it can read and${C.reset}`);
  console.log(`  ${C.gray}write files, run commands, and do real work in this folder.${C.reset}\n`);

  const env = readEnv();
  if (!env.ANTHROPIC_API_KEY) {
    console.log(`  ${C.yellow}Add your Anthropic (Claude) API key first — menu ▸ API keys.${C.reset}`);
    return void (await pause());
  }
  // One-time, informed consent before the agent can touch the machine.
  if (!fs.existsSync(AGENT_CONSENT_FILE)) {
    console.log(`  ${C.white}This agent can read/write files and run commands in:${C.reset}`);
    console.log(`  ${C.gray}${process.cwd()}${C.reset}\n`);
    const ok = (await prompt("  Allow it to act here? (y/N) ")).toLowerCase();
    if (ok !== "y") { console.log(`\n  ${C.gray}No problem — nothing enabled.${C.reset}`); return void (await pause()); }
    try { fs.writeFileSync(AGENT_CONSENT_FILE, new Date().toISOString()); } catch {}
  }
  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY; // hand the key to the child

  for (;;) {
    const task = await prompt("\n  What should it do? (blank to go back) ");
    if (!task.trim()) return;
    process.stdout.write(`\n  ${ACCENT}● ${C.reset}${C.gray}working…${C.reset}`);
    const r = await runClaude(task);
    process.stdout.write("\r\x1b[2K");
    if (r.ok) {
      console.log(`  ${ACCENT}${B.v}${C.reset} ${C.white}Agent${C.reset}\n`);
      for (const ln of String(r.result).split(/\n/)) console.log("  " + ln);
    } else if (r.why === "missing") {
      console.log(`  ${C.yellow}Claude Code isn't installed on this machine.${C.reset}`);
      console.log(`  ${C.gray}Install it once:  npm install -g @anthropic-ai/claude-code${C.reset}`);
      return void (await pause());
    } else {
      console.log(`  ${C.red}That didn't run: ${r.why}${C.reset}`);
    }
  }
}

async function mainMenu() {
  for (;;) {
    const env = readEnv();
    dashboard(env);
    const tgOk = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_IDS;
    const keyCount = KEYS.filter((k) => env[k.key]).length;
    console.log("");
    const item = (n, letter, label, note = "") =>
      console.log(`  ${ACCENT}${n}${C.reset} ${C.gray}${letter}${C.reset}  ${padV(label, 22)} ${note}`);
    header("Menu");
    item("0", "a", `${ACCENT}Ask the agent${C.reset}`, `${C.gray}powered by Claude Code${C.reset}`);
    item("1", "t", "Telegram messaging", tgOk ? C.green + "✓ configured" + C.reset : C.yellow + "not set" + C.reset);
    item("2", "k", "API keys", `${C.gray}${keyCount}/${KEYS.length} set${C.reset}`);
    item("3", "s", "Status");
    item("4", "d", "Test my setup");
    item("5", "r", "Start services");
    item("6", "b", `${C.magenta}Book a session${C.reset}`);
    item("7", "c", `${C.magenta}Contact Orion${C.reset}`);
    item("8", "n", "News & markets", `${C.gray}AI news + stocks${C.reset}`);
    item("9", "p", `${C.magenta}Crypto trading${C.reset}`, `${C.yellow}🔒 Premium${C.reset}`);
    footer("0–9 or shortcut letter · q save & quit");
    const c = (await prompt()).toLowerCase();
    if (c === "0" || c === "a") await agentScreen();
    else if (c === "1" || c === "t") await telegramSetup();
    else if (c === "2" || c === "k") await keysSetup();
    else if (c === "3" || c === "s") await statusScreen();
    else if (c === "4" || c === "d") await testScreen();
    else if (c === "5" || c === "r") await startScreen();
    else if (c === "6") await bookScreen();
    else if (c === "7" || c === "c") await helpScreen();
    else if (c === "8" || c === "n") await newsScreen();
    else if (c === "9" || c === "p") await cryptoScreen();
    else if (c === "q") { clear(); console.log("\n  " + C.green + "✓ Saved to " + ENV_PATH + ". You're all set." + C.reset + "\n"); return; }
  }
}

async function telegramSetup() {
  clear(); banner();
  header("Telegram messaging", "message your assistant like a text");
  console.log(`  ${C.gray}1. Open @BotFather, send /newbot, copy the token.${C.reset}`);
  console.log(`  ${C.gray}2. Open @userinfobot to get your numeric user id.${C.reset}\n`);
  const tok = await ask(`  Bot token ${C.gray}(enter to skip)${C.reset}: `);
  if (tok) setEnv("TELEGRAM_BOT_TOKEN", tok);
  const uid = await ask(`  Your Telegram user id: `);
  if (uid) setEnv("TELEGRAM_ALLOWED_USER_IDS", uid);
  console.log(C.green + "\n  ✓ Saved." + C.reset);
  await pause();
}

async function keysSetup() {
  for (;;) {
    clear(); banner();
    const env = readEnv();
    header("API keys", "pick a number to set · b to go back");
    KEYS.forEach((k, i) => {
      const cur = env[k.key]
        ? C.green + "✓ " + (k.secret ? mask(env[k.key]) : env[k.key]) + C.reset
        : C.yellow + "— not set —" + C.reset;
      console.log(`  ${ACCENT}${i + 1}${C.reset}  ${padV(k.label, 26)} ${padV(cur, 20)} ${C.gray}${k.hint}${C.reset}`);
    });
    footer("number set · b back");
    const c = (await prompt()).toLowerCase();
    if (c === "b" || c === "") return;
    const idx = Number(c) - 1;
    if (KEYS[idx]) {
      const v = await ask(`\n  ${KEYS[idx].label} = `);
      if (v) { setEnv(KEYS[idx].key, v); console.log(C.green + "  ✓ saved" + C.reset); await ask(`  ${C.gray}enter${C.reset}`); }
    }
  }
}

async function statusScreen() {
  clear(); banner();
  const env = readEnv();
  header("Status");
  const rows = [];
  const row = (label, ok, note = "") => rows.push(`${ok ? C.green + "●" : C.red + "○"}${C.reset}  ${padV(C.white + label + C.reset, 30)} ${C.gray}${note}${C.reset}`);
  row("Telegram messaging", env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_IDS, (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_IDS) ? "ready" : "needs token + id");
  for (const k of KEYS) { if (k.key.startsWith("TELEGRAM")) continue; row(k.label, !!env[k.key], env[k.key] ? "set" : "not set"); }
  printPanel(rows, { title: "Configuration" });
  console.log(`\n  ${C.gray}config file: ${ENV_PATH}${C.reset}`);
  footer("enter back");
  await pause();
}

async function testScreen() {
  clear(); banner();
  header("Test my setup", "runs a live check on your connections");
  const env = readEnv();
  const line = (ok, label, note = "") => console.log(`  ${ok ? C.green + "✓" : C.red + "✗"} ${C.reset}${padV(label, 30)}${note ? C.gray + "  " + note + C.reset : ""}`);

  // Telegram: prove the token is real (getMe) and actually deliver a test message.
  if (env.TELEGRAM_BOT_TOKEN) {
    let stop = startSpinner("checking Telegram bot…");
    try {
      const me = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`).then((r) => r.json());
      stop();
      if (me.ok) {
        line(true, `Telegram bot`, "@" + me.result.username);
        if (env.TELEGRAM_ALLOWED_USER_IDS) {
          stop = startSpinner("sending a test message…");
          const chat = String(env.TELEGRAM_ALLOWED_USER_IDS).split(",")[0].trim();
          const sent = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text: "✅ Orion AI setup test — messaging works." }),
          }).then((r) => r.json());
          stop();
          line(sent.ok, `Test message to your Telegram`, sent.ok ? "check your phone" : (sent.description || "failed"));
        } else line(false, "Your Telegram user id", "not set");
      } else line(false, "Telegram bot token", me.description || "invalid");
    } catch (e) { stop(); line(false, "Telegram", "no network: " + String(e.message).slice(0, 40)); }
  } else line(false, "Telegram bot token", "not set");

  // API keys: format sanity, not a live call (avoids surprise charges on a test).
  for (const k of KEYS) {
    if (k.key.startsWith("TELEGRAM")) continue;
    if (!env[k.key]) { line(false, k.label, "not set"); continue; }
    const check = KEY_SHAPE[k.key] ? KEY_SHAPE[k.key](env[k.key]) : true;
    line(check === true, k.label, check === true ? "looks right" : check);
  }
  footer("enter back");
  await pause();
}

async function startScreen() {
  clear(); banner();
  header("Start services");
  console.log(`  Runs ${ACCENT}${START_COMMAND}${C.reset} in this folder.\n`);
  const go = (await ask(`  Start now? ${C.gray}(y/N)${C.reset} `)).toLowerCase();
  if (go !== "y") return;
  const stop = startSpinner("launching…");
  try {
    const [cmd, ...rest] = START_COMMAND.split(" ");
    const bin = process.platform === "win32" ? cmd + ".cmd" : cmd;
    const child = spawn(bin, rest, { cwd: process.cwd(), detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.unref();
    stop();
    console.log(C.green + "  ✓ Started in the background." + C.reset);
  } catch (e) { stop(); console.log(C.red + "  ✗ Could not start: " + e.message + C.reset); }
  footer("enter back");
  await pause();
}

async function helpScreen() {
  clear(); banner();
  header("Contact Orion", "reach a real person, fast");
  console.log(`  ${ACCENT}1${C.reset}  Email   ${C.white}${SUPPORT_EMAIL}${C.reset}`);
  console.log(`  ${ACCENT}2${C.reset}  Call    ${C.white}${SUPPORT_PHONE}${C.reset}`);
  footer("1–2 choose · b back");
  const c = (await prompt()).toLowerCase();
  if (c === "1") {
    console.log(`\n  ${C.gray}Opening your email to ${SUPPORT_EMAIL}…${C.reset}`);
    openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Help with my Orion AI setup")}`);
    console.log(`  ${C.gray}If nothing opened, just email ${SUPPORT_EMAIL} directly.${C.reset}`);
  } else if (c === "2") {
    console.log(`\n  ${C.gray}Opening your dialer…${C.reset}`);
    openExternal(`tel:${SUPPORT_PHONE.replace(/[^0-9+]/g, "")}`);
    console.log(`  ${C.gray}Or call ${SUPPORT_PHONE} directly.${C.reset}`);
  } else return;
  await pause();
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
licenseGate()
  .then((ok) => ok ? fetchRemoteUpdates().then(mainMenu) : null)
  .then(() => process.exit(0));
