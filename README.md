# top-gg-voter-railway

## Environment variables

Set a single `CONFIG` env var with JSON:

```json
{
  "tokens": [
    { "token": "YOUR_DISCORD_TOKEN_1", "voteAt": "08:50" },
    { "token": "YOUR_DISCORD_TOKEN_2", "voteAt": "09:30" }
  ],
  "botIds": [
    "123456789012345678",
    "987654321098765432"
  ]
}
```

Also set:
```
BROWSER_WS_URL=wss://your-chrome.up.railway.app?token=xxx
```

## How it works

- Each token fires independently at its scheduled time (every 24h)
- On each fire, it votes for all botIds sequentially
- Times are in 24h format (HH:MM), server local time

## Local test

```bash
npm install
CONFIG='{"tokens":[{"token":"tok","voteAt":"08:50"}],"botIds":["123"]}' \
BROWSER_WS_URL=wss://... node index.js
```
