#!/usr/bin/env node
// The regression suite. Zero dependencies, runs anywhere, touches no network
// and sends nothing.
//
// What it is actually for: this system's failure mode is not a crash, it is
// sending something it should not have, or silently sending nothing at all. So
// the tests that matter most are the ones asserting that a guard REFUSES —
// caps, pacing, pause, the approval queue, recipient validation. Those are the
// ones that would otherwise only be discovered by a client's account getting
// banned.
//
//   node test.mjs            everything offline
//   node test.mjs --verbose  show each passing assertion too
//
// Anything requiring macOS or a live login is reported as SKIPPED with the
// reason, never quietly passed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA, ROOT } from "./lib/env.mjs";

const execFileP = promisify(execFile);
const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m", c: "\x1b[36m" };
const VERBOSE = process.argv.includes("--verbose");

let pass = 0, fail = 0, skip = 0, group = "";
const failures = [];

const G = (n) => { group = n; console.log(`\n${C.b}${C.c}${n}${C.x}`); };

function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    if (VERBOSE) console.log(`  ${C.g}✓${C.x} ${label}`);
  } else {
    fail++;
    failures.push({ group, label, detail });
    console.log(`  ${C.r}✗ ${label}${C.x}${detail ? ` ${C.d}${detail}${C.x}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
const skipped = (label, why) => { skip++; console.log(`  ${C.y}skip${C.x} ${label} ${C.d}${why}${C.x}`); };

async function throws(label, fn, matcher) {
  try { await fn(); ok(label, false, "expected it to throw"); }
  catch (e) { ok(label, !matcher || matcher.test(String(e.message)), `threw: ${e.message}`); }
}

// Tests write real files, so snapshot data/ and put it back afterwards. A test
// run must not destroy whatever state this machine already had.
const SNAP = path.join(os.tmpdir(), `orion-test-snap-${Date.now()}`);
function snapshot() {
  fs.mkdirSync(SNAP, { recursive: true });
  if (!fs.existsSync(DATA)) return;
  for (const f of fs.readdirSync(DATA)) {
    const p = path.join(DATA, f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(SNAP, f));
  }
}
function restore() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  for (const f of fs.readdirSync(DATA)) {
    const p = path.join(DATA, f);
    if (fs.statSync(p).isFile()) fs.rmSync(p, { force: true });
  }
  for (const f of fs.readdirSync(SNAP)) fs.copyFileSync(path.join(SNAP, f), path.join(DATA, f));
  fs.rmSync(SNAP, { recursive: true, force: true });
}
const wipe = (...names) => names.forEach((n) => fs.rmSync(path.join(DATA, `${n}.json`), { force: true }));

snapshot();
try {

// ===========================================================================
G("store — atomic JSON");
{
  const store = await import("./lib/store.mjs");
  wipe("t-store");
  eq("missing file returns the fallback", store.read("t-store", { a: 1 }), { a: 1 });
  store.write("t-store", { n: 1 });
  eq("what was written comes back", store.read("t-store", null), { n: 1 });
  store.update("t-store", {}, (c) => ({ ...c, n: c.n + 1 }));
  eq("update is read-modify-write", store.read("t-store", null).n, 2);
  fs.writeFileSync(path.join(DATA, "t-store.json"), "{ this is not json");
  eq("corrupt file falls back instead of throwing", store.read("t-store", { safe: true }), { safe: true });
  ok("no .tmp file is left behind", !fs.existsSync(path.join(DATA, "t-store.json.tmp")));
  ok("id() is unique", new Set(Array.from({ length: 200 }, () => store.id())).size === 200);
  wipe("t-store");
}

// ===========================================================================
G("settings — the gate every engine asks");
{
  const s = await import("./lib/settings.mjs");
  wipe("settings");
  const d = s.getSettings();
  ok("autoSend defaults OFF", d.autoSend === false, "approval-by-default is the whole safety model");
  ok("paused defaults off", d.paused === false);
  ok("every engine has a block", ["linkedin", "reddit", "imessage", "whatsapp", "socials"].every((k) => d[k]));

  s.saveSettings({ activeHours: [0, 24] });
  ok("allowed inside active hours", s.mayAct("linkedin").ok);

  s.saveSettings({ paused: true });
  ok("pause blocks linkedin", !s.mayAct("linkedin").ok);
  ok("pause blocks reddit", !s.mayAct("reddit").ok);
  ok("pause blocks socials", !s.mayAct("socials").ok);
  ok("pause blocks whatsapp", !s.mayAct("whatsapp").ok);
  ok("pause blocks the unnamed caller too", !s.mayAct().ok);
  s.saveSettings({ paused: false });

  s.saveSettings({ linkedin: { enabled: false } });
  ok("a disabled engine is blocked", !s.mayAct("linkedin").ok);
  ok("...but its neighbours still run", s.mayAct("reddit").ok);
  s.saveSettings({ linkedin: { enabled: true } });

  s.saveSettings({ linkedin: { halted: true, haltReason: "captcha" } });
  const h = s.mayAct("linkedin");
  ok("a halted engine is blocked", !h.ok);
  ok("...and says why", /captcha/.test(h.why), h.why);
  s.saveSettings({ linkedin: { halted: false, haltReason: "" } });

  const hour = new Date().getHours();
  const closed = hour === 23 ? [0, 1] : [Math.min(23, hour + 1), 24];
  s.saveSettings({ activeHours: closed });
  ok("outside active hours is blocked", !s.mayAct("reddit").ok);
  s.saveSettings({ activeHours: [0, 24] });

  s.saveSettings({ reddit: { dailyPostCap: 99 } });
  eq("a partial save does not wipe its siblings", s.getSettings().reddit.minHoursPerSubreddit, 24);
  wipe("settings");
}

// ===========================================================================
G("queue — the approval choke point");
{
  const q = await import("./lib/queue.mjs");
  wipe("queue");
  const item = q.enqueue({ kind: "imessage", title: "to +1", preview: "hi", payload: { to: "+13105551212", text: "hi", dedupeKey: "+13105551212" } });
  ok("a new item starts pending", q.getItem(item.id).status === "pending");
  ok("...and nothing else", q.pending().length === 1);
  eq("sentToday counts nothing yet", q.sentToday("imessage"), 0);

  q.setStatus(item.id, "sent", "ok");
  ok("a sent item leaves the pending list", q.pending().length === 0);
  eq("sentToday counts what actually sent", q.sentToday("imessage"), 1);
  ok("dedupe recognises the target", q.alreadyContacted("imessage", "+13105551212"));
  ok("...and does not false-positive", !q.alreadyContacted("imessage", "+19998887777"));

  const skippedItem = q.enqueue({ kind: "reddit", title: "r/x", preview: "p", payload: { subreddit: "x" } });
  q.setStatus(skippedItem.id, "skipped");
  eq("a skipped item is NOT counted as sent", q.sentToday("reddit"), 0);

  const failedItem = q.enqueue({ kind: "social", title: "x", preview: "p", payload: { platform: "x" } });
  q.setStatus(failedItem.id, "failed", "boom");
  eq("a failed item is NOT counted as sent", q.sentToday("social"), 0);

  ok("an unknown id is null, not a crash", q.getItem("nope") === null);

  // The double-tap case: two approvals racing on one draft.
  const race = q.enqueue({ kind: "social", title: "x", preview: "p", payload: { platform: "x" } });
  q.setStatus(race.id, "sending");
  ok("an in-flight item is no longer pending", !q.pending().some((i) => i.id === race.id),
     "this is what stops a double-tap sending twice");

  // prune must never drop something still awaiting a human.
  const keep = q.enqueue({ kind: "social", title: "keep", preview: "p", payload: {} });
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, "queue.json"), "utf8"));
  raw.items = raw.items.map((i) => (i.status === "sent" ? { ...i, decidedAt: new Date(Date.now() - 60 * 864e5).toISOString() } : i));
  fs.writeFileSync(path.join(DATA, "queue.json"), JSON.stringify(raw));
  q.prune();
  ok("prune drops old decided items", !JSON.parse(fs.readFileSync(path.join(DATA, "queue.json"), "utf8")).items.some((i) => i.id === item.id));
  ok("prune NEVER drops a pending item", q.getItem(keep.id) !== null);
  wipe("queue");
}

// ===========================================================================
G("reddit — cadence, the shadowban guard");
{
  const r = await import("./engines/reddit.mjs");
  const q = await import("./lib/queue.mjs");
  const s = await import("./lib/settings.mjs");
  wipe("queue", "settings");
  s.saveSettings({ activeHours: [0, 24] });

  ok("a fresh account may post", r.cadenceCheck("test").ok);

  const posted = q.enqueue({ kind: "reddit", title: "r/test", preview: "p", payload: { subreddit: "test" } });
  q.setStatus(posted.id, "sent");
  const c1 = r.cadenceCheck("test");
  ok("same subreddit is blocked right after", !c1.ok);
  ok("...naming the per-subreddit rule", /subreddit/.test(c1.why), c1.why);

  const c2 = r.cadenceCheck("different");
  ok("a different subreddit is also blocked by the global gap", !c2.ok);
  ok("...naming the global gap", /minimum gap/.test(c2.why), c2.why);

  // Age the post past the global gap but not the per-subreddit one.
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, "queue.json"), "utf8"));
  raw.items = raw.items.map((i) => ({ ...i, decidedAt: new Date(Date.now() - 5 * 3600e3).toISOString() }));
  fs.writeFileSync(path.join(DATA, "queue.json"), JSON.stringify(raw));
  ok("after the global gap, a new subreddit is allowed", r.cadenceCheck("different").ok);
  ok("...but the same one still is not", !r.cadenceCheck("test").ok);

  s.saveSettings({ reddit: { dailyPostCap: 1 } });
  ok("the daily cap blocks everything once hit", !r.cadenceCheck("anything").ok);

  ok("submit refuses with no subreddit", !(await r.submit({ subreddit: "", title: "t" })).ok);
  ok("submit refuses with no title", !(await r.submit({ subreddit: "x", title: "" })).ok);
  const long = await r.submit({ subreddit: "x", title: "z".repeat(400) });
  ok("submit refuses an over-length title", !long.ok && /300/.test(long.why), long.why);
  wipe("queue", "settings");
}

// ===========================================================================
G("iMessage — recipient validation");
{
  const im = await import("./engines/imessage.mjs");
  const n = im.normalizeRecipient;
  eq("10-digit US number gets +1", n("3105551212").id, "+13105551212");
  eq("formatting is stripped", n("(310) 555-1212").id, "+13105551212");
  eq("leading 1 is handled", n("13105551212").id, "+13105551212");
  eq("E.164 passes through", n("+447700900123").id, "+447700900123");
  eq("an Apple ID is accepted", n("a@b.com").kind, "email");
  ok("junk is rejected", !n("not a number").ok);
  ok("an empty string is rejected", !n("").ok);
  ok("a too-short number is rejected", !n("12345").ok);
  ok("a bare word is rejected", !n("hello").ok);

  const bad = await im.send("garbage", "hi");
  ok("send refuses an invalid recipient", !bad.ok);
  const empty = await im.send("3105551212", "   ");
  ok("send refuses an empty body", !empty.ok, empty.why);
  if (process.platform !== "darwin") {
    const r = await im.send("3105551212", "hi");
    ok("send refuses off macOS rather than pretending", !r.ok && /macOS/.test(r.why), r.why);
    skipped("real AppleScript send", "needs macOS");
    skipped("chat.db reply detection", "needs macOS + Full Disk Access");
  }
}

// ===========================================================================
G("WhatsApp — number normalisation");
{
  const wa = await import("./engines/whatsapp.mjs");
  eq("10 digits assumes US", wa.normalize("3105551212").id, "13105551212");
  eq("punctuation is stripped", wa.normalize("+1 (310) 555-1212").id, "13105551212");
  eq("an international number survives", wa.normalize("447700900123").id, "447700900123");
  ok("junk is rejected", !wa.normalize("abc").ok);
  ok("a short number is rejected", !wa.normalize("12345").ok);
  const r = await wa.send("abc", "hi");
  ok("send refuses an invalid number", !r.ok);
  const e = await wa.send("3105551212", "", { dryRun: true });
  ok("send refuses an empty body", !e.ok);
  skipped("real WhatsApp Web send", "needs a linked session");
}

// ===========================================================================
G("socials — validation order and shared sessions");
{
  const so = await import("./engines/socials.mjs");
  const s = await import("./lib/settings.mjs");
  wipe("settings");
  s.saveSettings({ activeHours: [0, 24] });

  ok("an unknown platform is rejected", !(await so.post("myspace", "hi")).ok);
  const long = await so.post("x", "z".repeat(400));
  ok("an over-length post is rejected", !long.ok);
  ok("...by length, not by login state", /280/.test(long.why),
     `got "${long.why}" — reporting the wrong reason sends someone down the wrong path`);
  const ig = await so.post("instagram", "hello");
  ok("Instagram refuses text with no image", !ig.ok && /image/.test(ig.why), ig.why);
  ok("an empty post is rejected", !(await so.post("x", "")).ok);
  ok("dryRun never touches a browser", (await so.post("x", "fine", { dryRun: true })).ok);

  eq("every platform is present", so.platformNames().sort(),
     ["facebook", "instagram", "linkedin", "threads", "x"]);
  ok("every platform declares a character limit", so.platformNames().every((n) => so.PLATFORMS[n].limit > 0));
  ok("every platform declares editor + submit selectors",
     so.platformNames().every((n) => so.PLATFORMS[n].editor?.length && so.PLATFORMS[n].submit?.length));
  eq("LinkedIn shares the scraper's profile", so.PLATFORMS.linkedin.profile, "linkedin");

  const li = await import("./engines/linkedin.mjs");
  ok("one LinkedIn login covers scraping and posting",
     so.isLoggedIn("linkedin") === li.isLoggedIn(),
     "if these disagree the client is asked to sign in to LinkedIn twice");
  wipe("settings");
}

// ===========================================================================
G("linkedin — targets and gating");
{
  const li = await import("./engines/linkedin.mjs");
  const s = await import("./lib/settings.mjs");
  wipe("settings", "targets");
  s.saveSettings({ activeHours: [0, 24] });

  ok("falls back to the shipped targets file", Array.isArray(li.targets().linkedin?.searches));
  const store = await import("./lib/store.mjs");
  store.write("targets", { linkedin: { searches: ["live override"] } });
  eq("a live target list wins over the file", li.targets().linkedin.searches, ["live override"]);
  wipe("targets");

  s.saveSettings({ paused: true });
  const r = await li.sweep();
  ok("sweep refuses while paused", !r.ok);
  eq("...and collects nothing", r.added, 0);
  s.saveSettings({ paused: false });

  if (!li.isLoggedIn()) {
    const r2 = await li.sweep();
    ok("sweep refuses when not logged in", !r2.ok && /log/i.test(r2.why), r2.why);
    skipped("a real LinkedIn sweep", "needs a saved session");
  }
  wipe("settings");
}

// ===========================================================================
G("relay — the support line must not lose a message");
{
  const relay = await import("./lib/relay.mjs");
  wipe("relay-outbox", "relay-alerts");
  const store = await import("./lib/store.mjs");
  const had = process.env.ORION_RELAY_BOT_TOKEN;
  delete process.env.ORION_RELAY_BOT_TOKEN;

  ok("reports itself unconfigured", !relay.relayConfigured());
  const r = await relay.toOrion("test message", { kind: "help" });
  ok("an unsendable message is not lost", r.spooled === true, "it must spool, not vanish");
  ok("...and lands in the outbox", store.read("relay-outbox", []).length === 1);

  const f = await relay.flushOutbox();
  ok("flush keeps it while still unconfigured", f.left === 1);

  await relay.alertOnce("dupe-key", "first");
  const after = store.read("relay-outbox", []).length;
  await relay.alertOnce("dupe-key", "second");
  eq("alertOnce does not re-fire inside its window", store.read("relay-outbox", []).length, after);

  process.env.ORION_ADMIN_TELEGRAM_IDS = "111,222";
  ok("an admin id is recognised", relay.isAdmin("111"));
  ok("...as a number too", relay.isAdmin(222));
  ok("a stranger is not an admin", !relay.isAdmin("999"));
  delete process.env.ORION_ADMIN_TELEGRAM_IDS;
  if (had) process.env.ORION_RELAY_BOT_TOKEN = had;
  wipe("relay-outbox", "relay-alerts");
}

// ===========================================================================
G("telegram helpers");
{
  const tg = await import("./lib/telegram.mjs");
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const parts = tg.chunk(long);
  ok("a long message is split", parts.length > 1);
  ok("every chunk fits Telegram's 4096 limit", parts.every((p) => p.length <= 4096));
  eq("no content is lost in the split", parts.join("\n"), long);
  eq("an empty string still yields one chunk", tg.chunk("").length, 1);
  eq("HTML is escaped", tg.esc('<b>&"x"</b>'), '&lt;b&gt;&amp;"x"&lt;/b&gt;');
  eq("null escapes to empty", tg.esc(null), "");
  const single = tg.chunk("short");
  eq("a short message is not split", single, ["short"]);
}

// ===========================================================================
G("services — the status board");
{
  const svc = await import("./lib/services.mjs");
  const b = await svc.board();
  ok("the board renders", b.rows.length > 0);
  eq("every row id is unique", b.rows.length, new Set(b.rows.map((r) => r.id)).size);
  ok("every row has a valid state", b.rows.every((r) => ["up", "warn", "down", "off"].includes(r.state)));
  ok("every row explains itself", b.rows.every((r) => typeof r.detail === "string" && r.detail.length > 0));
  ok("counts add up to the row total",
     b.counts.up + b.counts.warn + b.counts.down + b.counts.off === b.rows.length);
  for (const want of ["tailscale", "crd", "telegram", "chatbot", "jobs", "linkedin", "reddit", "whatsapp", "imessage"]) {
    ok(`${want} has a row`, b.rows.some((r) => r.id === want));
  }
  ok("LinkedIn appears exactly once", b.rows.filter((r) => /^LinkedIn$/.test(r.label)).length === 1);
  const txt = svc.renderText(b);
  ok("the text rendering works", txt.length > 50 && /Remote access/.test(txt));
}

// ===========================================================================
G("booking");
{
  const bk = await import("./lib/booking.mjs");
  const had = process.env.ORION_SLOTS_URL;
  delete process.env.ORION_SLOTS_URL;
  const s = await bk.fetchSlots();
  ok("no slots service is handled, not thrown", !s.ok && Array.isArray(s.slots));
  eq("...and returns no slots", s.slots.length, 0);
  ok("a book URL is always available", /^https?:\/\//.test(bk.BOOK_URL()));
  const r = await bk.book({ slot: null, reason: "test", name: "t" });
  ok("booking without a service still returns", r.ok === true);
  ok("...and admits it is not confirmed", r.confirmed === false,
     "claiming a confirmed booking that is not on his calendar is worse than none");
  if (had) process.env.ORION_SLOTS_URL = had;
}

// ===========================================================================
G("env — .env editing");
{
  const env = await import("./lib/env.mjs");
  const backup = fs.existsSync(env.ENV_PATH) ? fs.readFileSync(env.ENV_PATH, "utf8") : null;
  fs.writeFileSync(env.ENV_PATH, "AAA=1\nBBB=2\n");
  env.setEnv("CCC", "3");
  let txt = fs.readFileSync(env.ENV_PATH, "utf8");
  ok("a new key is appended", /^CCC=3$/m.test(txt));
  ok("existing keys survive", /^AAA=1$/m.test(txt) && /^BBB=2$/m.test(txt));
  env.setEnv("AAA", "changed");
  txt = fs.readFileSync(env.ENV_PATH, "utf8");
  ok("an existing key is replaced in place", /^AAA=changed$/m.test(txt));
  ok("...without duplicating it", (txt.match(/^AAA=/gm) || []).length === 1);
  env.setEnv("TOK", "abc/def&ghi+jkl");
  ok("a token with / & + survives byte-exact", /^TOK=abc\/def&ghi\+jkl$/m.test(fs.readFileSync(env.ENV_PATH, "utf8")));
  if (backup !== null) fs.writeFileSync(env.ENV_PATH, backup); else fs.rmSync(env.ENV_PATH, { force: true });
}

// ===========================================================================
G("draft — writing layer (offline shape checks)");
{
  const d = await import("./lib/draft.mjs");
  ok("brief() always returns a string", typeof d.brief() === "string");
  const { VOICE } = await import("./lib/deepseek.mjs");
  ok("the house voice bans em-dashes", /em-dash/i.test(VOICE));
  ok("...and bans inventing facts about a person", /invent/i.test(VOICE));
  if (!process.env.DEEPSEEK_API_KEY) {
    await throws("drafting without a key fails loudly", () => d.imessageDraft({ name: "x" }), /DEEPSEEK_API_KEY/);
    skipped("live draft quality", "needs DEEPSEEK_API_KEY");
  }
}

// ===========================================================================
G("cookies — signing in without signing in");
{
  const ck = await import("./lib/cookies.mjs");
  const mk = (arr) => ck.parseCookies(JSON.stringify(arr)).cookies;
  const future = Math.floor(Date.now() / 1000) + 30 * 86400;

  // Every export format a client might paste, because they should not have to
  // know which extension they used.
  ok("Cookie-Editor JSON parses", ck.parseCookies(JSON.stringify([{ name: "li_at", value: "v", domain: ".linkedin.com" }])).ok);
  ok("a {cookies:[...]} wrapper parses", ck.parseCookies(JSON.stringify({ cookies: [{ name: "li_at", value: "v", domain: ".linkedin.com" }] })).ok);
  const TAB = String.fromCharCode(9), NL = String.fromCharCode(10);
  const netscape = ["# Netscape HTTP Cookie File",
    [".linkedin.com", "TRUE", "/", "TRUE", "1800000000", "li_at", "v"].join(TAB)].join(NL) + NL;
  ok("Netscape cookies.txt parses", ck.parseCookies(netscape).ok);
  ok("a raw Cookie header parses", ck.parseCookies("li_at=v; JSESSIONID=x").ok);
  ok("empty input is rejected", !ck.parseCookies("").ok);
  ok("prose is rejected", !ck.parseCookies("here are my cookies thanks").ok);
  ok("broken JSON is rejected with a reason", !ck.parseCookies("[{name:").ok);

  const norm = mk([{ name: "li_at", value: "v", domain: ".linkedin.com", sameSite: "no_restriction", expirationDate: 1800000000.9, secure: false }])[0];
  eq("sameSite no_restriction maps to None", norm.sameSite, "None");
  ok("SameSite=None forces secure", norm.secure === true, "browsers drop the pair otherwise");
  eq("a float expiry is floored", norm.expires, 1800000000);
  ok("a session cookie keeps no expiry", mk([{ name: "a", value: "v", domain: ".x.com" }])[0].expires === undefined);

  ok("a valid LinkedIn session validates", ck.validate("linkedin", mk([{ name: "li_at", value: "v", domain: ".linkedin.com", expirationDate: future }])).ok);
  const wrong = ck.validate("linkedin", mk([{ name: "sessionid", value: "v", domain: ".instagram.com" }]));
  ok("cookies from the wrong site are refused", !wrong.ok);
  ok("...naming the cookie that's missing", /li_at/.test(wrong.why), wrong.why);
  const dead = ck.validate("linkedin", mk([{ name: "li_at", value: "v", domain: ".linkedin.com", expirationDate: Math.floor(Date.now() / 1000) - 100 }]));
  ok("an already-expired session is refused before import", !dead.ok && /expired/.test(dead.why),
     "importing a dead cookie would 'succeed' and then fail silently");
  const soon = ck.validate("linkedin", mk([{ name: "li_at", value: "v", domain: ".linkedin.com", expirationDate: Math.floor(Date.now() / 1000) + 2 * 86400 }]));
  ok("an imminent expiry passes but warns", soon.ok && !!soon.warn);
  const fb = ck.validate("facebook", mk([{ name: "c_user", value: "1", domain: ".facebook.com" }]));
  ok("Facebook requires both c_user and xs", !fb.ok && /xs/.test(fb.why));

  ok("whatsapp is not cookie-importable", !ck.cookieImportable("whatsapp"));
  const wa = await ck.importCookies("whatsapp", "[]");
  ok("...and importing it explains why", !wa.ok && /QR/.test(wa.why), wa.why);
  const unknown = await ck.importCookies("myspace", "[]");
  ok("an unknown platform is refused", !unknown.ok);

  const so = await import("./engines/socials.mjs");
  for (const [id, p] of Object.entries(ck.PLATFORMS)) {
    ok(id + " declares a required session cookie", p.required.length > 0);
    ok(id + " declares its domains", p.domains.length > 0);
    if (so.PLATFORMS[id]) {
      const want = so.PLATFORMS[id].profile || "social-" + id;
      eq(id + " writes to the profile its engine reads", p.profile, want);
    }
  }
}

// ===========================================================================
G("dashboard — remote onboarding");
{
  const src = fs.readFileSync(path.join(ROOT, "dashboard.mjs"), "utf8");
  const has = (s) => src.includes(s);

  ok("a token is required for every write", has("tokenOk(given)"));
  ok("the token compare is length-safe",
     has("timingSafeEqual") && has('createHash("sha256")'),
     "a prefix match must not authenticate");
  ok("loopback is the default bind", has('STATUS_BIND || "127.0.0.1"'));
  ok("a token is generated when absent", has("randomBytes(16)"));
  ok("request bodies are size-capped", has("too large"), "an unbounded POST is a free OOM");
  ok("blank key fields do not clobber stored values", has("if (v) { setEnv"));
  ok("secrets are never echoed back into the page", !has('value="' + "$" + '{esc(cur)}"'));
  ok("the referrer is suppressed", has("no-referrer"), "the token travels in the URL");
  ok("HTML is escaped", has("const esc ="));
  ok("it serves the setup wizard", has("pageSetup"));
  ok("it serves per-platform connect pages", has("pageConnect"));
  ok("it names what still needs the Mac", has("Full Disk Access"));
  ok("the old read-only server is gone", !fs.existsSync(path.join(ROOT, "statusweb.mjs")),
     "two servers bound to one port would fight");

  const l = fs.readFileSync(path.join(ROOT, "launchd", "install-services.sh"), "utf8");
  ok("launchd runs the dashboard", l.includes("dashboard.mjs") && !l.includes("statusweb"));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  ok("npm run dashboard exists", !!pkg.scripts.dashboard);
  ok("the superseded npm run status is gone", !pkg.scripts.status);
}

// ===========================================================================
G("installer — the one-shot path");
{
  const sh = fs.readFileSync(path.join(ROOT, "install-mac.sh"), "utf8");
  const has = (s) => sh.includes(s);
  ok("refuses to run off macOS", has("Darwin"));
  ok("gates on a license", has("ALLOWED_HASHES"));
  ok("the master hash is present", has("abd0fb08d15c821c012a6c6f0ed5385ad0adbc2c953527893b782ec1fe880ce1"));
  ok("reads the key from the real terminal, not the pipe", has("read -r KEY </dev/tty"));
  ok("hands the TUI a real terminal", has("exec node tui.mjs </dev/tty"),
     "without this, curl | bash exits instantly at the end");
  ok("seeds .env from environment variables", has("SEEDED"));
  ok("seeds with awk, not sed", has("awk -v k="),
     "a token containing / or & would corrupt a sed replacement");
  ok("does not clobber a filled-in value by default", has("ORION_FORCE_ENV"));
  ok("generates a status token when absent", has("STATUS_TOKEN"));
  ok("supports an unattended finish", has("ORION_AUTO"));
  ok("hands over the dashboard link at the end", has("Finish setup from any device"),
     "the client onboards from that URL, not from this Mac");
  ok("has no CRLF line endings", !sh.includes(String.fromCharCode(13)), "CRLF breaks curl | bash outright");

  const parses = async (f) => execFileP("bash", ["-n", path.join(ROOT, f)]).then(() => true).catch(() => false);
  ok("the installer parses", await parses("install-mac.sh"));
  ok("the service installer parses", await parses("launchd/install-services.sh"));
  ok("the service uninstaller parses", await parses("launchd/uninstall-services.sh"));

  const inst = fs.readFileSync(path.join(ROOT, "launchd", "install-services.sh"), "utf8");
  const unin = fs.readFileSync(path.join(ROOT, "launchd", "uninstall-services.sh"), "utf8");
  for (const svc of ["bot", "scheduler", "status"]) {
    ok("launchd installs the " + svc + " service", inst.includes("com.orion.assistant." + svc));
    ok("...and can remove it", unin.includes("com.orion.assistant." + svc));
  }
  ok("services restart on crash", inst.includes("KeepAlive"));
}

// ===========================================================================
G("packaging");
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const s of ["setup", "bot", "scheduler", "start", "selftest", "dashboard", "install:service"]) {
    ok("npm run " + s + " exists", !!pkg.scripts[s]);
  }
  ok("declares node 20+", String(pkg.engines && pkg.engines.node || "").includes("20"));

  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  ok(".env is gitignored", gi.split(/\r?\n/).includes(".env"));
  ok("data/ is gitignored", gi.split(/\r?\n/).includes("data/"),
     "profiles, leads and the queue must never be committed");

  for (const f of ["config/targets.json", "config/brief.json", "config/services.json", "config/orion-theme.json"]) {
    let valid = true;
    try { JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { valid = false; }
    ok(f + " is valid JSON", valid);
  }

  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "DEEPSEEK_API_KEY",
                   "ORION_RELAY_BOT_TOKEN", "STATUS_TOKEN", "STATUS_BIND"]) {
    ok(".env.example documents " + k, example.includes(k));
  }
  ok(".env.example ships no real values",
     !/sk-[A-Za-z0-9]{20,}/.test(example) && !/[0-9]{9,10}:AA/.test(example));
}

// ===========================================================================
G("send — claim, concurrency, recovery");
{
  const q = await import("./lib/queue.mjs");
  const s = await import("./lib/send.mjs");
  wipe("queue");

  const it = q.enqueue({ kind: "social", title: "t", preview: "p", payload: { platform: "x", text: "hi" } });
  const first = q.claim(it.id);
  ok("a pending item can be claimed", !!first);
  ok("the same item cannot be claimed twice", q.claim(it.id) === null,
     "this is the cross-process guard against a double-send");
  ok("a claimed item leaves the pending list", !q.pending().some((x) => x.id === it.id));
  q.release(it.id);

  q.setStatus(it.id, "pending");
  ok("released, it can be claimed again", !!q.claim(it.id));
  q.release(it.id);
  q.setStatus(it.id, "pending");

  // Two approvals racing: exactly one may reach the engine.
  const results = await Promise.all([
    s.approve(it.id, { via: "a" }),
    s.approve(it.id, { via: "b" }),
  ]);
  const refused = results.filter((r) => /already sending|already/.test(r.why || "")).length;
  eq("exactly one of two racing approvals is refused", refused, 1);
  ok("the item ends decided, not stuck", ["sent", "failed"].includes(q.getItem(it.id).status));

  ok("approving an unknown id is refused cleanly", !(await s.approve("nope")).ok);
  ok("skipping an unknown id is refused cleanly", !s.skip("nope").ok);
  ok("rewriting an unknown id is refused cleanly", !(await s.redo("nope")).ok);

  const parked = q.enqueue({ kind: "imessage", title: "no number", preview: "hi", payload: { to: "", text: "hi" } });
  const noNum = await s.approve(parked.id);
  ok("a draft with no recipient will not send", !noNum.ok && /no phone number/.test(noNum.why), noNum.why);
  ok("...and stays pending for a number", q.getItem(parked.id).status === "pending");
  ok("a bad number is refused on attach", !s.attachRecipient(parked.id, "garbage").ok);
  const att = s.attachRecipient(parked.id, "3105551212");
  ok("a good number attaches", att.ok && att.item.payload.to === "+13105551212");
  s.skip(parked.id);

  // A crash mid-send must not freeze the queue forever.
  const stuck = q.enqueue({ kind: "social", title: "stuck", preview: "p", payload: { platform: "x" } });
  q.claim(stuck.id);
  const rawq = q.raw();
  q.writeRaw({ ...rawq, items: rawq.items.map((i) => (i.id === stuck.id
    ? { ...i, decidedAt: new Date(Date.now() - 60 * 60000).toISOString() } : i)) });
  const recovered = q.recoverStuck(15);
  ok("a crash-stranded send is recovered", recovered >= 1);
  ok("...back to pending, so a human sees it again", q.getItem(stuck.id).status === "pending");
  wipe("queue");
}

// ===========================================================================
G("the send path — nothing sends itself");
{
  // The most important invariant in the system, asserted structurally. There
  // are now TWO human surfaces that can approve a draft, so the guarantee has
  // to hold in one shared place rather than being reimplemented in each.
  const sendSrc = fs.readFileSync(path.join(ROOT, "lib", "send.mjs"), "utf8");
  ok("one module dispatches every send", sendSrc.includes("async function dispatch"));
  ok("...and claims the item first", sendSrc.includes("queue.claim(itemId)"),
     "claiming before sending is what stops two surfaces double-sending");
  ok("...and always releases the claim", sendSrc.includes("finally") && sendSrc.includes("queue.release"));

  // No engine may reach into another engine's send.
  for (const e of ["imessage", "reddit", "socials", "whatsapp", "linkedin"]) {
    const src = fs.readFileSync(path.join(ROOT, "engines", e + ".mjs"), "utf8");
    const importsPeer = ["imessage", "whatsapp", "socials"].some((peer) =>
      peer !== e && src.includes('from "./' + peer + '.mjs"'));
    ok(e + " never calls another engine send", !importsPeer);
  }

  // Only send.mjs may call an engine send function.
  for (const f of ["bot.mjs", "dashboard.mjs", "scheduler.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const direct = src.includes("imessage.send(") || src.includes("whatsapp.send(") ||
                   src.includes("socials.post(") || src.includes("reddit.submit(");
    ok(f + " does not call an engine send directly", !direct,
       "it must go through lib/send.mjs so the claim is not bypassed");
  }

  const sched = fs.readFileSync(path.join(ROOT, "scheduler.mjs"), "utf8");
  ok("the 24/7 scheduler never sends at all",
     !sched.includes("approve(") && !sched.includes(".send(") && !sched.includes(".submit("),
     "the unattended loop must only draft and notify");

  const bot = fs.readFileSync(path.join(ROOT, "bot.mjs"), "utf8");
  ok("the bot approves via the shared path", bot.includes("send.approve("));
  ok("the bot has an allowlist", bot.includes("TELEGRAM_ALLOWED_USER_IDS"));
  ok("an empty allowlist locks the bot rather than opening it", bot.includes("ALLOWED.includes"));

  const dash = fs.readFileSync(path.join(ROOT, "dashboard.mjs"), "utf8");
  ok("the dashboard approves via the shared path", dash.includes("outbox.approve("));
  ok("the dashboard requires a token before any write", dash.includes("tokenOk(given)"));
}
} finally {
  restore();
}

// ===========================================================================
const total = pass + fail;
console.log(`\n${C.b}${"─".repeat(60)}${C.x}`);
console.log(`${C.b}${pass}/${total} passed${C.x}   ${skip ? `${C.y}${skip} skipped${C.x}   ` : ""}${fail ? `${C.r}${fail} FAILED${C.x}` : `${C.g}all green${C.x}`}`);
if (fail) {
  console.log(`\n${C.b}Failures${C.x}`);
  for (const f of failures) console.log(`  ${C.r}✗${C.x} ${C.d}[${f.group}]${C.x} ${f.label}${f.detail ? `\n    ${C.d}${f.detail}${C.x}` : ""}`);
}
if (skip) console.log(`\n${C.d}Skipped checks need macOS, a saved login, or a live key. The preflight\n(node selftest.mjs) covers those on the client's machine.${C.x}`);
console.log();
process.exit(fail ? 1 : 0);
