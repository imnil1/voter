const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COOKIE_DIR = process.env.COOKIE_DIR || "./cookies";

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

function nowISO() { return new Date().toISOString(); }
function log(msg) { console.log(`[${nowISO()}] ${msg}`); }

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

async function doOAuth(page, token, shortT) {
  log(`[auth:${shortT}] Setting Discord token in localStorage...`);
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", `"${t}"`);
  }, token);

  await page.goto("https://top.gg", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  log(`[auth:${shortT}] Clicking login button...`);
  const loginBtn = page.locator("button", { hasText: "Login" }).first();
  const loginVisible = await loginBtn.isVisible().catch(() => false);

  if (!loginVisible) {
    const bodyText = await page.locator("body").innerText();
    if (!bodyText.includes("Login")) {
      log(`[auth:${shortT}] Already logged in`);
      return;
    }
    throw new Error("Login button not found and not logged in");
  }

  await loginBtn.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });

  log(`[auth:${shortT}] Waiting for Discord authorize button...`);
  const authorizeBtn = page.locator("button", { hasText: /authoriz|allow|yes/i }).first();
  await authorizeBtn.waitFor({ state: "visible", timeout: 15000 });

  log(`[auth:${shortT}] Clicking authorize...`);
  await authorizeBtn.click();

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes("Login")) throw new Error("Authorization failed - Discord OAuth did not complete");
  log(`[auth:${shortT}] Authorization successful`);
}

// DOM-structure-based state check (not text matching) — more robust to copy changes.
// "vote"    -> a vote button is present and clickable
// "already" -> the page's <h2> heading indicates a vote was already cast
// "login"   -> neither of the above; assume not authenticated / unknown state
async function getVotePageState(page) {
  return page.evaluate(() => {
    const btn = document.querySelector("button.button-primary:not([disabled])");
    if (btn && /vote/i.test(btn.textContent)) return "vote";
    const h2 = document.querySelector("h2");
    if (h2 && /already voted/i.test(h2.textContent)) return "already";
    return "unknown";
  });
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

async function waitForVoteStatus(page, timeoutMs) {
  const WAIT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  let start = Date.now();

  while (true) {
    try {
      const state = await getVotePageState(page);

      if (state === "vote") return "vote";

      if (state === "already") {
        const cooldownMs = await getVoteCountdownMs(page);
        if (cooldownMs !== null && cooldownMs <= WAIT_THRESHOLD_MS) {
          log(`[vote] Cooldown is ${Math.round(cooldownMs / 60000)} min — waiting it out...`);
          await delay(cooldownMs + 5000);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          start = Date.now(); // reset timer after cooldown wait
          continue;
        }
        return "already";
      }
    } catch (_) {}

    if (Date.now() - start > timeoutMs) return "timeout";
    await delay(2500);
  }
}

async function voteForBot(page, token, botId) {
  const shortT = token.slice(0, 5) + "...";
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
    log(`[vote:${shortT}] Vote button clicked for bot ${botId}, verifying...`);

    // verify via DOM state, not hardcoded text — checks the <h2> flips to "already voted"
    const confirmed = await page.waitForFunction(
      () => {
        const h2 = document.querySelector("h2");
        return h2 && /already voted/i.test(h2.textContent);
      },
      { timeout: 15000 }
    ).then(() => true).catch(() => false);

    if (confirmed) {
      log(`[vote:${shortT}] Vote confirmed for bot ${botId}`);
      return true;
    } else {
      log(`[vote:${shortT}] Vote click did not confirm for bot ${botId}, retrying once...`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const retryBtn = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
      const retryVisible = await retryBtn.isVisible().catch(() => false);
      if (retryVisible) {
        await retryBtn.click();
        await delay(3000);
        const retryConfirmed = await page.waitForFunction(
          () => {
            const h2 = document.querySelector("h2");
            return h2 && /already voted/i.test(h2.textContent);
          },
          { timeout: 15000 }
        ).then(() => true).catch(() => false);
        log(`[vote:${shortT}] Retry ${retryConfirmed ? "confirmed" : "still unconfirmed"} for bot ${botId}`);
        return retryConfirmed;
      }
      return false;
    }
  } else if (status === "already") {
    log(`[vote:${shortT}] Already voted for bot ${botId}`);
    return false;
  } else {
    log(`[vote:${shortT}] Vote timed out for bot ${botId}`);
    return false;
  }
}

// Main entry point: one session per token, votes all bots in that session
async function voteAllBotsForToken(token, botIds) {
  const shortT = token.slice(0, 5) + "...";

  log(`[token:${shortT}] Validating...`);
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: token },
    });
    if (!res.ok) {
      log(`[token:${shortT}] Invalid token, skipping`);
      clearCookies(token);
      return;
    }
  } catch (err) {
    log(`[token:${shortT}] Validation error: ${err.message}`);
    return;
  }
  log(`[token:${shortT}] Valid`);

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
        await voteForBot(page, token, botId);
      } catch (err) {
        log(`[token:${shortT}] Error voting for bot ${botId}: ${err.message}`);
      }
      await delay(2000);
    }

    const updatedCookies = await context.cookies();
    saveCookies(token, updatedCookies);

  } catch (err) {
    log(`[token:${shortT}] Fatal error: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
      log(`[token:${shortT}] Browser closed`);
    }
  }
}

module.exports = { voteAllBotsForToken };
