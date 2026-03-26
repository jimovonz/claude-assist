# claude-assist

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Work in Progress.** This project is functional but experimental and tightly coupled to a specific personal infrastructure setup — a particular GCE instance, Google Cloud project, OAuth credentials, and Telegram bot. No effort has been made yet to generalise configuration, provide setup automation, or make this accessible for general consumption. If you're interested in running something similar, the code and architecture are here to learn from, but expect to adapt significantly to your own environment.

**Talk to Claude Code from anywhere. Telegram, browser, terminal. One session, full memory, all your tools.**

claude-assist wraps Claude Code in a multi-channel routing layer called **Conduit**. You message a Telegram bot on your phone, Conduit pipes it into a persistent `claude -p` process with full tool access, streams status updates back, and delivers the response — with rich HTML views for long output via a GCE edge server.

Paired with [Cairn](https://github.com/jimovonz/cairn), every conversation across every channel feeds the same persistent memory. Context from a terminal session surfaces in Telegram. A decision made on your phone is remembered on your laptop.

---

## How it works

```
┌──────────────────────────────────────────────────┐
│                Conduit (Bun)                      │
│                                                   │
│  Telegram ──┐                                     │
│  TUI ───────┤── Router ── Session Manager         │
│  Remote TUI ┘      │          │                   │
│                    │     claude -p (persistent)    │
│               Commands    stream-json I/O          │
│               Cairn Hooks                          │
│                                                   │
│  Scheduler ── Task CLI ── Scheduled Tasks (SQLite) │
│  Email Agent ── Gmail Push ── Classification       │
│  View Server ── GCE Edge ── HTTPS (SSL)           │
└──────────────────────────────────────────────────┘
         ↕                           ↕
    Gmail Pub/Sub              Google Calendar
```

1. **Message arrives** from any channel (Telegram, TUI, Remote TUI)
2. **Commands intercepted** (`/tasks`, `/clear`, etc.) or **Cairn prompt hook** injects memory context
3. **Persistent Claude process** receives the message via stream-json stdin
4. **Status streams back** — tool calls, text previews, heartbeats — edited in place
5. **Cairn stop hook** stores memories, retrieves context if insufficient
6. **Response delivered** — short text inline, long responses as HTML view links
7. **Scheduled tasks** fire on cron/one-shot, results route to Telegram
8. **Gmail push** triggers email classification, labeling, calendar events, actionable alerts

## Key features

- **Persistent sessions** — one `claude -p` process per channel, kept alive. No cold start after the first message.
- **Full Claude Code** — tools, file access, shell commands, web search. Not a limited chat mode.
- **Cairn memory** — proactive context injection via prompt hook, memory storage via stop hook. Cross-session, cross-channel.
- **Streaming status** — Telegram shows what Claude is doing in real time (reading files, running commands, thinking). Edits one message in place, 5s throttle.
- **Rich HTML views** — long responses rendered as styled pages served via GCE edge server (HTTPS). Interactive action buttons (button, select, checkbox, text) with POST-back routing.
- **Scheduled tasks** — cron and one-shot scheduling with per-task model selection (Haiku for monitoring, Opus for analysis), LLM-controlled notifications (`auto` mode — Claude decides whether to alert), context files, Cairn memory queries, session strategies (fresh/resume), and reply-to routing.
- **Email agent** — Gmail push notifications via Pub/Sub trigger instant email classification. Applies intelligent labels (`CA/` prefix), creates calendar events for time-sensitive items, only notifies for personally-addressed actionable emails. Silent for newsletters, marketing, automated.
- **Google API access** — Gmail (read/send/label/watch) and Calendar (create/list/free) available from any channel. Natural language calendar creation ("put a meeting with Dave on Thursday at 2pm").
- **Session isolation** — each channel gets its own conversation context. Telegram chat doesn't bleed into TUI work.
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
- Python 3.10+ with `google-auth-oauthlib` and `google-api-python-client` (for Gmail/Calendar — uses Cairn's venv)
- Google Cloud project with OAuth credentials and Gmail/Calendar/Pub/Sub APIs enabled (for email agent)
- GCE instance with Apache + SSL for edge server (for remote TUI and Gmail push webhook)

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
| **Session Manager** | `src/conduit/session.ts` | Persistent `claude -p` processes per channel, stream-json I/O, per-session model selection |
| **Router** | `src/conduit/router.ts` | Channel routing, Cairn hook integration, status streaming, view creation, centralized commands |
| **Scheduler** | `src/conduit/scheduler.ts` | Cron + one-shot task scheduling, LLM-controlled notifications, context injection |
| **Commands** | `src/conduit/commands.ts` | Centralized `/tasks`, `/task`, `/clear`, `/context`, `/sessions`, `/help` |
| **Task CLI** | `bin/task-cli.ts` | CLI for Claude subprocess to create/manage scheduled tasks |
| **Email Agent** | `src/conduit/email-agent.ts` | Gmail push processing: classification, labeling, calendar events, notifications |
| **Gmail Helpers** | `bin/gmail-*.py` | Gmail API: check, label, send, watch (OAuth, Python) |
| **Calendar Helper** | `bin/gcal.py` | Google Calendar: create, list, today, free slots (OAuth, Python) |
| **Telegram** | `src/conduit/channels/telegram/` | Grammy bot, status edits, typing indicator, task reply routing |
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
- [x] Telegram channel with status streaming, message chunking, and commands
- [x] WebSocket/TUI channel with auth, streaming, and session restore
- [x] Remote TUI access via GCE edge relay (NAT-friendly outbound WebSocket)
- [x] Cloudflare Tunnel integration (named or quick)
- [x] systemd service with watchdog integration
- [x] Session persistence across restarts (SQLite)
- [x] HTML view rendering with edge push and Telegram Mini App support
- [x] Cairn memory integration (prompt and stop hooks)
- [x] Scheduled agent tasks — cron, one-shot, per-task model, LLM-controlled notifications, context files/queries, reply-to routing
- [x] Centralized commands (`/tasks`, `/task`, `/clear`, `/context`, `/sessions`, `/help`) across all channels
- [x] Email agent — Gmail push notifications, intelligent classification/labeling, auto calendar events, actionable-only alerts
- [x] Google API integration — Gmail (read/send/label), Calendar (CRUD), accessible from all channels via system prompt
- [x] SSL on GCE edge server (Let's Encrypt)

**Planned:**
- [ ] Todo system — natural language, time-aware reminders, location-aware
- [ ] Email drafting with review/approval flow (careful scoping required)
- [ ] Web CLI channel (browser-based terminal)
- [ ] Generalised setup and configuration for wider accessibility

## License

[MIT](LICENSE)
