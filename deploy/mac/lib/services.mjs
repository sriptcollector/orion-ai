// The service board. One probe per thing that can be up, down, or half-broken,
// so the same picture renders in the terminal, in Telegram, and on the remote
// status page — and nobody has to guess which of the three is telling the truth.
//
// Every probe returns the same shape:
//   { id, label, group, state: "up"|"warn"|"down"|"off", detail, url? }
//
//   up    working now
//   warn  working but needs a human soon (session expiring, cap hit, paused)
//   down  broken, the thing it does is not happening
//   off   deliberately not configured — not a failure, don't alarm anyone
//
// Probes must be individually guarded and individually timed out. A hung
// Tailscale call must never blank the whole board, because a blank board during
// an outage is exactly when someone needs to read it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA, ROOT, loadEnv } from "./env.mjs";
import { read } from "./store.mjs";
import { getSettings } from "./settings.mjs";
import * as queue from "./queue.mjs";

const execFileP = promisify(execFile);
loadEnv();

const sh = async (bin, args, ms = 6000) => (await execFileP(bin, args, { timeout: ms })).stdout.trim();
const ageMin = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : null);

// ---------------------------------------------------------------- remote access

// Tailscale is how Orion and the client reach this Mac from anywhere, so its
// own status is the most important row on the board: if this is down, nothing
// else on the board can be checked remotely either.
async function tailscale() {
  const base = { id: "tailscale", label: "Tailscale", group: "Remote access", url: "https://login.tailscale.com/admin/machines" };
  const bins = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "tailscale"];
  for (const bin of bins) {
    try {
      const out = await sh(bin, ["status", "--json"], 8000);
      const j = JSON.parse(out);
      const state = j.BackendState || "";
      const self = j.Self || {};
      const ip = (self.TailscaleIPs || [])[0] || "";
      const name = (self.DNSName || "").replace(/\.$/, "");
      if (state !== "Running") {
        return { ...base, state: "down", detail: `backend is ${state || "unknown"} - open the Tailscale app and connect` };
      }
      return { ...base, state: "up", detail: `${name || self.HostName || os.hostname()}${ip ? ` · ${ip}` : ""}`, ip, magicDNS: name };
    } catch {}
  }
  return { ...base, state: "off", detail: "not installed - install from tailscale.com to reach this Mac remotely" };
}

// Chrome Remote Desktop: the fallback when someone needs the actual screen
// rather than a terminal.
async function chromeRemote() {
  const base = { id: "crd", label: "Chrome Remote Desktop", group: "Remote access", url: "https://remotedesktop.google.com/access" };
  const hostDir = "/Library/Application Support/Google/Chrome Remote Desktop";
  const installed = existsSync(hostDir) || existsSync("/Applications/Chrome Remote Desktop Host.app");
  if (!installed) return { ...base, state: "off", detail: "not installed - set up at remotedesktop.google.com/access" };
  try {
    const out = await sh("/bin/sh", ["-c", "pgrep -fl remoting_me2me_host || true"], 5000);
    if (out) return { ...base, state: "up", detail: "host running - reachable at remotedesktop.google.com" };
    return { ...base, state: "down", detail: "installed but the host isn't running - re-enable remote access in Chrome" };
  } catch { return { ...base, state: "warn", detail: "installed, could not confirm the host is running" }; }
}

// ------------------------------------------------------------------- control

async function telegramBridge() {
  const base = { id: "telegram", label: "Telegram bridge", group: "Control" };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ...base, state: "down", detail: "no bot token - run the setup screen" };
  if (!process.env.TELEGRAM_ALLOWED_USER_IDS) return { ...base, state: "warn", detail: "connected but no allowlist, so nobody can use it" };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const j = await (await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: c.signal })).json();
    clearTimeout(t);
    if (!j.ok) return { ...base, state: "down", detail: j.description || "token rejected" };
    return { ...base, state: "up", detail: `@${j.result.username}`, url: `https://t.me/${j.result.username}` };
  } catch { return { ...base, state: "down", detail: "cannot reach Telegram from this machine" }; }
}

function chatbot() {
  const base = { id: "chatbot", label: "Chatbot (DeepSeek)", group: "Control" };
  if (!process.env.DEEPSEEK_API_KEY) return { ...base, state: "down", detail: "no API key - nothing can be written without it" };
  const brief = (() => {
    try { return read("brief", null)?.text || JSON.parse(readFileSync(path.join(ROOT, "config", "brief.json"), "utf8")).text || ""; } catch { return ""; }
  })();
  if (!brief || brief.length < 40) return { ...base, state: "warn", detail: "key set, but no business brief - drafts will be generic" };
  return { ...base, state: "up", detail: `${process.env.DEEPSEEK_MODEL || "deepseek-chat"} · brief set` };
}

// The 24/7 loop itself. A heartbeat older than a few minutes means the
// scheduler is dead and every schedule below it is fiction.
function jobs() {
  const base = { id: "jobs", label: "Jobs / scheduler", group: "Control" };
  const beat = read("heartbeat", null);
  const age = ageMin(beat?.at);
  const st = read("scheduler-state", { last: {}, next: {} });
  const ran = Object.entries(st.last || {});
  const failing = ran.filter(([, v]) => v?.error).map(([k]) => k);
  const detail = ran.length
    ? `${ran.length} jobs · last ${ran.map(([k, v]) => `${k}:${v.error ? "err" : String(v.result ?? "ok").slice(0, 14)}`).slice(0, 3).join(", ")}`
    : "no jobs have run yet";
  if (age === null) return { ...base, state: "down", detail: "scheduler has never started" };
  if (age > 5) return { ...base, state: "down", detail: `heartbeat is ${age.toFixed(0)}m old - the scheduler is not running` };
  if (failing.length) return { ...base, state: "warn", detail: `running, but failing: ${failing.join(", ")}` };
  return { ...base, state: "up", detail };
}

// ------------------------------------------------------------------ channels

function sessionRow(id, label, loggedIn, extra = {}) {
  const base = { id, label, group: "Channels", ...extra };
  if (!loggedIn) return { ...base, state: "off", detail: "not signed in" };
  return { ...base, state: "up", detail: "session saved" };
}

async function channels() {
  const s = getSettings();
  const rows = [];

  const linkedin = await import("../engines/linkedin.mjs");
  const li = sessionRow("linkedin", "LinkedIn", linkedin.isLoggedIn(), { url: "https://www.linkedin.com/feed/" });
  if (s.linkedin.halted) Object.assign(li, { state: "down", detail: `HALTED: ${s.linkedin.haltReason}`.slice(0, 90) });
  else if (li.state === "up" && !s.linkedin.enabled) Object.assign(li, { state: "warn", detail: "signed in but switched off" });
  else if (li.state === "up") li.detail = `${Object.keys(linkedin.allLeads()).length} leads collected`;
  rows.push(li);

  const reddit = await import("../engines/reddit.mjs");
  rows.push(reddit.configured()
    ? { id: "reddit", label: "Reddit", group: "Channels", state: s.reddit.enabled ? "up" : "warn", url: "https://www.reddit.com",
        detail: `u/${process.env.REDDIT_USERNAME || "?"} · ${queue.sentToday("reddit")}/${s.reddit.dailyPostCap} posts today${s.reddit.enabled ? "" : " · switched off"}` }
    : { id: "reddit", label: "Reddit", group: "Channels", state: "off", detail: "no API keys" });

  const wa = await import("../engines/whatsapp.mjs");
  rows.push(sessionRow("whatsapp", "WhatsApp", wa.isLoggedIn(), { url: "https://web.whatsapp.com" }));

  const im = await import("../engines/imessage.mjs");
  rows.push(im.isMac()
    ? { id: "imessage", label: "iMessage", group: "Channels", state: s.imessage.enabled ? "up" : "warn",
        detail: `${queue.sentToday("imessage")}/${s.imessage.dailyCap} sent today${s.imessage.enabled ? "" : " · switched off"}` }
    : { id: "imessage", label: "iMessage", group: "Channels", state: "off", detail: "macOS only" });

  const socials = await import("../engines/socials.mjs");
  for (const n of socials.platformNames()) {
    // LinkedIn shares the scraper's session, so it already has a row above.
    // Two rows for one login would read as two things that can break.
    if (n === "linkedin") continue;
    rows.push(sessionRow(`social-${n}`, socials.PLATFORMS[n].label, socials.isLoggedIn(n), { url: socials.PLATFORMS[n].home }));
  }
  return rows;
}

// --------------------------------------------------------------------- custom

// "And more": anything with a URL that should be green or red on the board.
// config/services.json -> [{ id, label, group?, url, expectStatus?, contains? }]
async function custom() {
  let list = [];   // eslint-disable-line prefer-const
  try { list = JSON.parse(readFileSync(path.join(ROOT, "config", "services.json"), "utf8")); } catch { return []; }
  if (list && !Array.isArray(list) && Array.isArray(list.services)) list = list.services;
  if (!Array.isArray(list)) return [];
  return Promise.all(list.filter((s) => s?.url).slice(0, 20).map(async (s) => {
    const base = { id: s.id || s.url, label: s.label || s.url, group: s.group || "Other", url: s.url };
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 7000);
      const res = await fetch(s.url, { signal: c.signal, redirect: "follow" });
      const body = s.contains ? (await res.text()).slice(0, 20000) : "";
      clearTimeout(t);
      const okStatus = s.expectStatus ? res.status === s.expectStatus : res.ok;
      if (!okStatus) return { ...base, state: "down", detail: `HTTP ${res.status}` };
      if (s.contains && !body.includes(s.contains)) return { ...base, state: "warn", detail: `up, but "${s.contains}" missing from the page` };
      return { ...base, state: "up", detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ...base, state: "down", detail: e.name === "AbortError" ? "timed out" : String(e.message).slice(0, 60) };
    }
  }));
}

// ----------------------------------------------------------------------- board

/** The whole board. Every probe guarded, so one failure can't blank the rest. */
export async function board() {
  const s = getSettings();
  const settled = await Promise.allSettled([tailscale(), chromeRemote(), telegramBridge(), channels(), custom()]);
  const rows = [];
  const push = (r) => (Array.isArray(r) ? rows.push(...r) : rows.push(r));
  for (const r of settled) {
    if (r.status === "fulfilled") push(r.value);
    else rows.push({ id: "probe-error", label: "A status check failed", group: "Other", state: "warn", detail: String(r.reason?.message || r.reason).slice(0, 80) });
  }
  rows.push(chatbot(), jobs());

  // Built-in probes win over anything config adds with the same id, so a
  // duplicate entry in services.json shows once rather than contradicting itself.
  const seen = new Set();
  const deduped = rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
  rows.length = 0;
  rows.push(...deduped);

  const order = ["Remote access", "Control", "Channels", "Other"];
  rows.sort((a, b) => (order.indexOf(a.group) - order.indexOf(b.group)) || a.label.localeCompare(b.label));

  return {
    client: process.env.CLIENT_NAME || os.hostname(),
    host: os.hostname(),
    at: new Date().toISOString(),
    paused: s.paused,
    activeHours: s.activeHours,
    pending: queue.pending().length,
    rows,
    counts: {
      up: rows.filter((r) => r.state === "up").length,
      warn: rows.filter((r) => r.state === "warn").length,
      down: rows.filter((r) => r.state === "down").length,
      off: rows.filter((r) => r.state === "off").length,
    },
  };
}

export const ICON = { up: "🟢", warn: "🟡", down: "🔴", off: "⚪" };

/** Plain-text board, for Telegram and for logs. */
export function renderText(b) {
  const out = [`${b.paused ? "⏸" : "▶️"} ${b.client}  ·  ${b.counts.up} up · ${b.counts.warn} warn · ${b.counts.down} down`];
  let group = "";
  for (const r of b.rows) {
    if (r.group !== group) { group = r.group; out.push(`\n${group}`); }
    out.push(`${ICON[r.state]} ${r.label} — ${r.detail}`);
  }
  return out.join("\n");
}
