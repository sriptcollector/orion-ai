// The approval queue. NOTHING outbound — no iMessage, no Reddit post — is sent
// by an engine directly. Engines draft and enqueue; a human taps ✅ in Telegram
// and only then does the send function run. This is the single choke point that
// makes an autonomous 24/7 system safe to point at a real phone number.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA } from "./env.mjs";
import { read, write, update, id, today } from "./store.mjs";

const EMPTY = { items: [], ledger: {} };

export function enqueue({ kind, title, preview, payload, source = "" }) {
  const item = {
    id: id(), kind, title, preview, payload, source,
    status: "pending", createdAt: new Date().toISOString(), decidedAt: null, result: null,
  };
  update("queue", EMPTY, (q) => ({ ...q, items: [...q.items, item] }));
  return item;
}

export const pending = () => read("queue", EMPTY).items.filter((i) => i.status === "pending");
export const getItem = (itemId) => read("queue", EMPTY).items.find((i) => i.id === itemId) || null;

export function setStatus(itemId, status, result = null) {
  update("queue", EMPTY, (q) => ({
    ...q,
    items: q.items.map((i) => (i.id === itemId ? { ...i, status, result, decidedAt: new Date().toISOString() } : i)),
  }));
  return getItem(itemId);
}

// Count what actually WENT OUT today, per kind — never what we intended to send.
// Caps read from this, so a crash-and-retry loop can't double a day's volume.
export function sentToday(kind) {
  const q = read("queue", EMPTY);
  return q.items.filter((i) => i.kind === kind && i.status === "sent" && String(i.decidedAt || "").slice(0, 10) === today()).length;
}

export function lastSent(kind, matchFn = () => true) {
  const q = read("queue", EMPTY);
  const hits = q.items.filter((i) => i.kind === kind && i.status === "sent" && matchFn(i));
  return hits.length ? hits[hits.length - 1] : null;
}

// Keep the file small: drop decided items older than 30 days, keep all pending.
export function prune() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  update("queue", EMPTY, (q) => ({
    ...q,
    items: q.items.filter((i) => i.status === "pending" || new Date(i.decidedAt || i.createdAt).getTime() > cutoff),
  }));
}

// Dedupe guard: has this exact target already been contacted, ever?
export function alreadyContacted(kind, key) {
  const q = read("queue", EMPTY);
  return q.items.some((i) => i.kind === kind && i.status === "sent" && (i.payload?.dedupeKey || "") === key);
}

// Atomically claim a pending item for sending.
//
// The bot and the dashboard are SEPARATE PROCESSES that can both approve the
// same draft at the same moment. A read-then-write status check does not stop
// that — both read "pending", both send. So the claim is an exclusive file
// create, which the OS guarantees only one caller can win.
//
// Returns the item on success, or null if someone else already has it.
export function claim(itemId) {
  const item = getItem(itemId);
  if (!item || item.status !== "pending") return null;

  const lock = path.join(DATA, "locks");
  mkdirSync(lock, { recursive: true });
  const f = path.join(lock, `${itemId}.lock`);
  try {
    // wx fails if the file exists. This is the atomic part.
    writeFileSync(f, String(process.pid), { flag: "wx" });
  } catch {
    return null;
  }

  // Re-read after winning the lock: the other side may have finished between
  // our status check and our claim.
  const fresh = getItem(itemId);
  if (!fresh || fresh.status !== "pending") { release(itemId); return null; }
  setStatus(itemId, "sending");
  return fresh;
}

export function release(itemId) {
  try { rmSync(path.join(DATA, "locks", `${itemId}.lock`), { force: true }); } catch {}
}

// A process killed mid-send leaves a lock and an item stuck in "sending".
// Called on startup so a crash cannot silently freeze the queue forever.
export function recoverStuck(olderThanMin = 15) {
  const cutoff = Date.now() - olderThanMin * 60000;
  let n = 0;
  update("queue", EMPTY, (q) => ({
    ...q,
    items: q.items.map((i) => {
      if (i.status !== "sending") return i;
      if (new Date(i.decidedAt || i.createdAt).getTime() > cutoff) return i;
      n++;
      release(i.id);
      return { ...i, status: "pending", result: null, decidedAt: null };
    }),
  }));
  return n;
}

// Direct access for callers that must rewrite an item wholesale (attaching a
// recipient to a parked draft). Kept explicit rather than exporting the store,
// so every such write is greppable.
export const raw = () => read("queue", EMPTY);
export const writeRaw = (v) => write("queue", v);
