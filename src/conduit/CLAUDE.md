## Conduit Core

The Conduit is the central message router. It manages persistent `claude -p` processes (stream-json I/O) and routes messages between channels (Telegram, WebSocket/TUI) and Claude sessions.

### Key components
- `router.ts` — Channel interface, message queuing, view creation, stop/prompt hook orchestration, centralized command handling
- `session.ts` — SessionManager spawns and manages persistent claude processes, handles resume/abort, per-session model selection
- `hooks.ts` — Cairn memory system integration (prompt and stop hooks)
- `state.ts` — Session and task persistence (SQLite)
- `scheduler.ts` — TaskScheduler: 30s tick loop, cron + one-shot scheduling, context injection, LLM-controlled notifications
- `commands.ts` — Centralized command handler for `/clear`, `/context`, `/sessions`, `/tasks`, `/task`, `/help` — shared across all channels

### Scheduled Tasks

The scheduler fires tasks on cron schedules or at specific times (one-shot). Tasks are defined in SQLite with slug-based IDs, per-task model selection, notification control (always/auto/never), session strategies (fresh/resume), context files, and optional Cairn context queries. Claude creates tasks via `bin/task-cli.ts` during natural conversation. Output routes to Telegram with HTML view support and reply-to routing for interactive follow-up. Manual trigger via `/task <id> run`.

### HTML Views

When generating complex output — tables, code with syntax highlighting, structured layouts, diffs, diagrams — consider whether it would be better served as an HTML view. The view pipeline (`src/views/renderer.ts`) renders markdown to styled HTML and pushes it to the GCE edge server at `conduit.alimento.co.nz/view/<id>`.

The pipeline auto-triggers for responses >500 chars or with 2+ code blocks (`shouldCreateView`), but you should actively structure output to leverage rich HTML when the medium is better suited than plain text.

### Edge Relay

`src/service/edge-relay.ts` implements the Channel interface over an outbound WebSocket to the GCE edge server. The conduit initiates the connection (NAT-friendly) and the edge bridges remote TUI clients through it.
