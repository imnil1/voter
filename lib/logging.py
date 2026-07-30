"""Port of lib/logging.js — timezone-aware log formatting + verbose gate."""
import os
import re
from datetime import datetime
from zoneinfo import ZoneInfo

LOG_TIMEZONE = os.environ.get("TIMEZONE", "UTC")

VERBOSE_LOGS = bool(re.match(r"^(true|1)$", os.environ.get("VERBOSE_LOGS", ""), re.IGNORECASE))


def now_formatted() -> str:
    try:
        tz = ZoneInfo(LOG_TIMEZONE)
        return datetime.now(tz).strftime("%b %d, %Y, %I:%M:%S %p")
    except Exception:
        return datetime.utcnow().isoformat()


def log(msg: str) -> None:
    print(f"[{now_formatted()}] {msg}", flush=True)


def log_verbose(msg: str) -> None:
    if VERBOSE_LOGS:
        log(msg)
