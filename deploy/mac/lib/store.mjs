// Tiny atomic JSON store. Every engine and the bot read/write the same files
// from different processes, so writes go through a temp file + rename (atomic
// on macOS) — a crash mid-write can never leave a half-written queue on disk.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA } from "./env.mjs";

mkdirSync(DATA, { recursive: true });
const file = (name) => path.join(DATA, `${name}.json`);

export function read(name, fallback) {
  try { return JSON.parse(readFileSync(file(name), "utf8")); } catch { return fallback; }
}

export function write(name, value) {
  mkdirSync(DATA, { recursive: true });
  const tmp = file(name) + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file(name));
  return value;
}

// Read-modify-write in one call. Not a real lock — the processes here write
// different files in practice, and rename() keeps any single file consistent.
export function update(name, fallback, fn) {
  const cur = read(name, fallback);
  const next = fn(cur);
  write(name, next === undefined ? cur : next);
  return read(name, fallback);
}

export const id = () => crypto.randomBytes(6).toString("hex");
export const today = () => new Date().toISOString().slice(0, 10);
