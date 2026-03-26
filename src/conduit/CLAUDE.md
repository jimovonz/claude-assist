## Conduit Core

The Conduit is the central message router. It manages persistent `claude -p` processes (stream-json I/O) and routes messages between channels (Telegram, WebSocket/TUI) and Claude sessions.

### Key components
- `router.ts` — Channel interface, message queuing, view creation, stop/prompt hook orchestration
- `session.ts` — SessionManager spawns and manages persistent claude processes, handles resume/abort
- `hooks.ts` — Cairn memory system integration (prompt and stop hooks)
- `state.ts` — Session persistence to disk for restart recovery

### HTML Views

When generating complex output — tables, code with syntax highlighting, structured layouts, diffs, diagrams — consider whether it would be better served as an HTML view. The view pipeline (`src/views/renderer.ts`) renders markdown to styled HTML and pushes it to the GCE edge server at `conduit.alimento.co.nz/view/<id>`.

The pipeline auto-triggers for responses >500 chars or with 2+ code blocks (`shouldCreateView`), but you should actively structure output to leverage rich HTML when the medium is better suited than plain text.

### Edge Relay

`src/service/edge-relay.ts` implements the Channel interface over an outbound WebSocket to the GCE edge server. The conduit initiates the connection (NAT-friendly) and the edge bridges remote TUI clients through it.
