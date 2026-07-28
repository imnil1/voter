const { delay } = require("./util");
const { log } = require("./logging");

// Detects a Cloudflare Turnstile challenge iframe on the page.
async function isTurnstilePresent(page) {
  try {
    return await page.evaluate(() => {
      const iframes = [...document.querySelectorAll("iframe")];
      return iframes.some(f => (f.src || "").includes("challenges.cloudflare.com"));
    });
  } catch (_) {
    return false;
  }
}

// Polls for a Turnstile challenge over several seconds instead of checking
// once after a fixed delay — Cloudflare's injection timing varies, and a
// single early check can miss a challenge that renders a bit slower.
//
// Logs each iteration's outcome (with elapsed time) so a poll that exits
// earlier than its nominal timeoutMs is visible in the logs instead of
// showing up as an unexplained gap between two timestamps — previously
// indistinguishable from "genuinely no Turnstile in 6s" versus "the loop
// exited early for some other reason" (e.g. an evaluate() error from the
// page navigating mid-check), which made a real occurrence hard to
// diagnose after the fact. Uses its own try/catch around evaluate()
// directly (rather than calling isTurnstilePresent) so it can log the
// distinction between "not found" and "check errored" per iteration.
async function pollForTurnstile(page, timeoutMs = 6000, intervalMs = 750, shortT = "?") {
  const start = Date.now();
  let iteration = 0;
  while (Date.now() - start < timeoutMs) {
    iteration++;
    const elapsed = Date.now() - start;
    try {
      const found = await page.evaluate(() => {
        const iframes = [...document.querySelectorAll("iframe")];
        return iframes.some(f => (f.src || "").includes("challenges.cloudflare.com"));
      });
      if (found) {
        log(`[turnstile:${shortT}] poll #${iteration} at ${elapsed}ms: Turnstile iframe found`);
        return true;
      }
      log(`[turnstile:${shortT}] poll #${iteration} at ${elapsed}ms: not found yet`);
    } catch (err) {
      log(`[turnstile:${shortT}] poll #${iteration} at ${elapsed}ms: evaluate() error (likely mid-navigation) — ${err.message}`);
    }
    await delay(intervalMs);
  }
  log(`[turnstile:${shortT}] poll window closed after ${iteration} iteration(s), ${Date.now() - start}ms elapsed — no Turnstile found`);
  return false;
}

// Extracts the Turnstile sitekey from the page. Checks the common places it
// appears: a [data-sitekey] element, or embedded in the challenge iframe's src.
async function getTurnstileSitekey(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector("[data-sitekey]");
      if (el) return el.getAttribute("data-sitekey");

      const iframe = [...document.querySelectorAll("iframe")]
        .find(f => (f.src || "").includes("challenges.cloudflare.com"));
      if (iframe) {
        try {
          const url = new URL(iframe.src);
          // sitekey commonly appears as a path segment after /turnstile/if/ove/
          const match = url.pathname.match(/\/([0-9a-zA-Z_-]{20,})\//);
          if (match) return match[1];
        } catch (_) {}
      }
      return null;
    });
  } catch (_) {
    return null;
  }
}

// Injects a solved Turnstile token into the page's hidden response field,
// matching what a real solve would populate.
async function injectTurnstileToken(page, tokenValue) {
  return page.evaluate((val) => {
    const candidates = [
      'input[name="cf-turnstile-response"]',
      'textarea[name="cf-turnstile-response"]',
      'input[name="g-recaptcha-response"]', // some Turnstile embeds reuse this name
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }, tokenValue);
}

// Submits a Turnstile solve task to the self-hosted icemellow-me solver
// (2captcha-compatible API) and polls until solved, failed, or timed out.
// Returns the token string, or null if solving failed/unavailable.
// Reads env vars fresh on each call (rather than once at module load) so
// credentials can be rotated via Railway without requiring a redeploy.
async function solveTurnstile(sitekey, pageUrl, shortT) {
  const SOLVER_URL = (process.env.TURNSTILE_SOLVER_URL || "").replace(/\/$/, "");
  const SOLVER_KEY = process.env.TURNSTILE_SOLVER_KEY || "";

  if (!SOLVER_URL || !SOLVER_KEY) {
    log(`[turnstile-solver:${shortT}] TURNSTILE_SOLVER_URL/KEY not configured, skipping solve attempt`);
    return null;
  }
  if (!sitekey) {
    log(`[turnstile-solver:${shortT}] Could not extract sitekey, skipping solve attempt`);
    return null;
  }

  try {
    const submitUrl = `${SOLVER_URL}/in.php?key=${encodeURIComponent(SOLVER_KEY)}&method=turnstile&sitekey=${encodeURIComponent(sitekey)}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
    const submitRes = await fetch(submitUrl, { signal: AbortSignal.timeout(15000) });
    const submitJson = await submitRes.json();
    if (submitJson.status !== 1) {
      log(`[turnstile-solver:${shortT}] Submit failed: ${JSON.stringify(submitJson)}`);
      return null;
    }
    const taskId = submitJson.request;
    log(`[turnstile-solver:${shortT}] Task submitted (${taskId}), polling...`);

    const POLL_TIMEOUT_MS = 60_000;
    const POLL_INTERVAL_MS = 3000;
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await delay(POLL_INTERVAL_MS);
      const pollUrl = `${SOLVER_URL}/res.php?key=${encodeURIComponent(SOLVER_KEY)}&id=${encodeURIComponent(taskId)}&json=1`;
      const pollRes = await fetch(pollUrl, { signal: AbortSignal.timeout(10000) });
      const pollJson = await pollRes.json();

      if (pollJson.status === 1) {
        log(`[turnstile-solver:${shortT}] Solved after ${Math.round((Date.now() - start) / 1000)}s`);
        return pollJson.request;
      }
      if (pollJson.request && pollJson.request !== "CAPCHA_NOT_READY") {
        log(`[turnstile-solver:${shortT}] Solve failed: ${pollJson.request}`);
        return null;
      }
    }
    log(`[turnstile-solver:${shortT}] Solve timed out after ${POLL_TIMEOUT_MS / 1000}s`);
    return null;
  } catch (err) {
    log(`[turnstile-solver:${shortT}] Solver request error: ${err.message}`);
    return null;
  }
}

// Combines sitekey extraction, calling the solver API, and injecting the
// resulting token into the page. Returns true if a token was successfully
// obtained and injected, false otherwise (caller should fall back to skip).
async function trySolveTurnstileOnPage(page, shortT) {
  const sitekey = await getTurnstileSitekey(page);
  const pageUrl = page.url();
  const token = await solveTurnstile(sitekey, pageUrl, shortT);
  if (!token) return false;

  const injected = await injectTurnstileToken(page, token);
  if (!injected) {
    log(`[turnstile-solver:${shortT}] Got token but found no field to inject it into`);
    return false;
  }
  return true;
}

module.exports = {
  isTurnstilePresent,
  pollForTurnstile,
  getTurnstileSitekey,
  injectTurnstileToken,
  solveTurnstile,
  trySolveTurnstileOnPage,
};
