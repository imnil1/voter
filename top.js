const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COOKIE_DIR = process.env.COOKIE_DIR || "./cookies";
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "./screenshots";

function cookiePath(token) {
  return path.join(COOKIE_DIR, `${token.slice(0, 16).replace(/[^a-zA-Z0-9]/g, "_")}.json`);
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
async function saveDebugScreenshot(page, label, botId, reason) {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    // Give any in-flight rendering (images, lazy content) a moment to settle
    // before capturing — otherwise fullPage screenshots can come out
    // truncated if taken the instant a text condition becomes true.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await delay(500);
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${safeLabel}_${botId}_${reason}_${timestamp}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    log(`[screenshot:${label}] Saved debug screenshot for bot ${botId}: ${filename}`);
  } catch (err) {
    log(`[screenshot:${label}] Failed to save screenshot: ${err.message}`);
  }
}

async function connectBrowser() {
  const wsEndpoint = process.env.BROWSER_WS_URL;
  if (!wsEndpoint) throw new Error("BROWSER_WS_URL is not set");
  log(`[browser] Connecting via Playwright (CDP)...`);
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  return { browser, context, page };
}

async function isLoggedInToTopgg(page) {
  try {
    await page.goto("https://top.gg", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const bodyText = await page.locator("body").innerText();
    return !bodyText.includes("Login");
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
  const loginBtn = page.locator("button", { hasText: "Login" }).first();
  const loginVisible = await loginBtn.isVisible().catch(() => false);

  if (!loginVisible) {
    const bodyText = await page.locator("body").innerText();
    if (!bodyText.includes("Login")) {
      log(`[auth:${label}] Already logged in`);
      return;
    }
    throw new Error("Login button not found and not logged in");
  }

  await loginBtn.click();
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  } catch (err) {
    await saveDebugScreenshot(page, label, "oauth", "post-login-click-timeout");
    throw err;
  }

  log(`[auth:${label}] Waiting for Discord authorize button...`);
  const authorizeBtn = page.locator("button", { hasText: /authoriz|allow|yes/i }).first();
  try {
    await authorizeBtn.waitFor({ state: "visible", timeout: 15000 });
  } catch (err) {
    await saveDebugScreenshot(page, label, "oauth", "authorize-button-missing");
    throw err;
  }

  log(`[auth:${label}] Clicking authorize...`);
  await authorizeBtn.click();

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes("Login")) throw new Error("Authorization failed - Discord OAuth did not complete");
  log(`[auth:${label}] Authorization successful`);
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
// actual confirmation text top.gg shows now — not "already voted".
async function isVoteConfirmed(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll("h2")].some(h => /thanks for voting/i.test(h.textContent));
  });
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

const SOLVER_URL = (process.env.TURNSTILE_SOLVER_URL || "").replace(/\/$/, "");
const SOLVER_KEY = process.env.TURNSTILE_SOLVER_KEY || "";

// Submits a Turnstile solve task to the self-hosted icemellow-me solver
// (2captcha-compatible API) and polls until solved, failed, or timed out.
// Returns the token string, or null if solving failed/unavailable.
async function solveTurnstile(sitekey, pageUrl, shortT) {
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

async function voteForBot(page, label, botId) {
  const shortT = label;
  const timeoutMs = 60_000;

  log(`[vote:${shortT}] Navigating to vote page for bot ${botId}...`);
  await page.goto(`https://top.gg/bot/${botId}/vote`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const status = await waitForVoteStatus(page, timeoutMs);
  log(`[vote:${shortT}] Status for bot ${botId}: ${status}`);

  if (status === "vote") {
    const voteBtn = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
    await voteBtn.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await voteBtn.click();
    log(`[vote:${shortT}] Vote button clicked for bot ${botId}, checking for Turnstile...`);

    // Give Cloudflare a moment to inject the challenge iframe if it's going to.
    await delay(1500);
    if (await isTurnstilePresent(page)) {
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
    const confirmed = await page.waitForFunction(
      () => [...document.querySelectorAll("h2")].some(h => /thanks for voting/i.test(h.textContent)),
      { timeout: 15000 }
    ).then(() => true).catch(() => false);

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
      const lateConfirmed = await page.waitForFunction(
        () => [...document.querySelectorAll("h2")].some(h => /thanks for voting/i.test(h.textContent)),
        { timeout: 15000 }
      ).then(() => true).catch(() => false);
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
      const retryConfirmed = await page.waitForFunction(
        () => [...document.querySelectorAll("h2")].some(h => /thanks for voting/i.test(h.textContent)),
        { timeout: 15000 }
      ).then(() => true).catch(() => false);
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
      log(`[token:${shortT}] Cookies saved`);
    }

    for (const botId of botIds) {
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
