// The writing layer. Every word this system puts in front of a human is drafted
// here, by DeepSeek, against one shared voice — so an iMessage, a Reddit post
// and an X post all sound like the same person rather than three different bots.
//
// Everything returned here is a DRAFT. Nothing in this file sends anything.
import { deepseek, deepseekJSON, VOICE } from "./deepseek.mjs";
import { readFileSync } from "node:fs";
import { read } from "./store.mjs";

// The client's own description of their business, product and audience. Written
// once during setup and editable from Telegram with /brief. Without this the
// model writes generic slop, so it is the single highest-leverage config here.
export function brief() {
  const live = read("brief", null);
  if (live?.text) return live.text;
  try {
    return JSON.parse(readFileSync(new URL("../config/brief.json", import.meta.url), "utf8")).text || "";
  } catch { return ""; }
}

const withBrief = (task) => [
  { role: "system", content: `${VOICE}\n\nAbout the business you write for:\n${brief() || "(not set - keep it generic and never invent specifics)"}` },
  { role: "user", content: task },
];

/** A short outreach iMessage to one lead. */
export async function imessageDraft(lead, { angle = "", maxChars = 320 } = {}) {
  const who = [lead.name && `Name: ${lead.name}`, lead.headline && `Headline: ${lead.headline}`,
               lead.location && `Location: ${lead.location}`, lead.company && `Company: ${lead.company}`]
              .filter(Boolean).join("\n");
  const text = await deepseek(withBrief(
    `Write a first text message to this person. This goes out as a real SMS/iMessage from a personal phone number.

${who}

${angle ? `Angle to take: ${angle}\n` : ""}
Hard requirements:
- Under ${maxChars} characters. Two or three sentences.
- Open by saying who you are in four words or less.
- Say the ONE specific reason you are texting them, tied to something in their headline above. If their headline tells you nothing useful, be plainly direct instead of pretending to know them.
- End with a low-pressure question they can answer in three words.
- No links. No emoji. No "Hope you're well". Do not mention where you found them unless it is flattering and true.

Return only the message text, nothing else.`), { temperature: 0.8, max_tokens: 300 });
  return String(text).trim().replace(/^["']|["']$/g, "").slice(0, maxChars + 60);
}

/** A reply to an inbound iMessage, given the thread so far. */
export async function replyDraft(thread, { instruction = "" } = {}) {
  const convo = thread.map((m) => `${m.fromMe ? "US" : "THEM"}: ${m.text}`).join("\n");
  const text = await deepseek(withBrief(
    `Here is a text conversation. Write ONLY our next message.

${convo}

${instruction ? `The human running this account says: ${instruction}\n` : ""}
Match the length and register of what they just sent. If they asked a question, answer it directly first. If they said no or asked to stop, write a short gracious close and nothing else. Never push after a no.

Return only the message text.`), { temperature: 0.7, max_tokens: 400 });
  return String(text).trim().replace(/^["']|["']$/g, "");
}

/** A Reddit self-post written to fit one subreddit's actual rules. */
export async function redditDraft({ subreddit, topic, rules = [], examples = [] }) {
  const j = await deepseekJSON(withBrief(
    `Write a Reddit self-post for r/${subreddit}.

Topic: ${topic}

${rules.length ? `This subreddit's rules:\n${rules.map((r) => "- " + r).join("\n")}\n` : ""}
${examples.length ? `Titles doing well there right now:\n${examples.map((e) => "- " + e).join("\n")}\n` : ""}
Reddit punishes anything that reads as an ad. So:
- The post must be genuinely useful to that subreddit ON ITS OWN, even if nobody clicks anything.
- Lead with the specific thing you learned or built, with real detail and at least one concrete number or example.
- Mention what you are selling at most once, near the end, plainly, or not at all if the rules forbid promotion.
- Title under 300 characters, no clickbait, no "I made a thing!!!".
- Write the body in plain paragraphs. No markdown headers, no bullet-point listicle, no emoji.

Return JSON: {"title": "...", "text": "...", "selfPromo": true|false, "ruleRisk": "none|low|medium|high", "riskNote": "..."}`),
    { temperature: 0.8, max_tokens: 1600 });
  return { title: String(j.title || "").slice(0, 300), text: String(j.text || ""), selfPromo: !!j.selfPromo, ruleRisk: j.ruleRisk || "unknown", riskNote: j.riskNote || "" };
}

/** A social post sized to one platform. */
export async function socialDraft({ platform, topic, limit = 280 }) {
  const text = await deepseek(withBrief(
    `Write one ${platform} post.

Topic: ${topic}

- Hard limit ${limit} characters. Aim for 60-80% of it.
- One idea only. Open with the most concrete or surprising part, not a preamble.
- No hashtags unless the platform is Instagram, and then at most three.
- No "Thread 🧵", no "Here's why", no engagement bait, no emoji as bullet points.

Return only the post text.`), { temperature: 0.85, max_tokens: 500 });
  return String(text).trim().replace(/^["']|["']$/g, "").slice(0, limit);
}

/** Score a scraped lead 0-100 for fit, so the queue surfaces the good ones first. */
export async function scoreLead(lead) {
  try {
    const j = await deepseekJSON(withBrief(
      `Score this person as a prospect, 0-100, for the business described above.

Name: ${lead.name}
Headline: ${lead.headline || "(none)"}
Location: ${lead.location || "(unknown)"}

Be harsh. 80+ means an obvious fit worth a personal message today. Under 40 means skip.
Return JSON: {"score": 0-100, "why": "one short sentence", "angle": "the single best reason to contact them, or empty"}`),
      { temperature: 0.3, max_tokens: 300 });
    return { score: Math.max(0, Math.min(100, Number(j.score) || 0)), why: j.why || "", angle: j.angle || "" };
  } catch (e) {
    return { score: null, why: "scoring failed: " + String(e.message || e).slice(0, 120), angle: "" };
  }
}
