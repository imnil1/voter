require("dotenv").config();
const { voteAllBotsForToken } = require("./top");

let config;
try {
  config = JSON.parse(process.env.CONFIG);
} catch (e) {
  console.error("[fatal] CONFIG env var is missing or invalid JSON");
  console.error('[fatal] Example: CONFIG={"tokens":[{"token":"...","voteAt":["08:50","20:50"]}],"botIds":["123456789"]}');
  process.exit(1);
}

const { tokens, botIds } = config;
const timezone = process.env.TIMEZONE || "UTC";

if (!Array.isArray(tokens) || tokens.length === 0) {
  console.error("[fatal] CONFIG.tokens must be a non-empty array"); process.exit(1);
}
if (!Array.isArray(botIds) || botIds.length === 0) {
  console.error("[fatal] CONFIG.botIds must be a non-empty array"); process.exit(1);
}

try {
  Intl.DateTimeFormat(undefined, { timeZone: timezone });
} catch (_) {
  console.error(`[fatal] Invalid timezone "${timezone}"`); process.exit(1);
}

for (const entry of tokens) {
  const times = Array.isArray(entry.voteAt) ? entry.voteAt : [entry.voteAt];
  for (const t of times) {
    if (!/^\d{1,2}:\d{2}$/.test(t)) {
      console.error(`[fatal] Invalid voteAt time "${t}" — must be HH:MM`); process.exit(1);
    }
  }
}

function getTimezoneOffsetMs(tz, date) {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr  = date.toLocaleString("en-US", { timeZone: tz });
  return new Date(tzStr) - new Date(utcStr);
}

function msUntilNext(h, m, tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parseInt(parts.find(p => p.type === type).value);
  const year = get("year"), month = get("month") - 1, day = get("day");
  const candidate = new Date(
    Date.UTC(year, month, day, h, m, 0) -
    getTimezoneOffsetMs(tz, new Date(Date.UTC(year, month, day, h, m, 0)))
  );
  if (candidate <= now) {
    const tomorrow = new Date(Date.UTC(year, month, day + 1, h, m, 0));
    return tomorrow - getTimezoneOffsetMs(tz, tomorrow) - now;
  }
  return candidate - now;
}

function formatMs(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function nowISO() { return new Date().toISOString(); }

async function scheduleSlot(token, h, m, label) {
  const short = token.slice(0, 5) + "...";
  while (true) {
    const wait = msUntilNext(h, m, timezone);
    console.log(`[${nowISO()}] [scheduler] Token ${short} slot ${label} (${timezone}) fires in ${formatMs(wait)}`);
    await new Promise(r => setTimeout(r, wait));
    console.log(`[${nowISO()}] [scheduler] Token ${short} slot ${label} firing now`);
    await voteAllBotsForToken(token, botIds);
    await new Promise(r => setTimeout(r, 61000));
  }
}

for (const entry of tokens) {
  const { token, voteAt } = entry;
  const times = Array.isArray(voteAt) ? voteAt : [voteAt];
  for (const time of times) {
    const [h, m] = time.split(":").map(Number);
    scheduleSlot(token, h, m, time).catch(err => {
      console.error(`[fatal] scheduler crashed for token ${token.slice(0, 5)} slot ${time}: ${err.message}`);
    });
  }
}

console.log(`[${nowISO()}] [main] Using timezone: ${timezone}`);
console.log(`[${nowISO()}] [main] Scheduler started — ${tokens.length} token(s), ${botIds.length} bot(s)`);
