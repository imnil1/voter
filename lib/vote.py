"""Port of lib/vote.js.

Change from the original: waitForVoteStatus() (the PRE-click polling loop,
run right after navigating to the vote page) now detects and attempts to
actively resolve a Cloudflare interstitial via try_solve_interstitial_on_page,
falling back to a passive wait if that doesn't clear it. The original only
handled interstitials in the POST-click path (resolvePostClickState) — this
was the actual gap: a real interstitial was observed at the pre-click stage,
where getVotePageState had no case for it at all and it fell through to
"unknown" forever.
"""
import re
import time

from .util import delay
from .logging import log, log_verbose
from .screenshot import save_debug_screenshot, save_debug_html
from .turnstile import (
    poll_post_click_state,
    try_solve_turnstile_on_page,
    try_solve_interstitial_on_page,
    is_cloudflare_interstitial,
)

ALREADY_VOTED_PATTERN = re.compile(r"you have already voted", re.I)
VOTE_AGAIN_PATTERN = re.compile(r"you can vote again", re.I)
AD_WAIT_PATTERN = re.compile(r"you will be able to vote after this ad", re.I)


async def get_vote_page_state(page) -> str:
    """DOM-structure-based state check (not text matching alone, though the
    interstitial check is text-based by necessity — see turnstile.py).
    "vote"         -> a vote button is present and clickable
    "already"      -> the page indicates a vote was already cast (cooldown screen)
    "ad-wait"      -> the fixed ~10s ad countdown before the Vote button appears
    "interstitial" -> full-page Cloudflare challenge, blocking the whole page load
    "unknown"      -> none of the above; caller should keep polling or bail
    """
    if await is_cloudflare_interstitial(page):
        return "interstitial"

    return await page.evaluate("""
        () => {
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
        }
    """)


async def is_vote_confirmed(page, timeout_ms=15000) -> bool:
    try:
        await page.wait_for_function(
            "() => [...document.querySelectorAll('h2')].some(h => /thanks for voting/i.test(h.textContent))",
            timeout=timeout_ms,
        )
        return True
    except Exception:
        return False


async def get_vote_countdown_ms(page):
    return await page.evaluate("""
        () => {
            const p = [...document.querySelectorAll("p")]
                .find(el => /vote again/i.test(el.textContent));
            const text = p?.textContent || "";
            const hourMatch = text.match(/(\\d+)\\s*hour/i);
            const minMatch  = text.match(/(\\d+)\\s*min/i);
            if (hourMatch) return parseInt(hourMatch[1]) * 60 * 60 * 1000;
            if (minMatch)  return parseInt(minMatch[1])  * 60 * 1000;
            return null;
        }
    """)


async def wait_for_vote_status(page, timeout_ms, short_t="?", bot_id="?") -> str:
    """Note: timeout_ms bounds each individual polling phase, not the overall
    call. A cooldown wait resets `start` afterward (see below) so a bot that
    cycles through several short cooldowns in a row can legitimately run
    past the nominal timeout_ms passed in by the caller — this is
    intentional, not an unbounded loop."""
    WAIT_THRESHOLD_MS = 10 * 60 * 1000  # 10 minutes
    AD_WAIT_MS = 11 * 1000  # fixed ~10s ad countdown before Vote button appears, +1s buffer
    start = time.monotonic()
    ad_waited = False
    unknown_streak = 0
    interstitial_attempts = 0
    INTERSTITIAL_MAX_ATTEMPTS = 3

    while True:
        try:
            state = await get_vote_page_state(page)

            if state == "vote":
                return "vote"

            if state == "interstitial":
                interstitial_attempts += 1
                log(f"[vote:{short_t}] Full Cloudflare interstitial detected for bot {bot_id} (pre-click) — attempting to resolve, attempt {interstitial_attempts}...")
                await save_debug_screenshot(page, short_t, bot_id, "cloudflare-interstitial-preclick", True)

                solved = await try_solve_interstitial_on_page(page, short_t, bot_id)
                if not solved:
                    # ClickSolver couldn't find/click anything — likely a
                    # non-interactive challenge. Fall back to waiting for
                    # Cloudflare's own redirect, same as the original
                    # passive-wait approach, before re-checking state.
                    try:
                        await page.wait_for_load_state("domcontentloaded", timeout=15000)
                    except Exception:
                        pass

                if interstitial_attempts >= INTERSTITIAL_MAX_ATTEMPTS:
                    log(f"[vote:{short_t}] Interstitial still present after {interstitial_attempts} attempts for bot {bot_id} — likely a session/IP-level block, not a solvable challenge")
                    await save_debug_html(page, short_t, bot_id, "interstitial-stuck")
                    return "interstitial"

                unknown_streak = 0
                continue

            if state == "ad-wait" and not ad_waited:
                log(f"[vote] Ad countdown in progress — waiting {AD_WAIT_MS / 1000}s...")
                await delay(AD_WAIT_MS)
                ad_waited = True  # only wait out the ad once per page load
                unknown_streak = 0
                continue

            if state == "already":
                cooldown_ms = await get_vote_countdown_ms(page)
                if cooldown_ms is not None and cooldown_ms <= WAIT_THRESHOLD_MS:
                    log(f"[vote] Cooldown is {round(cooldown_ms / 60000)} min — waiting it out...")
                    await delay(cooldown_ms + 5000)
                    try:
                        await page.reload(wait_until="domcontentloaded", timeout=30000)
                    except Exception:
                        pass
                    try:
                        await page.wait_for_load_state("networkidle", timeout=10000)
                    except Exception:
                        pass
                    start = time.monotonic()  # reset timer after cooldown wait
                    ad_waited = False  # fresh page load may show the ad countdown again
                    unknown_streak = 0
                    continue
                return "already"

            # state === "unknown" — neither a votable button, an ad
            # countdown, nor a cooldown screen. Log a page snapshot
            # periodically so a stall shows what was actually on screen.
            unknown_streak += 1
            if unknown_streak == 4 and ad_waited:
                log("[vote] Still no vote button after the ad countdown — reloading once...")
                try:
                    await page.reload(wait_until="domcontentloaded", timeout=30000)
                except Exception:
                    pass
                try:
                    await page.wait_for_load_state("networkidle", timeout=10000)
                except Exception:
                    pass
                ad_waited = False  # fresh load may show the ad countdown again
                unknown_streak = 0
                continue
            if unknown_streak % 4 == 0:
                try:
                    snapshot = await page.evaluate("""
                        () => {
                            const btn = document.querySelector("button.button-primary");
                            return {
                                url: location.href,
                                bodyTextSample: (document.body.innerText || "").slice(0, 200),
                                hasPrimaryButton: !!btn,
                                primaryButtonDisabled: btn ? btn.disabled : null,
                                primaryButtonText: btn ? btn.textContent.trim().slice(0, 60) : null,
                            };
                        }
                    """)
                except Exception as err:
                    snapshot = {"evalError": str(err)}
                log_verbose(f"[vote-diag] unknown state persisting (streak={unknown_streak}): {snapshot}")
        except Exception:
            pass

        if (time.monotonic() - start) * 1000 > timeout_ms:
            return "timeout"
        await delay(2500)


async def goto_with_retry(page, url, short_t, bot_id):
    """Navigates with a single retry for two known-transient failure modes:
    ERR_ABORTED (a navigation race) and a flat navigation timeout."""
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    except Exception as err:
        msg = str(err)
        if re.search(r"ERR_ABORTED", msg, re.I):
            log(f"[vote:{short_t}] goto() hit ERR_ABORTED for bot {bot_id} — likely a navigation race, retrying once after a short delay...")
            await delay(1500)
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        elif re.search(r"timeout", msg, re.I):
            log(f"[vote:{short_t}] goto() timed out for bot {bot_id} — retrying once after a short delay...")
            await delay(1500)
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        else:
            raise


async def resolve_post_click_state(page, short_t, bot_id, overall_timeout_ms=20000) -> str:
    """Drives the post-click flow using a single continuous state poll.
    Returns one of: "confirmed" | "already" | "turnstile" | "unresolved"."""
    deadline = time.monotonic() + overall_timeout_ms / 1000

    while time.monotonic() < deadline:
        remaining_ms = (deadline - time.monotonic()) * 1000
        state = await poll_post_click_state(page, remaining_ms, 750, short_t)

        if state == "success":
            return "confirmed"
        if state == "already":
            return "already"

        if state == "interstitial":
            log(f"[vote:{short_t}] Full Cloudflare interstitial detected for bot {bot_id} — attempting to resolve...")
            await save_debug_screenshot(page, short_t, bot_id, "cloudflare-interstitial", True)
            solved = await try_solve_interstitial_on_page(page, short_t, bot_id)
            if not solved:
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=min(remaining_ms, 15000))
                except Exception:
                    pass
            continue

        if state == "captcha":
            log(f"[vote:{short_t}] Turnstile challenge detected for bot {bot_id} — attempting to solve...")
            solved = await try_solve_turnstile_on_page(page, short_t, bot_id)
            if not solved:
                log(f"[vote:{short_t}] Could not solve Turnstile for bot {bot_id} — skipping, will retry later")
                await save_debug_screenshot(page, short_t, bot_id, "turnstile-unsolved")
                return "turnstile"
            log(f"[vote:{short_t}] Turnstile solved for bot {bot_id}, re-checking vote button...")
            revote_btn = page.locator("button.button-primary:not([disabled])", has_text="Vote").first
            try:
                revote_visible = await revote_btn.is_visible()
            except Exception:
                revote_visible = False
            if revote_visible:
                await revote_btn.click()
            await delay(1000)
            continue  # re-poll from a clean state after solving

        break

    return "unresolved"


async def vote_for_bot(page, label, bot_id) -> str:
    short_t = label
    timeout_ms = 60_000

    vote_page_url = f"https://top.gg/bot/{bot_id}/vote"
    log(f"[vote:{short_t}] Navigating to vote page for bot {bot_id}...")
    await goto_with_retry(page, vote_page_url, short_t, bot_id)
    try:
        await page.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        pass

    status = await wait_for_vote_status(page, timeout_ms, short_t, bot_id)
    log(f"[vote:{short_t}] Status for bot {bot_id}: {status}")

    if status == "vote":
        vote_btn = page.locator("button.button-primary:not([disabled])", has_text="Vote").first
        try:
            await vote_btn.wait_for(state="visible", timeout=10000)
        except Exception:
            pass
        await vote_btn.click()
        log(f"[vote:{short_t}] Vote button clicked for bot {bot_id}, watching for outcome...")

        result = await resolve_post_click_state(page, short_t, bot_id, 20000)

        if result == "confirmed":
            log(f"[vote:{short_t}] Vote confirmed for bot {bot_id}")
            return "confirmed"
        if result == "already":
            log(f"[vote:{short_t}] Already voted for bot {bot_id}")
            return "already"
        if result == "turnstile":
            log(f"[vote:{short_t}] Turnstile blocked bot {bot_id} — reloading once, challenge doesn't always reappear...")
            try:
                await page.reload(wait_until="domcontentloaded", timeout=30000)
            except Exception:
                pass
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass

            post_reload_status = await wait_for_vote_status(page, 30_000, short_t, bot_id)

            if post_reload_status == "already":
                log(f"[vote:{short_t}] Already voted for bot {bot_id} (discovered after turnstile reload)")
                return "already"

            if post_reload_status != "vote":
                log(f"[vote:{short_t}] Post-turnstile-reload did not reach a votable state for bot {bot_id} (status: {post_reload_status})")
                await save_debug_screenshot(page, short_t, bot_id, "turnstile-reload-status-" + post_reload_status)
                return "turnstile"

            post_reload_btn = page.locator("button.button-primary:not([disabled])", has_text="Vote").first
            try:
                post_reload_visible = await post_reload_btn.is_visible()
            except Exception:
                post_reload_visible = False
            if not post_reload_visible:
                await save_debug_screenshot(page, short_t, bot_id, "turnstile-reload-no-button")
                return "turnstile"

            await post_reload_btn.click()
            post_reload_result = await resolve_post_click_state(page, short_t, bot_id, 20000)

            log(f"[vote:{short_t}] Post-turnstile-reload result {post_reload_result} for bot {bot_id}")
            if post_reload_result == "confirmed":
                return "confirmed"
            if post_reload_result == "already":
                return "already"

            await save_debug_screenshot(page, short_t, bot_id, "turnstile-reload-unconfirmed")
            await save_debug_html(page, short_t, bot_id, "turnstile-reload-unconfirmed")
            return "turnstile"

        log(f"[vote:{short_t}] Vote click did not resolve for bot {bot_id}, retrying once...")
        await save_debug_screenshot(page, short_t, bot_id, "before-reload")
        await save_debug_html(page, short_t, bot_id, "before-reload")
        try:
            await page.reload(wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass

        retry_status = await wait_for_vote_status(page, 30_000, short_t, bot_id)

        if retry_status == "already":
            log(f"[vote:{short_t}] Already voted for bot {bot_id} (discovered on retry)")
            return "already"

        if retry_status != "vote":
            log(f"[vote:{short_t}] Retry did not reach a votable state for bot {bot_id} (status: {retry_status})")
            await save_debug_screenshot(page, short_t, bot_id, "retry-status-" + retry_status)
            return "failed"

        retry_btn = page.locator("button.button-primary:not([disabled])", has_text="Vote").first
        try:
            retry_visible = await retry_btn.is_visible()
        except Exception:
            retry_visible = False
        if not retry_visible:
            await save_debug_screenshot(page, short_t, bot_id, "no-retry-button")
            return "failed"

        await retry_btn.click()
        retry_result = await resolve_post_click_state(page, short_t, bot_id, 20000)

        log(f"[vote:{short_t}] Retry {retry_result} for bot {bot_id}")
        if retry_result == "confirmed":
            return "confirmed"
        if retry_result == "already":
            return "already"
        if retry_result == "turnstile":
            return "turnstile"

        await save_debug_screenshot(page, short_t, bot_id, "unconfirmed")
        await save_debug_html(page, short_t, bot_id, "unconfirmed")
        return "failed"

    elif status == "already":
        log(f"[vote:{short_t}] Already voted for bot {bot_id}")
        return "already"
    elif status == "interstitial":
        log(f"[vote:{short_t}] Vote blocked by unresolvable interstitial for bot {bot_id}")
        return "failed"
    else:
        log(f"[vote:{short_t}] Vote timed out for bot {bot_id}")
        await save_debug_screenshot(page, short_t, bot_id, "timeout")
        return "failed"
