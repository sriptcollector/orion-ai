#!/usr/bin/env node
// provision.mjs — "set up this whole machine" step of the onboarding.
//
// Runs right after the installer clones the bundle, BEFORE the key/Telegram
// wizard (orion-setup.mjs). It installs the machine-level things a fresh device
// needs — the runtime (git/node/Claude Code), Tailscale (private network so the
// dashboard reaches this box from anywhere), and Chrome Remote Desktop host —
// then hands off to orion-setup for keys and services.
//
// HONEST BY DESIGN: every step is wrapped and REPORTS its real result. Nothing
// prints "done" it didn't do. Two steps genuinely cannot finish headlessly and
// say so out loud:
//   - Tailscale join needs an auth key (TS_AUTHKEY) or a browser login.
//   - Chrome Remote Desktop pairing needs a Google sign-in (remotedesktop.google.com/headless).
// Everything is idempotent: re-running skips what's already present.
//
//   node deploy/provision.mjs            provision, then launch the key wizard
//   node deploy/provision.mjs --no-setup provision only
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const OSP = process.platform; // "win32" | "darwin" | "linux"
const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[90m", b: "\x1b[1m", x: "\x1b[0m", cy: "\x1b[36m" };
const results = [];
const line = (s = "") => process.stdout.write(s + "\n");
const step = (name) => { line(`\n${C.b}▸ ${name}${C.x}`); };
const okr = (name, msg = "") => { results.push({ name, ok: true, msg }); line(`  ${C.g}✓ ${msg || "done"}${C.x}`); };
const skip = (name, msg) => { results.push({ name, ok: true, msg: "already " + msg }); line(`  ${C.d}• ${msg}${C.x}`); };
const failr = (name, msg) => { results.push({ name, ok: false, msg }); line(`  ${C.r}✗ ${msg}${C.x}`); };

function have(cmd) {
  const finder = OSP === "win32" ? "where" : "which";
  return spawnSync(finder, [cmd], { encoding: "utf8" }).status === 0;
}
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
}
// Run a shell string (PowerShell on Windows, bash elsewhere) with a timeout.
function shell(script, timeoutMs = 6 * 60 * 1000) {
  if (OSP === "win32") return spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: timeoutMs });
  return spawnSync("bash", ["-lc", script], { encoding: "utf8", timeout: timeoutMs });
}

// ---- runtime: git, node, claude code -------------------------------------
function ensureRuntime() {
  step("Runtime (git · node · Claude Code)");
  // git + node are prerequisites of the installer itself, so they are normally
  // already here; verify and report rather than assume.
  for (const t of ["git", "node"]) {
    if (have(t)) skip(t, `${t} present`);
    else failr(t, `${t} missing — install from ${t === "git" ? "git-scm.com" : "nodejs.org"} and re-run`);
  }
  if (have("claude")) { skip("claude-code", "Claude Code present"); return; }
  line(`  ${C.d}installing Claude Code (npm i -g @anthropic-ai/claude-code)…${C.x}`);
  const r = sh("npm", ["install", "-g", "@anthropic-ai/claude-code"], { timeout: 5 * 60 * 1000 });
  if (r.status === 0 || have("claude")) okr("claude-code", "Claude Code installed"); else failr("claude-code", "npm install failed — run: npm i -g @anthropic-ai/claude-code");
}

// ---- Tailscale -----------------------------------------------------------
function ensureTailscale() {
  step("Tailscale (private network so the dashboard reaches this machine anywhere)");
  const already = have("tailscale");
  if (!already) {
    line(`  ${C.d}installing…${C.x}`);
    let r;
    if (OSP === "win32") {
      const msi = path.join(os.tmpdir(), "tailscale-setup.msi");
      r = shell(`Invoke-WebRequest -UseBasicParsing 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.msi' -OutFile '${msi}'; Start-Process msiexec.exe -Wait -ArgumentList '/i','${msi}','/quiet','/norestart'`);
    } else if (OSP === "darwin") {
      r = have("brew") ? shell(`brew install tailscale`) : { status: 1, stderr: "Homebrew not found — install from brew.sh, or get Tailscale from the App Store" };
    } else {
      r = shell(`curl -fsSL https://tailscale.com/install.sh | sh`);
    }
    if (r.status === 0 || have("tailscale")) okr("tailscale-install", "Tailscale installed");
    else { failr("tailscale-install", (r.stderr || "install failed").split("\n")[0].slice(0, 120)); return; }
  } else skip("tailscale-install", "Tailscale present");

  // Join the tailnet. An auth key (TS_AUTHKEY) makes this fully automatic;
  // without one we fall back to the interactive browser login and say so.
  const key = process.env.TS_AUTHKEY;
  const upArgs = OSP === "win32" ? null : null;
  if (key) {
    const r = OSP === "win32"
      ? shell(`& "$env:ProgramFiles\\Tailscale\\tailscale.exe" up --authkey ${key} --hostname orion-$(hostname)`)
      : shell(`sudo tailscale up --authkey ${key} --hostname orion-$(hostname)`);
    if (r.status === 0) okr("tailscale-up", "joined your tailnet (auth key)");
    else failr("tailscale-up", "join failed: " + (r.stderr || "").split("\n")[0].slice(0, 100));
  } else {
    failr("tailscale-up", "no TS_AUTHKEY — run 'tailscale up' once to log in via browser (get an auth key from Orion to make this automatic)");
  }
}

// ---- Chrome Remote Desktop host ------------------------------------------
function ensureCRD() {
  step("Chrome Remote Desktop host (optional graphical remote access)");
  if (OSP === "linux") { skip("crd", "skipped on Linux (use Tailscale SSH)"); return; }
  const url = OSP === "win32"
    ? "https://dl.google.com/edgedl/chrome-remote-desktop/chromeremotedesktophost.msi"
    : "https://dl.google.com/chrome-remote-desktop/chromeremotedesktophost.pkg";
  const out = path.join(os.tmpdir(), OSP === "win32" ? "crd-host.msi" : "crd-host.pkg");
  let r;
  if (OSP === "win32") r = shell(`Invoke-WebRequest -UseBasicParsing '${url}' -OutFile '${out}'; Start-Process msiexec.exe -Wait -ArgumentList '/i','${out}','/quiet','/norestart'`);
  else r = shell(`curl -fsSL '${url}' -o '${out}' && sudo installer -pkg '${out}' -target /`);
  if (r.status === 0) okr("crd", "host installed — finish pairing at remotedesktop.google.com/headless (needs your Google sign-in)");
  else failr("crd", "install failed — you can skip CRD and use Tailscale instead");
}

// ---- summary + handoff ---------------------------------------------------
function summary() {
  line(`\n${C.b}── Provision summary ──${C.x}`);
  for (const r of results) line(`  ${r.ok ? C.g + "✓" : C.r + "✗"} ${r.name}${C.x}  ${C.d}${r.msg}${C.x}`);
  const failed = results.filter((r) => !r.ok);
  line(failed.length
    ? `\n  ${C.y}${failed.length} step(s) need attention above. The rest is set.${C.x}`
    : `\n  ${C.g}Machine provisioned.${C.x}`);
}

(function main() {
  line(`${C.cy}${C.b}Orion — machine setup${C.x}  ${C.d}(${OSP})${C.x}`);
  ensureRuntime();
  ensureTailscale();
  ensureCRD();
  summary();
  if (process.argv.includes("--no-setup")) return;
  // Hand off to the key/Telegram wizard in the same window.
  const setup = path.resolve(process.cwd(), "deploy", "orion-setup.mjs");
  if (existsSync(setup)) {
    line(`\n${C.d}Launching key & Telegram setup…${C.x}\n`);
    spawnSync(process.execPath, [setup], { stdio: "inherit" });
  } else {
    line(`\n${C.y}Next: run  node deploy/orion-setup.mjs  to add your keys.${C.x}`);
  }
})();
