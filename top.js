const { log } = require("./lib/logging");
const { delay } = require("./lib/util");
const { loadCookies, saveCookies, clearCookies } = require("./lib/cookies");
const { connectBrowser } = require("./lib/browser");
const { isLoggedInToTopgg, doOAuth } = require("./lib/oauth");
const { voteForBot } = require("./lib/vote");

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

    // Sequential processing, one bot/page at a time, reusing the single
    // `page` throughout. Pre-opening a tab per bot (to overlap the ~10s ad
    // countdown / Turnstile render with the current bot's processing) was
    // tried and reverted: browserless-v2 is on a 1GB memory limit, and 3
    // concurrent tabs (shared page + 2 pre-opened) already pushed it to
    // ~721MB+ in one run — confirmed via the Railway metrics dashboard,
    // with the memory/CPU spike landing at the exact timestamp of a bot #1
    // goto() timeout and a bot #3 3-minute stall in waitForVoteStatus. That
    // headroom is too thin to risk an OOM kill for a ~10-20s/bot speedup.
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
