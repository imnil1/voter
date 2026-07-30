"""Port of lib/turnstile.js.

The external-solver-API flow (sitekey extraction -> HTTP solve -> token
injection) is replaced entirely by playwright_captcha's ClickSolver, which
clicks the real Turnstile checkbox in-page. This removes the need for
TURNSTILE_SOLVER_URL/KEY, a separate solver service, and sitekey capture
hooks in browser.py.
"""
import time

from .util import delay
from .logging import log, log_verbose
from .screenshot import save_debug_html


async def is_turnstile_present(page, short_t="?") -> bool:
    try:
        result = await page.evaluate("""
            () => {
                const hasHostDiv = !!document.querySelector('div[id^="cf-turnstile"], div.cf-turnstile, [data-sitekey]');
                const iframes = [...document.querySelectorAll("iframe")];
                const srcs = iframes.map(f => f.src || "(no src)");
                const hasMatchingIframeSrc = iframes.some(f => (f.src || "").includes("challenges.cloudflare.com"));
                let foundVia = null;
                if (hasHostDiv) foundVia = "host-div";
                else if (hasMatchingIframeSrc) foundVia = "iframe-src";
                return { found: hasHostDiv || hasMatchingIframeSrc, foundVia, allSrcs: srcs };
            }
        """)
        found = result["found"]
        found_via = result["foundVia"]
        all_srcs = result["allSrcs"]

        if found:
            log_verbose(f"[turnstile-diag:{short_t}] Turnstile detected via {found_via}")
        elif all_srcs:
            log_verbose(f"[turnstile-diag:{short_t}] no Turnstile host-div or matching iframe; {len(all_srcs)} iframe(s) present: {all_srcs}")
        else:
            log_verbose(f"[turnstile-diag:{short_t}] no Turnstile host-div and no iframes present at all on this check")
        return found
    except Exception as err:
        log_verbose(f"[turnstile-diag:{short_t}] isTurnstilePresent evaluate() error: {err}")
        return False


async def is_cloudflare_interstitial(page) -> bool:
    try:
        return await page.evaluate("""
            () => {
                const bodyText = document.body.innerText || "";
                const patterns = [
                    /performing security verification/i,
                    /checking your browser/i,
                    /attention required/i,
                    /just a moment/i,
                ];
                if (patterns.some(p => p.test(bodyText))) return true;
                const scripts = [...document.querySelectorAll("script[src], iframe[src]")];
                return scripts.some(el => /\\/cdn-cgi\\/|\\/challenge-platform\\//.test(el.src || ""));
            }
        """)
    except Exception:
        return False


async def get_post_click_page_state(page, short_t="?") -> str:
    """Returns one of: "success" | "already" | "interstitial" | "captcha" | "unknown"."""
    try:
        if await is_cloudflare_interstitial(page):
            return "interstitial"

        dom_state = await page.evaluate("""
            () => {
                const bodyText = document.body.innerText || "";
                if ([...document.querySelectorAll("h2")].some(h => /thanks for voting/i.test(h.textContent))) {
                    return "success";
                }
                if (/you have already voted/i.test(bodyText) || /you can vote again/i.test(bodyText)) {
                    return "already";
                }
                return null;
            }
        """)
        if dom_state:
            return dom_state

        if await is_turnstile_present(page, short_t):
            return "captcha"

        return "unknown"
    except Exception:
        return "unknown"


async def poll_post_click_state(page, timeout_ms=20000, interval_ms=750, short_t="?") -> str:
    start = time.monotonic()
    iteration = 0
    while (time.monotonic() - start) * 1000 < timeout_ms:
        iteration += 1
        elapsed = (time.monotonic() - start) * 1000
        state = await get_post_click_page_state(page, short_t)
        if state != "unknown":
            log_verbose(f"[vote-state:{short_t}] poll #{iteration} at {elapsed:.0f}ms: {state}")
            return state
        log_verbose(f"[vote-state:{short_t}] poll #{iteration} at {elapsed:.0f}ms: unknown, still waiting")
        await delay(interval_ms)
    log(f"[vote-state:{short_t}] Post-click state poll timed out after {(time.monotonic() - start) * 1000:.0f}ms with no resolved state")
    return "unknown"


async def poll_for_turnstile(page, timeout_ms=6000, interval_ms=750, short_t="?") -> bool:
    start = time.monotonic()
    iteration = 0
    while (time.monotonic() - start) * 1000 < timeout_ms:
        iteration += 1
        elapsed = (time.monotonic() - start) * 1000
        try:
            found = await page.evaluate("""
                () => {
                    const hasHostDiv = !!document.querySelector('div[id^="cf-turnstile"], div.cf-turnstile, [data-sitekey]');
                    const iframes = [...document.querySelectorAll("iframe")];
                    const hasMatchingIframeSrc = iframes.some(f => (f.src || "").includes("challenges.cloudflare.com"));
                    return hasHostDiv || hasMatchingIframeSrc;
                }
            """)
            if found:
                log_verbose(f"[turnstile:{short_t}] poll #{iteration} at {elapsed:.0f}ms: Turnstile iframe found")
                return True
            log_verbose(f"[turnstile:{short_t}] poll #{iteration} at {elapsed:.0f}ms: not found yet")
        except Exception as err:
            log_verbose(f"[turnstile:{short_t}] poll #{iteration} at {elapsed:.0f}ms: evaluate() error (likely mid-navigation) — {err}")
        await delay(interval_ms)
    log_verbose(f"[turnstile:{short_t}] poll window closed after {iteration} iteration(s), {(time.monotonic() - start) * 1000:.0f}ms elapsed — no Turnstile found")
    return False


async def try_solve_turnstile_on_page(page, short_t="?", bot_id="?") -> bool:
    """Solves an in-page Turnstile challenge using playwright_captcha's
    ClickSolver against the voter's own live page/context — clicks the real
    checkbox element (found via shadow-root/light-DOM traversal), rather
    than the old sitekey-extraction + external-API + token-injection flow."""
    try:
        from playwright_captcha import CaptchaType, ClickSolver, FrameworkType
    except ImportError as e:
        log(f"[turnstile-solver:{short_t}] playwright_captcha not available: {e}")
        return False

    try:
        async with ClickSolver(framework=FrameworkType.CAMOUFOX, page=page) as solver:
            await solver.solve_captcha(
                captcha_container=page,
                captcha_type=CaptchaType.CLOUDFLARE_TURNSTILE,
            )
        log(f"[turnstile-solver:{short_t}] ClickSolver solved Turnstile for bot {bot_id}")
        return True
    except Exception as e:
        log(f"[turnstile-solver:{short_t}] ClickSolver could not solve Turnstile for bot {bot_id}: {e}")
        await save_debug_html(page, short_t, bot_id, "turnstile-clicksolver-failed")
        return False


async def try_solve_interstitial_on_page(page, short_t="?", bot_id="?") -> bool:
    """Attempts to resolve a full-page Cloudflare interstitial using
    playwright_captcha's ClickSolver (CLOUDFLARE_INTERSTITIAL) — an active
    click attempt, tried before falling back to passively waiting for
    Cloudflare's own redirect. Interstitials are frequently non-interactive
    (a background JS/proof-of-work check with no checkbox at all), so this
    is expected to no-op harmlessly in that case; ClickSolver raises if it
    can't find a clickable challenge, which the caller should treat the same
    as "still waiting", not as a hard failure."""
    try:
        from playwright_captcha import CaptchaType, ClickSolver, FrameworkType
    except ImportError as e:
        log(f"[interstitial-solver:{short_t}] playwright_captcha not available: {e}")
        return False

    try:
        async with ClickSolver(framework=FrameworkType.CAMOUFOX, page=page) as solver:
            await solver.solve_captcha(
                captcha_container=page,
                captcha_type=CaptchaType.CLOUDFLARE_INTERSTITIAL,
            )
        log(f"[interstitial-solver:{short_t}] ClickSolver resolved interstitial for bot {bot_id}")
        return True
    except Exception as e:
        log_verbose(f"[interstitial-solver:{short_t}] ClickSolver did not resolve interstitial for bot {bot_id} (may be non-interactive): {e}")
        return False
