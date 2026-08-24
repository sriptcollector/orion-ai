// The one place anything leaves this machine.
//
// There are now two human surfaces — Telegram and the dashboard — and both can
// approve a draft. If each had its own send code, the guarantee that nothing
// sends without approval would have to hold in two places, and eventually would
// not. So both call approve() here, and no engine send function is invoked
// anywhere else in the codebase.
//
// Concurrency is the real hazard: the bot and the dashboard are separate
// processes, so both can be looking at the same pending draft. claim() is an
// atomic file create, and only the winner sends.
import * as queue from "./queue.mjs";
import * as draft from "./draft.mjs";
import { logger } from "./log.mjs";
import { toOrion } from "./relay.mjs";
import * as imessage from "../engines/imessage.mjs";
import * as whatsapp from "../engines/whatsapp.mjs";
import * as reddit from "../engines/reddit.mjs";
import * as socials from "../engines/socials.mjs";

const log = logger("send");

/** Dispatch one approved item to its engine. Never called directly — use approve(). */
async function dispatch(item) {
  switch (item.kind) {
    case "imessage":
      return imessage.send(item.payload.to, item.payload.text, { service: item.payload.service || "iMessage" });
    case "whatsapp": {
      const r = await whatsapp.send(item.payload.to, item.payload.text);
      return r.ok ? { ok: true, detail: `sent to +${r.to}`, screenshot: r.screenshot } : r;
    }
    case "reddit": {
      const r = await reddit.submit({ subreddit: item.payload.subreddit, title: item.payload.title, text: item.payload.text });
      return r.ok ? { ok: true, detail: r.url || `posted to r/${r.subreddit}` } : r;
    }
    case "social": {
      const r = await socials.post(item.payload.platform, item.payload.text, { imagePath: item.payload.imagePath || null });
      return r.ok ? { ok: true, detail: r.url || "posted", screenshot: r.screenshot } : r;
    }
    default:
      return { ok: false, why: `unknown item kind "${item.kind}"` };
  }
}

/**
 * Approve and send. Safe to call from either surface, concurrently.
 * Returns { ok, why?, detail?, screenshot?, item }.
 */
export async function approve(itemId, { via = "unknown" } = {}) {
  const existing = queue.getItem(itemId);
  if (!existing) return { ok: false, why: "that draft is gone" };
  if (existing.status !== "pending") return { ok: false, why: `already ${existing.status}`, item: existing };
  if (existing.kind === "imessage" && !existing.payload.to) {
    return { ok: false, why: "no phone number attached to this draft yet", item: existing };
  }

  const item = queue.claim(itemId);
  if (!item) return { ok: false, why: "someone else is already sending this one" };

  try {
    const res = await dispatch(item);
    queue.setStatus(itemId, res.ok ? "sent" : "failed", res.ok ? (res.detail || "sent") : res.why);
    log(via, item.kind, res.ok ? "sent" : "FAILED", String(res.detail || res.why || "").slice(0, 120));
    if (!res.ok) {
      await toOrion(`A send failed.\n\nKind: ${item.kind}\nTarget: ${item.title}\nError: ${res.why}`, { kind: "alert" });
    }
    return { ...res, item: queue.getItem(itemId) };
  } catch (e) {
    const why = String(e.message || e).slice(0, 300);
    queue.setStatus(itemId, "failed", why);
    log(via, "EXCEPTION", why);
    return { ok: false, why, item: queue.getItem(itemId) };
  } finally {
    queue.release(itemId);
  }
}

export function skip(itemId) {
  const item = queue.getItem(itemId);
  if (!item) return { ok: false, why: "that draft is gone" };
  if (item.status !== "pending") return { ok: false, why: `already ${item.status}` };
  queue.setStatus(itemId, "skipped");
  return { ok: true, item: queue.getItem(itemId) };
}

/** Rewrite a draft: the old one is retired and a fresh pending item replaces it. */
export async function redo(itemId, { instruction = "" } = {}) {
  const item = queue.getItem(itemId);
  if (!item) return { ok: false, why: "that draft is gone" };
  if (item.status !== "pending") return { ok: false, why: `already ${item.status}` };

  let payload;
  try {
    if (item.kind === "imessage" || item.kind === "whatsapp") {
      const text = await draft.imessageDraft(item.payload.lead || { name: item.payload.to }, {
        angle: instruction || item.payload.angle || "",
      });
      payload = { ...item.payload, text };
    } else if (item.kind === "reddit") {
      const d = await draft.redditDraft({
        subreddit: item.payload.subreddit,
        topic: instruction || item.payload.topic,
        rules: item.payload.rules || [],
      });
      payload = { ...item.payload, title: d.title, text: d.text };
    } else if (item.kind === "social") {
      const limit = socials.PLATFORMS[item.payload.platform]?.limit || 280;
      const text = await draft.socialDraft({
        platform: item.payload.platform,
        topic: instruction || item.payload.topic,
        limit,
      });
      payload = { ...item.payload, text };
    } else {
      return { ok: false, why: `cannot rewrite a "${item.kind}" draft` };
    }
  } catch (e) {
    return { ok: false, why: "rewrite failed: " + String(e.message || e).slice(0, 200) };
  }

  queue.setStatus(itemId, "skipped", "redrafted");
  const fresh = queue.enqueue({
    kind: item.kind,
    title: titleOf(item.kind, payload),
    preview: previewOf(item.kind, payload),
    payload,
    source: item.source,
  });
  return { ok: true, item: fresh };
}

export const previewOf = (kind, p) => (kind === "reddit" ? `${p.title}\n\n${p.text}` : p.text);
export const titleOf = (kind, p) =>
  kind === "imessage" ? `to ${p.to || "(no number yet)"}`
  : kind === "whatsapp" ? `WhatsApp to +${p.to || "?"}`
  : kind === "reddit" ? `r/${p.subreddit}`
  : socials.PLATFORMS[p.platform]?.label || p.platform;

/** Attach a recipient to a draft parked without one. */
export function attachRecipient(itemId, to) {
  const item = queue.getItem(itemId);
  if (!item) return { ok: false, why: "that draft is gone" };
  const n = item.kind === "whatsapp" ? whatsapp.normalize(to) : imessage.normalizeRecipient(to);
  if (!n.ok) return { ok: false, why: n.why };
  const all = queue.raw();
  queue.writeRaw({
    ...all,
    items: all.items.map((i) =>
      i.id === itemId
        ? { ...i, payload: { ...i.payload, to: n.id, dedupeKey: n.id }, title: titleOf(i.kind, { ...i.payload, to: n.id }) }
        : i),
  });
  return { ok: true, item: queue.getItem(itemId) };
}
