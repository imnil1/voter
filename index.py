"""Port of index.js — the scheduler entry point."""
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from playwright.async_api import async_playwright

from top import vote_all_bots_for_token

try:
    config = json.loads(os.environ.get("CONFIG", ""))
except Exception:
    print("[fatal] CONFIG env var is missing or invalid JSON", file=sys.stderr)
    print('[fatal] Example: CONFIG={"tokens":[{"token":"...","voteAt":["08:50","20:50"]}],"botIds":["123456789"]}', file=sys.stderr)
    sys.exit(1)

tokens = config.get("tokens")
bot_ids = config.get("botIds")
timezone_name = os.environ.get("TIMEZONE", "UTC")

if not isinstance(tokens, list) or len(tokens) == 0:
    print("[fatal] CONFIG.tokens must be a non-empty array", file=sys.stderr)
    sys.exit(1)
if not isinstance(bot_ids, list) or len(bot_ids) == 0:
    print("[fatal] CONFIG.botIds must be a non-empty array", file=sys.stderr)
    sys.exit(1)

try:
    TZ = ZoneInfo(timezone_name)
except Exception:
    print(f'[fatal] Invalid timezone "{timezone_name}"', file=sys.stderr)
    sys.exit(1)

for entry in tokens:
    vote_at = entry.get("voteAt")
    if vote_at is None:
        continue  # immediate-run token, no times to validate
    times = vote_at if isinstance(vote_at, list) else [vote_at]
    for t in times:
        if not re.match(r"^\d{1,2}:\d{2}$", t):
            print(f'[fatal] Invalid voteAt time "{t}" — must be HH:MM', file=sys.stderr)
            sys.exit(1)


def next_fire_date(h: int, m: int) -> datetime:
    now = datetime.now(TZ)
    candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if candidate <= now:
        candidate = candidate + timedelta(days=1)
    return candidate


def format_fire_time(dt: datetime) -> str:
    return dt.strftime("%I:%M %p").lstrip("0")


def format_ms(ms: float) -> str:
    total_min = round(ms / 60000)
    h, m = divmod(total_min, 60)
    return f"{h}h {m}m" if h > 0 else f"{m}m"


def now_iso() -> str:
    try:
        return datetime.now(TZ).strftime("%b %d, %Y, %I:%M:%S %p")
    except Exception:
        return datetime.utcnow().isoformat()


TURNSTILE_RETRY_MS = 10 * 60 * 1000  # retry Turnstile-blocked bots after 10 min
TURNSTILE_MAX_RETRIES = 3  # give up after this many retries until the next scheduled slot


async def retry_turnstile_bots(playwright, token, token_label, bot_ids_to_retry, attempt=1):
    print(f"[{now_iso()}] [scheduler] Token {token_label} retrying {len(bot_ids_to_retry)} Turnstile-blocked bot(s), attempt {attempt}")
    results = await vote_all_bots_for_token(playwright, token, bot_ids_to_retry, token_label)

    still_blocked = [bid for bid in bot_ids_to_retry if results.get(bid) == "turnstile"]
    if not still_blocked:
        print(f"[{now_iso()}] [scheduler] Token {token_label} all retried bots resolved")
        return
    if attempt >= TURNSTILE_MAX_RETRIES:
        print(f"[{now_iso()}] [scheduler] Token {token_label} giving up on {len(still_blocked)} bot(s) after {attempt} retries — will try again at next scheduled slot")
        return

    print(f"[{now_iso()}] [scheduler] Token {token_label} {len(still_blocked)} bot(s) still Turnstile-blocked, retrying again in {format_ms(TURNSTILE_RETRY_MS)}")
    await asyncio.sleep(TURNSTILE_RETRY_MS / 1000)
    await retry_turnstile_bots(playwright, token, token_label, still_blocked, attempt + 1)


async def schedule_slot(playwright, token, token_label, h, m, slot_label):
    while True:
        fire_date = next_fire_date(h, m)
        wait_s = (fire_date - datetime.now(TZ)).total_seconds()
        print(f"[{now_iso()}] [scheduler] Token {token_label} slot {slot_label} ({timezone_name}) fires at {format_fire_time(fire_date)}")
        await asyncio.sleep(max(wait_s, 0))
        print(f"[{now_iso()}] [scheduler] Token {token_label} slot {slot_label} firing now")

        results = await vote_all_bots_for_token(playwright, token, bot_ids, token_label)
        turnstile_blocked = [bid for bid in bot_ids if results.get(bid) == "turnstile"]

        if turnstile_blocked:
            print(f"[{now_iso()}] [scheduler] Token {token_label} {len(turnstile_blocked)} bot(s) blocked by Turnstile, will retry in {format_ms(TURNSTILE_RETRY_MS)}")
            # Fire-and-forget so the main slot loop below isn't held up.
            asyncio.create_task(_retry_wrapper(playwright, token, token_label, turnstile_blocked))

        await asyncio.sleep(61)


async def _retry_wrapper(playwright, token, token_label, turnstile_blocked):
    try:
        await retry_turnstile_bots(playwright, token, token_label, turnstile_blocked)
    except Exception as err:
        print(f"[{now_iso()}] [scheduler] Token {token_label} retry chain crashed: {err}")


async def run_immediately(playwright, token, token_label):
    print(f"[{now_iso()}] [scheduler] Token {token_label} has no voteAt — running immediately")

    results = await vote_all_bots_for_token(playwright, token, bot_ids, token_label)
    turnstile_blocked = [bid for bid in bot_ids if results.get(bid) == "turnstile"]

    if turnstile_blocked:
        print(f"[{now_iso()}] [scheduler] Token {token_label} {len(turnstile_blocked)} bot(s) blocked by Turnstile, will retry in {format_ms(TURNSTILE_RETRY_MS)}")
        asyncio.create_task(_retry_wrapper(playwright, token, token_label, turnstile_blocked))


async def main():
    async with async_playwright() as playwright:
        tasks = []

        for entry in tokens:
            token = entry["token"]
            vote_at = entry.get("voteAt")
            token_label = entry.get("label") or (token[:5] + "...")

            if vote_at is None:
                tasks.append(asyncio.create_task(_immediate_wrapper(playwright, token, token_label)))
                continue

            times = vote_at if isinstance(vote_at, list) else [vote_at]
            for time_str in times:
                h, m = map(int, time_str.split(":"))
                tasks.append(asyncio.create_task(_slot_wrapper(playwright, token, token_label, h, m, time_str)))

        print(f"[{now_iso()}] [main] Using timezone: {timezone_name}")
        print(f"[{now_iso()}] [main] Scheduler started — {len(tokens)} token(s), {len(bot_ids)} bot(s)")

        # Keep the process alive indefinitely — asyncio.gather on the
        # scheduled tasks below serves the same purpose as the Node
        # version's setInterval heartbeat (nothing left to schedule
        # shouldn't exit the process).
        if tasks:
            await asyncio.gather(*tasks)
        else:
            await asyncio.Event().wait()


async def _immediate_wrapper(playwright, token, token_label):
    try:
        await run_immediately(playwright, token, token_label)
    except Exception as err:
        print(f"[fatal] immediate run crashed for token {token_label}: {err}", file=sys.stderr)


async def _slot_wrapper(playwright, token, token_label, h, m, time_str):
    try:
        await schedule_slot(playwright, token, token_label, h, m, time_str)
    except Exception as err:
        print(f"[fatal] scheduler crashed for token {token_label} slot {time_str}: {err}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
