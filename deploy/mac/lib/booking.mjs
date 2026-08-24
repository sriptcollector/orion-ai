// Booking a call with Orion, from inside the client's terminal.
//
// Two paths, because the honest answer is that the booking server may or may
// not be reachable from a client's Mac on any given day:
//
//   1. If ORION_SLOTS_URL is set and answers, we show Orion's REAL open slots
//      and book one directly. The client picks a number and it's on his calendar.
//   2. If it isn't reachable, we do not guess at times — proposing a slot we
//      cannot verify is how you double-book someone. Instead the request goes
//      to Orion's Telegram through the relay, with the client's own words about
//      when suits them, and he confirms.
//
// Path 2 always works as long as the relay does, so the button is never dead.
import { toOrion } from "./relay.mjs";
import { loadEnv } from "./env.mjs";
loadEnv();

const SLOTS_URL = () => process.env.ORION_SLOTS_URL || "";
export const BOOK_URL = () => process.env.ORION_BOOK_URL || "https://book.orion-jones.com";

const timeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

/**
 * Orion's real open slots, if the booking service is reachable.
 * Contract: GET -> { slots: [{ startISO, label, mode? }] }
 */
export async function fetchSlots() {
  const url = SLOTS_URL();
  if (!url) return { ok: false, why: "no slots service configured", slots: [] };
  const t = timeout(6000);
  try {
    const res = await fetch(url, { signal: t.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, why: `slots service returned ${res.status}`, slots: [] };
    const j = await res.json();
    const slots = (Array.isArray(j) ? j : j.slots || [])
      .filter((s) => s && s.startISO)
      .map((s) => ({ startISO: s.startISO, label: s.label || new Date(s.startISO).toLocaleString(), mode: s.mode || "zoom" }))
      .slice(0, 8);
    return slots.length ? { ok: true, slots } : { ok: false, why: "no open slots came back", slots: [] };
  } catch (e) {
    return { ok: false, why: String(e.name === "AbortError" ? "slots service timed out" : e.message).slice(0, 120), slots: [] };
  } finally { t.done(); }
}

/**
 * Book a specific slot. Confirms via the service when it can, and tells Orion
 * either way — a booking he never hears about is not a booking.
 */
export async function book({ slot, reason, name, contact }) {
  const url = SLOTS_URL();
  let confirmed = false;
  let why = "";

  if (url && slot?.startISO) {
    const t = timeout(10000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: slot.startISO, name, reason, contact, source: "client-tui" }),
        signal: t.signal,
      });
      confirmed = res.ok;
      if (!res.ok) why = `booking service returned ${res.status}`;
    } catch (e) {
      why = String(e.name === "AbortError" ? "booking service timed out" : e.message).slice(0, 120);
    } finally { t.done(); }
  } else {
    why = "no booking service configured";
  }

  const when = slot?.label || slot?.startISO || "(no specific time — they asked you to propose one)";
  await toOrion(
    `📅 <b>${confirmed ? "BOOKED" : "Booking request"}</b>\n\n` +
    `When: <b>${when}</b>\n` +
    `Who: ${name || "(client)"}${contact ? ` · ${contact}` : ""}\n` +
    `About: ${reason || "(not given)"}\n` +
    (confirmed ? "\nThis is on your calendar." : `\n⚠️ Not on your calendar — ${why}. Confirm with them directly.`),
    { kind: "update" }
  );

  return { ok: true, confirmed, why };
}

/** No slot service: send Orion the client's own words about when suits them. */
export async function requestCallback({ reason, when, name, contact }) {
  const r = await toOrion(
    `📅 <b>Call request</b>\n\n` +
    `Wants: ${reason || "(not given)"}\n` +
    `Good times: ${when || "(any)"}\n` +
    `Who: ${name || "(client)"}${contact ? ` · ${contact}` : ""}\n\n` +
    `Reply in their Telegram to lock a time.`,
    { kind: "update" }
  );
  return r;
}
