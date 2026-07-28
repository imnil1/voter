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
  if (entry.voteAt === undefined || entry.voteAt === null) continue; // immediate-run token, no times to validate
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

function nextFireDate(h, m, tz) {
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
    return new Date(tomorrow - getTimezoneOffsetMs(tz, tomorrow));
  }
  return candidate;
}

function msUntilNext(h, m, tz) {
  return nextFireDate(h, m, tz) - new Date();
}

function formatFireTime(date, tz) {
  return date.toLocaleString("en-US", {
    timeZone: tz,
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function formatMs(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function nowISO() {
  try {
    return new Date().toLocaleString("en-US", {
      timeZone: timezone,
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit",
      hour12: true,
    });
  } catch (_) {
    return new Date().toISOString();
  }
}

const TURNSTILE_RETRY_MS = 10 * 60 * 1000; // retry Turnstile-blocked bots after 10 min
const TURNSTILE_MAX_RETRIES = 3; // give up after this many retries until the next scheduled slot

async function retryTurnstileBots(token, tokenLabel, botIdsToRetry, attempt = 1) {
  console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} retrying ${botIdsToRetry.length} Turnstile-blocked bot(s), attempt ${attempt}`);
  const results = await voteAllBotsForToken(token, botIdsToRetry, tokenLabel);

  const stillBlocked = botIdsToRetry.filter(id => results[id] === "turnstile");
  if (stillBlocked.length === 0) {
    console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} all retried bots resolved`);
    return;
  }
  if (attempt >= TURNSTILE_MAX_RETRIES) {
    console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} giving up on ${stillBlocked.length} bot(s) after ${attempt} retries — will try again at next scheduled slot`);
    return;
  }

  console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} ${stillBlocked.length} bot(s) still Turnstile-blocked, retrying again in ${formatMs(TURNSTILE_RETRY_MS)}`);
  await new Promise(r => setTimeout(r, TURNSTILE_RETRY_MS));
  await retryTurnstileBots(token, tokenLabel, stillBlocked, attempt + 1);
}

async function scheduleSlot(token, tokenLabel, h, m, slotLabel) {
  while (true) {
    const fireDate = nextFireDate(h, m, timezone);
    const wait = fireDate - new Date();
    console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} slot ${slotLabel} (${timezone}) fires at ${formatFireTime(fireDate, timezone)}`);
    await new Promise(r => setTimeout(r, wait));
    console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} slot ${slotLabel} firing now`);

    const results = await voteAllBotsForToken(token, botIds, tokenLabel);
    const turnstileBlocked = botIds.filter(id => results[id] === "turnstile");

    if (turnstileBlocked.length > 0) {
      console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} ${turnstileBlocked.length} bot(s) blocked by Turnstile, will retry in ${formatMs(TURNSTILE_RETRY_MS)}`);
      // Fire-and-forget so the main 12h slot loop below isn't held up.
      retryTurnstileBots(token, tokenLabel, turnstileBlocked).catch(err => {
        console.error(`[${nowISO()}] [scheduler] Token ${tokenLabel} retry chain crashed: ${err.message}`);
      });
    }

    await new Promise(r => setTimeout(r, 61000));
  }
}

async function runImmediately(token, tokenLabel) {
  console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} has no voteAt — running immediately`);

  const results = await voteAllBotsForToken(token, botIds, tokenLabel);
  const turnstileBlocked = botIds.filter(id => results[id] === "turnstile");

  if (turnstileBlocked.length > 0) {
    console.log(`[${nowISO()}] [scheduler] Token ${tokenLabel} ${turnstileBlocked.length} bot(s) blocked by Turnstile, will retry in ${formatMs(TURNSTILE_RETRY_MS)}`);
    retryTurnstileBots(token, tokenLabel, turnstileBlocked).catch(err => {
      console.error(`[${nowISO()}] [scheduler] Token ${tokenLabel} retry chain crashed: ${err.message}`);
    });
  }
}

for (const entry of tokens) {
  const { token, voteAt, label } = entry;
  const tokenLabel = label || (token.slice(0, 5) + "...");

  if (voteAt === undefined || voteAt === null) {
    runImmediately(token, tokenLabel).catch(err => {
      console.error(`[fatal] immediate run crashed for token ${tokenLabel}: ${err.message}`);
    });
    continue;
  }

  const times = Array.isArray(voteAt) ? voteAt : [voteAt];
  for (const time of times) {
    const [h, m] = time.split(":").map(Number);
    scheduleSlot(token, tokenLabel, h, m, time).catch(err => {
      console.error(`[fatal] scheduler crashed for token ${tokenLabel} slot ${time}: ${err.message}`);
    });
  }
}

console.log(`[${nowISO()}] [main] Using timezone: ${timezone}`);
console.log(`[${nowISO()}] [main] Scheduler started — ${tokens.length} token(s), ${botIds.length} bot(s)`);

// Keeps the process alive indefinitely, even if every configured token is
// immediate-run-only (no voteAt) and has nothing left to schedule — without
// this, Node's event loop can empty out and the process exits naturally
// once all one-shot runs finish, which looks like a crash but isn't one.
// No log line needed here — the interval itself is what matters, not
// printing anything on each tick (was cluttering logs every 5 min).
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
setInterval(() => {}, HEARTBEAT_INTERVAL_MS);
