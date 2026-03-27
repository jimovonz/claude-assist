# claude-assist — Architecture

> **Note:** This is a personal project in active development. The architecture below reflects the current implementation, not a stable public API.

## Overview

claude-assist is a multi-channel AI assistant built on Claude Code. It wraps persistent `claude -p` subprocesses in a routing layer (the **Conduit**) that connects Telegram, a terminal TUI, and a remote TUI via a GCE edge server. Paired with [Cairn](https://github.com/jimovonz/cairn) for persistent semantic memory, it provides a unified assistant accessible from any device.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Conduit (Bun)                       │
│               Single process, systemd service         │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │              Channel Connectors               │    │
│  ├──────────┬─────────┬─────────────────────────┤    │
│  │ Telegram │ TUI/WS  │ Remote TUI (EdgeRelay)  │    │
│  │ Grammy   │ Bun.serve│ Outbound WSS to GCE    │    │
│  └────┬─────┴────┬────┴────────────┬────────────┘    │
│       │          │                 │                   │
│  ┌────┴──────────┴─────────────────┴─────────────┐   │
│  │              Router                            │   │
│  │  channelId → session mapping                   │   │
│  │  Command interception (/tasks, /clear, etc.)   │   │
│  │  Cairn hook orchestration                      │   │
│  │  View creation + action routing                │   │
│  └────┬──────────────────────────────────────────┘   │
│       │                                               │
│  ┌────┴──────────┐  ┌────────────────────────────┐   │
│  │ Session Mgr   │  │ Scheduler                  │   │
│  │ claude -p     │  │ 30s tick, cron + one-shot   │   │
│  │ stream-json   │  │ Per-task model, notify ctrl │   │
│  │ Per-channel   │  │ Context files + Cairn query │   │
│  └───────────────┘  └────────────────────────────┘   │
│                                                       │
│  ┌───────────────┐  ┌────────────────────────────┐   │
│  │ Email Agent   │  │ View Server                │   │
│  │ Gmail push    │  │ HTML views + action API    │   │
│  │ Classify/label│  │ Bun.serve on :8099         │   │
│  │ Dedup (SQLite)│  │ /api/action POST-back      │   │
│  │ Calendar evts │  │                            │   │
│  └───────────────┘  └────────────────────────────┘   │
│                                                       │
│  ┌───────────────┐                                   │
│  │ Location      │                                   │
│  │ OwnTracks GPS │                                   │
│  │ Geofences     │                                   │
│  │ History (1K)  │                                   │
│  └───────────────┘                                   │
│                                                       │
│  ┌───────────────┐  ┌────────────────────────────┐   │
│  │ Cairn Hooks   │  │ State (SQLite)             │   │
│  │ Prompt + Stop │  │ Sessions, tasks, emails,   │   │
│  └───────────────┘  │ locations, history          │   │
│                      └────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
         ↕                    ↕                ↕
    Telegram             GCE Edge          Gmail Pub/Sub
   (any device)      (conduit.alimento     (push webhook)
                       .co.nz HTTPS)
```

## Key Design Decisions

### Why `claude -p` instead of Claude Code SDK?

The Conduit spawns Claude as a persistent subprocess using `claude -p --input-format stream-json --output-format stream-json`. This gives:

- Full Claude Code tool access (Bash, Read, Write, etc.)
- `--resume` for session continuity across messages
- `--append-system-prompt` for injecting Conduit-specific instructions
- `--model` for per-session/per-task model selection
- `--permission-mode bypassPermissions` for autonomous operation

The SDK was considered initially but `claude -p` is simpler, more stable, and gives identical capabilities.

### Session isolation

Each channel gets its own `channelId` (e.g. `telegram:<user_id>`, `tui:user-abc123`, `task:heartbeat`). Sessions persist across restarts via SQLite. The Router dispatches uniformly — channel-specific behaviour lives in each channel's connector.

### Centralized commands

Commands (`/tasks`, `/task`, `/clear`, `/context`, `/sessions`, `/help`) are handled in `commands.ts` before reaching Claude. All channels share the same command set — no duplication.

### LLM-controlled notifications

Scheduled tasks support `notify: auto` mode where Claude decides whether the user should be notified by including a `<notify>true|false</notify>` tag. The scheduler respects this — healthy heartbeat checks stay silent, problems trigger alerts. Manual triggers (`/task <id> run`) always notify.

### Email agent — push not poll

Gmail push notifications via Google Pub/Sub arrive at the GCE edge server within seconds of inbox changes. The edge forwards via WebSocket to the conduit's EdgeRelay, which triggers the EmailAgent. This avoids the latency and cost of polling. Watch registration auto-renews every 3 days via a scheduled task.

### Email dedup — SQLite not in-memory

Processed email IDs are tracked in SQLite (not an in-memory Set) so dedup state survives service restarts. Entries have 7-day retention with automatic cleanup. Emails are marked as read after processing to prevent re-processing on next push.

### Location tracking — OwnTracks via edge relay

GPS updates from OwnTracks arrive via the edge server WebSocket as `type: "location"` messages. The EdgeRelay stores them in SQLite (`location_history`, last 1000 entries) and checks against named geofences. Named locations are CRUD-managed with slug IDs and configurable radii. Haversine distance used for matching.

### Interactive HTML views

Views support `<action>` tags (button, select, checkbox, text) rendered as interactive forms in HTML. A single Submit collects all inputs and POSTs to `/api/action`. Actions route back to the originating session via `channelId` stored in the view index. TUI/CLI renders actions as numbered choices. The GCE edge server proxies action requests back to the conduit.

## Components

### Conduit Core (`src/conduit/`)

| File | Purpose |
|------|---------|
| `router.ts` | Channel interface, message queuing, command interception, view creation, Cairn hooks |
| `session.ts` | SessionManager — spawns/manages persistent `claude -p` processes, resume, abort, model selection |
| `state.ts` | SQLite persistence — sessions, scheduled tasks, processed emails (dedup), locations, location history |
| `scheduler.ts` | TaskScheduler — 30s tick, cron parser, one-shot (runAt), fireTask, notify resolution |
| `commands.ts` | Central `/tasks`, `/task`, `/clear`, `/context`, `/sessions`, `/help` handler |
| `email-agent.ts` | EmailAgent — Gmail push processing, classification, labeling, calendar events, dedup persistence, mark-as-read |
| `hooks.ts` | Cairn prompt/stop hook subprocess runners |
| `index.ts` | Public exports |

### Channels (`src/conduit/channels/`)

| Channel | Transport | Features |
|---------|-----------|----------|
| Telegram | Grammy bot, long-polling | Status edits (5s throttle), typing indicator, reply-to task routing, `sendTaskResult` with HTML views, `/views` command |
| WebSocket/TUI | Bun.serve WebSocket | Streaming text, action extraction, session restore greeting, cancel support |
| Edge Relay | Outbound WSS to GCE | TUI bridging, action proxy, Gmail push forwarding |

### Services (`src/service/`)

| File | Purpose |
|------|---------|
| `edge-relay.ts` | Channel interface over WebSocket to GCE edge (handles TUI, actions, Gmail push, OwnTracks location updates) |
| `tunnel.ts` | Cloudflare Tunnel management (legacy, optional) |
| `watchdog.ts` | systemd watchdog via FFI |
| `systemd.ts` | Service unit generation, install, status, logs |

### Views (`src/views/`)

| File | Purpose |
|------|---------|
| `renderer.ts` | Markdown → HTML, action tag extraction, view creation, edge push |
| `server.ts` | Bun.serve for views, `/api/action` endpoint, health, WebSocket upgrade |

### Python Helpers (`bin/`)

| Script | Purpose |
|--------|---------|
| `gmail-check.py` | List/read emails (--since, --body, --query, --id) |
| `gmail-label.py` | Create/apply/remove labels, mark read |
| `gmail-send.py` | Send email (with reply-to threading) |
| `gmail-watch.py` | Register/renew/stop Gmail push notifications |
| `gcal.py` | Calendar CRUD (create, list, today, free slots) |
| `task-cli.ts` | Scheduled task management (create, list, get, update, delete) |

### Configuration Files

| File | Purpose |
|------|---------|
| `email-agent.md` | Email classification rules, label taxonomy, notification criteria, calendar event rules |
| `HEARTBEAT.md` | Heartbeat checklist — what to monitor, thresholds, reporting format |
| `.env` | Telegram token, edge URL, secrets |

## GCE Edge Server

Python/aiohttp on the GCE edge server, Apache reverse proxy with Let's Encrypt SSL.

Endpoints:
- `POST /api/views` — receive and store HTML views from conduit
- `GET /view/<id>` — serve HTML views (Telegram Mini Apps, direct links)
- `POST /api/action` — proxy action button clicks to conduit via WebSocket
- `POST /api/gmail-push` — receive Gmail Pub/Sub notifications, forward to conduit
- `GET /ws/conduit` — conduit upstream WebSocket (authenticated)
- `GET /ws/tui` — TUI client downstream WebSocket
- `GET /health` — status, view count, connection state

## State & Persistence

- **Sessions**: SQLite in `~/.local/state/claude-assist/conduit.db` — channelId, sessionId, lastActivity
- **Tasks**: Same SQLite DB — slug IDs, schedules, prompts, model, notify, contextFiles, contextQuery, runAt, lastRun
- **Processed emails**: Same SQLite DB — email_id (PK), processed_at timestamp, 7-day retention with auto-cleanup
- **Locations**: Same SQLite DB (lazy init) — named places with lat/lon/radius for geofencing
- **Location history**: Same SQLite DB (lazy init) — GPS updates with accuracy/velocity/battery, capped at 1000 entries
- **Gmail watch**: `~/.local/state/claude-assist/gmail-watch.json` — historyId, expiration
- **Gmail history**: `~/.local/state/claude-assist/gmail-history-id.txt` — last processed historyId
- **Views**: `views/index.json` — slug, title, URL, channelId (for action routing), capped at 100
- **Google OAuth**: `~/.config/google/token.json` + `credentials.json`

## Test Coverage

529 tests across 27 files covering:
- Cron parser (wildcards, steps, ranges, commas, day-of-week)
- Task CRUD (slug IDs, dedup, all fields, one-shot, notify/model/skipCairn/contextQuery)
- Scheduler integration (tick, fire, strategies, notify modes, force-notify, auto-disable, model passing)
- Command handler (all commands, edge cases, isCommand validation)
- Email agent (action parsing, notification extraction, configuration, script structure, context file)
- Email dedup (isEmailProcessed, markEmailProcessed, cleanupOldEmails, retention, batch processing)
- Location tracking (CRUD, slug IDs, geofence matching, haversine distance, boundary tests, history retention)
- Telegram (throttling, chunking, status, sendDirect with chunking, allowlist)
- Interactive views (action extraction, types, HTML rendering, stripMetadata, form output)
- Router (message flow, hooks, views, metadata stripping, error handling)
- Sessions (spawn, resume, abort, parsing, persistence)
- WebSocket (auth, reconnect, commands)
- Views (renderer, XSS, index management)
