// LinkedIn engine — reads search results from the owner's own logged-in
// session and turns them into leads.
//
// Worth being honest about what this is: automated collection is against
// LinkedIn's terms of service, and the real risk is not legal, it is that an
// aggressive scraper gets the account restricted within days. This engine is
// therefore built to be slow and boring on purpose:
//
//   - it reads SEARCH RESULT pages, which a human loads normally, and only
//     opens individual profiles when explicitly asked
//   - every wait is a range, never a constant
//   - a hard daily ceiling counted from what was actually collected
//   - the moment LinkedIn shows a login wall, captcha or "unusual activity"
//     page, it HALTS itself, flags it in settings, and texts both the client
//     and Orion. It does not retry. Retrying through a challenge is exactly
//     what converts a warning into a ban.
//
// Selectors on LinkedIn change constantly, so extraction is deliberately
// structural (anchors to /in/ plus their surrounding card text) rather than a
// list of class names that will be dead in a month.
import { withPage, open, hasProfile, detectChallenge, pause, rand, shot } from "../lib/browser.mjs";
import { getSettings, saveSettings, mayAct } from "../lib/settings.mjs";
import { readFileSync } from "node:fs";
import { read, write, today } from "../lib/store.mjs";
import { logger } from "../lib/log.mjs";
import { alertOnce } from "../lib/relay.mjs";

const log = logger("linkedin");
const PROFILE = "linkedin";

export const isLoggedIn = () => hasProfile(PROFILE);

// One-time interactive login. Opens a real window; the human signs in (and
// clears 2FA) and we just wait for the feed to appear. No password is ever
// typed by, passed to, or stored by this code.
export async function login({ waitMinutes = 5 } = {}) {
  const { page, close } = await open(PROFILE, { headed: true, timeout: waitMinutes * 60000 });
  try {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    log("waiting for human login");
    await page.waitForURL(/linkedin\.com\/(feed|in)\//, { timeout: waitMinutes * 60000 });
    await pause(2, 4);
    saveSettings({ linkedin: { halted: false, haltReason: "" } });
    log("login confirmed");
    return { ok: true };
  } catch (e) {
    return { ok: false, why: "Did not reach the LinkedIn feed within " + waitMinutes + " minutes. Run login again." };
  } finally { await close(); }
}

// Halt hard, once, and make sure a human hears about it.
async function halt(why) {
  saveSettings({ linkedin: { halted: true, haltReason: why } });
  log("HALTED:", why);
  await alertOnce("linkedin-halt", "LinkedIn scraping auto-halted.\n\nReason: " + why +
    "\n\nNothing will run until someone logs in again and clears it. Run:  node engines/linkedin.mjs login");
  return { ok: false, halted: true, why };
}

// Pull every person card off whatever LinkedIn page we are on. Structural, not
// class-name based: find links into /in/, walk up to the card, read its text.
async function extractPeople(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/in/"]')) {
      const href = a.href.split("?")[0];
      const m = href.match(/\/in\/([^/]+)/);
      if (!m) continue;
      const slug = m[1];
      if (seen.has(slug)) continue;

      // Walk up to the enclosing result card. li first, then a bounded climb.
      let card = a.closest("li") || a.closest("div[data-chameleon-result-urn]");
      if (!card) {
        card = a;
        for (let i = 0; i < 5 && card.parentElement; i++) {
          card = card.parentElement;
          if (card.innerText && card.innerText.length > 60) break;
        }
      }
      const text = clean(card.innerText);
      if (!text || text.length < 8) continue;

      const lines = text.split("\n").map(clean).filter(Boolean)
        .filter((l) => !/^(Status is|View |Message|Connect|Follow|\d+(st|nd|rd|th))/i.test(l));
      const name = clean(a.innerText).split("\n")[0] || lines[0] || "";
      if (!name || /^view\b/i.test(name)) continue;

      seen.add(slug);
      out.push({
        slug,
        url: href,
        name,
        headline: lines.find((l) => l !== name && l.length > 3 && !/^\d/.test(l)) || "",
        location: lines.slice().reverse().find((l) => /,\s*[A-Z]|United States|Area$/.test(l)) || "",
        raw: text.slice(0, 400),
      });
    }
    return out;
  });
}

// Search targets live in config/targets.json so the client can retarget from
// Telegram without a redeploy. data/targets.json (written by /target) wins over
// the shipped config file when present.
export function targets() {
  const live = read("targets", null);
  if (live) return live;
  try {
    return JSON.parse(readFileSync(new URL("../config/targets.json", import.meta.url), "utf8"));
  } catch { return { linkedin: { searches: [] } }; }
}

const searchUrl = (q) =>
  /^https?:\/\//i.test(q) ? q
    : "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(q) + "&origin=GLOBAL_SEARCH_HEADER";

/**
 * One sweep: run the configured searches, collect people, store new leads.
 * Returns { ok, added, seen, halted }.
 */
export async function sweep({ queries = null, maxProfiles = null } = {}) {
  const gate = mayAct("linkedin");
  if (!gate.ok) return { ok: false, why: gate.why, added: 0 };
  if (!isLoggedIn()) return { ok: false, why: "Not logged in to LinkedIn yet. Run:  node engines/linkedin.mjs login", added: 0 };

  const s = getSettings().linkedin;
  const counters = read("counters", {});
  const usedToday = counters[`linkedin-${today()}`] || 0;
  if (usedToday >= s.dailyProfileCap) return { ok: false, why: `daily cap reached (${s.dailyProfileCap})`, added: 0 };

  const list = queries && queries.length ? queries : (targets().linkedin?.searches || []);
  if (!list.length) return { ok: false, why: "No searches configured. Add them in config/targets.json or /target in Telegram.", added: 0 };

  const budget = Math.min(maxProfiles || s.profilesPerSweep, s.dailyProfileCap - usedToday);
  let added = 0, seen = 0;
  const leads = read("leads", {});

  try {
    const result = await withPage(PROFILE, async (page) => {
      for (const q of list) {
        if (seen >= budget) break;
        log("search:", q);
        await page.goto(searchUrl(q), { waitUntil: "domcontentloaded" });
        await pause(3, 7);

        const ch = await detectChallenge(page);
        if (ch.challenged) { await shot(page, "linkedin-challenge"); return await halt(ch.why); }

        // Scroll like a reader so lazy-loaded cards actually render.
        for (let i = 0; i < 3; i++) {
          await page.mouse.wheel(0, rand(500, 1100));
          await pause(1, 3);
        }

        const people = await extractPeople(page);
        log(`  ${people.length} cards`);
        for (const p of people) {
          if (seen >= budget) break;
          seen++;
          if (leads[p.slug]) continue;
          leads[p.slug] = {
            ...p, source: q, foundAt: new Date().toISOString(),
            status: "new", score: null, notes: "",
          };
          added++;
        }
        await pause(s.minDelaySec, s.maxDelaySec);
      }
      return null;
    });
    if (result && result.halted) return result;
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 300), added };
  }

  write("leads", leads);
  counters[`linkedin-${today()}`] = usedToday + seen;
  write("counters", counters);
  log(`sweep done: +${added} new, ${seen} seen`);
  return { ok: true, added, seen, total: Object.keys(leads).length };
}

// Open one profile for detail. Higher risk per action than reading search
// results, so it is never part of the 24/7 loop — only an explicit request.
export async function viewProfile(slugOrUrl) {
  const gate = mayAct("linkedin");
  if (!gate.ok) return { ok: false, why: gate.why };
  const url = /^https?:/.test(slugOrUrl) ? slugOrUrl : `https://www.linkedin.com/in/${slugOrUrl}/`;
  return withPage(PROFILE, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await pause(3, 6);
    const ch = await detectChallenge(page);
    if (ch.challenged) return halt(ch.why);
    const text = await page.locator("main").innerText().catch(() => "");
    return { ok: true, url, text: text.replace(/\s*\n\s*/g, "\n").slice(0, 6000) };
  });
}

export const allLeads = () => read("leads", {});
export function setLead(slug, patch) {
  const leads = read("leads", {});
  if (!leads[slug]) return null;
  leads[slug] = { ...leads[slug], ...patch };
  write("leads", leads);
  return leads[slug];
}

// CLI: node engines/linkedin.mjs login | sweep | view <slug>
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("linkedin.mjs")) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = {
    login: () => login(),
    sweep: () => sweep({ queries: rest.length ? [rest.join(" ")] : null }),
    view: () => viewProfile(rest[0]),
    leads: async () => ({ ok: true, count: Object.keys(allLeads()).length, leads: Object.values(allLeads()).slice(-10) }),
  }[cmd || "sweep"];
  if (!run) { console.log("usage: linkedin.mjs [login|sweep|view <slug>|leads]"); process.exit(1); }
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r?.ok ? 0 : 1); })
       .catch((e) => { console.error(e); process.exit(1); });
}
