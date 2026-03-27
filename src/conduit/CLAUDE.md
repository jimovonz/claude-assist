## Conduit Core

The Conduit is the central message router. It manages persistent `claude -p` processes (stream-json I/O) and routes messages between channels (Telegram, WebSocket/TUI) and Claude sessions.

### Key components
- `router.ts` — Channel interface, message queuing, view creation, stop/prompt hook orchestration, centralized command handling
- `session.ts` — SessionManager spawns and manages persistent claude processes, handles resume/abort, per-session model selection
- `hooks.ts` — Cairn memory system integration (prompt and stop hooks)
- `state.ts` — Session, task, processed email, and location persistence (SQLite)
- `scheduler.ts` — TaskScheduler: 30s tick loop, cron + one-shot scheduling, context injection, LLM-controlled notifications
- `commands.ts` — Centralized command handler for `/clear`, `/context`, `/sessions`, `/tasks`, `/task`, `/help` — shared across all channels
- `email-agent.ts` — EmailAgent processes Gmail push notifications: classification, labeling, calendar events, actionable notifications

### Scheduled Tasks

The scheduler fires tasks on cron schedules or at specific times (one-shot). Tasks are defined in SQLite with slug-based IDs, per-task model selection, notification control (always/auto/never), session strategies (fresh/resume), context files, and optional Cairn context queries. Claude creates tasks via `bin/task-cli.ts` during natural conversation. Output routes to Telegram with HTML view support and reply-to routing for interactive follow-up. Manual trigger via `/task <id> run`.

### Email Agent

Gmail push notifications via Google Pub/Sub → GCE edge webhook → EdgeRelay → EmailAgent. On each push, fetches unread messages, filters out already-processed IDs (SQLite `processed_emails` table, 7-day retention), runs through Claude (Haiku) with `email-agent.md` context for classification. Applies `CA/` prefixed Gmail labels, creates calendar events for time-sensitive items, marks processed emails as read, notifies via Telegram `sendDirect` only for actionable personally-addressed emails. Python helper scripts (`bin/gmail-check.py`, `gmail-label.py`, `gmail-send.py`, `gmail-watch.py`, `gcal.py`) handle Google API access using OAuth token at `~/.config/google/token.json`. Watch auto-renews every 3 days via scheduled task.

### Location Tracking

OwnTracks GPS updates arrive via edge server WebSocket as `type: "location"` messages → EdgeRelay `handleLocationUpdate`. Stores in SQLite `location_history` (last 1000 entries) with lat/lon/accuracy/velocity/battery/timestamp. Named locations (geofences) managed via `createLocation`/`listLocations`/`getLocation`/`deleteLocation` with slug IDs and configurable radius. `checkGeofences` uses haversine distance to find matching locations on each update.

### Google API Access

All channels have access to Gmail and Calendar via Python helpers in `bin/`. The system prompt documents these so Claude can read/send email, create calendar events, and check schedules from any conversation. OAuth token shared across all usage.

### HTML Views & Interactive Actions

The view pipeline (`src/views/renderer.ts`) renders markdown to styled HTML and pushes to the GCE edge server at `conduit.alimento.co.nz/view/<id>`. Auto-triggers for responses >500 chars or with 2+ code blocks.

Views support interactive `<action>` tags — buttons, radio select, checkboxes, and text input. Actions POST to `/api/action` (local or via edge proxy), route back to the originating session. TUI/CLI renders actions as numbered choices. Plain text fallback shows bracketed labels. Single-submit form pattern — form disables after submission.

### Edge Relay

`src/service/edge-relay.ts` implements the Channel interface over an outbound WebSocket to the GCE edge server (HTTPS/WSS). Handles TUI relay, action button proxying, and Gmail push notification forwarding. The conduit initiates the connection (NAT-friendly).
