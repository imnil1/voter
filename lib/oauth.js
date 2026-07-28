const { delay } = require("./util");
const { log } = require("./logging");
const { saveDebugScreenshot } = require("./screenshot");

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

  // `networkidle` is unreliable here (continuous background activity from
  // analytics/Turnstile-adjacent scripts can make it silently time out
  // every time), so rather than trusting a fixed settle delay before
  // checking login state, poll for the state to actually resolve one way
  // or the other. This closes a race where hasLoginButton() could run on a
  // page still mid-redirect from Discord back to top.gg, before either the
  // Login button or the logged-in UI has actually rendered — which would
  // make a real login look like a false failure (or vice versa).
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

module.exports = { hasLoginButton, isLoggedInToTopgg, doOAuth };
