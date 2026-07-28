// Human-readable timestamp in the configured TIMEZONE (falls back to UTC if
// unset/invalid), e.g. "Jul 27, 2026, 9:39:01 AM" instead of raw ISO 8601 UTC.
const LOG_TIMEZONE = process.env.TIMEZONE || "UTC";

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

module.exports = { nowFormatted, log };
