## Telegram Channel

Grammy bot with long-polling.

- `allowedUserIds` allowlist — unauthorized users are silently ignored
- Status messages: sent/edited with 5s cooldown to avoid Telegram rate limits
- `replyWithView` sends a summary + view link (edge URL) — Telegram opens these as Mini Apps via `telegram-web-app.js`
- Commands centralized in router (`/clear`, `/context`, `/tasks`, `/task`, `/help`, `/sessions`). Only `/views` handled locally (needs Telegram-specific view creation)
- `sendTaskResult()` delivers scheduled task output with HTML view support, `📋 Scheduled Task:` header, and reply-to routing
- Reply-to routing: task output messages tracked in a bounded map (max 100). User replies to task messages route to the task's session, not the main conversation
- 4096 char message limit — long responses are chunked by line boundaries
- Typing indicator kept alive on 4s interval during processing
