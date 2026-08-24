// Runtime settings the client can change from Telegram or the TUI without
// editing files. Anything that shapes 24/7 behaviour lives here, not in .env,
// so a change takes effect on the next loop tick with no restart.
import { read, write } from "./store.mjs";

export const DEFAULTS = {
  paused: false,                 // master kill switch — halts every engine
  autoSend: false,               // false = everything outbound waits for a tap
  activeHours: [8, 22],          // local-time window engines are allowed to act
  linkedin: {
    enabled: true,
    everyMinutes: 90,            // one sweep this often, plus jitter
    profilesPerSweep: 12,        // hard ceiling per sweep
    dailyProfileCap: 120,        // hard ceiling per day
    minDelaySec: 45,             // pacing between profile views
    maxDelaySec: 110,
    halted: false,               // set true automatically on a LinkedIn challenge
    haltReason: "",
  },
  reddit: {
    enabled: true,
    everyMinutes: 240,
    dailyPostCap: 3,             // Reddit removes accounts that post more
    minHoursBetweenPosts: 4,
    minHoursPerSubreddit: 24,
  },
  imessage: {
    enabled: true,
    dailyCap: 40,
    minDelaySec: 60,
  },
  socials: {
    enabled: true,
    dailyPostCap: 6,             // across all platforms combined
    minHoursBetweenPosts: 2,
  },
};

// Deep-merge stored settings over defaults so a bundle upgrade that adds a new
// knob doesn't need a migration — the new default just appears.
function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object"
      ? merge(base[k], v) : v;
  }
  return out;
}

export const getSettings = () => merge(DEFAULTS, read("settings", {}));
export const saveSettings = (patch) => write("settings", merge(read("settings", {}), patch));

// Engines ask this before every action. One place decides "may I act right now",
// so pausing from Telegram reliably stops all of them.
export function mayAct(engine) {
  const s = getSettings();
  if (s.paused) return { ok: false, why: "everything is paused" };
  if (engine && s[engine]?.enabled === false) return { ok: false, why: `${engine} is switched off` };
  if (engine && s[engine]?.halted) return { ok: false, why: s[engine].haltReason || `${engine} auto-halted` };
  const h = new Date().getHours();
  const [from, to] = s.activeHours;
  if (h < from || h >= to) return { ok: false, why: `outside active hours (${from}:00-${to}:00)` };
  return { ok: true, settings: s };
}
