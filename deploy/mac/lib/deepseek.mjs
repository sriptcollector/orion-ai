// DeepSeek client (OpenAI-compatible). Every piece of writing this system does —
// message drafts, Reddit posts, lead scoring — routes through here.
import { loadEnv } from "./env.mjs";
loadEnv();

const BASE = () => process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
export const hasDeepSeek = () => !!process.env.DEEPSEEK_API_KEY;

export async function deepseek(messages, {
  model = process.env.DEEPSEEK_MODEL || "deepseek-chat",
  json = false, temperature = 0.7, max_tokens = 2000, timeoutMs = 90000,
} = {}) {
  const KEY = process.env.DEEPSEEK_API_KEY;
  if (!KEY) throw new Error("DEEPSEEK_API_KEY missing — add it in the TUI (Keys) or .env");
  const body = { model, messages, temperature, max_tokens };
  // json_object mode only applies to deepseek-chat; the reasoner ignores it and
  // returns prose, so ask for JSON in the prompt there instead of the format.
  if (json && !/reasoner/i.test(model)) body.response_format = { type: "json_object" };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? "";
  } finally { clearTimeout(t); }
}

export async function deepseekJSON(messages, opts = {}) {
  const raw = await deepseek(messages, { ...opts, json: true });
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error("deepseek did not return valid JSON: " + raw.slice(0, 200));
}

// The house style for anything a human will read. Kept in one place because the
// fastest way to make this system look like a bot is to let each engine invent
// its own voice.
export const VOICE = `You write like a real person typing on a phone, not like marketing copy.
Rules, without exception:
- No em-dashes. No "I hope this finds you well". No "excited to connect". No "leverage", "synergy", "reach out".
- Short sentences. Lowercase is fine. One concrete specific detail beats three adjectives.
- Never claim a shared connection, past meeting, or mutual friend you were not given.
- Never invent facts about the person or their company. If you only know their title, only use their title.
- If you have nothing specific to say about them, say something plainly useful instead of flattering them.`;
