const { delay } = require("./util");
const { log } = require("./logging");
const { saveDebugScreenshot } = require("./screenshot");
const {
  isTurnstilePresent,
  pollForTurnstile,
  trySolveTurnstileOnPage,
} = require("./turnstile");

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
    if (await pollForTurnstile(page, 6000, 750, shortT)) {
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

module.exports = {
  getVotePageState,
  isVoteConfirmed,
  getVoteCountdownMs,
  waitForVoteStatus,
  gotoWithRetry,
  voteForBot,
};
