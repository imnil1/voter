const { delay } = require("./util");
const { log, logVerbose } = require("./logging");
const { saveDebugScreenshot, saveDebugHTML } = require("./screenshot");
const {
  pollPostClickState,
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
// actual confirmation text top.gg shows now — not "already voted".
//
// Note: voteForBot() itself no longer calls this directly — the post-click
// flow now goes through resolvePostClickState()/getPostClickPageState() in
// turnstile.js, which folds the same "thanks for voting" check into its
// unified state detection. This function is kept as a public export for
// any external/ad-hoc use (e.g. a one-off script checking confirmation
// state), and the two checks are intentionally kept in sync — if the
// success-text pattern here ever changes, update it in both places.
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
  let unknownStreak = 0;

  while (true) {
    try {
      const state = await getVotePageState(page);

      if (state === "vote") return "vote";

      if (state === "ad-wait" && !adWaited) {
        log(`[vote] Ad countdown in progress — waiting ${AD_WAIT_MS / 1000}s...`);
        await delay(AD_WAIT_MS);
        adWaited = true; // only wait out the ad once per page load
        unknownStreak = 0;
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
          unknownStreak = 0;
          continue;
        }
        return "already";
      }

      // state === "unknown" — neither a votable button, an ad countdown,
      // nor a cooldown screen. Was previously silent, so a stall here (as
      // happened in production — a bot sat here for ~40s straight after its
      // ad countdown finished, then the whole call just timed out with no
      // clue why) gave no diagnostic signal at all. Log a page snapshot
      // periodically (every ~4th unknown poll, so we're not spamming every
      // 2.5s) so the next occurrence tells us what was actually on screen.
      //
      // Known cause (confirmed by direct observation, not just guessed from
      // logs): once the ad countdown finishes, top.gg's page does not
      // always reactively render the vote button on its own — it can need
      // an explicit reload to actually show up, the same way the cooldown
      // path already reloads after waiting. If we're still stuck in
      // "unknown" a while after the ad wait completed, try one reload
      // before continuing to poll, rather than just waiting out the clock.
      unknownStreak++;
      if (unknownStreak === 4 && adWaited) {
        log(`[vote] Still no vote button after the ad countdown — reloading once...`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        adWaited = false; // fresh load may show the ad countdown again
        unknownStreak = 0;
        continue;
      }
      if (unknownStreak % 4 === 0) {
        const snapshot = await page.evaluate(() => {
          const btn = document.querySelector("button.button-primary");
          return {
            url: location.href,
            bodyTextSample: (document.body.innerText || "").slice(0, 200),
            hasPrimaryButton: !!btn,
            primaryButtonDisabled: btn ? btn.disabled : null,
            primaryButtonText: btn ? btn.textContent.trim().slice(0, 60) : null,
          };
        }).catch(err => ({ evalError: err.message }));
        logVerbose(`[vote-diag] unknown state persisting (streak=${unknownStreak}): ${JSON.stringify(snapshot)}`);
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

// Drives the post-click flow using a single continuous state poll rather
// than a sequence of separate one-shot checks. Loops: poll state -> if a
// captcha appeared (embedded or full interstitial), attempt to resolve it
// and poll again -> repeat until "success", "already", a captcha that
// couldn't be resolved, or the overall timeout. This is the fix for a
// late-appearing Turnstile slipping through the gap between two one-shot
// checks (confirmed to have happened twice in production — a Turnstile
// screenshot was caught by a debug capture that the surrounding one-shot
// checks never detected, because it appeared in the window between them).
//
// Returns one of: "confirmed" | "already" | "turnstile" | "unresolved"
async function resolvePostClickState(page, shortT, botId, overallTimeoutMs = 20000) {
  const deadline = Date.now() + overallTimeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const state = await pollPostClickState(page, remaining, 750, shortT);

    if (state === "success") return "confirmed";
    if (state === "already") return "already";

    if (state === "interstitial") {
      // Full-page Cloudflare interstitials are rare and, per design notes,
      // not yet observed during actual automation — only seen manually.
      // There's no embedded widget to solve here; the only real option is
      // to wait for Cloudflare's own redirect back to top.gg once it
      // clears, then let the loop re-poll from a clean state.
      log(`[vote:${shortT}] Full Cloudflare interstitial detected for bot ${botId} — waiting for redirect...`);
      await saveDebugScreenshot(page, shortT, botId, "cloudflare-interstitial", true);
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(remaining, 15000) }).catch(() => {});
      continue;
    }

    if (state === "captcha") {
      log(`[vote:${shortT}] Turnstile challenge detected for bot ${botId} — attempting to solve...`);
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
      }
      await delay(1000);
      continue; // re-poll from a clean state after solving
    }

    // state === "unknown" and pollPostClickState's own internal timeout
    // fired (it returns "unknown" on timeout too) — nothing left to do but
    // stop; the overall while-loop condition will also naturally end here
    // since pollPostClickState only returns after using up its budget in
    // that case.
    break;
  }

  return "unresolved";
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
    log(`[vote:${shortT}] Vote button clicked for bot ${botId}, watching for outcome...`);

    const result = await resolvePostClickState(page, shortT, botId, 20000);

    if (result === "confirmed") {
      log(`[vote:${shortT}] Vote confirmed for bot ${botId}`);
      return "confirmed";
    }
    if (result === "already") {
      log(`[vote:${shortT}] Already voted for bot ${botId}`);
      return "already";
    }
    if (result === "turnstile") {
      // A fresh page load doesn't always re-trigger Turnstile at all —
      // confirmed by direct observation, not just a hopeful guess. So
      // rather than give up immediately, reload once and give the vote
      // flow a full second attempt; if Turnstile shows up again, this
      // second attempt's own resolvePostClickState will already try to
      // solve it — reload is just a shot at skipping the challenge
      // entirely, not a replacement for solving.
      log(`[vote:${shortT}] Turnstile blocked bot ${botId} — reloading once, challenge doesn't always reappear...`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      // Same as the "unresolved" path below: a reload can restart the ad
      // countdown, so re-run the full status wait rather than assuming the
      // button is immediately clickable.
      const postReloadStatus = await waitForVoteStatus(page, 30_000);

      if (postReloadStatus === "already") {
        log(`[vote:${shortT}] Already voted for bot ${botId} (discovered after turnstile reload)`);
        return "already";
      }

      if (postReloadStatus !== "vote") {
        log(`[vote:${shortT}] Post-turnstile-reload did not reach a votable state for bot ${botId} (status: ${postReloadStatus})`);
        await saveDebugScreenshot(page, shortT, botId, "turnstile-reload-status-" + postReloadStatus);
        return "turnstile";
      }

      const postReloadBtn = page.locator("button.button-primary:not([disabled])", { hasText: "Vote" }).first();
      const postReloadVisible = await postReloadBtn.isVisible().catch(() => false);
      if (!postReloadVisible) {
        await saveDebugScreenshot(page, shortT, botId, "turnstile-reload-no-button");
        return "turnstile";
      }

      await postReloadBtn.click();
      const postReloadResult = await resolvePostClickState(page, shortT, botId, 20000);

      log(`[vote:${shortT}] Post-turnstile-reload result ${postReloadResult} for bot ${botId}`);
      if (postReloadResult === "confirmed") return "confirmed";
      if (postReloadResult === "already") return "already";

      // Still turnstile, or unresolved — either way, no further retry here.
      // The outer scheduler will naturally try again at the next run.
      await saveDebugScreenshot(page, shortT, botId, "turnstile-reload-unconfirmed");
      await saveDebugHTML(page, shortT, botId, "turnstile-reload-unconfirmed");
      return "turnstile";
    }

    // "unresolved" — no clear outcome within the timeout. Reload and give
    // it one more full attempt, same overall retry budget as before.
    log(`[vote:${shortT}] Vote click did not resolve for bot ${botId}, retrying once...`);
    await saveDebugScreenshot(page, shortT, botId, "before-reload");
    await saveDebugHTML(page, shortT, botId, "before-reload");
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
    if (!retryVisible) {
      await saveDebugScreenshot(page, shortT, botId, "no-retry-button");
      return "failed";
    }

    await retryBtn.click();
    const retryResult = await resolvePostClickState(page, shortT, botId, 20000);

    log(`[vote:${shortT}] Retry ${retryResult} for bot ${botId}`);
    if (retryResult === "confirmed") return "confirmed";
    if (retryResult === "already") return "already";
    if (retryResult === "turnstile") return "turnstile";

    await saveDebugScreenshot(page, shortT, botId, "unconfirmed");
    await saveDebugHTML(page, shortT, botId, "unconfirmed");
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
  resolvePostClickState,
  voteForBot,
};
