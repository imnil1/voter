"""Port of top.js — one session per token, votes all bots in that session."""
import aiohttp

from lib.logging import log, log_verbose
from lib.util import delay
from lib.cookies import load_cookies, save_cookies, clear_cookies
from lib.browser import connect_browser, prepare_page
from lib.oauth import is_logged_in_to_topgg, do_oauth
from lib.vote import vote_for_bot


async def vote_all_bots_for_token(playwright, token, bot_ids, label=None) -> dict:
    short_t = label or (token[:5] + "...")

    log(f"[token:{short_t}] Validating...")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                "https://discord.com/api/v10/users/@me",
                headers={"Authorization": token},
            ) as res:
                if not res.ok:
                    log(f"[token:{short_t}] Invalid token, skipping")
                    clear_cookies(token)
                    return {bot_id: "failed" for bot_id in bot_ids}
    except Exception as err:
        log(f"[token:{short_t}] Validation error: {err}")
        return {bot_id: "failed" for bot_id in bot_ids}
    log(f"[token:{short_t}] Valid")

    results = {}  # bot_id -> "confirmed" | "already" | "turnstile" | "failed"

    browser = None
    try:
        browser, context, page = await connect_browser(playwright)
        log(f"[token:{short_t}] Browser connected")

        saved_cookies = load_cookies(token)
        logged_in = False

        if saved_cookies:
            log(f"[token:{short_t}] Loading saved cookies...")
            await context.add_cookies(saved_cookies)
            logged_in = await is_logged_in_to_topgg(page)
            if logged_in:
                log(f"[token:{short_t}] Cookie login successful")
            else:
                log(f"[token:{short_t}] Cookies expired, re-authing...")
                clear_cookies(token)

        if not logged_in:
            await do_oauth(page, token, short_t)
            cookies = await context.cookies()
            save_cookies(token, cookies)
            log(f"[token:{short_t}] Cookies saved ({len(cookies)} total)")
            log_verbose(f"[token:{short_t}] Cookie detail: " + ", ".join(
                f"{c['name']}[domain={c.get('domain')},path={c.get('path')},secure={c.get('secure')},sameSite={c.get('sameSite')}]"
                for c in cookies
            ))

        # Sequential processing, one bot/page at a time, reusing the single
        # `page` throughout — same reasoning as the original: concurrent
        # tabs previously pushed the browser process too close to its
        # memory limit for the modest speedup gained.
        for bot_id in bot_ids:
            try:
                results[bot_id] = await vote_for_bot(page, short_t, bot_id)
            except Exception as err:
                log(f"[token:{short_t}] Error voting for bot {bot_id}: {err}")
                results[bot_id] = "failed"
                msg = str(err)
                if "page crashed" in msg.lower() or "target crashed" in msg.lower():
                    log(f"[token:{short_t}] Browser/page crashed — aborting remaining bots for this session")
                    break
            await delay(2000)

        for bot_id in bot_ids:
            if bot_id not in results:
                results[bot_id] = "failed"

        try:
            updated_cookies = await context.cookies()
            save_cookies(token, updated_cookies)
        except Exception:
            pass

    except Exception as err:
        log(f"[token:{short_t}] Fatal error: {err}")
        for bot_id in bot_ids:
            if bot_id not in results:
                results[bot_id] = "failed"
    finally:
        if browser:
            try:
                await browser.close()
            except Exception:
                pass
            log(f"[token:{short_t}] Browser closed")

    return results
