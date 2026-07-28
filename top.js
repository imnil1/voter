const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COOKIE_DIR = process.env.COOKIE_DIR || "./cookies";
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "./screenshots";

const crypto = require("crypto");

function cookiePath(token) {
  // Hash rather than slice the raw token — two tokens sharing the same
  // first N characters (plausible given common token-format prefixes)
  // would otherwise silently overwrite each other's saved cookies.
  const hash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  return path.join(COOKIE_DIR, `${hash}.json`);
}

function loadCookies(token) {
  try {
    const p = cookiePath(token);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {}
  return null;
}

function saveCookies(token, cookies) {
  try {
    if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR, { recursive: true });
    fs.writeFileSync(cookiePath(token), JSON.stringify(cookies, null, 2));
  } catch (err) {
    console.error(`[cookies] Failed to save: ${err.message}`);
  }
}

function clearCookies(token) {
  try {
    const p = cookiePath(token);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

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
function log(msg) { console.log(`[${nowFormatted()}] ${msg}`); }

// Saves a full-page screenshot for debugging unconfirmed/failed votes.
// Filename includes label, botId, and a timestamp so repeated failures
// don't overwrite each other. Never throws — a screenshot failure should
// never crash the vote flow itself.
//
// Known Playwright/Chromium quirks this specifically works around:
//  - `networkidle` is documented as unreliable on pages with polling,
//    analytics, or third-party iframes (Discord/top.gg/Turnstile all
//    qualify) — it can time out every single time instead of settling,
//    silently wasting the full timeout for nothing. `load` is used instead,
//    since DOMContentLoaded + resource load is a deterministic event that
//    will always fire, unlike networkidle's "no network activity" window.
//  - Full-page screenshots duplicate or distort `position: fixed`/`sticky`
//    elements (nav bars, cookie banners, Turnstile overlays) because
//    Chromium expands the capture surface but fixed elements re-pin
//    themselves at every scroll position during the stitch. Converting
//    them to `absolute` just before capture (and only in memory, on a
//    throwaway debug page — never on the live interaction page) avoids this.
//  - If the page/context/browser already closed (e.g. mid-crash, which is
//    exactly when this function tends to get called), every call below can
//    throw "Target page, context or browser has been closed". This is
//    expected in that case and is now logged distinctly from a genuine
//    screenshot bug, so the two aren't indistinguishable in the logs.
async function saveDebugScreenshot(page, label, botId, reason, fullPage = false) {
  try {
    if (page.isClosed()) {
      log(`[screenshot:${label}] Skipped for bot ${botId} (${reason}) — page already closed`);
      return;
    }

    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // "load" instead of "networkidle" — deterministic, won't burn the full
    // timeout on pages with continuous background network activity.
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    // Small settle delay for any last lazy-rendered content/images.
    await delay(500);

    // Re-assert viewport in case a navigation/redirect reset it — CDP-connected
    // sessions can be less reliable about retaining viewport size than a
    // locally-launched browser.
    await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});

    if (fullPage) {
      // Neutralize fixed/sticky elements only for the duration of this
      // capture so full-page screenshots don't show duplicated/smeared
      // headers or overlays. Restored immediately after regardless of
      // whether the screenshot itself succeeds.
      await page.evaluate(() => {
        const fixedEls = [];
        for (const el of document.querySelectorAll("*")) {
          const pos = window.getComputedStyle(el).position;
          if (pos === "fixed" || pos === "sticky") {
            fixedEls.push([el, el.style.position]);
            el.style.position = "absolute";
          }
        }
        window.__debugScreenshotRestoreFixed = () => {
          for (const [el, original] of fixedEls) el.style.position = original;
        };
      }).catch(() => {});
    }

    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${safeLabel}_${botId}_${reason}_${timestamp}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);

    try {
      await page.screenshot({ path: filepath, fullPage, timeout: 15000 });
      log(`[screenshot:${label}] Saved debug screenshot for bot ${botId}: ${filename}`);
    } finally {
      if (fullPage) {
        await page.evaluate(() => {
          if (window.__debugScreenshotRestoreFixed) {
            window.__debugScreenshotRestoreFixed();
            delete window.__debugScreenshotRestoreFixed;
          }
        }).catch(() => {});
      }
    }
  } catch (err) {
    if (/closed/i.test(err.message)) {
      log(`[screenshot:${label}] Could not capture for bot ${botId} (${reason}) — page/context/browser closed before or during capture`);
    } else {
      log(`[screenshot:${label}] Failed to save screenshot: ${err.message}`);
    }
  }
}

// Overridable via env var so keeping the UA's claimed Chrome version in
// sync with browserless-v2's actual Chromium build doesn't require a code
// change/redeploy — just a Railway env var update.
const SPOOFED_USER_AGENT = process.env.SPOOFED_USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Applies the same viewport + UA setup to any page — used for both the
// initial auth page and every pre-opened bot tab, so every tab gets
// identical, correctly-sized rendering and consistent fingerprinting
// instead of only the first page getting it.
async function preparePage(page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({ "User-Agent": SPOOFED_USER_AGENT });
  return page;
}

async function connectBrowser() {
  const baseWsEndpoint = process.env.BROWSER_WS_URL;
  if (!baseWsEndpoint) throw new Error("BROWSER_WS_URL is not set");

  // browserless v2 can render in an undersized frame regardless of any
  // post-connect page.setViewportSize() call. Browserless staff recommend
  // combining both defaultViewport (page-level) and --window-size (actual
  // Chrome window) in the same launch param for reliability.
  // See: https://github.com/browserless/browserless/discussions/3910
  const launchParams = JSON.stringify({
    defaultViewport: { width: 1920, height: 1080 },
    args: ["--window-size=1920,1080"],
  });
  const separator = baseWsEndpoint.includes("?") ? "&" : "?";
  const wsEndpoint = `${baseWsEndpoint}${separator}launch=${encodeURIComponent(launchParams)}`;

  log(`[browser] Connecting via Playwright (CDP)...`);
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  await preparePage(page);
  const actualViewport = page.viewportSize();
  log(`[browser] Viewport set to ${actualViewport?.width}x${actualViewport?.height}`);
  return { browser, context, page };
}

// Checks for the actual "Login" *button* in the top nav, not just the
// substring "Login" anywhere in body text — top.gg's page can contain the
// word "Login" in other contexts (banners, ads, etc.) independent of
// session state, so text-matching alone is not a reliable signal. A logged
// out session shows a clickable "Login" button in the top-right nav; a
// logged-in session replaces it with the user's avatar and no such button.
async function hasLoginButton(page) {
  const loginBtn = page.locator("button", { hasText: "Login" }).first();
  return loginBtn.isVisible().catch(() => false);
}

async function isLoggedInToTopgg(page) {
  try {
    await page.goto("https://top.gg", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    return !(await hasLoginButton(page));
  } catch (_) {
    return false;
  }
}

async function doOAuth(page, token, label) {
  log(`[auth:${label}] Setting Discord token in localStorage...`);
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", `"${t}"`);
  }, token);

  await page.goto("https://top.gg", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  log(`[auth:${label}] Clicking login button...`);
  const loginVisible = await hasLoginButton(page);

  if (!loginVisible) {
    log(`[auth:${label}] Already logged in`);
    return;
  }

  const loginBtn = page.locator("button", { hasText: "Login" }).first();
  await loginBtn.click();
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  } catch (err) {
    await saveDebugScreenshot(page, label, "oauth", "post-login-click-timeout", true);
    throw err;
  }

  log(`[auth:${label}] Waiting for Discord consent page to render...`);
  // Discord's consent screen requires scrolling its permissions-list
  // container to the end before "Authorize" replaces a "Keep Scrolling..."
  // button. The container has CSS-module classes with a hash suffix that
  // can change between Discord deploys (confirmed as of writing:
  // "body__8a031 auto_d125d2 scrollerBase_d125d2") — matching on the
  // stable "scrollerBase" substring instead of the exact hashed name.
  const scrollableBtn = page.locator("button", { hasText: /authoriz|allow|yes|keep scrolling/i }).first();
  try {
    await scrollableBtn.waitFor({ state: "visible", timeout: 30000 });
  } catch (err) {
    await saveDebugScreenshot(page, label, "oauth", "authorize-button-missing", true);
    throw err;
  }

  const scrolled = await page.evaluate(() => {
    const el = [...document.querySelectorAll("div[class*='scrollerBase']")][0];
    if (el) {
      el.scrollTop = el.scrollHeight;
      return true;
    }
    return false;
  }).catch(() => false);
  log(`[auth:${label}] Scrolled consent list to bottom: ${scrolled}`);
  await delay(500);

  let authorizeBtn = page.locator("button", { hasText: /authoriz|allow|yes/i }).first();
  let authorizeVisible = await authorizeBtn.waitFor({ state: "visible", timeout: 15000 })
    .then(() => true).catch(() => false);

  if (!authorizeVisible) {
    // Scroll alone didn't reveal it — fall back to zooming out (shrinks the
    // whole page so the list fits without scrolling) combined with a
    // broader scroller-container match, matching the approach in the
    // reference implementation (captcha_helper.py).
    log(`[auth:${label}] Authorize still hidden after scroll — trying zoom-out fallback...`);
    await page.evaluate(() => { document.body.style.zoom = "0.5"; }).catch(() => {});
    await delay(1000);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); }).catch(() => {});
    await delay(1000);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("[class*='scroller']")][0];
      if (el) el.scrollTop = el.scrollHeight;
    }).catch(() => {});
    await delay(1000);

    authorizeBtn = page.locator("button", { hasText: /authoriz|allow|yes/i }).first();
    authorizeVisible = await authorizeBtn.waitFor({ state: "visible", timeout: 15000 })
      .then(() => true).catch(() => false);
  }

  if (!authorizeVisible) {
    await saveDebugScreenshot(page, label, "oauth", "authorize-still-scrolling", true);
    throw new Error("Authorize button never became visible after scroll and zoom-out attempts");
  }

  log(`[auth:${label}] Clicking authorize...`);
  await authorizeBtn.click();

  // Restore normal zoom in case the fallback path changed it, so later
  // screenshots and interactions on top.gg aren't affected.
  await page.evaluate(() => { document.body.style.zoom = "1"; }).catch(() => {});

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });

  // `networkidle` is unreliable here (see saveDebugScreenshot's comments —
  // continuous background activity from analytics/Turnstile-adjacent
  // scripts can make it silently time out every time), so rather than
  // trusting a fixed settle delay before checking login state, poll for
  // the state to actually resolve one way or the other. This closes a race
  // where hasLoginButton() could run on a page still mid-redirect from
  // Discord back to top.gg, before either the Login button or the logged-in
  // UI has actually rendered — which would make a real login look like a
  // false failure (or vice versa).
  const OAUTH_SETTLE_TIMEOUT_MS = 15000;
  const settleStart = Date.now();
  let stillLoggedOut = true;
  while (Date.now() - settleStart < OAUTH_SETTLE_TIMEOUT_MS) {
    stillLoggedOut = await hasLoginButton(page);
    if (!stillLoggedOut) break;
    await delay(500);
  }

  if (stillLoggedOut) {
    const currentUrl = page.url();
    log(`[auth:${label}] Still shows logged out after authorize (waited ${OAUTH_SETTLE_TIMEOUT_MS / 1000}s) — current URL: ${currentUrl}`);
    await saveDebugScreenshot(page, label, "oauth", "still-logged-out-after-authorize", true);
    throw new Error("Authorization failed - Discord OAuth did not complete");
  }
  log(`[auth:${label}] Authorization successful (on ${page.url()})`);
  // Confirm this success is real, not a transient false-positive from the
  // login-button poll — capture the actual post-auth page state so a
  // regression (session reported successful here but logged-out on the
  // next navigation) is visible in the screenshot, not just inferred from
  // a later timeout several bots downstream.
  await saveDebugScreenshot(page, label, "oauth", "post-authorize-confirmed", true);
}

// DOM-structure-based state check (not text matching) — more robust to copy changes.
// "vote"    -> a vote button is present and clickable
// "already" -> the page indicates a vote was already cast (cooldown screen)
// "ad-wait" -> the fixed ~10s ad countdown before the Vote button appears
// "unknown" -> none of the above; caller should keep polling or bail
async function getVotePageState(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || "";

    if (/you have already voted/i.test(bodyText) || /you can vote again/i.test(bodyText)) {
      return "already";
    }
    if (/you will be able to vote after this ad/i.test(bodyText)) {
      return "ad-wait";
    }
    const btn = document.querySelector("button.button-primary:not([disabled])");
    if (btn && /vote/i.test(btn.textContent) && !/already/i.test(bodyText)) return "vote";
    return "unknown";
  });
}

// Detects the post-vote success screen ("Thanks for voting!"), which is the
// actual confirmation text top.gg shows now — not "already voted". Used by
// every confirmation check in voteForBot (initial, after late Turnstile,
// and after retry) so there's a single source of truth for this check.
async function isVoteConfirmed(page, timeoutMs = 15000) {
  return page.waitForFunction(
    () => [...document.querySelectorAll("h2")].some(h => /thanks for voting/i.test(h.textContent)),
    { timeout: timeoutMs }
  ).then(() => true).catch(() => false);
}

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
async function pollForTurnstile(page, timeoutMs = 6000, intervalMs = 750) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isTurnstilePresent(page)) return true;
    await delay(intervalMs);
  }
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

async function getVoteCountdownMs(page) {
  return page.evaluate(() => {
    const p = [...document.querySelectorAll("p")]
      .find(el => /vote again/i.test(el.textContent));
    const text = p?.textContent || "";
    const hourMatch = text.match(/(\d+)\s*hour/i);
    const minMatch  = text.match(/(\d+)\s*min/i);
    if (hourMatch) return parseInt(hourMatch[1]) * 60 * 60 * 1000;
    if (minMatch)  return parseInt(minMatch[1])  * 60 * 1000;
    return null;
  });
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

async function waitForVoteStatus(page, timeoutMs) {
  // Note: `timeoutMs` bounds each individual polling phase, not the overall
  // call. A cooldown wait resets `start` afterward (see below) so a bot
  // that cycles through several short cooldowns in a row can legitimately
  // run past the nominal `timeoutMs` passed in by the caller — this is
  // intentional (each cooldown is still capped by WAIT_THRESHOLD_MS below),
  // not an unbounded loop.
  const WAIT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  const AD_WAIT_MS = 11 * 1000; // fixed ~10s ad countdown before Vote button appears, +1s buffer
  let start = Date.now();
  let adWaited = false;

  while (true) {
    try {
      const state = await getVotePageState(page);

      if (state === "vote") return "vote";

      if (state === "ad-wait" && !adWaited) {
        log(`[vote] Ad countdown in progress — waiting ${AD_WAIT_MS / 1000}s...`);
        await delay(AD_WAIT_MS);
        adWaited = true; // only wait out the ad once per page load
        continue;
      }

      if (state === "already") {
        const cooldownMs = await getVoteCountdownMs(page);
        if (cooldownMs !== null && cooldownMs <= WAIT_THRESHOLD_MS) {
          log(`[vote] Cooldown is ${Math.round(cooldownMs / 60000)} min — waiting it out...`);
          await delay(cooldownMs + 5000);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          start = Date.now(); // reset timer after cooldown wait
          adWaited = false; // fresh page load may show the ad countdown again
          continue;
        }
        return "already";
      }
    } catch (_) {}

    if (Date.now() - start > timeoutMs) return "timeout";
    await delay(2500);
  }
}

// Navigates with a single retry for two known-transient failure modes:
//  - ERR_ABORTED: a Chromium navigation race (one goto() interrupted by
//    another in-flight navigation, e.g. top.gg's own client-side redirect
//    right after OAuth completes).
//  - a flat navigation timeout ("Timeout 30000ms exceeded"): seen in
//    practice under browserless-v2 resource pressure, but also plausible
//    from an ordinary slow/transient page load even without contention —
//    cheap to retry once either way.
// Any other error is thrown as-is; only these two specific, known-transient
// cases get retried.
async function gotoWithRetry(page, url, shortT, botId) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    if (/ERR_ABORTED/i.test(err.message)) {
      log(`[vote:${shortT}] goto() hit ERR_ABORTED for bot ${botId} — likely a navigation race, retrying once after a short delay...`);
      await delay(1500);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } else if (/timeout/i.test(err.message)) {
      log(`[vote:${shortT}] goto() timed out for bot ${botId} — retrying once after a short delay...`);
      await delay(1500);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } else {
      throw err;
    }
  }
}

async function voteForBot(page, label, botId) {
  const shortT = label;
  const timeoutMs = 60_000;

  const votePageUrl = `https://top.gg/bot/${botId}/vote`;
  log(`[vote:${shortT}] Navigating to vote page for bot ${botId}...`);
  await gotoWithRetry(page, votePageUrl, shortT, botId);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const status = await waitForVoteStatus(page, timeoutMs);
  log(`[vote:${shortT}] Status for bot ${botId}: ${status}`);

  if (status === "vote") {
    const voteBtn = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
    await voteBtn.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await voteBtn.click();
    log(`[vote:${shortT}] Vote button clicked for bot ${botId}, checking for Turnstile...`);

    // Cloudflare can take a few seconds to inject the challenge iframe —
    // poll instead of a single fixed-delay check, so slower renders aren't missed.
    if (await pollForTurnstile(page)) {
      log(`[vote:${shortT}] Turnstile challenge appeared for bot ${botId} — attempting to solve...`);
      const solved = await trySolveTurnstileOnPage(page, shortT);
      if (!solved) {
        log(`[vote:${shortT}] Could not solve Turnstile for bot ${botId} — skipping, will retry later`);
        await saveDebugScreenshot(page, shortT, botId, "turnstile-unsolved");
        return "turnstile";
      }
      log(`[vote:${shortT}] Turnstile solved for bot ${botId}, re-checking vote button...`);
      const revoteBtn = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
      const revoteVisible = await revoteBtn.isVisible().catch(() => false);
      if (revoteVisible) {
        await revoteBtn.click();
        await delay(1500);
      }
    }

    log(`[vote:${shortT}] No Turnstile detected, verifying vote...`);

    // verify via the real success screen text ("Thanks for voting!"), not the
    // stale "already voted" heading top.gg no longer uses for this state.
    const confirmed = await isVoteConfirmed(page);

    if (confirmed) {
      log(`[vote:${shortT}] Vote confirmed for bot ${botId}`);
      return "confirmed";
    }

    // Still no confirmation — check again for a late-appearing Turnstile before retrying the click.
    if (await isTurnstilePresent(page)) {
      log(`[vote:${shortT}] Turnstile challenge appeared (late) for bot ${botId} — attempting to solve...`);
      const solvedLate = await trySolveTurnstileOnPage(page, shortT);
      if (!solvedLate) {
        log(`[vote:${shortT}] Could not solve late Turnstile for bot ${botId} — skipping, will retry later`);
        await saveDebugScreenshot(page, shortT, botId, "turnstile-unsolved-late");
        return "turnstile";
      }
      log(`[vote:${shortT}] Late Turnstile solved for bot ${botId}, re-checking vote button...`);
      const revoteBtn2 = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
      const revoteVisible2 = await revoteBtn2.isVisible().catch(() => false);
      if (revoteVisible2) {
        await revoteBtn2.click();
        await delay(1500);
      }
      const lateConfirmed = await isVoteConfirmed(page);
      if (lateConfirmed) {
        log(`[vote:${shortT}] Vote confirmed for bot ${botId} after solving late Turnstile`);
        return "confirmed";
      }
    }

    log(`[vote:${shortT}] Vote click did not confirm for bot ${botId}, retrying once...`);
    await saveDebugScreenshot(page, shortT, botId, "before-reload");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    // A reload can restart the ~10s ad countdown, so re-run the same status
    // wait used on first load instead of assuming the button is immediately
    // clickable — otherwise a fresh ad-wait screen is misread as "no button".
    const retryStatus = await waitForVoteStatus(page, 30_000);

    if (retryStatus === "already") {
      log(`[vote:${shortT}] Already voted for bot ${botId} (discovered on retry)`);
      return "already";
    }

    if (retryStatus !== "vote") {
      log(`[vote:${shortT}] Retry did not reach a votable state for bot ${botId} (status: ${retryStatus})`);
      await saveDebugScreenshot(page, shortT, botId, "retry-status-" + retryStatus);
      return "failed";
    }

    const retryBtn = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
    const retryVisible = await retryBtn.isVisible().catch(() => false);
    if (retryVisible) {
      await retryBtn.click();
      await delay(1500);
      if (await isTurnstilePresent(page)) {
        log(`[vote:${shortT}] Turnstile challenge appeared on retry for bot ${botId} — attempting to solve...`);
        const solvedRetry = await trySolveTurnstileOnPage(page, shortT);
        if (!solvedRetry) {
          log(`[vote:${shortT}] Could not solve Turnstile on retry for bot ${botId} — skipping, will retry later`);
          await saveDebugScreenshot(page, shortT, botId, "turnstile-unsolved-retry");
          return "turnstile";
        }
        const revoteBtn3 = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
        const revoteVisible3 = await revoteBtn3.isVisible().catch(() => false);
        if (revoteVisible3) {
          await revoteBtn3.click();
        }
        await delay(1500);
      }
      await delay(1500);
      const retryConfirmed = await isVoteConfirmed(page);
      log(`[vote:${shortT}] Retry ${retryConfirmed ? "confirmed" : "still unconfirmed"} for bot ${botId}`);
      if (!retryConfirmed) {
        await saveDebugScreenshot(page, shortT, botId, "unconfirmed");
      }
      return retryConfirmed ? "confirmed" : "failed";
    }
    await saveDebugScreenshot(page, shortT, botId, "no-retry-button");
    return "failed";
  } else if (status === "already") {
    log(`[vote:${shortT}] Already voted for bot ${botId}`);
    return "already";
  } else {
    log(`[vote:${shortT}] Vote timed out for bot ${botId}`);
    await saveDebugScreenshot(page, shortT, botId, "timeout");
    return "failed";
  }
}

// Main entry point: one session per token, votes all bots in that session.
// `label` is an optional human-readable name for logging (falls back to a
// truncated token prefix if not provided).
async function voteAllBotsForToken(token, botIds, label) {
  const shortT = label || (token.slice(0, 5) + "...");

  log(`[token:${shortT}] Validating...`);
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: token },
    });
    if (!res.ok) {
      log(`[token:${shortT}] Invalid token, skipping`);
      clearCookies(token);
      const failResults = {};
      for (const botId of botIds) failResults[botId] = "failed";
      return failResults;
    }
  } catch (err) {
    log(`[token:${shortT}] Validation error: ${err.message}`);
    const failResults = {};
    for (const botId of botIds) failResults[botId] = "failed";
    return failResults;
  }
  log(`[token:${shortT}] Valid`);

  const results = {}; // botId -> "confirmed" | "already" | "turnstile" | "failed"

  let browser, context, page;
  try {
    ({ browser, context, page } = await connectBrowser());
    log(`[token:${shortT}] Browser connected`);

    const savedCookies = loadCookies(token);
    let loggedIn = false;

    if (savedCookies) {
      log(`[token:${shortT}] Loading saved cookies...`);
      await context.addCookies(savedCookies);
      loggedIn = await isLoggedInToTopgg(page);
      if (loggedIn) {
        log(`[token:${shortT}] Cookie login successful`);
      } else {
        log(`[token:${shortT}] Cookies expired, re-authing...`);
        clearCookies(token);
      }
    }

    if (!loggedIn) {
      await doOAuth(page, token, shortT);
      const cookies = await context.cookies();
      saveCookies(token, cookies);
      log(`[token:${shortT}] Cookies saved (${cookies.length} total): ${cookies.map(c => `${c.name}[domain=${c.domain},path=${c.path},secure=${c.secure},sameSite=${c.sameSite}]`).join(", ")}`);
    }

    // Sequential processing, one bot/page at a time. Pre-opening tabs for
    // upcoming bots was tried (to overlap the ~10s ad countdown / Turnstile
    // render with the current bot's processing) but reverted: browserless-v2
    // is on a 1GB memory limit, and 3 concurrent tabs (shared page + 2
    // pre-opened) already pushed it to ~721MB+ in one run — confirmed via
    // the Railway metrics dashboard, with the memory/CPU spike landing at
    // the exact timestamp of a bot #1 goto() timeout and a bot #3 3-minute
    // stall in waitForVoteStatus. That headroom is too thin to risk an OOM
    // kill for a ~10-20s/bot speedup. Reusing a single `page` keeps peak
    // memory bounded to one top.gg tab (+ Turnstile iframe) at a time.
    const pages = [page]; // kept as an array for compatibility with the tab-close loop below

    for (let i = 0; i < botIds.length; i++) {
      const botId = botIds[i];
      try {
        results[botId] = await voteForBot(page, shortT, botId);
      } catch (err) {
        log(`[token:${shortT}] Error voting for bot ${botId}: ${err.message}`);
        results[botId] = "failed";
        if (/page crashed/i.test(err.message) || /target crashed/i.test(err.message)) {
          log(`[token:${shortT}] Browser/page crashed — aborting remaining bots for this session`);
          break;
        }
      }
      await delay(2000);
    }

    for (const botId of botIds) {
      if (!(botId in results)) results[botId] = "failed";
    }

    // Close any extra tabs we opened beyond the original auth page. Errors
    // here are almost always "already closed" (e.g. browserless killed it
    // after a crash) and are safe to ignore, but logged at low volume so a
    // genuine close failure isn't completely invisible.
    for (let i = 1; i < pages.length; i++) {
      if (pages[i]) {
        try {
          await pages[i].close();
        } catch (err) {
          log(`[token:${shortT}] Note: tab close for bot ${botIds[i]} failed (likely already closed): ${err.message}`);
        }
      }
    }

    const updatedCookies = await context.cookies().catch(() => null);
    if (updatedCookies) saveCookies(token, updatedCookies);

  } catch (err) {
    log(`[token:${shortT}] Fatal error: ${err.message}`);
    for (const botId of botIds) {
      if (!(botId in results)) results[botId] = "failed";
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
      log(`[token:${shortT}] Browser closed`);
    }
  }

  return results;
}

module.exports = { voteAllBotsForToken };
