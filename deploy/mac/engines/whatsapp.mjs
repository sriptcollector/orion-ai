// WhatsApp engine — drives WhatsApp Web in a saved browser session.
//
// There is no usable API here without a Meta Business account and template
// approval, so this is the browser. The client scans the QR code once with
// their phone and the session persists in the profile on disk.
//
// Same rule as everything else outbound: this never sends on its own. Drafts go
// into the approval queue and bot.mjs calls send() after a human taps.
//
// The session is more fragile than the others — WhatsApp Web logs out if the
// phone is offline for a long stretch — so checkSession() is what the status
// board and the scheduler lean on, and it reports honestly rather than
// pretending a stale profile is a live login.
import { withPage, open, hasProfile, pause, typeHuman, shot, sleep } from "../lib/browser.mjs";
import { mayAct } from "../lib/settings.mjs";
import { logger } from "../lib/log.mjs";
import { alertOnce } from "../lib/relay.mjs";

const log = logger("whatsapp");
const PROFILE = "whatsapp";
const HOME = "https://web.whatsapp.com/";

// Selectors, in one place, each a list tried in order — same convention as the
// socials engine, because WhatsApp Web redesigns as often as any of them.
const SEL = {
  loggedIn: ['div[data-testid="chat-list"]', '#pane-side', 'div[aria-label="Chat list"]'],
  qr: ['canvas[aria-label*="scan"]', 'div[data-testid="qrcode"]', 'canvas'],
  composer: ['div[data-testid="conversation-compose-box-input"]', 'footer div[contenteditable="true"]', 'div[contenteditable="true"][data-tab]'],
  send: ['button[data-testid="compose-btn-send"]', 'span[data-testid="send"]', 'button[aria-label="Send"]'],
  invalid: ['div[data-testid="popup-contents"]', 'div[role="dialog"]'],
};

async function first(page, selectors, { timeout = 8000 } = {}) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: "visible", timeout: Math.max(1500, timeout / selectors.length) });
      return el;
    } catch {}
  }
  return null;
}

export const isLoggedIn = () => hasProfile(PROFILE);

// Only digits, with country code. WhatsApp's deep link silently shows a "phone
// number shared via url is invalid" dialog for anything else, which would
// otherwise look to us like a successful send.
export function normalize(raw) {
  const d = String(raw || "").replace(/[^\d]/g, "");
  if (/^\d{10}$/.test(d)) return { ok: true, id: "1" + d };          // assume US
  if (/^\d{11,15}$/.test(d)) return { ok: true, id: d };
  return { ok: false, why: `"${raw}" is not a valid WhatsApp number (include the country code)` };
}

/** One-time login: opens a window showing the QR code for the client to scan. */
export async function login({ waitMinutes = 5 } = {}) {
  const { page, close } = await open(PROFILE, { headed: true, timeout: waitMinutes * 60000 });
  try {
    await page.goto(HOME, { waitUntil: "domcontentloaded" });
    log("waiting for QR scan");
    const chat = await first(page, SEL.loggedIn, { timeout: waitMinutes * 60000 });
    if (!chat) return { ok: false, why: `No chat list appeared within ${waitMinutes} minutes. Scan the QR code with WhatsApp on the phone (Settings > Linked devices).` };
    await pause(2, 4);
    log("login confirmed");
    return { ok: true };
  } finally { await close(); }
}

/** Is the saved session actually alive right now? */
export async function checkSession() {
  if (!isLoggedIn()) return { ok: false, why: "never linked" };
  try {
    return await withPage(PROFILE, async (page) => {
      await page.goto(HOME, { waitUntil: "domcontentloaded" });
      await pause(4, 7);                                  // WhatsApp Web boots slowly
      if (await first(page, SEL.loggedIn, { timeout: 15000 })) return { ok: true };
      if (await first(page, SEL.qr, { timeout: 3000 })) {
        return { ok: false, why: "logged out - showing the QR code again. Re-link the phone." };
      }
      return { ok: false, why: "could not confirm the session" };
    });
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 160) }; }
}

/** Send one message. Called only from bot.mjs, after approval. */
export async function send(recipient, body, { dryRun = false } = {}) {
  const n = normalize(recipient);
  if (!n.ok) return { ok: false, why: n.why };
  const text = String(body || "").trim();
  if (!text) return { ok: false, why: "empty message" };
  if (dryRun) return { ok: true, dryRun: true, to: n.id, preview: text };

  const gate = mayAct("whatsapp");
  if (!gate.ok) return { ok: false, why: gate.why };
  if (!isLoggedIn()) return { ok: false, why: "WhatsApp is not linked. Run:  node engines/whatsapp.mjs login" };

  try {
    return await withPage(PROFILE, async (page) => {
      // Deep-link straight into the conversation. Typing the body ourselves
      // rather than passing &text= keeps one code path with the socials engine
      // and avoids URL-length limits on longer messages.
      await page.goto(`${HOME}send?phone=${n.id}`, { waitUntil: "domcontentloaded" });
      await pause(5, 9);

      if (await first(page, SEL.qr, { timeout: 3000 })) {
        await alertOnce("whatsapp-loggedout", "WhatsApp Web is logged out. Re-link the phone:  node engines/whatsapp.mjs login");
        return { ok: false, why: "WhatsApp Web is logged out. Re-link the phone." };
      }

      const composer = await first(page, SEL.composer, { timeout: 25000 });
      if (!composer) {
        const png = await shot(page, "whatsapp-nocomposer");
        return { ok: false, why: `WhatsApp did not open a chat for +${n.id}. The number may not be on WhatsApp.`, screenshot: png };
      }

      await typeHuman(page, composer, text);
      await pause(1, 2);

      const btn = await first(page, SEL.send, { timeout: 8000 });
      if (btn) await btn.click();
      else await page.keyboard.press("Enter");            // the composer accepts Enter

      await sleep(3500);
      const png = await shot(page, "whatsapp-sent");
      // The composer emptying is the reliable signal that it went; a "sent"
      // tick can lag for seconds on a slow link.
      const stillTyped = await composer.innerText().catch(() => "");
      if (stillTyped && stillTyped.trim().length > 2) {
        return { ok: false, why: "the message stayed in the box - it probably did not send", screenshot: png };
      }
      log("sent", n.id, JSON.stringify(text.slice(0, 60)));
      return { ok: true, to: n.id, screenshot: png };
    });
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 300) };
  }
}

if (process.argv[1]?.endsWith("whatsapp.mjs")) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = {
    login: () => login(),
    check: () => checkSession(),
    send: () => send(rest[0], rest[1], { dryRun: rest[2] !== "--send" }),
  }[cmd || "check"];
  if (!run) { console.log('usage: whatsapp.mjs [login|check|send <number> "text" [--send]]'); process.exit(1); }
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r?.ok === false ? 1 : 0); })
       .catch((e) => { console.error(e); process.exit(1); });
}
