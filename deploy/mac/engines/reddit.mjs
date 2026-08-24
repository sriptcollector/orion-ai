// Reddit engine — posts through the official API using a "script" app.
//
// API rather than browser automation on purpose: Reddit publishes an API, and
// using it means the account is not pretending to be something it isn't. It is
// also the only path that returns real errors (flair required, subreddit
// banned, rate limited) instead of a silently failing click.
//
// The dangerous thing about Reddit is not the API, it is cadence. An account
// that posts three self-promotional threads an hour gets shadowbanned, and a
// shadowban is invisible from the inside — posts look fine to you and are shown
// to nobody. So this enforces, from the ledger of what actually sent:
//   - a daily post cap
//   - a minimum gap between any two posts
//   - a much longer minimum gap per individual subreddit
// and it reads each subreddit's own rules before drafting.
import { logger } from "../lib/log.mjs";
import { getSettings, mayAct } from "../lib/settings.mjs";
import { sentToday, lastSent } from "../lib/queue.mjs";
import { read, write } from "../lib/store.mjs";
import { loadEnv } from "../lib/env.mjs";
loadEnv();

const log = logger("reddit");
const UA = () => process.env.REDDIT_USER_AGENT || `macos:orion-assistant:v1.0 (by /u/${process.env.REDDIT_USERNAME || "unknown"})`;

export const configured = () =>
  !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET &&
     process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD);

// Access tokens last an hour. Cache in memory; a fresh one per call would look
// like credential stuffing.
let _token = { value: null, expires: 0 };

async function token() {
  if (_token.value && Date.now() < _token.expires - 60000) return _token.value;
  if (!configured()) throw new Error("Reddit is not configured. Set REDDIT_CLIENT_ID / SECRET / USERNAME / PASSWORD in .env");

  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", "user-agent": UA() },
    body: new URLSearchParams({
      grant_type: "password",
      username: process.env.REDDIT_USERNAME,
      password: process.env.REDDIT_PASSWORD,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    // The overwhelmingly common cause, worth saying out loud rather than
    // letting someone debug a bare 401 for an hour.
    const hint = /invalid_grant/i.test(JSON.stringify(j))
      ? " (invalid_grant almost always means 2FA is on for this Reddit account, or the app is not type 'script'. Password grant cannot pass 2FA - use a dedicated script account.)"
      : "";
    throw new Error(`Reddit auth failed ${res.status}: ${JSON.stringify(j).slice(0, 200)}${hint}`);
  }
  _token = { value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return _token.value;
}

async function api(path, { method = "GET", body = null } = {}) {
  const t = await token();
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t}`,
      "user-agent": UA(),
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body) : undefined,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`reddit ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return j;
}

export async function me() {
  const j = await api("/api/v1/me");
  return { ok: true, name: j.name, karma: (j.link_karma || 0) + (j.comment_karma || 0), created: j.created_utc };
}

// A subreddit's own rules, so a draft can be written to fit them instead of
// being removed by a mod ten minutes later.
export async function rules(sub) {
  const clean = String(sub).replace(/^\/?r\//, "");
  try {
    const j = await api(`/r/${clean}/about/rules`);
    const list = (j.rules || []).map((r) => `${r.short_name}: ${(r.description || "").slice(0, 200)}`);
    let about = null;
    try {
      const a = await api(`/r/${clean}/about`);
      about = { subscribers: a.data?.subscribers, title: a.data?.title, over18: a.data?.over18, type: a.data?.subreddit_type };
    } catch {}
    return { ok: true, sub: clean, rules: list, about };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 300) }; }
}

// Some subreddits reject any post without flair. Fetch the options so we can
// attach one rather than failing on submit.
export async function flairs(sub) {
  const clean = String(sub).replace(/^\/?r\//, "");
  try {
    const j = await api(`/r/${clean}/api/link_flair_v2`);
    return { ok: true, flairs: (j || []).map((f) => ({ id: f.id, text: f.text })) };
  } catch { return { ok: true, flairs: [] }; }   // most subs 403 here; not fatal
}

// Cadence gate. Reads the queue ledger — what actually went out — never intent.
export function cadenceCheck(sub) {
  const s = getSettings().reddit;
  const clean = String(sub || "").replace(/^\/?r\//, "").toLowerCase();

  if (sentToday("reddit") >= s.dailyPostCap) {
    return { ok: false, why: `daily Reddit cap reached (${s.dailyPostCap} posts)` };
  }
  const last = lastSent("reddit");
  if (last) {
    const hrs = (Date.now() - new Date(last.decidedAt).getTime()) / 3600000;
    if (hrs < s.minHoursBetweenPosts) {
      return { ok: false, why: `last post was ${hrs.toFixed(1)}h ago; minimum gap is ${s.minHoursBetweenPosts}h` };
    }
  }
  const lastHere = lastSent("reddit", (i) => String(i.payload?.subreddit || "").toLowerCase() === clean);
  if (lastHere) {
    const hrs = (Date.now() - new Date(lastHere.decidedAt).getTime()) / 3600000;
    if (hrs < s.minHoursPerSubreddit) {
      return { ok: false, why: `already posted to r/${clean} ${hrs.toFixed(1)}h ago; minimum per-subreddit gap is ${s.minHoursPerSubreddit}h` };
    }
  }
  return { ok: true };
}

/**
 * Submit a self (text) post. Called by bot.mjs only after human approval.
 */
export async function submit({ subreddit, title, text, flairId = null, dryRun = false }) {
  const gate = mayAct("reddit");
  if (!gate.ok) return { ok: false, why: gate.why };
  const sub = String(subreddit || "").replace(/^\/?r\//, "");
  if (!sub) return { ok: false, why: "no subreddit given" };
  if (!String(title || "").trim()) return { ok: false, why: "no title" };
  if (String(title).length > 300) return { ok: false, why: `title is ${title.length} chars; Reddit's limit is 300` };

  const cad = cadenceCheck(sub);
  if (!cad.ok) return { ok: false, why: cad.why };
  if (dryRun) return { ok: true, dryRun: true, subreddit: sub, title, text };

  try {
    let body = { api_type: "json", sr: sub, kind: "self", title, text: text || "", resubmit: "true", sendreplies: "true" };
    if (flairId) body.flair_id = flairId;

    let j = await api("/api/submit", { method: "POST", body });
    let errs = j?.json?.errors || [];

    // Flair-required is recoverable: pick the first available flair and retry
    // once. Anything else is reported as-is.
    if (errs.length && /FLAIR/i.test(JSON.stringify(errs)) && !flairId) {
      const f = await flairs(sub);
      if (f.flairs.length) {
        log(`r/${sub} requires flair; retrying with "${f.flairs[0].text}"`);
        body.flair_id = f.flairs[0].id;
        j = await api("/api/submit", { method: "POST", body });
        errs = j?.json?.errors || [];
      }
    }
    if (errs.length) return { ok: false, why: errs.map((e) => e.join(" ")).join("; ") };

    const url = j?.json?.data?.url || null;
    log("posted", `r/${sub}`, url || "(no url returned)");
    return { ok: true, subreddit: sub, url, id: j?.json?.data?.id || null };
  } catch (e) {
    const msg = String(e.message || e);
    if (/RATELIMIT|429/i.test(msg)) return { ok: false, why: "Reddit rate-limited this account. Wait before trying again." };
    return { ok: false, why: msg.slice(0, 300) };
  }
}

export async function comment({ parentFullname, text }) {
  const gate = mayAct("reddit");
  if (!gate.ok) return { ok: false, why: gate.why };
  try {
    const j = await api("/api/comment", { method: "POST", body: { api_type: "json", thing_id: parentFullname, text } });
    const errs = j?.json?.errors || [];
    if (errs.length) return { ok: false, why: errs.map((e) => e.join(" ")).join("; ") };
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 300) }; }
}

// Read a subreddit — used to find threads worth replying to, and to give the
// drafter real context about what does well there.
export async function hot(sub, limit = 10) {
  const clean = String(sub).replace(/^\/?r\//, "");
  try {
    const j = await api(`/r/${clean}/hot?limit=${Math.min(25, limit)}`);
    return {
      ok: true,
      posts: (j.data?.children || []).map((c) => ({
        id: c.data.name, title: c.data.title, score: c.data.score,
        comments: c.data.num_comments, url: "https://reddit.com" + c.data.permalink,
        flair: c.data.link_flair_text || null, self: c.data.is_self,
      })),
    };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 300) }; }
}

// Did a post survive? A removed post looks fine to its author, so check.
export async function checkAlive(postId) {
  try {
    const j = await api(`/api/info?id=${postId}`);
    const d = j.data?.children?.[0]?.data;
    if (!d) return { ok: true, alive: false, why: "not found" };
    const removed = d.removed_by_category || (d.selftext === "[removed]");
    return { ok: true, alive: !removed, removedBy: d.removed_by_category || null, score: d.score };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 200) }; }
}

if (process.argv[1]?.endsWith("reddit.mjs")) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = {
    me: () => me(),
    rules: () => rules(rest[0]),
    hot: () => hot(rest[0], Number(rest[1] || 10)),
    flairs: () => flairs(rest[0]),
    cadence: async () => cadenceCheck(rest[0]),
    post: () => submit({ subreddit: rest[0], title: rest[1], text: rest[2] || "", dryRun: rest[3] !== "--send" }),
  }[cmd || "me"];
  if (!run) { console.log("usage: reddit.mjs [me|rules <sub>|hot <sub>|flairs <sub>|cadence <sub>|post <sub> <title> <text> [--send]]"); process.exit(1); }
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r?.ok === false ? 1 : 0); })
       .catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
