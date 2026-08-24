// Shared headless-browser layer. Every site this system touches — LinkedIn,
// X, Instagram, Facebook, Threads, Reddit's web fallback — goes through here.
//
// The model is: the human logs in ONCE, headed, and the session is kept in a
// persistent Chrome profile on disk. After that every run is headless and just
// reuses those cookies. We never ask for, store, or type a social password.
//
// Two things this file exists to prevent:
//   1. Six engines each inventing their own launch flags and pacing, so five of
//      them look like a bot.
//   2. A silent logged-out state. A scraper that quietly returns zero results
//      for a week because the cookie expired is worse than one that crashes.
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { DATA } from "./env.mjs";
import { logger } from "./log.mjs";

const log = logger("browser");
export const PROFILES = path.join(DATA, "profiles");

// Playwright is a real dependency but a heavy one. Import it lazily so the bot,
// the TUI and the iMessage engine all still run on a box where `npx playwright
// install` has not finished yet.
let _chromium = null;
export async function chromium() {
  if (_chromium) return _chromium;
  try {
    ({ chromium: _chromium } = await import("playwright"));
    return _chromium;
  } catch {
    throw new Error("Playwright is not installed. Run:  npm install && npx playwright install chromium");
  }
}

// A real desktop Chrome UA. The bundled Chromium's default UA contains
// "HeadlessChrome", which several of these sites match on directly.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const profileDir = (name) => path.join(PROFILES, name.replace(/[^a-z0-9_-]/gi, "_"));
export const hasProfile = (name) => existsSync(path.join(profileDir(name), "Default"));

/**
 * Open a persistent context for one named account profile.
 * headed:true is for the one-time login; everything else runs headless.
 */
export async function open(name, { headed = false, timeout = 45000 } = {}) {
  const cr = await chromium();
  const dir = profileDir(name);
  mkdirSync(dir, { recursive: true });

  const launch = {
    headless: !headed && process.env.ORION_HEADFUL !== "1",
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: "en-US",
    timezoneId: process.env.ORION_TZ || "America/Los_Angeles",
    args: [
      "--disable-blink-features=AutomationControlled",  // drops navigator.webdriver
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  };

  // Real Chrome if this Mac has it (far less likely to be challenged than the
  // bundled Chromium); fall back to Chromium so a bare machine still works.
  let ctx;
  try {
    ctx = await cr.launchPersistentContext(dir, { ...launch, channel: "chrome" });
  } catch {
    ctx = await cr.launchPersistentContext(dir, launch);
  }
  ctx.setDefaultTimeout(timeout);
  ctx.setDefaultNavigationTimeout(timeout);
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page, close: async () => { try { await ctx.close(); } catch {} } };
}

// Human-ish pacing. Fixed intervals are the single most obvious bot tell, so
// every wait in this system is a range, never a constant.
export const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pause = (minSec, maxSec) => sleep(rand(minSec * 1000, maxSec * 1000));

// Type at a human rate instead of pasting the whole string at once. Two reasons:
// a paste is an obvious bot tell, and these editors are all contenteditable, so
// several of them ignore a programmatic value set and leave Post disabled.
// Takes an already-resolved locator, because every caller has one by then.
export async function typeHuman(page, locator, text) {
  await locator.click();
  await sleep(rand(300, 900));
  for (const part of String(text).split(/(\s+)/)) {
    await page.keyboard.type(part, { delay: rand(18, 55) });
    if (Math.random() < 0.08) await sleep(rand(180, 500));   // a pause to think
  }
}

// Screenshot to disk. Everything that posts captures one, so the client gets
// visual proof in Telegram rather than a bare "posted" they have to trust.
export async function shot(page, label) {
  const dir = path.join(DATA, "shots");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}-${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); return file; } catch { return null; }
}

// Did we land on a login wall, a captcha, or a "we noticed unusual activity"
// interstitial? Callers treat true as: stop, do not retry, tell a human.
const CHALLENGE = [
  /log in|sign in|sign up/i,
  /unusual activity|suspicious|verify (?:your|it.s you)|security check/i,
  /captcha|are you a (?:human|robot)|challenge/i,
  /temporarily restricted|account restricted|try again later/i,
];
export async function detectChallenge(page) {
  const url = page.url();
  if (/\/(login|signin|checkpoint|challenge|authwall|uas\/login)/i.test(url)) {
    return { challenged: true, why: `redirected to ${url}` };
  }
  let body = "";
  try { body = (await page.locator("body").innerText({ timeout: 5000 })).slice(0, 4000); } catch { return { challenged: false }; }
  // Only trust these near the top of the page; the words appear in footers too.
  const head = body.slice(0, 1200);
  for (const re of CHALLENGE) {
    if (re.test(head)) return { challenged: true, why: head.match(re)[0] };
  }
  return { challenged: false };
}

// One wrapper so every engine gets the same guarantees: the context always
// closes, a challenge always halts, and the reason always reaches the log.
export async function withPage(name, fn, opts = {}) {
  const session = await open(name, opts);
  try {
    return await fn(session.page, session.ctx);
  } catch (e) {
    log(name, "ERROR", String(e.message || e).slice(0, 300));
    throw e;
  } finally {
    await session.close();
  }
}
