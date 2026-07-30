"""Port of lib/util.js."""
import asyncio


async def delay(ms: int) -> None:
    await asyncio.sleep(ms / 1000)
