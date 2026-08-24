// One log file per engine, capped so a 24/7 loop can't fill a Mac Mini's disk.
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import path from "node:path";
import { DATA } from "./env.mjs";

const MAX_BYTES = 5 * 1024 * 1024;

export function logger(name) {
  const dir = path.join(DATA, "logs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  return (...parts) => {
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file + ".1");
      appendFileSync(file, line + "\n");
    } catch {}
    if (process.env.ORION_VERBOSE !== "0") console.log(`${name}: ${line}`);
  };
}
