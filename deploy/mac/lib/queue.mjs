// The approval queue. NOTHING outbound — no iMessage, no Reddit post — is sent
// by an engine directly. Engines draft and enqueue; a human taps ✅ in Telegram
// and only then does the send function run. This is the single choke point that
// makes an autonomous 24/7 system safe to point at a real phone number.
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
