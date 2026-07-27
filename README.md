Automates voting for Discord bots on top.gg using multiple Discord tokens,
via a remote browser (Playwright connected to a `browserless-v2` instance),
with per-token scheduling, Cloudflare Turnstile solving, and debug
screenshots on failure.

## Environment variables

### `CONFIG` (required)

A single JSON blob with your tokens, their schedules, and the bots to vote for:

```json
{
  "tokens": [
    { "label": "main", "token": "YOUR_DISCORD_TOKEN_1", "voteAt": ["08:50", "20:50"] },
    { "label": "alt",  "token": "YOUR_DISCORD_TOKEN_2" }
  ],
  "botIds": [
    "123456789012345678",
    "987654321098765432"
  ]
}
```

Per-token fields:
- **`token`** (required) — the Discord token.
- **`label`** (optional) — a readable name used in logs instead of a
  truncated token prefix (e.g. `[token:main]` instead of `[token:ODk4M...]`).
- **`voteAt`** (optional) — one time (`"08:50"`) or a list of times
  (`["08:50", "20:50"]`), in 24h `HH:MM` format, interpreted in `TIMEZONE`.
  **Omit this field (or set it to `null`) to have that token run once
  immediately on startup instead of waiting for a scheduled time** —
  useful for quick testing without waiting for a real slot.

### Browser connection (required)

```
BROWSER_WS_URL=wss://your-browserless-domain.up.railway.app?token=xxx
```
WebSocket endpoint of your `browserless-v2` (or compatible) service.

### Timezone (optional)

```
TIMEZONE=Asia/Kolkata
```
IANA timezone used to interpret all `voteAt` times. Defaults to UTC if unset.

### Cookie persistence (optional)

```
COOKIE_DIR=/app/cookies
```
Where per-token session cookies are cached, so each run can skip a full
Discord OAuth login when possible. Mount a Railway volume here to persist
across deploys/restarts.

### Debug screenshots (optional)

```
SCREENSHOT_DIR=/app/screenshots
```
Where full-page screenshots are saved whenever a vote fails to confirm,
times out, or a Turnstile challenge can't be solved. Filenames look like
`{label}_{botId}_{reason}_{timestamp}.png`, so repeated failures don't
overwrite each other. Mount a Railway volume here if you want these to
persist and be inspectable later. Screenshot failures never crash the vote
flow itself — this is best-effort debugging output only.

### Turnstile solving (optional but recommended)

```
TURNSTILE_SOLVER_URL=https://your-turnstile-solver-domain.up.railway.app
TURNSTILE_SOLVER_KEY=your_solver_api_key
```
Points at a self-hosted, 2captcha-API-compatible Turnstile solver (e.g. a
deployment of `icemellow-me/turnstile-solver` or a fork of it) running as
its own service. When top.gg shows a Cloudflare Turnstile challenge after
clicking Vote, this code:
1. Extracts the sitekey from the page.
2. Submits it + the page URL to the solver's `/in.php`.
3. Polls `/res.php` until solved (or a ~60s timeout).
4. Injects the returned token into top.gg's hidden response field and
   re-submits.

If these vars are unset, or solving fails/times out, the bot is simply
skipped for that run and retried later (see below) — nothing crashes.

## How voting actually works (top.gg's current flow)

1. Navigate to the vote page.
2. A **~10s ad countdown** runs (`"You will be able to vote after this
   ad."`) — the Vote button exists in the DOM the whole time but is
   `disabled` until it finishes.
3. Once enabled, click **Vote**.
4. **Sometimes** a Cloudflare Turnstile challenge appears — solved via the
   solver above if configured, otherwise the vote is skipped for now.
5. Success shows an `<h2>Thanks for voting!</h2>` heading — this (not
   "already voted") is what confirms a vote actually went through.
6. If already voted, the page shows a cooldown message
   (`"You can vote again in about N hours."`). If that cooldown is ≤10
   minutes, the code waits it out and retries automatically instead of
   giving up.

## Turnstile retry behavior

If a bot comes back blocked by Turnstile (solver unavailable or couldn't
solve it in time), the scheduler retries just that bot every **10
minutes**, up to **3 attempts**, without blocking the rest of the
schedule. If still blocked after 3 tries, it's left alone until the next
regular `voteAt` slot (or next immediate-run on restart).

## How scheduling works

- Each token with a `voteAt` fires independently at its scheduled time(s),
  repeating every 24h.
- A token with no `voteAt` runs once immediately on startup instead.
- On each fire, a token opens **one** browser session, logs in once
  (via cached cookies or a fresh Discord OAuth flow), and votes for all
  `botIds` sequentially in that same session.
- Different tokens run concurrently/independently of each other — they are
  not staggered automatically, so if several tokens share very close
  `voteAt` times, expect that many simultaneous browser sessions against
  `BROWSER_WS_URL`.

## Local test

```bash
npm install
CONFIG='{"tokens":[{"label":"test","token":"tok"}],"botIds":["123"]}' \
BROWSER_WS_URL=wss://... \
TURNSTILE_SOLVER_URL=https://... \
TURNSTILE_SOLVER_KEY=... \
node index.js
```

Omitting `voteAt` above means this fires immediately — good for a quick
end-to-end smoke test before deploying with real schedules.
