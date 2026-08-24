// Cookie import — how a client signs in without ever signing in.
//
// The problem this solves: the old flow opened a real browser window ON the Mac
// Mini and asked a human to log in there. That is fine when you are standing in
// the room and hopeless when you are not — it needs a screen, a keyboard, and
// the client's 2FA device, all at the same machine.
//
// Instead: the client stays on their OWN computer, where they are already
// logged into everything, exports their cookies with a free browser extension,
// and pastes them into the dashboard. We load them into the headless profile.
// No password is typed, none is stored, and no 2FA prompt is triggered, because
// from the site's point of view the session already exists.
//
// Honest limits, stated up front rather than discovered later:
//   - WhatsApp Web does NOT authenticate with cookies. Its session lives in
//     IndexedDB and is bound to the browser instance, so it cannot be pasted in.
//     WhatsApp needs the QR scan. This module says so instead of failing oddly.
//   - Cookies expire. LinkedIn's li_at is typically ~1 year, Instagram and
//     Facebook far less. The status board watches for this and asks for a
//     re-paste rather than going quietly dead.
import { open, profileDir } from "./browser.mjs";
import { logger } from "./log.mjs";

const log = logger("cookies");

// What a working session looks like per platform: the cookie without which the
// site treats you as logged out. Checked before import so a client pasting the
// wrong tab's cookies is told immediately, not three days later.
export const PLATFORMS = {
  linkedin: {
    label: "LinkedIn", profile: "linkedin",
    domains: ["linkedin.com"], required: ["li_at"],
    help: "Log in to linkedin.com on your own computer, then export cookies for that tab.",
  },
  x: {
    label: "X / Twitter", profile: "social-x",
    domains: ["x.com", "twitter.com"], required: ["auth_token"],
    help: "Log in to x.com, then export cookies for that tab.",
  },
  instagram: {
    label: "Instagram", profile: "social-instagram",
    domains: ["instagram.com"], required: ["sessionid"],
    help: "Log in to instagram.com, then export cookies for that tab.",
  },
  facebook: {
    label: "Facebook", profile: "social-facebook",
    domains: ["facebook.com"], required: ["c_user", "xs"],
    help: "Log in to facebook.com, then export cookies for that tab.",
  },
  threads: {
    label: "Threads", profile: "social-threads",
    domains: ["threads.net", "threads.com", "instagram.com"], required: ["sessionid"],
    help: "Threads uses your Instagram login. Export cookies from threads.net after logging in.",
  },
  reddit: {
    label: "Reddit", profile: "social-reddit",
    domains: ["reddit.com"], required: ["reddit_session"],
    help: "Only needed if you'd rather not use Reddit API keys.",
  },
};

// WhatsApp is deliberately absent above; callers ask this before offering it.
export const cookieImportable = (platform) => !!PLATFORMS[platform];

const SAMESITE = { no_restriction: "None", none: "None", unspecified: "Lax", lax: "Lax", strict: "Strict" };

/**
 * Parse whatever the client pasted. Browser extensions disagree on format, and
 * a client should not have to know which one they used, so accept them all:
 *   - Cookie-Editor / EditThisCookie JSON array
 *   - an object wrapping such an array ({cookies:[...]})
 *   - Netscape cookies.txt
 *   - a raw "name=value; name2=value2" Cookie header
 */
export function parseCookies(input) {
  const text = String(input || "").trim();
  if (!text) return { ok: false, why: "nothing pasted" };

  // 1. JSON, in either shape.
  if (text.startsWith("[") || text.startsWith("{")) {
    let j;
    try { j = JSON.parse(text); } catch (e) { return { ok: false, why: "that looks like JSON but won't parse: " + String(e.message).slice(0, 80) }; }
    const arr = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : null;
    if (!arr) return { ok: false, why: "JSON parsed, but there's no cookie array in it" };
    const out = arr.map(normalizeOne).filter(Boolean);
    return out.length ? { ok: true, cookies: out } : { ok: false, why: "no usable cookies in that JSON" };
  }

  // 2. Netscape cookies.txt — tab separated, # comments.
  if (/^#|\t/m.test(text)) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const p = line.split("\t");
      if (p.length < 7) continue;
      out.push(normalizeOne({
        domain: p[0], path: p[2], secure: p[3] === "TRUE",
        expirationDate: Number(p[4]) || undefined, name: p[5], value: p[6],
      }));
    }
    const clean = out.filter(Boolean);
    if (clean.length) return { ok: true, cookies: clean };
  }

  // 3. A raw Cookie header. No domain in it, so the caller supplies one.
  if (/=/.test(text)) {
    const out = text.split(/;\s*/).map((pair) => {
      const i = pair.indexOf("=");
      if (i < 1) return null;
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), needsDomain: true };
    }).filter(Boolean);
    if (out.length) return { ok: true, cookies: out, needsDomain: true };
  }

  return { ok: false, why: "couldn't recognise that as cookies. Use a Cookie-Editor 'Export' — it copies JSON." };
}

function normalizeOne(c) {
  if (!c || !c.name || c.value === undefined || c.value === null) return null;
  const domain = String(c.domain || c.host || "").trim();
  const out = {
    name: String(c.name),
    value: String(c.value),
    domain: domain || undefined,
    path: c.path || "/",
    secure: c.secure !== false,
    httpOnly: !!c.httpOnly,
    sameSite: SAMESITE[String(c.sameSite || "").toLowerCase()] || "Lax",
  };
  // Playwright wants seconds; extensions emit float seconds. A session cookie
  // (no expiry) is legitimate — leave it off rather than inventing a date.
  const exp = c.expirationDate ?? c.expires ?? c.expiry;
  if (exp && Number(exp) > 0) out.expires = Math.floor(Number(exp));
  // "None" is only legal on a secure cookie; browsers drop the pair otherwise.
  if (out.sameSite === "None") out.secure = true;
  return out;
}

/** Does this set actually contain a usable session for the platform? */
export function validate(platform, cookies) {
  const p = PLATFORMS[platform];
  if (!p) return { ok: false, why: `${platform} can't be set up with cookies` };
  const names = new Set(cookies.map((c) => c.name));
  const missing = p.required.filter((r) => !names.has(r));
  if (missing.length) {
    return {
      ok: false,
      why: `these cookies don't contain a ${p.label} session (missing ${missing.join(", ")}). ${p.help}`,
    };
  }
  const onDomain = cookies.filter((c) => !c.domain || p.domains.some((d) => String(c.domain).includes(d)));
  if (!onDomain.length) return { ok: false, why: `none of those cookies belong to ${p.label}` };

  // Warn on an expiry that is already past or imminent — importing a dead
  // cookie "succeeds" and then fails silently on the first real run.
  const now = Date.now() / 1000;
  const session = cookies.filter((c) => p.required.includes(c.name));
  const expired = session.filter((c) => c.expires && c.expires < now);
  if (expired.length) return { ok: false, why: `that ${p.label} session has already expired. Log in again on your own computer and re-export.` };
  const soon = session.filter((c) => c.expires && c.expires < now + 7 * 86400);
  return { ok: true, cookies: onDomain, warn: soon.length ? `this ${p.label} session expires within a week` : null };
}

/**
 * Load cookies into the headless profile the engines use.
 * Returns { ok, count, verified } — verified means the site actually served a
 * logged-in page afterwards, which is the only claim worth making.
 */
export async function importCookies(platform, rawInput, { verify = true } = {}) {
  const p = PLATFORMS[platform];
  if (!p) {
    return { ok: false, why: platform === "whatsapp"
      ? "WhatsApp Web can't be set up with cookies — its session isn't stored in them. It needs the QR scan."
      : `unknown platform "${platform}"` };
  }

  const parsed = parseCookies(rawInput);
  if (!parsed.ok) return { ok: false, why: parsed.why };

  // A raw Cookie header carries no domain; attach the platform's own.
  let cookies = parsed.cookies;
  if (parsed.needsDomain) {
    cookies = cookies.map((c) => normalizeOne({ ...c, domain: "." + p.domains[0] })).filter(Boolean);
  }

  const v = validate(platform, cookies);
  if (!v.ok) return { ok: false, why: v.why };

  let session;
  try {
    session = await open(p.profile, { headed: false });
    await session.ctx.addCookies(v.cookies);
    log(platform, `imported ${v.cookies.length} cookies`);

    if (!verify) {
      await session.close();
      return { ok: true, count: v.cookies.length, verified: false, warn: v.warn };
    }

    // Prove it. An import that "worked" but leaves the account logged out is
    // the exact failure this whole flow exists to avoid.
    const { PLATFORMS: SOCIALS } = await import("../engines/socials.mjs");
    const home = platform === "linkedin" ? "https://www.linkedin.com/feed/" : (SOCIALS[platform]?.home || `https://${p.domains[0]}/`);
    await session.page.goto(home, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 3500));
    const { detectChallenge } = await import("./browser.mjs");
    const ch = await detectChallenge(session.page);
    await session.close();

    if (ch.challenged) {
      return { ok: false, why: `${p.label} still shows a login screen with those cookies. They may be from a different account, or already expired. ${p.help}` };
    }
    return { ok: true, count: v.cookies.length, verified: true, warn: v.warn };
  } catch (e) {
    try { if (session) await session.close(); } catch {}
    return { ok: false, why: String(e.message || e).slice(0, 200) };
  }
}

/** Wipe a platform's saved session — the "sign me out" path. */
export async function clearCookies(platform) {
  const p = PLATFORMS[platform];
  if (!p) return { ok: false, why: `unknown platform "${platform}"` };
  try {
    const session = await open(p.profile, { headed: false });
    await session.ctx.clearCookies();
    await session.close();
    log(platform, "cleared");
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 200) }; }
}

export const profilePathFor = (platform) => (PLATFORMS[platform] ? profileDir(PLATFORMS[platform].profile) : null);

if (process.argv[1]?.endsWith("cookies.mjs")) {
  const [cmd, platform] = process.argv.slice(2);
  if (cmd === "import") {
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", async () => {
      const r = await importCookies(platform, raw);
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    });
  } else if (cmd === "clear") {
    clearCookies(platform).then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
  } else {
    console.log("usage: cookies.mjs import <platform> < cookies.json\n       cookies.mjs clear <platform>");
    console.log("platforms: " + Object.keys(PLATFORMS).join(", "));
    process.exit(1);
  }
}
