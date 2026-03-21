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
VIEW_PORT=8099          # Optional — view server port (default: 8099)
VIEW_BASE_URL=          # Optional — Cloudflare Tunnel URL for view links
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full architectural breakdown, design decisions, and lessons learned.

### Components

| Component | File | Purpose |
|-----------|------|---------|
| **Session Manager** | `src/conduit/session.ts` | Persistent `claude -p` processes per channel, stream-json I/O |
| **Router** | `src/conduit/router.ts` | Channel routing, Cairn hook integration, status streaming, view creation |
| **Telegram** | `src/conduit/channels/telegram.ts` | Grammy bot, status edits, typing indicator, message queuing |
| **Hooks** | `src/conduit/hooks.ts` | Cairn prompt/stop hook runners |
| **View Renderer** | `src/views/renderer.ts` | Markdown-to-HTML, syntax highlighting |
| **View Server** | `src/views/server.ts` | Bun.serve() for HTML views, token-based URLs, auto-cleanup |

### Conduit naming

- **claude-assist** — the project
- **Conduit** — the session manager and channel routing layer
- **Cairn** — the persistent memory system ([separate repo](https://github.com/jimovonz/cairn))

## Status

MVP — functional Telegram integration with Cairn memory and HTML views. Work in progress:

- [ ] Web CLI channel (browser-based terminal)
- [ ] Remote CLI channel (thin terminal client)
- [ ] Cloudflare Tunnel auto-setup
- [ ] systemd service for always-on
- [ ] Session persistence across restarts
- [ ] Slash commands from Telegram (`/clear`, `/sessions`, `/switch`)
- [ ] Telegram Mini Apps for interactive content

## License

[MIT](LICENSE)
