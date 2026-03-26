## WebSocket / TUI Channel

Server-side channel for TUI clients connecting directly (localhost) or via edge relay.

- JSON protocol: `auth` -> `auth_ok`, then `message`/`status`/`text`/`text_end`/`result`
- Streams partial text via `sendStreamText` / `sendStreamEnd`
- No `replyWithView` — TUI always gets full inline responses, Router falls back to `reply()`
- Commands sent as regular messages (e.g. `/tasks`), handled centrally by the Router
- Session restore: on reconnect, auto-fires a greeting prompt so Claude summarises context
- `TUI_AUTH_TOKEN` for authentication
- Persistent userId stored in `~/.local/state/claude-assist/tui-user-id`
- 30s keepalive ping interval
