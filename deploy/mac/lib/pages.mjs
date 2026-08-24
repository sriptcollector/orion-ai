// The dashboard's control pages: approvals, messages, and the switches.
//
// Kept out of dashboard.mjs so that file stays what it is — an HTTP server with
// an auth gate — while the HTML lives here. The shared chrome (page shell, nav,
// escaping) is passed in rather than duplicated, so there is one look and one
// escaping function across every page.
import path from "node:path";
import fs from "node:fs";
import { DATA } from "./env.mjs";
import * as queue from "./queue.mjs";
import { getSettings } from "./settings.mjs";
import * as imessage from "../engines/imessage.mjs";
import * as linkedin from "../engines/linkedin.mjs";

const KIND = { imessage: "💬", whatsapp: "🟢", reddit: "👽", social: "📣" };

export function makePages({ page, navBar, banner, esc, COLOR }) {

  // Approvals — the same drafts and the same three choices as Telegram, so a
  // client never has to remember which surface a draft is waiting on.
  async function pageQueue(q) {
    const pending = queue.pending();
    const decided = queue.raw().items.filter((i) => i.status !== "pending").slice(-12).reverse();

    const parked = (i) => `
      <form data-post="/api/attach" data-back="/queue">
        <input type="hidden" name="id" value="${esc(i.id)}">
        <div class="field"><label>Phone number to send this to</label>
        <input name="to" placeholder="+1 310 555 1212" required></div>
        <button>Attach number</button>
      </form>`;

    const actions = (i) => `
      <div class="btnrow">
        <form data-post="/api/approve" data-back="/queue"><input type="hidden" name="id" value="${esc(i.id)}"><button>Send</button></form>
        <form data-post="/api/redo" data-back="/queue"><input type="hidden" name="id" value="${esc(i.id)}"><button class="ghost">Rewrite</button></form>
        <form data-post="/api/skip" data-back="/queue"><input type="hidden" name="id" value="${esc(i.id)}"><button class="ghost">Skip</button></form>
      </div>`;

    const card = (i) => `
      <div class="step">
        <h3>${KIND[i.kind] || ""} ${esc(i.title)}</h3>
        <div class="detail">${esc(new Date(i.createdAt).toLocaleString())}${i.source ? " · " + esc(i.source) : ""}</div>
        <pre class="draft">${esc(i.preview)}</pre>
        ${(i.kind === "imessage" || i.kind === "whatsapp") && !i.payload.to ? parked(i) : actions(i)}
      </div>`;

    const history = decided.map((i) => `
      <div class="row">
        <span class="dot" style="background:${i.status === "sent" ? COLOR.up : i.status === "failed" ? COLOR.down : COLOR.off}"></span>
        <div class="body"><div class="label">${esc(i.status)} — ${esc(i.title)}</div>
        <div class="detail">${esc(String(i.result || "").slice(0, 140))}</div></div>
      </div>`).join("");

    return page("Approvals", "queue", `
      <h1>Approvals</h1>
      <div class="sub">Nothing here has been sent, and nothing will be until you say so.</div>
      ${navBar("queue")}${banner(q)}
      ${pending.length ? pending.map(card).join("") : `<div class="step"><p class="detail">Nothing waiting on you.</p></div>`}
      ${history ? `<h2>Recently decided</h2>${history}` : ""}`);
  }

  // Messages — what came in, and a composer that drafts before anything sends.
  async function pageMessages(q) {
    const r = await imessage.recent({ sinceMs: Date.now() - 7 * 86400000, limit: 60 });
    const threads = new Map();
    for (const m of r.messages || []) {
      if (!threads.has(m.from)) threads.set(m.from, []);
      threads.get(m.from).push(m);
    }
    const list = [...threads.entries()].slice(0, 15).map(([who, msgs]) => {
      const last = msgs[0];
      return `<div class="row">
        <span class="dot" style="background:${last.fromMe ? COLOR.off : COLOR.up}"></span>
        <div class="body"><div class="label">${esc(who)}</div>
        <div class="detail">${last.fromMe ? "you: " : ""}${esc(last.text.slice(0, 140))}</div></div>
        <form data-post="/api/reply" data-back="/queue">
          <input type="hidden" name="to" value="${esc(who)}">
          <button class="ghost">Draft reply</button></form>
      </div>`;
    }).join("");

    return page("Messages", "messages", `
      <h1>Messages</h1>
      <div class="sub">iMessage, from this Mac. Every draft goes to Approvals first.</div>
      ${navBar("messages")}${banner(q)}
      ${!r.ok ? `<div class="msg err">${esc(r.why)}</div>` : ""}
      <h2>New message</h2>
      <div class="step">
        <form data-post="/api/compose" data-back="/queue">
          <div class="field"><label>To</label>
            <div class="hint">A phone number, or an Apple ID email.</div>
            <input name="to" placeholder="+1 310 555 1212" required></div>
          <div class="field"><label>What do you want to get across?</label>
            <div class="hint">Plain English. It gets written properly, then waits for your approval.</div>
            <textarea name="angle" style="min-height:80px" placeholder="ask if they're still hiring ops people, mention we did the same for a 40-person logistics company" required></textarea></div>
          <button>Write it</button>
        </form>
      </div>
      <h2>Recent conversations</h2>
      ${list || `<div class="step"><p class="detail">Nothing in the last week.</p></div>`}`);
  }

  // Control — the switches, and the actions that used to need a terminal.
  async function pageControl(q) {
    const s = getSettings();
    const logs = ["scheduler", "bot", "linkedin", "socials", "reddit", "imessage", "dashboard"].map((n) => {
      const f = path.join(DATA, "logs", `${n}.log`);
      if (!fs.existsSync(f)) return "";
      const tail = fs.readFileSync(f, "utf8").trim().split("\n").slice(-5).join("\n");
      return `<h2>${esc(n)}</h2><pre class="draft">${esc(tail.slice(-1200))}</pre>`;
    }).join("");
    const searches = (linkedin.targets().linkedin?.searches || []).map((x) => "• " + esc(x)).join("<br>");

    return page("Control", "control", `
      <h1>Control</h1>
      <div class="sub">Everything here also works from Telegram.</div>
      ${navBar("control")}${banner(q)}

      <div class="step">
        <h3>${s.paused ? "Paused" : "Running"}</h3>
        <p class="detail">${s.paused ? "Every engine is stopped." : `Active ${s.activeHours[0]}:00–${s.activeHours[1]}:00.`}</p>
        <div class="btnrow">
          <form data-post="/api/pause" data-back="/control">
            <input type="hidden" name="paused" value="${s.paused ? "0" : "1"}">
            <button>${s.paused ? "Resume" : "Pause everything"}</button></form>
          <form data-post="/api/scrape" data-back="/control"><button class="ghost">Find leads now</button></form>
        </div>
      </div>

      <div class="step">
        <h3>Active hours</h3>
        <p class="detail">Outside these hours nothing acts. Local time on this Mac.</p>
        <form data-post="/api/hours" data-back="/control">
          <div class="field"><label>From</label><input name="from" type="number" min="0" max="23" value="${s.activeHours[0]}"></div>
          <div class="field"><label>Until</label><input name="to" type="number" min="1" max="24" value="${s.activeHours[1]}"></div>
          <button>Save hours</button>
        </form>
      </div>

      <div class="step">
        <h3>Who to look for</h3>
        <p class="detail">The LinkedIn searches the 24/7 sweep rotates through.</p>
        <p class="detail">${searches || "none yet"}</p>
        <form data-post="/api/target" data-back="/control">
          <div class="field"><input name="search" placeholder="head of operations logistics" required></div>
          <button>Add search</button>
        </form>
      </div>

      <h2>Recent activity</h2>
      ${logs || `<div class="step"><p class="detail">No logs yet.</p></div>`}`);
  }

  return { pageQueue, pageMessages, pageControl };
}
