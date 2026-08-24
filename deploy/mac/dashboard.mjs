#!/usr/bin/env node
// The dashboard. Status board AND the whole setup process, in a browser, so the
// client can onboard from their own laptop instead of sitting at the Mac Mini.
//
// This replaces the part of setup that used to need physical presence. The old
// flow opened a browser window on the Mac and asked someone to log in there —
// which needs a screen, a keyboard, and their 2FA device, all in the same room.
// Here they paste cookies exported from the computer they are already logged in
// on, and the headless profile picks the session up.
//
// Security, because this writes config and lists which accounts are connected:
//   - loopback only unless STATUS_BIND says otherwise; exposed means the
//     tailnet, which is a private network, not the public internet
//   - a token is ALWAYS required for any write, even on loopback
//   - no password is ever asked for, sent, or stored — cookies only
//   - the token never appears in a page the browser could leak via Referer;
//     it is held in sessionStorage after the first load
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { loadEnv, setEnv } from "./lib/env.mjs";
import { logger } from "./lib/log.mjs";
import { board, renderText } from "./lib/services.mjs";
import { PLATFORMS as COOKIE_PLATFORMS, importCookies, clearCookies } from "./lib/cookies.mjs";

loadEnv();
const log = logger("dashboard");
const PORT = Number(process.env.STATUS_PORT || 8791);
const BIND = process.env.STATUS_BIND || "127.0.0.1";
const EXPOSED = BIND !== "127.0.0.1" && BIND !== "localhost";

let TOKEN = process.env.STATUS_TOKEN || "";
if (!TOKEN) {
  TOKEN = crypto.randomBytes(16).toString("hex");
  setEnv("STATUS_TOKEN", TOKEN);
  log("generated STATUS_TOKEN (saved to .env)");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLOR = { up: "#3fb950", warn: "#d29922", down: "#f85149", off: "#6e7681" };

// Constant-time, length-safe. Hashing both sides fixes the compared length, so
// a token that merely starts with the right characters is rejected.
function tokenOk(given) {
  if (!given) return false;
  const d = (v) => crypto.createHash("sha256").update(String(v)).digest();
  return crypto.timingSafeEqual(d(given), d(TOKEN));
}

// The keys a client can set from here. Deliberately not every key in .env —
// only the ones onboarding needs. Secrets are never echoed back to the page.
const KEYS = [
  { key: "CLIENT_NAME", label: "Your name or business", hint: "shows up in Telegram" },
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "from @BotFather: /newbot", secret: true },
  { key: "TELEGRAM_ALLOWED_USER_IDS", label: "Your Telegram user ID", hint: "@userinfobot tells you the number" },
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API key", hint: "platform.deepseek.com", secret: true },
  { key: "REDDIT_CLIENT_ID", label: "Reddit app ID", hint: "optional — reddit.com/prefs/apps, type 'script'" },
  { key: "REDDIT_CLIENT_SECRET", label: "Reddit app secret", hint: "optional", secret: true },
  { key: "REDDIT_USERNAME", label: "Reddit username", hint: "optional" },
  { key: "REDDIT_PASSWORD", label: "Reddit password", hint: "optional — account must not have 2FA", secret: true },
];

const STYLE = `
:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8b949e;--card:#161b22;--line:#30363d;--acc:#58a6ff;--ok:#3fb950}
@media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#1f2328;--dim:#59636e;--card:#f6f8fa;--line:#d1d9e0;--acc:#0969da}}
*{box-sizing:border-box}
body{margin:0;padding:22px 16px 60px;background:var(--bg);color:var(--fg);
     font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:660px;margin:0 auto}
h1{font-size:21px;margin:0 0 3px}
.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
nav{display:flex;gap:6px;margin-bottom:22px;flex-wrap:wrap}
nav a{padding:6px 13px;border-radius:99px;border:1px solid var(--line);color:var(--fg);
      text-decoration:none;font-size:13px}
nav a.on{background:var(--acc);border-color:var(--acc);color:#fff}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:24px 0 9px;font-weight:600}
.row{display:flex;gap:12px;align-items:flex-start;background:var(--card);border:1px solid var(--line);
     border-radius:9px;padding:11px 13px;margin-bottom:7px}
.dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:6px}
.body{min-width:0;flex:1}
.label{font-weight:600}
.label a{color:inherit}
.detail{color:var(--dim);font-size:13px;word-wrap:break-word}
.tally{display:flex;gap:14px;margin:0 0 20px;font-size:13px;color:var(--dim);flex-wrap:wrap}
.tally b{color:var(--fg)}
form{margin:0}
input,textarea,select{width:100%;padding:9px 11px;border-radius:7px;border:1px solid var(--line);
     background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
textarea{min-height:120px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
button{padding:9px 16px;border-radius:7px;border:0;background:var(--acc);color:#fff;
       font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
.field{margin-bottom:14px}
.field label{display:block;font-weight:600;font-size:14px;margin-bottom:4px}
.field .hint{color:var(--dim);font-size:12px;margin-bottom:6px}
.set{color:var(--ok);font-size:12px}
.step{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.step h3{margin:0 0 4px;font-size:16px}
.step .n{display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:50%;
         background:var(--acc);color:#fff;font-size:12px;font-weight:700;margin-right:7px}
.step.done .n{background:var(--ok)}
.msg{padding:10px 13px;border-radius:8px;margin-bottom:14px;font-size:14px}
.msg.ok{background:rgba(63,185,80,.14);border:1px solid rgba(63,185,80,.4)}
.msg.err{background:rgba(248,81,73,.14);border:1px solid rgba(248,81,73,.4)}
ol{padding-left:20px}ol li{margin-bottom:5px}
code{background:var(--card);padding:1px 5px;border-radius:4px;font-size:12px;border:1px solid var(--line)}
footer{margin-top:30px;color:var(--dim);font-size:12px;text-align:center}
`;

const page = (title, nav, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap">
${body}
<footer>${esc(new Date().toLocaleString())}</footer>
</div>
<script>
// Keep the token out of every link on the page: stash it once, then attach it
// to fetches and navigations from script instead of writing it into HTML.
(function(){
  var u=new URL(location.href), t=u.searchParams.get("t");
  if(t){sessionStorage.setItem("orion_t",t);}
  else{t=sessionStorage.getItem("orion_t");}
  window.T=t||"";
  document.querySelectorAll("a[data-to]").forEach(function(a){
    a.href=a.dataset.to+(window.T?"?t="+encodeURIComponent(window.T):"");
  });
  document.querySelectorAll("form[data-post]").forEach(function(f){
    f.addEventListener("submit",function(e){
      e.preventDefault();
      var btn=f.querySelector("button"); if(btn){btn.disabled=true;btn.textContent="Working…";}
      var fd=new FormData(f), o={};
      fd.forEach(function(v,k){o[k]=v;});
      fetch(f.dataset.post+"?t="+encodeURIComponent(window.T),{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(o)
      }).then(function(r){return r.json();}).then(function(j){
        location.href=f.dataset.back+"?t="+encodeURIComponent(window.T)+
          "&m="+encodeURIComponent(j.ok?(j.message||"Saved"):(j.why||"Failed"))+"&k="+(j.ok?"ok":"err");
      }).catch(function(err){
        if(btn){btn.disabled=false;btn.textContent="Try again";}
        alert("Request failed: "+err.message);
      });
    });
  });
})();
</script></body></html>`;

const navBar = (active) => `<nav>
  <a data-to="/" class="${active === "status" ? "on" : ""}">Status</a>
  <a data-to="/setup" class="${active === "setup" ? "on" : ""}">Setup</a>
  <a data-to="/accounts" class="${active === "accounts" ? "on" : ""}">Accounts</a>
  <a data-to="/keys" class="${active === "keys" ? "on" : ""}">Keys</a>
</nav>`;

const banner = (q) => {
  const m = q.get("m");
  return m ? `<div class="msg ${q.get("k") === "ok" ? "ok" : "err"}">${esc(m)}</div>` : "";
};

// ------------------------------------------------------------------ pages

async function pageStatus(q) {
  const b = await board();
  const groups = [...new Set(b.rows.map((r) => r.group))];
  const cards = groups.map((g) => `<h2>${esc(g)}</h2>` + b.rows.filter((r) => r.group === g).map((r) => `
    <div class="row"><span class="dot" style="background:${COLOR[r.state]}"></span><div class="body">
      <div class="label">${r.url && r.state !== "off" ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.label)}</a>` : esc(r.label)}</div>
      <div class="detail">${esc(r.detail)}</div></div></div>`).join("")).join("");
  return page(`${b.client} — status`, "status", `
    <h1>${esc(b.client)}</h1>
    <div class="sub">${esc(b.host)} · ${b.paused ? "paused" : "running"} · active ${b.activeHours[0]}:00–${b.activeHours[1]}:00</div>
    ${navBar("status")}${banner(q)}
    <div class="tally"><span><b>${b.counts.up}</b> up</span><span><b>${b.counts.warn}</b> need attention</span>
      <span><b>${b.counts.down}</b> down</span><span><b>${b.pending}</b> awaiting approval</span></div>
    ${cards}`);
}

async function pageSetup(q) {
  const b = await board();
  const has = (id, ok) => b.rows.find((r) => r.id === id)?.state === (ok || "up");
  const connected = Object.keys(COOKIE_PLATFORMS).filter((p) => {
    const row = b.rows.find((r) => r.id === (p === "linkedin" ? "linkedin" : `social-${p}`));
    return row && row.state !== "off";
  });
  const step = (n, title, done, body) => `<div class="step ${done ? "done" : ""}">
    <h3><span class="n">${done ? "✓" : n}</span>${esc(title)}</h3>${body}</div>`;

  return page("Setup", "setup", `
    <h1>Setup</h1>
    <div class="sub">Four steps. You can do all of this from this computer.</div>
    ${navBar("setup")}${banner(q)}
    ${step(1, "Keys", has("telegram") && has("chatbot"), `
      <p class="detail">Telegram and DeepSeek. Without these nothing can reach you or write anything.</p>
      <p><a data-to="/keys"><button type="button">Open keys</button></a></p>`)}
    ${step(2, "Connect your accounts", connected.length > 0, `
      <p class="detail">No passwords. You export cookies from the browser you're already
      logged in on, and paste them here.${connected.length ? ` <b>${connected.length} connected.</b>` : ""}</p>
      <p><a data-to="/accounts"><button type="button">Connect accounts</button></a></p>`)}
    ${step(3, "Tell it about your business", has("chatbot"), `
      <p class="detail">Every message and post is written against this. Two vague sentences
      produce generic drafts nobody replies to.</p>
      <form data-post="/api/brief" data-back="/setup">
        <div class="field"><textarea name="brief" placeholder="We do fractional ops for 20-60 person logistics companies. Most clients come to us drowning in spreadsheets after a growth spurt. Cheaper than a full-time ops hire, usually done in 90 days. We don't do software."></textarea></div>
        <button>Save</button>
      </form>`)}
    ${step(4, "Check it", has("jobs"), `
      <p class="detail">The status page shows every system green, amber or red, with the reason.</p>
      <p><a data-to="/"><button type="button">Open status</button></a></p>`)}
    <h2>What still needs the Mac itself</h2>
    <div class="row"><span class="dot" style="background:${COLOR.warn}"></span><div class="body">
      <div class="label">iMessage permissions and WhatsApp</div>
      <div class="detail">macOS Full Disk Access and Automation are system prompts someone has to
      click on the Mac, and WhatsApp Web needs a QR scan from your phone. Everything else on this
      page works from here.</div></div></div>`);
}

async function pageAccounts(q) {
  const b = await board();
  const rows = Object.entries(COOKIE_PLATFORMS).map(([id, p]) => {
    const rowId = id === "linkedin" ? "linkedin" : `social-${id}`;
    const st = b.rows.find((r) => r.id === rowId);
    const on = st && st.state !== "off";
    return `<div class="row"><span class="dot" style="background:${on ? COLOR.up : COLOR.off}"></span>
      <div class="body"><div class="label">${esc(p.label)}</div>
      <div class="detail">${on ? esc(st.detail) : "not connected"}</div></div>
      <a data-to="/connect/${id}"><button type="button" class="ghost">${on ? "Replace" : "Connect"}</button></a></div>`;
  }).join("");

  return page("Accounts", "accounts", `
    <h1>Accounts</h1>
    <div class="sub">Connect once from the computer you already use.</div>
    ${navBar("accounts")}${banner(q)}
    ${rows}
    <h2>How this works</h2>
    <div class="step"><p class="detail">You never give this app a password. You copy the session
    your own browser already has, and paste it in. That's why there's no login screen and no
    two-factor prompt — from the site's point of view, you're already signed in.</p></div>
    <h2>WhatsApp</h2>
    <div class="row"><span class="dot" style="background:${COLOR.off}"></span><div class="body">
      <div class="label">Needs a QR scan, not cookies</div>
      <div class="detail">WhatsApp Web doesn't keep its session in cookies, so it can't be pasted.
      On the Mac run <code>npm run login:whatsapp</code> and scan the code with your phone.</div>
    </div></div>`);
}

function pageConnect(id, q) {
  const p = COOKIE_PLATFORMS[id];
  if (!p) return page("Unknown", "accounts", `<h1>Unknown account</h1>${navBar("accounts")}`);
  return page(`Connect ${p.label}`, "accounts", `
    <h1>Connect ${esc(p.label)}</h1>
    <div class="sub">Takes about a minute.</div>
    ${navBar("accounts")}${banner(q)}
    <div class="step"><ol>
      <li>Install the free <b>Cookie-Editor</b> extension in your browser
          (<a href="https://cookie-editor.com/" target="_blank" rel="noreferrer">cookie-editor.com</a>).</li>
      <li>Open <b>${esc(p.domains[0])}</b> and make sure you're logged in.</li>
      <li>Click the Cookie-Editor icon, then <b>Export</b> → <b>Export as JSON</b>.
          It copies to your clipboard.</li>
      <li>Paste it below.</li>
    </ol>
    <p class="detail">${esc(p.help)}</p></div>
    <form data-post="/api/cookies" data-back="/accounts">
      <input type="hidden" name="platform" value="${esc(id)}">
      <div class="field">
        <label>Paste here</label>
        <div class="hint">Nothing is stored except the session itself. Your password never leaves your computer.</div>
        <textarea name="cookies" placeholder='[{"name":"...","value":"...","domain":"..."}]' required></textarea>
      </div>
      <button>Connect ${esc(p.label)}</button>
    </form>`);
}

function pageKeys(q) {
  const fields = KEYS.map((k) => {
    const cur = process.env[k.key] || "";
    return `<div class="field">
      <label>${esc(k.label)} ${cur ? `<span class="set">· set</span>` : ""}</label>
      <div class="hint">${esc(k.hint)}</div>
      <input name="${esc(k.key)}" type="${k.secret ? "password" : "text"}"
             placeholder="${cur ? (k.secret ? "•••••• (leave blank to keep)" : esc(cur)) : ""}"
             autocomplete="off">
    </div>`;
  }).join("");
  return page("Keys", "keys", `
    <h1>Keys</h1>
    <div class="sub">Leave a field blank to keep what's already there.</div>
    ${navBar("keys")}${banner(q)}
    <form data-post="/api/keys" data-back="/keys">${fields}<button>Save keys</button></form>`);
}

// -------------------------------------------------------------------- api

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error("too large");   // cookie dumps are small
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = "text/html; charset=utf-8") =>
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end(body);
  const json = (code, obj) => send(code, JSON.stringify(obj), "application/json");

  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/health") return send(200, "ok", "text/plain");

    const given = u.searchParams.get("t") || (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!tokenOk(given)) return send(401, "Unauthorized", "text/plain");

    if (req.method === "POST") {
      const body = await readBody(req);

      if (u.pathname === "/api/keys") {
        let n = 0;
        for (const k of KEYS) {
          const v = String(body[k.key] ?? "").trim();
          if (v) { setEnv(k.key, v); n++; }
        }
        log("keys updated:", n);
        return json(200, { ok: true, message: n ? `Saved ${n} key${n === 1 ? "" : "s"}. Restart the services for them to take effect.` : "Nothing changed." });
      }

      if (u.pathname === "/api/brief") {
        const text = String(body.brief || "").trim();
        if (text.length < 40) return json(200, { ok: false, why: "Too short to be useful — describe what you do, who you sell to, and what makes you different." });
        const { write } = await import("./lib/store.mjs");
        write("brief", { text, setAt: new Date().toISOString() });
        return json(200, { ok: true, message: "Saved. Every draft from now on uses it." });
      }

      if (u.pathname === "/api/cookies") {
        const r = await importCookies(String(body.platform || ""), String(body.cookies || ""));
        if (!r.ok) return json(200, { ok: false, why: r.why });
        const label = COOKIE_PLATFORMS[body.platform]?.label || body.platform;
        return json(200, { ok: true, message: `${label} connected${r.verified ? " and verified" : ""}.${r.warn ? " Note: " + r.warn + "." : ""}` });
      }

      if (u.pathname === "/api/disconnect") {
        const r = await clearCookies(String(body.platform || ""));
        return json(200, r.ok ? { ok: true, message: "Disconnected." } : { ok: false, why: r.why });
      }

      return json(404, { ok: false, why: "unknown endpoint" });
    }

    if (u.pathname === "/status.json") return send(200, JSON.stringify(await board(), null, 2), "application/json");
    if (u.pathname === "/status.txt") return send(200, renderText(await board()), "text/plain; charset=utf-8");
    if (u.pathname === "/") return send(200, await pageStatus(u.searchParams));
    if (u.pathname === "/setup") return send(200, await pageSetup(u.searchParams));
    if (u.pathname === "/accounts") return send(200, await pageAccounts(u.searchParams));
    if (u.pathname === "/keys") return send(200, pageKeys(u.searchParams));
    const m = u.pathname.match(/^\/connect\/([a-z]+)$/);
    if (m) return send(200, pageConnect(m[1], u.searchParams));
    return send(404, "Not found", "text/plain");
  } catch (e) {
    log("error", String(e.stack || e).slice(0, 300));
    return send(500, "Something went wrong", "text/plain");
  }
});

server.listen(PORT, BIND, () => {
  const host = BIND === "0.0.0.0" ? os.hostname() : BIND;
  const url = `http://${host}:${PORT}/setup?t=${TOKEN}`;
  log(`dashboard on ${url}`);
  console.log(`\n  Setup dashboard:\n  ${url}\n`);
  if (EXPOSED) console.log(`  Open that from any device on your Tailscale network.\n`);
  else console.log(`  Local only. To reach it from another device:  STATUS_BIND=0.0.0.0 npm run dashboard\n`);
});
