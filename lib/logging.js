// Human-readable timestamp in the configured TIMEZONE (falls back to UTC if
// unset/invalid), e.g. "Jul 27, 2026, 9:39:01 AM" instead of raw ISO 8601 UTC.
const LOG_TIMEZONE = process.env.TIMEZONE || "UTC";

// Off by default — the per-iteration Turnstile poll logs, full cookie
// dumps, and similar detail were added as diagnostics while chasing
// specific bugs (a poll exiting early, a session not persisting, etc.).
// They earned their keep for that debugging, but are too noisy for normal
// day-to-day runs. Set VERBOSE_LOGS=true (or 1) in the environment to bring
// them back on demand without touching code — e.g. while investigating a
// new issue — without permanently cluttering every run's logs.
const VERBOSE_LOGS = /^(true|1)$/i.test(process.env.VERBOSE_LOGS || "");

function nowFormatted() {
  try {
    return new Date().toLocaleString("en-US", {
      timeZone: LOG_TIMEZONE,
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit",
      hour12: true,
    });
  } catch (_) {
    return new Date().toISOString();
  }
}

function log(msg) {
  console.log(`[${nowFormatted()}] ${msg}`);
}

// Same as log(), but only prints when VERBOSE_LOGS is enabled. Use for
// high-frequency/diagnostic-only detail (poll iterations, full cookie
// dumps, etc.) that's valuable while actively debugging but too noisy for
// normal operation.
function logVerbose(msg) {
  if (VERBOSE_LOGS) log(msg);
}

module.exports = { nowFormatted, log, logVerbose, VERBOSE_LOGS };

