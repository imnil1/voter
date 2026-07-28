const { delay } = require("./util");
const { log, logVerbose } = require("./logging");

// Detects a Cloudflare Turnstile challenge on the page.
//
// Root cause (confirmed via captured page HTML from a real occurrence):
// Cloudflare renders Turnstile as `<div id="cf-turnstile"> -> #shadow-root
// (closed) -> <iframe src="https://challenges.cloudflare.com/...">`. The
// shadow root is CLOSED, meaning its contents — including that iframe —
// are unreachable from `document.querySelectorAll` or any outside JS,
// by design (this is a JS/DOM limitation, not a timing issue, and not
// something patchright's stealth patches address — closed-shadow-DOM
// piercing is an open, unresolved feature request against patchright
// itself as of this writing).
//
// The fix: the shadow HOST element (`#cf-turnstile`) is regular light DOM
// sitting outside the shadow boundary, so it's fully visible to a normal
// query even though its contents aren't. That's the primary signal now.
// The iframe-src substring check is kept as a secondary/fallback signal
// for cases where the widget isn't shadow-DOM-enclosed (or the id changes
// in a future Cloudflare update) — either match is sufficient.
async function isTurnstilePresent(page, shortT = "?") {
  try {
    const { found, foundVia, allSrcs } = await page.evaluate(() => {
      const hasHostDiv = !!document.querySelector('div[id^="cf-turnstile"], div.cf-turnstile, [data-sitekey]');

      const iframes = [...document.querySelectorAll("iframe")];
      const srcs = iframes.map(f => f.src || "(no src)");
      const hasMatchingIframeSrc = iframes.some(f => (f.src || "").includes("challenges.cloudflare.com"));

      let foundVia = null;
      if (hasHostDiv) foundVia = "host-div";
      else if (hasMatchingIframeSrc) foundVia = "iframe-src";

      return { found: hasHostDiv || hasMatchingIframeSrc, foundVia, allSrcs: srcs };
    });

    if (found) {
      logVerbose(`[turnstile-diag:${shortT}] Turnstile detected via ${foundVia}`);
    } else if (allSrcs.length > 0) {
      logVerbose(`[turnstile-diag:${shortT}] no Turnstile host-div or matching iframe; ${allSrcs.length} iframe(s) present: ${JSON.stringify(allSrcs)}`);
    } else {
      logVerbose(`[turnstile-diag:${shortT}] no Turnstile host-div and no iframes present at all on this check`);
    }
    return found;
  } catch (err) {
    logVerbose(`[turnstile-diag:${shortT}] isTurnstilePresent evaluate() error: ${err.message}`);
    return false;
  }
}

// Detects the rare full-page Cloudflare interstitial ("Checking your
// browser...", "Just a moment...", etc.) as opposed to the common
// embedded Turnstile widget that appears inline within the top.gg vote
// page itself. Distinct from isTurnstilePresent() because the interstitial
// replaces the whole page (no top.gg DOM at all), whereas the embedded
// widget is one element within an otherwise-normal top.gg page — they call
// for different handling (a full interstitial means "wait for a redirect
// back", not "solve this specific widget").
async function isCloudflareInterstitial(page) {
  try {
    return await page.evaluate(() => {
      const bodyText = document.body.innerText || "";
      const patterns = [
        /performing security verification/i,
        /checking your browser/i,
        /attention required/i,
        /just a moment/i,
      ];
      if (patterns.some(p => p.test(bodyText))) return true;
      // /cdn-cgi/ and /challenge-platform/ show up in Cloudflare's own
      // injected script/frame URLs during the interstitial, not during a
      // normal top.gg page load.
      const scripts = [...document.querySelectorAll("script[src], iframe[src]")];
      return scripts.some(el => /\/cdn-cgi\/|\/challenge-platform\//.test(el.src || ""));
    });
  } catch (_) {
    return false;
  }
}

// Post-click page-state detector. Rather than a sequence of separate
// one-shot checks with gaps between them (the previous design — poll once
// for Turnstile right after the click, check confirmation once, check
// Turnstile again before a retry, etc.), this gives a single answer per
// call covering the whole state space, meant to be called in one
// continuous loop (see pollPostClickState below). A late-appearing
// Turnstile — confirmed to have happened twice in production, both times
// slipping through the gap between two separate one-shot checks — can't
// slip through a state a continuous loop is always watching for.
//
// Returns one of:
//   "success"      - the "Thanks for voting!" confirmation is showing
//   "already"      - "already voted" / cooldown screen
//   "interstitial" - full-page Cloudflare challenge (rare)
//   "captcha"      - embedded Turnstile widget on an otherwise-normal page
//   "unknown"      - none of the above yet; caller should keep polling
async function getPostClickPageState(page, shortT = "?") {
  try {
    if (await isCloudflareInterstitial(page)) return "interstitial";

    const domState = await page.evaluate(() => {
      const bodyText = document.body.innerText || "";
      if ([...document.querySelectorAll("h2")].some(h => /thanks for voting/i.test(h.textContent))) {
        return "success";
      }
      if (/you have already voted/i.test(bodyText) || /you can vote again/i.test(bodyText)) {
        return "already";
      }
      return null;
    });
    if (domState) return domState;

    if (await isTurnstilePresent(page, shortT)) return "captcha";

    return "unknown";
  } catch (_) {
    return "unknown";
  }
}

// Continuously polls page state after a vote click until it resolves to
// something other than "unknown", or timeoutMs elapses. This replaces the
// old pattern of checking Turnstile once, then confirmation once, then
// Turnstile again before a retry — each of those had its own gap where a
// challenge could appear in between checks and be missed entirely (this
// happened twice in production: a Turnstile screenshot was caught by a
// debug capture that the state checks around it never detected). A single
// loop that's always watching removes those gaps.
async function pollPostClickState(page, timeoutMs = 20000, intervalMs = 750, shortT = "?") {
  const start = Date.now();
  let iteration = 0;
  while (Date.now() - start < timeoutMs) {
    iteration++;
    const elapsed = Date.now() - start;
    const state = await getPostClickPageState(page, shortT);
    if (state !== "unknown") {
      logVerbose(`[vote-state:${shortT}] poll #${iteration} at ${elapsed}ms: ${state}`);
      return state;
    }
    logVerbose(`[vote-state:${shortT}] poll #${iteration} at ${elapsed}ms: unknown, still waiting`);
    await delay(intervalMs);
  }
  log(`[vote-state:${shortT}] Post-click state poll timed out after ${Date.now() - start}ms with no resolved state`);
  return "unknown";
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
//
// Retained for backward compatibility / narrower use elsewhere; the main
// post-click flow in voteForBot now uses pollPostClickState() instead,
// which watches the full page state rather than only Turnstile.
async function pollForTurnstile(page, timeoutMs = 6000, intervalMs = 750, shortT = "?") {
  const start = Date.now();
  let iteration = 0;
  while (Date.now() - start < timeoutMs) {
    iteration++;
    const elapsed = Date.now() - start;
    try {
      const found = await page.evaluate(() => {
        const hasHostDiv = !!document.querySelector('div[id^="cf-turnstile"], div.cf-turnstile, [data-sitekey]');
        const iframes = [...document.querySelectorAll("iframe")];
        const hasMatchingIframeSrc = iframes.some(f => (f.src || "").includes("challenges.cloudflare.com"));
        return hasHostDiv || hasMatchingIframeSrc;
      });
      if (found) {
        logVerbose(`[turnstile:${shortT}] poll #${iteration} at ${elapsed}ms: Turnstile iframe found`);
        return true;
      }
      logVerbose(`[turnstile:${shortT}] poll #${iteration} at ${elapsed}ms: not found yet`);
    } catch (err) {
      logVerbose(`[turnstile:${shortT}] poll #${iteration} at ${elapsed}ms: evaluate() error (likely mid-navigation) — ${err.message}`);
    }
    await delay(intervalMs);
  }
  logVerbose(`[turnstile:${shortT}] poll window closed after ${iteration} iteration(s), ${Date.now() - start}ms elapsed — no Turnstile found`);
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
  isCloudflareInterstitial,
  getPostClickPageState,
  pollPostClickState,
  pollForTurnstile,
  getTurnstileSitekey,
  injectTurnstileToken,
  solveTurnstile,
  trySolveTurnstileOnPage,
};
