// Shared .env loader for the Mac bundle. Reads KEY=VALUE into process.env
// without clobbering anything already set (so launchd/CLI overrides win).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.join(ROOT, "data");
export const ENV_PATH = path.join(ROOT, ".env");

export function loadEnv() {
  if (!existsSync(ENV_PATH)) return process.env;
  for (const line of readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
  return process.env;
}

// Merge-write a key into .env without clobbering the rest of the file. The TUI
// and the bot both edit .env live, so this must never rewrite from memory.
export function setEnv(key, value) {
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8").split(/\r?\n/) : [];
  let found = false;
  lines = lines.map((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] === key) { found = true; return `${key}=${value}`; }
    return l;
  });
  if (!found) lines.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, lines.filter((l, i, a) => !(l === "" && a[i + 1] === "")).join("\n").replace(/\n*$/, "\n"));
  process.env[key] = value;
}

export const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set in .env`);
  return v;
};
