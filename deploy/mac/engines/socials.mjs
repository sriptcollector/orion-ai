// Socials engine — posts to X, LinkedIn, Threads, Instagram and Facebook by
// driving a real logged-in browser session, headlessly.
//
// Why a browser and not APIs: X's API is paid and rate-limited, Instagram's
// requires a Business account plus app review, and Threads had no public
// posting API worth the integration. Driving the logged-in session is what
// actually works today for all five from one machine.
//
// Design rule: every platform's fragile parts — URLs and selectors — live in
// the PLATFORMS table below and nowhere else. When a site redesigns (they all
// will), the fix is editing a selector string here, not rewriting the engine.
// Each selector is a LIST tried in order, so a redesign usually degrades to the
// next fallback instead of breaking outright.
//
// Nothing here posts on its own. Callers draft into the approval queue; bot.mjs
// calls post() only after a human taps approve.
import { withPage, open, hasProfile, detectChallenge, pause, typeHuman, shot, sleep } from "../lib/browser.mjs";
import { mayAct } from "../lib/settings.mjs";
import { logger } from "../lib/log.mjs";
import { alertOnce } from "../lib/relay.mjs";

const log = logger("socials");

// first(page, [selectors]) -> the first one that actually appears, or null.
async function first(page, selectors, { timeout = 8000, state = "visible" } = {}) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state, timeout: timeout / selectors.length });
      return el;
    } catch {}
  }
  return null;
}

export const PLATFORMS = {
  x: {
    label: "X / Twitter",
    home: "https://x.com/home",
    loginUrl: "https://x.com/login",
    loggedIn: /x\.com\/home/,
    limit: 280,
    compose: "https://x.com/compose/post",
    editor: ['div[data-testid="tweetTextarea_0"]', 'div[role="textbox"][contenteditable="true"]'],
    submit: ['button[data-testid="tweetButton"]', 'button[data-testid="tweetButtonInline"]'],
    confirm: ['a[href*="/status/"]', 'div[data-testid="toast"]'],
  },
  linkedin: {
    label: "LinkedIn",
    // Same saved session the scraper uses. One LinkedIn login, not two.
    profile: "linkedin",
    home: "https://www.linkedin.com/feed/",
    loginUrl: "https://www.linkedin.com/login",
    loggedIn: /linkedin\.com\/feed/,
    limit: 3000,
    openComposer: ['button.share-box-feed-entry__trigger', 'button[aria-label*="Start a post"]', 'div.share-box-feed-entry__top-bar button'],
    editor: ['div.ql-editor[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
    submit: ['button.share-actions__primary-action', 'button[aria-label="Post"]', 'button:has-text("Post")'],
    confirm: ['div[data-test-toast-message]', 'div.artdeco-toast-item'],
  },
  threads: {
    label: "Threads",
    home: "https://www.threads.net/",
    loginUrl: "https://www.threads.net/login",
    loggedIn: /threads\.(net|com)\/(\?|$|@)/,
    limit: 500,
    openComposer: ['div[role="button"]:has-text("What\'s new")', 'svg[aria-label="Create"]'],
    editor: ['div[contenteditable="true"][role="textbox"]', 'textarea'],
    submit: ['div[role="button"]:has-text("Post")', 'button:has-text("Post")'],
    confirm: ['div[role="alert"]'],
  },
  facebook: {
    label: "Facebook",
    home: "https://www.facebook.com/",
    loginUrl: "https://www.facebook.com/login",
    loggedIn: /facebook\.com\/(\?|$)/,
    limit: 5000,
    openComposer: ['div[role="button"]:has-text("What\'s on your mind")', 'span:has-text("What\'s on your mind")'],
    editor: ['div[contenteditable="true"][role="textbox"]'],
    submit: ['div[aria-label="Post"][role="button"]', 'button:has-text("Post")'],
    confirm: ['div[role="alert"]'],
  },
  instagram: {
    label: "Instagram",
    home: "https://www.instagram.com/",
    loginUrl: "https://www.instagram.com/accounts/login/",
    loggedIn: /instagram\.com\/(\?|$)/,
    limit: 2200,
    needsImage: true,          // IG web will not accept a text-only post
    openComposer: ['svg[aria-label="New post"]', 'a[href="#"]:has(svg[aria-label="New post"])'],
    fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    next: ['div[role="button"]:has-text("Next")', 'button:has-text("Next")'],
    editor: ['div[contenteditable="true"][role="textbox"]', 'textarea[aria-label*="caption"]'],
    submit: ['div[role="button"]:has-text("Share")', 'button:has-text("Share")'],
    confirm: ['img[alt*="shared"]', 'div:has-text("Your post has been shared")'],
  },
};

export const platformNames = () => Object.keys(PLATFORMS);
// Most platforms get their own profile; a platform may name a shared one.
const profileOf = (name) => PLATFORMS[name]?.profile || `social-${name}`;
export const isLoggedIn = (name) => hasProfile(profileOf(name));

// One-time interactive login per platform. Opens a real window and waits for a
// human to sign in. No social password is ever handled by this code.
export async function login(name, { waitMinutes = 6 } = {}) {
  const p = PLATFORMS[name];
  if (!p) return { ok: false, why: `Unknown platform "${name}". Known: ${platformNames().join(", ")}` };
  const { page, close } = await open(profileOf(name), { headed: true, timeout: waitMinutes * 60000 });
  try {
    await page.goto(p.loginUrl, { waitUntil: "domcontentloaded" });
    log(name, "waiting for human login");
    await page.waitForURL(p.loggedIn, { timeout: waitMinutes * 60000 });
    await pause(2, 4);
    log(name, "login confirmed");
    return { ok: true, platform: name };
  } catch {
    return { ok: false, why: `Did not reach a logged-in ${p.label} page within ${waitMinutes} minutes. Try again.` };
  } finally { await close(); }
}

// Is the saved session still alive? Run this before trusting a schedule — an
// expired cookie otherwise shows up as posts that silently never happen.
export async function checkSession(name) {
  const p = PLATFORMS[name];
  if (!p) return { ok: false, why: "unknown platform" };
  if (!isLoggedIn(name)) return { ok: false, why: "never logged in" };
  try {
    return await withPage(profileOf(name), async (page) => {
      await page.goto(p.home, { waitUntil: "domcontentloaded" });
      await pause(2, 4);
      const ch = await detectChallenge(page);
      if (ch.challenged) return { ok: false, why: `session expired or challenged (${ch.why})` };
      return { ok: true, url: page.url() };
    });
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 200) }; }
}

/**
 * Post text (and optionally an image) to one platform.
 * Returns { ok, platform, url?, screenshot?, why? }.
 */
export async function post(name, text, { imagePath = null, dryRun = false } = {}) {
  const p = PLATFORMS[name];
  if (!p) return { ok: false, why: `Unknown platform "${name}"` };

  // Validate the content FIRST. These checks are free and deterministic, and a
  // draft that is too long is too long whether or not a session happens to be
  // alive — reporting "not logged in" for it sends someone down the wrong path.
  const body = String(text || "").trim();
  if (!body) return { ok: false, why: "empty post" };
  if (body.length > p.limit) return { ok: false, why: `${p.label} allows ${p.limit} characters; this is ${body.length}.` };
  if (p.needsImage && !imagePath) return { ok: false, why: `${p.label} cannot post text alone. Attach an image.` };
  if (dryRun) return { ok: true, platform: name, dryRun: true, preview: body };

  const gate = mayAct("socials");
  if (!gate.ok) return { ok: false, why: gate.why };
  if (!isLoggedIn(name)) return { ok: false, why: `Not logged in to ${p.label}. Run:  node engines/socials.mjs login ${name}` };

  try {
    return await withPage(profileOf(name), async (page) => {
      await page.goto(p.compose || p.home, { waitUntil: "domcontentloaded" });
      await pause(3, 6);

      const ch = await detectChallenge(page);
      if (ch.challenged) {
        const png = await shot(page, `${name}-challenge`);
        await alertOnce(`social-${name}-challenge`,
          `${p.label} posting blocked: ${ch.why}\n\nThe saved login has probably expired. Re-run:  node engines/socials.mjs login ${name}`);
        return { ok: false, why: `${p.label} showed a login/challenge screen. Session needs re-login.`, screenshot: png };
      }

      // Open the composer, where the platform has one.
      if (p.openComposer) {
        const trigger = await first(page, p.openComposer, { timeout: 12000 });
        if (!trigger) return { ok: false, why: `Could not find the ${p.label} composer button. The site layout likely changed - selectors need updating.` };
        await trigger.click();
        await pause(1, 3);
      }

      // Image first: Instagram gates the caption behind the upload flow.
      if (imagePath) {
        const input = await first(page, p.fileInput || ['input[type="file"]'], { timeout: 12000, state: "attached" });
        if (!input) return { ok: false, why: `Could not find the ${p.label} image upload input.` };
        await input.setInputFiles(imagePath);
        await pause(3, 6);
        for (const step of [1, 2]) {                     // IG: Crop -> Filters -> Caption
          const next = p.next ? await first(page, p.next, { timeout: 6000 }) : null;
          if (!next) break;
          await next.click();
          await pause(2, 4);
        }
      }

      const editor = await first(page, p.editor, { timeout: 15000 });
      if (!editor) return { ok: false, why: `Could not find the ${p.label} text editor. The site layout likely changed.` };
      // Type rather than fill: these are all contenteditable editors that ignore
      // a programmatic value set and leave the Post button disabled.
      await typeHuman(page, editor, body);
      await pause(1, 3);

      const submit = await first(page, p.submit, { timeout: 12000 });
      if (!submit) return { ok: false, why: `Could not find the ${p.label} post button.` };
      if (await submit.isDisabled().catch(() => false)) {
        return { ok: false, why: `${p.label} left the post button disabled - the text may not have registered.`, screenshot: await shot(page, `${name}-disabled`) };
      }
      await submit.click();

      // Confirm rather than assume. A click that opened an error toast is not a
      // post, and reporting it as one is how a client loses trust in the system.
      await sleep(4000);
      const confirmed = p.confirm ? await first(page, p.confirm, { timeout: 8000 }) : null;
      const png = await shot(page, `${name}-posted`);
      const composerGone = !(await first(page, p.editor, { timeout: 3000 }));

      if (!confirmed && !composerGone) {
        return { ok: false, why: `${p.label} did not confirm the post. Check the screenshot before retrying - it may have posted anyway.`, screenshot: png };
      }
      log(name, "posted", JSON.stringify(body.slice(0, 60)));
      return { ok: true, platform: name, url: page.url(), screenshot: png };
    });
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 300) };
  }
}

// CLI: node engines/socials.mjs login x | check x | post x "text" [image]
if (process.argv[1]?.endsWith("socials.mjs")) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const run = {
    login: () => login(name),
    check: () => (name ? checkSession(name) : Promise.all(platformNames().map(async (n) => ({ n, ...(await checkSession(n)) })))),
    post: () => post(name, rest[0], { imagePath: rest[1] || null }),
    list: async () => ({ ok: true, platforms: platformNames().map((n) => ({ n, loggedIn: isLoggedIn(n) })) }),
  }[cmd || "list"];
  if (!run) { console.log("usage: socials.mjs [login <p>|check [p]|post <p> \"text\" [image]|list]"); process.exit(1); }
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r?.ok === false ? 1 : 0); })
       .catch((e) => { console.error(e); process.exit(1); });
}
