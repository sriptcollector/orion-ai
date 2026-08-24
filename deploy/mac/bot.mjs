#!/usr/bin/env node
// The Telegram control center. This is the only interface the client uses day
// to day: scraping, drafting, approving, posting, texting, and reaching Orion
// for support all happen in this one chat.
//
// Long-polling, zero dependencies. It holds no state of its own beyond an
// update offset — everything real lives in data/ so the scheduler, the TUI and
// this process always agree about what is true.
//
// The one rule that shapes the whole file: this process is the ONLY thing that
// calls a send function. Engines draft into the approval queue; a human taps a
// button; then and only then does anything leave this machine.
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv, ROOT, setEnv } from "./lib/env.mjs";
import { api, chunk, esc } from "./lib/telegram.mjs";
import { logger } from "./lib/log.mjs";
import { read, write } from "./lib/store.mjs";
import { getSettings, saveSettings } from "./lib/settings.mjs";
import * as queue from "./lib/queue.mjs";
import { toOrion, isAdmin, relayConfigured, flushOutbox } from "./lib/relay.mjs";
import * as draft from "./lib/draft.mjs";
import * as imessage from "./engines/imessage.mjs";
import * as reddit from "./engines/reddit.mjs";
import * as socials from "./engines/socials.mjs";
import * as linkedin from "./engines/linkedin.mjs";

loadEnv();
const log = logger("bot");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN missing. Run the setup TUI:  npm run setup"); process.exit(1); }
const tg = api(TOKEN);
const CLIENT = process.env.CLIENT_NAME || os.hostname();

// A bot that anyone who finds the username can drive is a bot that can text
// strangers from the owner's phone number. Empty allowlist = locked, not open.
const ALLOWED = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const allowed = (id) => ALLOWED.includes(String(id)) || isAdmin(id);

process.on("unhandledRejection", (e) => log("UNHANDLED", String(e?.stack || e)));
process.on("uncaughtException", (e) => log("UNCAUGHT", String(e?.stack || e)));

const say = async (chat, text, extra = {}) => {
  let last = null;
  for (const part of chunk(text)) {
    last = await tg("sendMessage", { chat_id: chat, text: part, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }
  return last;
};

async function sendPhoto(chat, file, caption = "") {
  if (!file || !existsSync(file)) return null;
  try {
    const fd = new FormData();
    fd.append("chat_id", String(chat));
    fd.append("caption", caption.slice(0, 1000));
    fd.append("parse_mode", "HTML");
    fd.append("photo", new Blob([readFileSync(file)]), path.basename(file));
    return await (await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd })).json();
  } catch (e) { log("sendPhoto failed", String(e.message || e)); return null; }
}

const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const btn = (text, data) => ({ text, callback_data: data });

// ---------------------------------------------------------------- approvals

// Render one queued item with its buttons. Everything outbound funnels through
// this, so the client sees the exact text before it exists anywhere else.
async function showItem(chat, item) {
  const head = { imessage: "💬 <b>iMessage draft</b>", reddit: "👽 <b>Reddit draft</b>", social: "📣 <b>Social draft</b>" }[item.kind] || "<b>Draft</b>";
  const body = `${head}\n${esc(item.title)}\n\n<pre>${esc(item.preview)}</pre>`;
  return say(chat, body, kb([
    [btn("✅ Send", `ok:${item.id}`), btn("✏️ Redo", `redo:${item.id}`), btn("❌ Skip", `no:${item.id}`)],
  ]));
}

// The actual send. One switch, one place, reached only from a button tap.
async function performSend(item) {
  if (item.kind === "imessage") {
    return imessage.send(item.payload.to, item.payload.text, { service: item.payload.service || "iMessage" });
  }
  if (item.kind === "reddit") {
    const r = await reddit.submit({ subreddit: item.payload.subreddit, title: item.payload.title, text: item.payload.text });
    return r.ok ? { ok: true, detail: r.url || `posted to r/${r.subreddit}` } : r;
  }
  if (item.kind === "social") {
    const r = await socials.post(item.payload.platform, item.payload.text, { imagePath: item.payload.imagePath || null });
    return r.ok ? { ok: true, detail: r.url || "posted", screenshot: r.screenshot } : r;
  }
  return { ok: false, why: `unknown item kind "${item.kind}"` };
}

async function redraft(item) {
  if (item.kind === "imessage") {
    const text = await draft.imessageDraft(item.payload.lead || { name: item.payload.to }, { angle: item.payload.angle || "" });
    return { ...item.payload, text };
  }
  if (item.kind === "reddit") {
    const d = await draft.redditDraft({ subreddit: item.payload.subreddit, topic: item.payload.topic, rules: item.payload.rules || [] });
    return { ...item.payload, title: d.title, text: d.text };
  }
  if (item.kind === "social") {
    const limit = socials.PLATFORMS[item.payload.platform]?.limit || 280;
    const text = await draft.socialDraft({ platform: item.payload.platform, topic: item.payload.topic, limit });
    return { ...item.payload, text };
  }
  return item.payload;
}

const previewOf = (kind, p) =>
  kind === "reddit" ? `${p.title}\n\n${p.text}` : p.text;
const titleOf = (kind, p) =>
  kind === "imessage" ? `to ${p.to}` : kind === "reddit" ? `r/${p.subreddit}` : `${socials.PLATFORMS[p.platform]?.label || p.platform}`;

// ------------------------------------------------------------------ status

async function statusText() {
  const s = getSettings();
  const leads = linkedin.allLeads();
  const pend = queue.pending();
  const lines = [];
  lines.push(`<b>${esc(CLIENT)}</b>  ·  ${s.paused ? "⏸ PAUSED" : "▶️ running"}`);
  lines.push(`Outbound: ${s.autoSend ? "⚠️ AUTO-SEND ON" : "✅ approval required"}   Active hours: ${s.activeHours[0]}:00-${s.activeHours[1]}:00`);
  lines.push("");
  lines.push(`📥 Awaiting your approval: <b>${pend.length}</b>`);
  lines.push(`👤 Leads collected: <b>${Object.keys(leads).length}</b>`);
  lines.push("");
  const li = s.linkedin;
  lines.push(`<b>LinkedIn</b> ${li.halted ? "🚨 HALTED" : li.enabled ? "on" : "off"}  ${linkedin.isLoggedIn() ? "(session saved)" : "(⚠️ not logged in)"}`);
  if (li.halted) lines.push(`   reason: ${esc(li.haltReason)}`);
  lines.push(`<b>Reddit</b> ${s.reddit.enabled ? "on" : "off"}  ${reddit.configured() ? "(keys set)" : "(⚠️ no keys)"}  ·  ${queue.sentToday("reddit")}/${s.reddit.dailyPostCap} today`);
  lines.push(`<b>iMessage</b> ${s.imessage.enabled ? "on" : "off"}  ${imessage.isMac() ? "" : "(⚠️ not macOS)"}  ·  ${queue.sentToday("imessage")}/${s.imessage.dailyCap} today`);
  const sess = socials.platformNames().map((n) => `${n}${socials.isLoggedIn(n) ? "✓" : "✗"}`).join(" ");
  lines.push(`<b>Socials</b> ${s.socials.enabled ? "on" : "off"}  ·  ${sess}  ·  ${queue.sentToday("social")}/${s.socials.dailyPostCap} today`);
  lines.push("");
  lines.push(`Support relay to Orion: ${relayConfigured() ? "✅ connected" : "⚠️ not configured"}`);
  return lines.join("\n");
}

const HELP = `<b>What I can do</b>

<b>Find people</b>
/scrape — run a LinkedIn sweep now
/scrape &lt;search&gt; — sweep one specific search
/leads — newest leads, tap one to draft a text
/target &lt;search&gt; — add a search to the 24/7 rotation

<b>Reach out</b>  (nothing sends without your tap)
/text &lt;number&gt; &lt;what to say&gt; — draft an iMessage
/inbox — inbound replies since last check
/post &lt;platform&gt; &lt;topic&gt; — draft a post (x, linkedin, threads, facebook, instagram)
/reddit &lt;sub&gt; &lt;topic&gt; — draft a Reddit post that fits that sub's rules
/pending — everything waiting on you

<b>Control</b>
/status — health of everything
/pause · /resume — master switch
/hours 8 22 — when it's allowed to act
/brief &lt;text&gt; — describe the business (this drives every draft)
/logins — which accounts are still signed in

<b>Support</b>
/orion &lt;message&gt; — text Orion directly from here`;

// ---------------------------------------------------------------- commands

async function handleCommand(chat, from, text) {
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/start":
    case "/help":
      return say(chat, `👋 <b>${esc(CLIENT)}</b> is online.\n\n${HELP}`);

    case "/status":
      return say(chat, await statusText(), kb([
        [btn("📥 Pending", "go:pending"), btn("👤 Leads", "go:leads")],
        [btn(getSettings().paused ? "▶️ Resume" : "⏸ Pause", "go:toggle"), btn("🔄 Refresh", "go:status")],
      ]));

    case "/pause":
      saveSettings({ paused: true });
      return say(chat, "⏸ Paused. Every engine stops after its current step.");

    case "/resume":
      saveSettings({ paused: false });
      return say(chat, "▶️ Resumed.");

    case "/hours": {
      const [a, b] = arg.split(/\s+/).map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 24 || a >= b) return say(chat, "Usage: /hours 8 22");
      saveSettings({ activeHours: [a, b] });
      return say(chat, `🕘 Active hours set to ${a}:00-${b}:00.`);
    }

    case "/brief": {
      if (!arg) return say(chat, `Current brief:\n\n<pre>${esc(draft.brief() || "(not set)")}</pre>\n\nSet it with /brief &lt;description of the business, who you sell to, and what makes you different&gt;`);
      write("brief", { text: arg, setAt: new Date().toISOString() });
      return say(chat, "📝 Brief saved. Every draft from now on uses it.");
    }

    case "/target": {
      const t = read("targets", null) || { linkedin: { searches: [] } };
      if (!arg) return say(chat, `Searches in rotation:\n${(t.linkedin?.searches || []).map((x) => "• " + esc(x)).join("\n") || "(none)"}\n\nAdd one: /target head of marketing fintech`);
      t.linkedin = t.linkedin || { searches: [] };
      t.linkedin.searches = [...new Set([...(t.linkedin.searches || []), arg])];
      write("targets", t);
      return say(chat, `🎯 Added. ${t.linkedin.searches.length} searches in rotation.`);
    }

    case "/scrape": {
      await say(chat, "🔎 Sweeping LinkedIn…");
      const r = await linkedin.sweep({ queries: arg ? [arg] : null });
      if (!r.ok) return say(chat, `⚠️ ${esc(r.why)}`);
      return say(chat, `✅ ${r.added} new leads (${r.seen} seen). ${r.total} total.`, kb([[btn("👤 Show them", "go:leads")]]));
    }

    case "/leads": {
      const all = Object.values(linkedin.allLeads()).sort((a, b) => String(b.foundAt).localeCompare(String(a.foundAt)));
      if (!all.length) return say(chat, "No leads yet. Run /scrape.");
      const top = all.slice(0, 8);
      await say(chat, `👤 <b>${all.length} leads</b> — newest first:`);
      for (const l of top) {
        await say(chat, `<b>${esc(l.name)}</b>\n${esc(l.headline || "")}\n${esc(l.location || "")}\n<a href="${esc(l.url)}">profile</a>`,
          kb([[btn("💬 Draft a text", `lead:${l.slug}`), btn("🗑 Drop", `drop:${l.slug}`)]]));
      }
      return;
    }

    case "/text": {
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return say(chat, "Usage: /text +13105551212 what you want to say");
      const to = imessage.normalizeRecipient(m[1]);
      if (!to.ok) return say(chat, `⚠️ ${esc(to.why)}`);
      await say(chat, "✍️ Drafting…");
      const body = await draft.imessageDraft({ name: "", headline: "" }, { angle: m[2] });
      const item = queue.enqueue({
        kind: "imessage", title: `to ${to.id}`, preview: body,
        payload: { to: to.id, text: body, angle: m[2], dedupeKey: to.id }, source: "manual",
      });
      return showItem(chat, item);
    }

    case "/inbox": {
      const r = await imessage.newReplies();
      if (!r.ok) return say(chat, `⚠️ ${esc(r.why)}`);
      if (!r.messages.length) return say(chat, "📭 Nothing new.");
      for (const m of r.messages.slice(0, 10)) {
        await say(chat, `💬 <b>${esc(m.from)}</b>\n<pre>${esc(m.text)}</pre>`,
          kb([[btn("✍️ Draft a reply", `rep:${Buffer.from(m.from).toString("base64url")}`)]]));
      }
      return;
    }

    case "/post": {
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return say(chat, `Usage: /post x your topic here\nPlatforms: ${socials.platformNames().join(", ")}`);
      const p = m[1].toLowerCase();
      if (!socials.PLATFORMS[p]) return say(chat, `Unknown platform. Try: ${socials.platformNames().join(", ")}`);
      if (!socials.isLoggedIn(p)) return say(chat, `⚠️ Not signed in to ${socials.PLATFORMS[p].label} yet. On the Mac run:\n<pre>node engines/socials.mjs login ${p}</pre>`);
      await say(chat, `✍️ Writing for ${socials.PLATFORMS[p].label}…`);
      const body = await draft.socialDraft({ platform: p, topic: m[2], limit: socials.PLATFORMS[p].limit });
      const item = queue.enqueue({
        kind: "social", title: socials.PLATFORMS[p].label, preview: body,
        payload: { platform: p, text: body, topic: m[2] }, source: "manual",
      });
      return showItem(chat, item);
    }

    case "/reddit": {
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return say(chat, "Usage: /reddit smallbusiness how we cut onboarding time in half");
      const sub = m[1].replace(/^\/?r\//, "");
      if (!reddit.configured()) return say(chat, "⚠️ Reddit keys aren't set. Add them in the setup TUI.");
      await say(chat, `📖 Reading r/${esc(sub)}'s rules…`);
      const [rl, hot, cad] = await Promise.all([reddit.rules(sub), reddit.hot(sub, 8), Promise.resolve(reddit.cadenceCheck(sub))]);
      if (!cad.ok) await say(chat, `⏳ Heads up: ${esc(cad.why)}. You can still draft it.`);
      const d = await draft.redditDraft({
        subreddit: sub, topic: m[2],
        rules: rl.ok ? rl.rules : [],
        examples: hot.ok ? hot.posts.map((x) => x.title) : [],
      });
      const item = queue.enqueue({
        kind: "reddit", title: `r/${sub}`, preview: `${d.title}\n\n${d.text}`,
        payload: { subreddit: sub, title: d.title, text: d.text, topic: m[2], rules: rl.ok ? rl.rules : [] }, source: "manual",
      });
      if (d.ruleRisk && d.ruleRisk !== "none") await say(chat, `⚠️ Rule risk: <b>${esc(d.ruleRisk)}</b> — ${esc(d.riskNote)}`);
      return showItem(chat, item);
    }

    case "/pending": {
      const p = queue.pending();
      if (!p.length) return say(chat, "✅ Nothing waiting on you.");
      await say(chat, `📥 <b>${p.length} waiting</b>`);
      for (const item of p.slice(0, 10)) await showItem(chat, item);
      return;
    }

    case "/logins": {
      const rows = [`<b>Saved sessions</b>`, `LinkedIn: ${linkedin.isLoggedIn() ? "✅" : "❌ run: node engines/linkedin.mjs login"}`];
      for (const n of socials.platformNames()) {
        rows.push(`${socials.PLATFORMS[n].label}: ${socials.isLoggedIn(n) ? "✅" : `❌ run: node engines/socials.mjs login ${n}`}`);
      }
      rows.push("", "A ✅ can still expire. /checklogins tests them for real (slow).");
      return say(chat, rows.join("\n"));
    }

    case "/checklogins": {
      await say(chat, "🔍 Testing each saved session for real, one at a time…");
      const out = [];
      for (const n of socials.platformNames()) {
        if (!socials.isLoggedIn(n)) { out.push(`${n}: ❌ never logged in`); continue; }
        const r = await socials.checkSession(n);
        out.push(`${n}: ${r.ok ? "✅ alive" : "⚠️ " + r.why}`);
      }
      return say(chat, out.join("\n"));
    }

    case "/orion": {
      if (!arg) return say(chat, "Usage: /orion the LinkedIn sweep stopped finding anyone");
      const r = await toOrion(`${arg}\n\n— sent from the Telegram bot by user ${from.id}${from.username ? " @" + from.username : ""}`, { kind: "help", from: from.first_name || "" });
      return say(chat, r.ok
        ? "📨 Sent to Orion. He'll get back to you here."
        : r.spooled ? "📥 Saved — Orion's relay is unreachable right now, it'll send itself as soon as it's back."
        : `⚠️ Couldn't reach Orion (${esc(r.description || "unknown")}). Email him instead: ${esc(process.env.ORION_SUPPORT_EMAIL || "orionjones99@gmail.com")}`);
    }

    // ---- admin (Orion only) -------------------------------------------
    case "/diag": {
      if (!isAdmin(from.id)) return say(chat, "That one's for Orion.");
      const s = getSettings();
      const q = read("queue", { items: [] });
      return say(chat, [
        `<b>diag ${esc(CLIENT)}</b>`,
        `host ${esc(os.hostname())} · ${os.platform()} ${os.release()} · node ${process.version}`,
        `uptime ${(os.uptime() / 3600).toFixed(1)}h · load ${os.loadavg().map((n) => n.toFixed(2)).join(" ")}`,
        `root ${esc(ROOT)}`,
        ``,
        `queue: ${q.items.length} items, ${queue.pending().length} pending`,
        `leads: ${Object.keys(linkedin.allLeads()).length}`,
        `deepseek: ${process.env.DEEPSEEK_API_KEY ? "key set" : "MISSING"}`,
        `reddit: ${reddit.configured() ? "configured" : "MISSING"}`,
        `relay: ${relayConfigured() ? "ok" : "MISSING"}`,
        `settings: <pre>${esc(JSON.stringify(s))}</pre>`,
      ].join("\n"));
    }

    case "/logs": {
      if (!isAdmin(from.id)) return say(chat, "That one's for Orion.");
      const name = rest[0] || "bot";
      const n = Number(rest[1] || 25);
      const f = path.join(ROOT, "data", "logs", `${name}.log`);
      if (!existsSync(f)) return say(chat, `No log for "${esc(name)}". Try: bot, scheduler, linkedin, socials, reddit, imessage`);
      const tail = readFileSync(f, "utf8").trim().split("\n").slice(-Math.min(80, n)).join("\n");
      return say(chat, `<pre>${esc(tail.slice(-3500))}</pre>`);
    }

    case "/say": {
      if (!isAdmin(from.id)) return say(chat, "That one's for Orion.");
      if (!arg) return say(chat, "Usage: /say <message to the client>");
      const owner = ALLOWED[0];
      if (!owner) return say(chat, "No client chat id on file.");
      await tg("sendMessage", { chat_id: owner, text: `🛠 <b>Orion:</b> ${esc(arg)}`, parse_mode: "HTML" });
      return say(chat, "Delivered.");
    }

    default:
      return say(chat, `Not a command I know. ${HELP}`);
  }
}

// --------------------------------------------------------------- callbacks

async function handleCallback(cbq) {
  const chat = cbq.message.chat.id;
  const [action, ref] = String(cbq.data || "").split(":");
  const ack = (text = "") => tg("answerCallbackQuery", { callback_query_id: cbq.id, text: text.slice(0, 190) });

  if (action === "go") {
    await ack();
    if (ref === "pending") return handleCommand(chat, cbq.from, "/pending");
    if (ref === "leads") return handleCommand(chat, cbq.from, "/leads");
    if (ref === "status") return handleCommand(chat, cbq.from, "/status");
    if (ref === "toggle") { saveSettings({ paused: !getSettings().paused }); return handleCommand(chat, cbq.from, "/status"); }
    return;
  }

  if (action === "lead") {
    await ack("Drafting…");
    const lead = linkedin.allLeads()[ref];
    if (!lead) return say(chat, "That lead is gone.");
    const scored = await draft.scoreLead(lead);
    const body = await draft.imessageDraft(lead, { angle: scored.angle });
    await say(chat, `Fit score <b>${scored.score ?? "?"}</b> — ${esc(scored.why)}`);
    // No phone number comes from LinkedIn, so this draft is parked until a
    // human supplies one. Pretending we have a number would be worse.
    const item = queue.enqueue({
      kind: "imessage", title: `for ${lead.name} (needs a number)`, preview: body,
      payload: { to: "", text: body, lead, angle: scored.angle, dedupeKey: lead.slug }, source: "lead",
    });
    return say(chat, `<pre>${esc(body)}</pre>\n\nReply to this message with their phone number to queue it, or use:\n<code>/text +1XXXXXXXXXX ${esc((scored.angle || "intro").slice(0, 40))}</code>`);
  }

  if (action === "drop") {
    await ack("Dropped");
    linkedin.setLead(ref, { status: "dropped" });
    return;
  }

  if (action === "rep") {
    await ack("Drafting…");
    const who = Buffer.from(ref, "base64url").toString();
    const hist = await imessage.recent({ sinceMs: Date.now() - 7 * 24 * 3600 * 1000, limit: 200 });
    const thread = (hist.messages || []).filter((m) => m.from === who).reverse().slice(-12);
    const body = await draft.replyDraft(thread);
    const item = queue.enqueue({
      kind: "imessage", title: `reply to ${who}`, preview: body,
      payload: { to: who, text: body, dedupeKey: "" }, source: "reply",
    });
    return showItem(chat, item);
  }

  // ---- the approval decisions ---------------------------------------
  const item = queue.getItem(ref);
  if (!item) { await ack("That draft is gone."); return; }
  if (item.status !== "pending") { await ack(`Already ${item.status}.`); return; }

  if (action === "no") {
    queue.setStatus(ref, "skipped");
    await ack("Skipped");
    return tg("editMessageText", { chat_id: chat, message_id: cbq.message.message_id, text: `❌ Skipped — ${esc(item.title)}`, parse_mode: "HTML" });
  }

  if (action === "redo") {
    await ack("Rewriting…");
    try {
      const payload = await redraft(item);
      queue.setStatus(ref, "skipped", "redrafted");
      const fresh = queue.enqueue({ kind: item.kind, title: titleOf(item.kind, payload), preview: previewOf(item.kind, payload), payload, source: item.source });
      return showItem(chat, fresh);
    } catch (e) { return say(chat, `⚠️ Rewrite failed: ${esc(String(e.message || e))}`); }
  }

  if (action === "ok") {
    if (item.kind === "imessage" && !item.payload.to) {
      await ack("No number on this one");
      return say(chat, "This draft has no phone number attached. Send it with:\n<code>/text +1XXXXXXXXXX …</code>");
    }
    await ack("Sending…");
    // Claim it BEFORE the send so a double-tap can't send twice.
    queue.setStatus(ref, "sending");
    const res = await performSend(item);
    queue.setStatus(ref, res.ok ? "sent" : "failed", res.ok ? (res.detail || "sent") : res.why);
    await tg("editMessageText", {
      chat_id: chat, message_id: cbq.message.message_id, parse_mode: "HTML",
      text: res.ok
        ? `✅ <b>Sent</b> — ${esc(item.title)}\n<pre>${esc(item.preview.slice(0, 500))}</pre>${res.detail ? `\n${esc(String(res.detail))}` : ""}`
        : `⚠️ <b>Failed</b> — ${esc(item.title)}\n${esc(res.why || "unknown error")}`,
    });
    if (res.screenshot) await sendPhoto(chat, res.screenshot, "Proof of post");
    if (!res.ok) await toOrion(`A send failed on ${CLIENT}.\n\nKind: ${item.kind}\nTarget: ${item.title}\nError: ${res.why}`, { kind: "alert" });
    return;
  }

  return ack();
}

// ------------------------------------------------------------------- loop

async function main() {
  const meInfo = await tg("getMe");
  log("starting as", meInfo.result?.username || "?", "allowlist:", ALLOWED.join(",") || "(EMPTY - locked)");
  if (!ALLOWED.length) log("WARNING: TELEGRAM_ALLOWED_USER_IDS is empty. Nobody can use the bot until it's set.");

  let offset = read("bot-offset", { offset: 0 }).offset;
  for (;;) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        write("bot-offset", { offset });
        try {
          if (u.callback_query) {
            if (!allowed(u.callback_query.from.id)) continue;
            await handleCallback(u.callback_query);
          } else if (u.message?.text) {
            const { chat, from, text } = u.message;
            if (!allowed(from.id)) {
              log("blocked", from.id, from.username || "");
              await say(chat.id, `🔒 This assistant is private.\n\nYour Telegram ID is <code>${from.id}</code> — give it to whoever set this up to be added.`);
              continue;
            }
            log("msg", from.id, text.slice(0, 120));
            if (text.startsWith("/")) await handleCommand(chat.id, from, text);
            else if (u.message.reply_to_message) await handleReplyToDraft(chat.id, from, u.message);
            else await say(chat.id, HELP);
          }
        } catch (e) {
          log("handler error", String(e.stack || e).slice(0, 400));
          try { await say(u.message?.chat?.id || u.callback_query?.message?.chat?.id, `⚠️ ${esc(String(e.message || e).slice(0, 300))}`); } catch {}
        }
      }
      await flushOutbox();
    } catch (e) {
      log("poll error", String(e.message || e));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Replying to a parked draft with a phone number is the fastest path from
// "found a lead" to "texted them", so it is worth supporting explicitly.
async function handleReplyToDraft(chat, from, msg) {
  const num = imessage.normalizeRecipient(msg.text);
  if (!num.ok) return say(chat, "Reply to a draft with just a phone number to attach it, or use /help.");
  const parked = queue.pending().filter((i) => i.kind === "imessage" && !i.payload.to);
  if (!parked.length) return say(chat, "No draft is waiting for a number.");
  const item = parked[parked.length - 1];
  item.payload.to = num.id;
  item.payload.dedupeKey = num.id;
  const all = read("queue", { items: [] });
  write("queue", { ...all, items: all.items.map((i) => (i.id === item.id ? { ...i, payload: item.payload, title: `to ${num.id}` } : i)) });
  return showItem(chat, queue.getItem(item.id));
}

main().catch((e) => { log("FATAL", String(e.stack || e)); process.exit(1); });
