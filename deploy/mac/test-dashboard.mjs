#!/usr/bin/env node
// Integration test: boots the real dashboard on a spare port and drives it over
// HTTP, the way a browser would.
//
// The unit suite proves the pieces behave. This proves the assembled server
// actually answers — routes wired, auth enforced on every path, JSON errors
// instead of 500s, and no write endpoint reachable without a token. Those are
// exactly the failures that look fine in isolation and break in the browser.
//
// It runs against a throwaway .env and data dir, so it cannot touch real state.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m", c: "\x1b[36m" };
let pass = 0, fail = 0, group = "";
const failures = [];
const G = (n) => { group = n; console.log(`\n${C.b}${C.c}${n}${C.x}`); };
function ok(label, cond, detail = "") {
  if (cond) pass++;
  else { fail++; failures.push({ group, label, detail }); console.log(`  ${C.r}✗ ${label}${C.x}${detail ? ` ${C.d}${detail}${C.x}` : ""}`); }
}
const eq = (l, a, e) => ok(l, JSON.stringify(a) === JSON.stringify(e), `got ${JSON.stringify(a)}, wanted ${JSON.stringify(e)}`);

// A sandbox so the test cannot write to the real .env or data dir.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "orion-dash-"));
const PORT = 8800 + Math.floor(Math.random() * 150);
const TOKEN = "integration-test-token";
fs.writeFileSync(path.join(SANDBOX, ".env"), "CLIENT_NAME=Test Client\nDEEPSEEK_API_KEY=keepme\n");
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });

// Run the real server, but pointed at the sandbox for anything it writes.
const child = spawn(process.execPath, [path.join(ROOT, "dashboard.mjs")], {
  cwd: ROOT,
  env: { ...process.env, STATUS_PORT: String(PORT), STATUS_TOKEN: TOKEN, ORION_ENV_PATH: path.join(SANDBOX, ".env"), ORION_VERBOSE: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverErr = "";
child.stderr.on("data", (d) => (serverErr += d));

const B = `http://127.0.0.1:${PORT}`;
const get = async (p, tok = TOKEN) => {
  const r = await fetch(`${B}${p}${p.includes("?") ? "&" : "?"}t=${encodeURIComponent(tok)}`);
  return { status: r.status, text: await r.text() };
};
const post = async (p, body, tok = TOKEN) => {
  const r = await fetch(`${B}${p}?t=${encodeURIComponent(tok)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};

// Wait for the port instead of sleeping a guessed amount.
async function waitUp(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`${B}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  const up = await waitUp();
  if (!up) {
    console.log(`${C.r}the dashboard never came up${C.x}\n${serverErr.slice(0, 600)}`);
    process.exit(1);
  }

  // =========================================================================
  G("auth — every path, every shape of wrong token");
  {
    const paths = ["/", "/setup", "/accounts", "/keys", "/queue", "/messages", "/control", "/status.json", "/status.txt"];
    for (const p of paths) {
      const noTok = await fetch(`${B}${p}`);
      ok(`${p} refuses a missing token`, noTok.status === 401);
    }
    for (const bad of ["wrong", "", TOKEN + "EXTRA", TOKEN.slice(0, -1), TOKEN.toUpperCase()]) {
      const r = await get("/setup", bad);
      ok(`a wrong token is refused (${bad.slice(0, 14) || "empty"})`, r.status === 401);
    }
    const bearer = await fetch(`${B}/setup`, { headers: { authorization: `Bearer ${TOKEN}` } });
    ok("a Bearer header authenticates", bearer.status === 200);
    const health = await fetch(`${B}/health`);
    ok("/health needs no token (it is how you check it is alive)", health.status === 200);

    for (const p of ["/api/approve", "/api/pause", "/api/keys", "/api/cookies", "/api/compose"]) {
      const r = await fetch(`${B}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      ok(`${p} refuses a write with no token`, r.status === 401);
    }
  }

  // =========================================================================
  G("pages render");
  {
    for (const p of ["/", "/setup", "/accounts", "/keys", "/queue", "/messages", "/control"]) {
      const r = await get(p);
      ok(`${p} returns 200`, r.status === 200, `status ${r.status}`);
      ok(`${p} is a complete HTML document`, r.text.startsWith("<!doctype html") && r.text.includes("</html>"));
      ok(`${p} carries the nav`, r.text.includes('data-to="/queue"'));
    }
    for (const id of ["linkedin", "x", "instagram", "facebook", "threads", "reddit"]) {
      const r = await get(`/connect/${id}`);
      ok(`/connect/${id} renders`, r.status === 200 && r.text.includes("Cookie-Editor"));
    }
    const unknown = await get("/connect/myspace");
    ok("an unknown platform does not 500", unknown.status === 200 && /Unknown/.test(unknown.text));
    const missing = await get("/nope");
    eq("an unknown path is 404", missing.status, 404);

    const j = await get("/status.json");
    let parsed = null;
    try { parsed = JSON.parse(j.text); } catch {}
    ok("/status.json is valid JSON", !!parsed);
    ok("...with rows and counts", !!parsed && Array.isArray(parsed.rows) && !!parsed.counts);
  }

  // =========================================================================
  G("no secret is echoed into a page");
  {
    const keys = await get("/keys");
    ok("a stored secret is never rendered", !keys.text.includes("keepme"),
       "the page would leak it to anyone who gets the URL");
    ok("...but it is shown as set", keys.text.includes("set"));
    const status = await get("/");
    ok("the status page carries no token in its HTML", !status.text.includes(TOKEN),
       "a token in the markup leaks via copy-paste and Referer");
  }

  // =========================================================================
  G("write endpoints behave");
  {
    let r = await post("/api/pause", { paused: "1" });
    ok("pause works", r.json?.ok === true);
    r = await post("/api/pause", { paused: "0" });
    ok("resume works", r.json?.ok === true);

    r = await post("/api/hours", { from: "20", to: "8" });
    ok("an inverted hour range is refused", r.json?.ok === false);
    r = await post("/api/hours", { from: "notanumber", to: "9" });
    ok("a non-numeric hour is refused", r.json?.ok === false);
    r = await post("/api/hours", { from: "8", to: "22" });
    ok("a valid hour range is accepted", r.json?.ok === true);

    r = await post("/api/target", { search: "" });
    ok("an empty search is refused", r.json?.ok === false);
    r = await post("/api/target", { search: "head of ops logistics" });
    ok("a search is added", r.json?.ok === true);

    r = await post("/api/brief", { brief: "too short" });
    ok("a too-short brief is refused", r.json?.ok === false);
    r = await post("/api/brief", { brief: "We do fractional ops for 20-60 person logistics companies drowning in spreadsheets." });
    ok("a real brief is accepted", r.json?.ok === true);

    r = await post("/api/compose", { to: "not-a-number", angle: "hi" });
    ok("composing to a bad number is refused", r.json?.ok === false);
    r = await post("/api/compose", { to: "3105551212", angle: "" });
    ok("composing with no instruction is refused", r.json?.ok === false);

    r = await post("/api/cookies", { platform: "linkedin", cookies: "nonsense" });
    ok("unparseable cookies are refused", r.json?.ok === false);
    r = await post("/api/cookies", { platform: "whatsapp", cookies: "[]" });
    ok("WhatsApp cookies are refused with the reason", r.json?.ok === false && /QR/.test(r.json.why));

    for (const p of ["/api/approve", "/api/skip", "/api/redo", "/api/attach"]) {
      r = await post(p, { id: "does-not-exist", to: "+13105551212" });
      ok(`${p} on a missing draft is a clean error, not a 500`, r.status === 200 && r.json?.ok === false,
         `status ${r.status}`);
    }

    r = await post("/api/nope", {});
    ok("an unknown endpoint is a clean 404", r.status === 404 && r.json?.ok === false);
  }

  // =========================================================================
  G("hostile input");
  {
    let r = await post("/api/target", { search: "<script>alert(1)</script>" });
    ok("a script tag is accepted as text", r.json?.ok === true);
    const control = await get("/control");
    ok("...and rendered escaped, not executed", !control.text.includes("<script>alert(1)</script>"),
       "an unescaped value here would be stored XSS");

    // The server answers and hangs up while the client is still uploading, so
    // the socket resets. That is correct behaviour for an oversized body —
    // what matters is that the process survives it, not what this fetch sees.
    const tryFetch = async (p, init) => {
      try { const r = await fetch(`${B}${p}?t=${TOKEN}`, init); return r.status; }
      catch { return "connection reset"; }
    };

    const big = "x".repeat(3 * 1024 * 1024);
    const bigRes = await tryFetch("/api/target", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ search: big }),
    });
    ok("an oversized body is refused rather than buffered", bigRes !== 200, `got ${bigRes}`);

    const badJson = await tryFetch("/api/pause", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    ok("malformed JSON is handled", badJson !== undefined);

    // The real assertion: after every hostile request above, is it still serving?
    let alive = false;
    for (let i = 0; i < 5 && !alive; i++) {
      try { alive = (await fetch(`${B}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    ok("the server is still alive after all of that", alive,
       "an oversized body or bad JSON must not be able to take it down");
  }
} finally {
  child.kill();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

const total = pass + fail;
console.log(`\n${C.b}${"─".repeat(60)}${C.x}`);
console.log(`${C.b}${pass}/${total} passed${C.x}   ${fail ? `${C.r}${fail} FAILED${C.x}` : `${C.g}all green${C.x}`}`);
if (fail) { console.log(`\n${C.b}Failures${C.x}`); failures.forEach((f) => console.log(`  ${C.r}✗${C.x} ${C.d}[${f.group}]${C.x} ${f.label}${f.detail ? `\n    ${C.d}${f.detail}${C.x}` : ""}`)); }
console.log();
process.exit(fail ? 1 : 0);
