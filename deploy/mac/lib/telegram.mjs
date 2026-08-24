// Bare Telegram HTTP helpers. No SDK — one dependency-free file both the bot
// and the engines use, so an engine can alert the owner without the bot running.
export function api(token) {
  const base = `https://api.telegram.org/bot${token}`;
  return async function call(method, body = {}) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({ ok: false, description: "bad json" }));
    if (!j.ok && process.env.ORION_VERBOSE !== "0") console.error(`telegram ${method}: ${j.description}`);
    return j;
  };
}

// Telegram hard-caps a message at 4096 chars. Split on line boundaries so a
// long lead list never silently truncates.
export function chunk(text, size = 3800) {
  const out = [];
  let cur = "";
  for (const line of String(text).split("\n")) {
    if ((cur + line).length > size) { if (cur) out.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

export const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
