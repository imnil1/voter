const fs = require("fs");
const path = require("path");
const { delay } = require("./util");
const { log } = require("./logging");

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "./screenshots";

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

module.exports = { saveDebugScreenshot };
