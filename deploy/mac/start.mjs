#!/usr/bin/env node
// Runs the bot and the scheduler together, and restarts either one if it dies.
//
// This is the foreground way to run everything (`npm start`) — good for the
// first day, when you want to watch it work. For real 24/7 use the launchd
// services instead (`npm run install:service`), which survive a reboot and a
// closed terminal.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const children = new Map();

function start(name, file) {
  const child = spawn(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, stdio: "inherit" });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    console.log(`\n[supervisor] ${name} exited (code ${code}${signal ? `, ${signal}` : ""}). Restarting in 5s.`);
    setTimeout(() => start(name, file), 5000);
  });
  child.on("error", (e) => console.error(`[supervisor] ${name} failed to spawn:`, e.message));
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[supervisor] stopping…");
  for (const c of children.values()) { try { c.kill("SIGTERM"); } catch {} }
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[supervisor] starting bot + scheduler. Ctrl-C to stop.");
start("bot", "bot.mjs");
start("scheduler", "scheduler.mjs");
