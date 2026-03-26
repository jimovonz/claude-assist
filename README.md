# claude-assist

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Talk to Claude Code from anywhere. Telegram, browser, terminal. One session, full memory, all your tools.**

claude-assist wraps Claude Code in a multi-channel routing layer called **Conduit**. You message a Telegram bot on your phone, Conduit pipes it into a persistent `claude -p` process with full tool access, streams status updates back, and delivers the response — with rich HTML views for long output via Cloudflare Tunnel.

Paired with [Cairn](https://github.com/jimovonz/cairn), every conversation across every channel feeds the same persistent memory. Context from a terminal session surfaces in Telegram. A decision made on your phone is remembered on your laptop.

---

## How it works

```
┌──────────────────────────────────────────────┐
│              Conduit (Bun)                    │
│                                               │
│  Telegram ──┐                                 │
│  Web CLI ───┤── Router ── Session Manager     │
│  Remote CLI ┘      │          │               │
│                    │     claude -p (persistent)│
│               Cairn Hooks    stream-json I/O   │
│               (memory)                         │
│                                               │
│  View Server ── Cloudflare Tunnel ── HTTPS    │
└──────────────────────────────────────────────┘
```

1. **Message arrives** from any channel (Telegram, web, CLI)
2. **Cairn prompt hook** searches memory for relevant context, injects it
3. **Persistent Claude process** receives the message via stream-json stdin
4. **Status streams back** — tool calls, text previews, heartbeats — edited in place
5. **Cairn stop hook** stores memories, retrieves context if insufficient
6. **Response delivered** — short text inline, long responses as HTML view links

## Key features

- **Persistent sessions** — one `claude -p` process per channel, kept alive. No cold start after the first message.
- **Full Claude Code** — tools, file access, shell commands, web search. Not a limited chat mode.
- **Cairn memory** — proactive context injection via prompt hook, memory storage via stop hook. Cross-session, cross-channel.
- **Streaming status** — Telegram shows what Claude is doing in real time (reading files, running commands, thinking). Edits one message in place, 5s throttle.
- **Rich HTML views** — long responses rendered as styled pages served via Cloudflare Tunnel. Syntax highlighting, diffs, structured content.
- **Session isolation** — each channel gets its own conversation context. Telegram chat doesn't bleed into web CLI work.
- **Message queuing** — rapid messages are queued per channel, preventing concurrent session corruption.

## Quick start

```bash
# Clone
git clone https://github.com/jimovonz/claude-assist.git
cd claude-assist

# Install
bun install

# Configure
cp .env.example .env
# Edit .env: add your TELEGRAM_BOT_TOKEN from @BotFather

# Run
bun run start
```

### Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code](https://code.claude.com) with a claude.ai subscription
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- [Cairn](https://github.com/jimovonz/cairn) for memory (optional but recommended)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) for HTTPS view links (optional)

### Environment variables

```
TELEGRAM_BOT_TOKEN=     # Required — from @BotFather
TELEGRAM_OWNER_ID=      # Optional — receives restart notifications
VIEW_PORT=8099          # Optional — view server port (default: 8099)
VIEW_BASE_URL=          # Optional — base URL for view links
EDGE_URL=               # Optional — GCE edge server for remote TUI access
EDGE_API_SECRET=        # Optional — edge API auth token
TUI_AUTH_TOKEN=          # Optional — WebSocket auth for TUI clients
CAIRN_DIR=              # Optional — path to cairn repo (default: ~/Projects/cairn)
CLOUDFLARE_TUNNEL_TOKEN= # Optional — for named Cloudflare tunnel
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full architectural breakdown, design decisions, and lessons learned.

### Components

| Component | File | Purpose |
|-----------|------|---------|
| **Session Manager** | `src/conduit/session.ts` | Persistent `claude -p` processes per channel, stream-json I/O |
| **Router** | `src/conduit/router.ts` | Channel routing, Cairn hook integration, status streaming, view creation |
| **Telegram** | `src/conduit/channels/telegram/` | Grammy bot, status edits, typing indicator, message queuing |
| **WebSocket/TUI** | `src/conduit/channels/websocket/` | WebSocket channel for local and remote TUI clients |
| **Edge Relay** | `src/service/edge-relay.ts` | Outbound WebSocket to GCE edge for NAT-friendly remote TUI access |
| **Hooks** | `src/conduit/hooks.ts` | Cairn prompt/stop hook runners |
| **View Renderer** | `src/views/renderer.ts` | Markdown-to-HTML with XSS prevention |
| **View Server** | `src/views/server.ts` | Bun.serve() for HTML views, WebSocket, health endpoint, auto-cleanup |
| **Tunnel** | `src/service/tunnel.ts` | Cloudflare Tunnel management (named or quick) |
| **Watchdog** | `src/service/watchdog.ts` | systemd watchdog integration via FFI |
| **systemd** | `src/service/systemd.ts` | Service unit generation, install, status, logs |

### Conduit naming

- **claude-assist** — the project
- **Conduit** — the session manager and channel routing layer
- **Cairn** — the persistent memory system ([separate repo](https://github.com/jimovonz/cairn))

## Status

Functional multi-channel assistant with Telegram, TUI, remote TUI access, and HTML views.

**Done:**
- [x] Telegram channel with status streaming, message chunking, and commands (`/clear`, `/views`, `/context`)
- [x] WebSocket/TUI channel with auth, streaming, and session restore
- [x] Remote TUI access via GCE edge relay (NAT-friendly outbound WebSocket)
- [x] Cloudflare Tunnel integration (named or quick)
- [x] systemd service with watchdog integration
- [x] Session persistence across restarts (SQLite)
- [x] HTML view rendering with edge push and Telegram Mini App support
- [x] Cairn memory integration (prompt and stop hooks)

**Planned:**
- [ ] Scheduled agent tasks (cron) with Google API integration
- [ ] Web CLI channel (browser-based terminal)
- [ ] Telegram Mini Apps for interactive two-way content

## License

[MIT](LICENSE)
