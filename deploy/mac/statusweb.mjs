#!/usr/bin/env node
// The remote status page. Serves the same board the terminal and Telegram show,
// as a web page, so Orion or the client can open it from a phone anywhere on
// the tailnet and see what this Mac is doing.
//
// Security, because this is a page about someone's business that lists which of
// their accounts are logged in:
//   - binds to 127.0.0.1 by default. Set STATUS_BIND=0.0.0.0 to expose it, and
//     then it is reachable over Tailscale (a private network) — NOT the public
//     internet, unless someone deliberately port-forwards it.
//   - requires a token once exposed. Generated on first run if unset, and
//     refuses to bind to a non-loopback address without one.
//   - read-only. There is no control surface here on purpose; control lives in
//     Telegram, where the allowlist and the approval queue already are.
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { loadEnv, setEnv } from "./lib/env.mjs";
import { logger } from "./lib/log.mjs";
import { board, ICON } from "./lib/services.mjs";

loadEnv();
const log = logger("statusweb");
const PORT = Number(process.env.STATUS_PORT || 8791);
const BIND = process.env.STATUS_BIND || "127.0.0.1";
const EXPOSED = BIND !== "127.0.0.1" && BIND !== "localhost";

let TOKEN = process.env.STATUS_TOKEN || "";
if (EXPOSED && !TOKEN) {
  TOKEN = crypto.randomBytes(16).toString("hex");
  setEnv("STATUS_TOKEN", TOKEN);
  log("generated STATUS_TOKEN (saved to .env)");
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const COLOR = { up: "#3fb950", warn: "#d29922", down: "#f85149", off: "#6e7681" };

function page(b) {
  const groups = [...new Set(b.rows.map((r) => r.group))];
  const cards = groups.map((g) => `
    <section>
      <h2>${esc(g)}</h2>
      ${b.rows.filter((r) => r.group === g).map((r) => `
        <div class="row">
          <span class="dot" style="background:${COLOR[r.state]}" title="${esc(r.state)}"></span>
          <div class="body">
            <div class="label">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.label)}</a>` : esc(r.label)}</div>
            <div class="detail">${esc(r.detail)}</div>
          </div>
        </div>`).join("")}
    </section>`).join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(b.client)} — status</title>
<style>
  :root{--bg:#0d1117;--fg:#e6edf3;--dim:#8b949e;--card:#161b22;--line:#30363d}
  @media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#1f2328;--dim:#59636e;--card:#f6f8fa;--line:#d1d9e0}}
  *{box-sizing:border-box}
  body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--fg);
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{max-width:620px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:20px}
  .tally{display:flex;gap:14px;margin:0 0 22px;font-size:13px;color:var(--dim);flex-wrap:wrap}
  .tally b{color:var(--fg)}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
     margin:22px 0 8px;font-weight:600}
  .row{display:flex;gap:12px;align-items:flex-start;background:var(--card);
       border:1px solid var(--line);border-radius:8px;padding:11px 13px;margin-bottom:7px}
  .dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:6px}
  .body{min-width:0}
  .label{font-weight:600}
  .label a{color:inherit}
  .detail{color:var(--dim);font-size:13px;word-wrap:break-word}
  footer{margin-top:28px;color:var(--dim);font-size:12px;text-align:center}
</style></head><body><div class="wrap">
  <h1>${esc(b.client)}</h1>
  <div class="sub">${esc(b.host)} · ${b.paused ? "PAUSED" : "running"} · active ${b.activeHours[0]}:00–${b.activeHours[1]}:00</div>
  <div class="tally">
    <span><b>${b.counts.up}</b> up</span><span><b>${b.counts.warn}</b> need attention</span>
    <span><b>${b.counts.down}</b> down</span><span><b>${b.pending}</b> awaiting approval</span>
  </div>
  ${cards}
  <footer>updated ${esc(new Date(b.at).toLocaleString())} · refreshes every 30s</footer>
</div>
<script>setTimeout(()=>location.reload(),30000)</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = "text/html; charset=utf-8") =>
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(body);
  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/health") return send(200, "ok", "text/plain");

    // Constant-time compare so the token can't be guessed a character at a time.
    // Hash both sides first: that fixes the compared length, so a token which
    // merely starts with the right characters is rejected like any other, and
    // timingSafeEqual never sees mismatched buffer lengths.
    if (TOKEN) {
      const given = u.searchParams.get("t") || (req.headers.authorization || "").replace(/^Bearer /, "");
      const digest = (v) => crypto.createHash("sha256").update(String(v)).digest();
      if (!given || !crypto.timingSafeEqual(digest(given), digest(TOKEN))) {
        return send(401, "Unauthorized", "text/plain");
      }
    }

    const b = await board();
    if (u.pathname === "/status.json") return send(200, JSON.stringify(b, null, 2), "application/json");
    if (u.pathname === "/status.txt") {
      const { renderText } = await import("./lib/services.mjs");
      return send(200, renderText(b), "text/plain; charset=utf-8");
    }
    if (u.pathname !== "/") return send(404, "Not found", "text/plain");
    return send(200, page(b));
  } catch (e) {
    log("error", String(e.stack || e).slice(0, 300));
    return send(500, "Something went wrong", "text/plain");
  }
});

server.listen(PORT, BIND, () => {
  const suffix = TOKEN ? `?t=${TOKEN}` : "";
  log(`status page on http://${BIND}:${PORT}/${suffix}`);
  console.log(`\n  Status page:  http://${BIND === "0.0.0.0" ? os.hostname() : BIND}:${PORT}/${suffix}`);
  if (EXPOSED) console.log(`  Reachable from any device on your Tailscale network.\n`);
  else console.log(`  Local only. To reach it remotely:  STATUS_BIND=0.0.0.0 npm run status\n`);
});
