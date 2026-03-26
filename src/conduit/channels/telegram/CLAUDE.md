## Telegram Channel

Grammy bot with long-polling.

- `allowedUserIds` allowlist — unauthorized users are silently ignored
- Status messages: sent/edited with 5s cooldown to avoid Telegram rate limits
- `replyWithView` sends a summary + view link (edge URL) — Telegram opens these as Mini Apps via `telegram-web-app.js`
- Commands: `/clear` (reset session), `/context` (show token usage)
- 4096 char message limit — long responses are chunked by line boundaries
- Typing indicator kept alive on 4s interval during processing
