# claude-assist — Design Document

## Overview

claude-assist extends Claude Code to provide a personal AI assistant accessible from any device, any channel, with persistent memory and rich interaction capabilities — similar to [OpenClaw](https://openclaw.ai/) but built on Claude Code's existing ecosystem.

Two core components:

- **Cairn** — persistent semantic memory (operational)
- **Conduit** — Conduit and channel router (to build)

This document captures the architectural decisions and planned work.

## Goals

- Access Claude Code from **any device** (phone, laptop, desktop)
- Interact via **multiple channels** — Telegram, web browser, remote CLI — each with its own isolated conversation context
- Provide **rich output** via interactive web views (Telegram Mini Apps, Cloudflare Tunnel-hosted pages)
- Maintain **persistent memory** across all sessions and channels via Cairn
- Run **autonomously** as an always-on service
- **Easy to distribute** — anyone should be able to deploy their own instance with minimal configuration

## Architecture

claude-assist is a **single Bun process** (the Conduit) that owns all channel connections and uses the `@anthropic-ai/claude-code` SDK as the backend. It does **not** use Claude Code's `--channels` MCP system.

```
┌──────────────────────────────────────────────────────────┐
│              Conduit (Bun)                        │
│              One process, one systemd service             │
│                                                          │
│  ┌─────────────────────────────────────────────────┐     │
│  │              Channel Connectors                  │     │
│  ├──────────┬──────────┬──────────┬───────────────┤     │
│  │ Telegram │ Web CLI  │ Remote   │  Future       │     │
│  │ Bot API  │ WebSocket│ CLI      │  (Slack,etc)  │     │
│  └────┬─────┴────┬─────┴────┬─────┴───────┬──────┘     │
│       │          │          │             │              │
│  ┌────┴──────────┴──────────┴─────────────┴────────┐    │
│  │              Session Router                      │    │
│  │  channelId → sessionId mapping                   │    │
│  │  Per-channel isolated Claude Code sessions       │    │
│  └────┬─────────────────────────────────────┬──────┘    │
│       │                                     │            │
│  ┌────┴──────────┐              ┌───────────┴────────┐  │
│  │ Claude Code   │              │ Claude Code        │  │
│  │ SDK session   │  ...         │ SDK session        │  │
│  │ (Telegram)    │              │ (Web CLI)          │  │
│  └───────────────┘              └────────────────────┘  │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
│  │  Cairn   │  │  View    │  │  cloudflared       │    │
│  │  Memory  │  │  Renderer│  │  (tunnel)           │    │
│  └──────────┘  └──────────┘  └────────────────────┘    │
└──────────────────────────────────────────────────────────┘
       ↕              ↕              ↕
  Telegram        Browser        Terminal
 (any device)   (any device)   (any machine)
```

### Why not `--channels`?

Claude Code's `--channels` MCP system ties channel connections to a single Claude Code process with shared conversation context. This means:

- All channels share one context (Telegram chat about dinner bleeds into Web CLI code work)
- Only one process can poll a Telegram bot at a time
- Adding channels requires restarting the Claude session

By using the SDK directly, the Conduit:

- Maintains **separate sessions per channel** with isolated contexts
- Owns all channel connections in one process
- Can spawn/suspend sessions on demand
- Routes tool approval requests back through the originating channel
- Streams responses in real-time via the SDK's async iterator

### Core SDK usage

```typescript
import { query } from "@anthropic-ai/claude-code";

// Per-channel session management
for await (const msg of query({
  prompt: userMessage,
  options: {
    resume: sessionId,          // multi-turn per channel
    allowedTools: [...],        // auto-approve safe tools
    canUseTool: (tool) => {     // route approvals to user's channel
      return channel.askApproval(userId, tool);
    }
  }
})) {
  if (msg.type === "assistant") {
    channel.reply(userId, msg.content);
  }
  if (msg.type === "result") {
    sessions.set(channelId, msg.session_id);
  }
}
```

## Channel Tiers

Each channel gets its own Claude Code session with isolated conversation context. Cairn memory is shared across all sessions.

| Channel | When to use | Strengths |
|---------|-------------|-----------|
| **Telegram** | Phone, quick tasks, on the go | Reactions for approvals, links to web views for detail |
| **Web CLI** | Browser, want rich rendering | HTML diffs, interactive forms, clickable elements, mobile-responsive |
| **Remote CLI** | At a terminal, want full speed | Native ANSI rendering, fast typing, familiar CLI feel |

## Key Components

### 1. Conduit (core — to build)

The central process that orchestrates everything.

- Single Bun process, runs as a systemd user service
- Owns all channel connections directly (Telegram Bot API, WebSocket, etc.)
- Spawns per-channel Claude Code SDK sessions
- Routes messages and tool approval requests
- Manages session lifecycle (spawn, suspend on idle, resume on message)
- Commands: `/sessions`, `/switch`, `/new`, `/kill`

### 2. Cairn (operational)

Persistent semantic memory system stored in SQLite with embeddings.

- Stop hook parses `<memory>` blocks from every Claude response
- Deduplication via cosine similarity (threshold 0.85)
- Confidence scoring with feedback loop
- Semantic search, full-text search, project/session scoping
- Shared across all channels and sessions

### 3. Telegram Connector

Direct integration with the Telegram Bot API (not the MCP plugin).

- Polls bot API for incoming messages
- Routes to per-user, per-channel SDK sessions
- Sends responses back via Bot API
- Sender allowlist for access control
- Telegram Mini Apps for rich interactive content (forms, selections, approvals)

### 4. Web CLI (to build)

A browser-based CLI interface served via Cloudflare Tunnel.

- HTML + JS web application with CLI-style input/output
- WebSocket connection to the Conduit
- Rich output rendering (syntax-highlighted diffs, collapsible tool cards, forms)
- Session tabs — view and switch between active sessions
- Mobile-responsive layout

### 5. Remote CLI (to build)

A thin CLI client that connects from any machine to the Conduit.

- Single binary (Bun/Go/Rust) for cross-platform use
- WebSocket connection to the Conduit via Cloudflare Tunnel
- Local readline prompt with ANSI-rendered output
- Usage: `claude-remote`

### 6. Interactive Web View Renderer (to build)

Generates rich HTML pages for content that exceeds Telegram/CLI capabilities.

- Renders diffs (diff2html, side-by-side or unified)
- Syntax-highlighted code with line numbers
- Test output with pass/fail coloring
- Interactive elements: per-hunk approve/reject, option selection, form inputs, file trees
- Two-way: user actions flow back to Claude via WebSocket
- Can be served as Telegram Mini Apps (inline in Telegram) or standalone via Cloudflare Tunnel
- Token-based URLs with TTL expiry

### 7. Cloudflare Tunnel

Exposes the Web CLI and view renderer to the internet without port forwarding.

- `cloudflared` runs as a child process of the Conduit (or separate systemd service)
- Free HTTPS with persistent subdomain
- No inbound ports, works behind any NAT/firewall
- Distributable — user just needs a free Cloudflare account and a domain

## Deployment

### For Claude Code users (primary distribution path)

```bash
npm install -g claude-assist     # or: git clone + bun install

claude-assist init
# → prompts for Telegram bot token
# → prompts for Cloudflare tunnel token (optional)
# → configures Cairn hooks
# → creates systemd user service

claude-assist start              # starts the Conduit
```

Target audience already has Claude Code installed (Bun, claude.ai login). No Docker needed.

### Authentication

Uses **claude.ai subscription only** (no Anthropic API keys). The SDK authenticates via the existing claude.ai OAuth credentials. One-time browser login required; credentials persist across restarts.

### Configuration

```bash
# .env
TELEGRAM_BOT_TOKEN=...          # from BotFather
CLOUDFLARE_TUNNEL_TOKEN=...     # optional, for web UI exposure
```

## Multi-User Support

Multiple users share one claude-assist instance on a single Claude subscription (e.g. Claude Max).

- Session manager spawns on-demand Claude SDK sessions per user per channel
- Idle sessions are suspended and resumed on next message
- Each user has isolated conversation context
- Cairn memory can be scoped per user
- Access controlled via Telegram allowlist and web UI authentication
- Rate limits are shared across all users (subscription constraint)

## Security Considerations

### Access control
- Telegram sender allowlist (paired users only)
- Web UI authentication (session tokens or Cloudflare Access)
- Token-based view URLs (unguessable, short-lived)

### Network
- Cloudflare Tunnel — no exposed ports, automatic HTTPS
- No inbound connections required

### Tool execution
- `canUseTool` callback routes approval requests to the user via their channel
- `allowedTools` for auto-approving safe operations
- Full Claude Code permission model applies per session

## Comparison: OpenClaw vs claude-assist

| Capability | OpenClaw | claude-assist |
|-----------|----------|---------------|
| Messaging channels | 20+ platforms | Telegram + Web + CLI (extensible) |
| Memory | Flat Markdown files | Cairn (semantic, confidence-scored, embedded) |
| Always-on | Built-in daemon | systemd service |
| Skill ecosystem | 2,800+ ClawHub | Claude Code skills + MCP ecosystem |
| Scheduled tasks | Built-in cron | Cron integration (planned) |
| Rich UI | None (chat only) | Interactive web views + Telegram Mini Apps |
| Model support | Any LLM | Claude only |
| Security | Sandboxed execution | Allowlist + tool approval callbacks |
| Multi-device | Via messaging platforms | Telegram + Web + CLI, all isolated sessions |
| Distribution | Docker/self-host | npm package for Claude Code users |

## Implementation Phases

### Phase 1: Conduit + Telegram
- Build Conduit core (Bun, Claude Code SDK integration)
- Telegram Bot API connector with allowlist auth
- Per-channel session isolation with resume
- Tool approval routing via Telegram
- `claude-assist init` and `claude-assist start` CLI
- systemd user service for always-on

### Phase 2: Web CLI + Cloudflare Tunnel
- Web CLI channel (HTML/JS + WebSocket)
- Cloudflare Tunnel integration for HTTPS exposure
- Session tabs in browser
- Rich output rendering (diffs, code, test results)

### Phase 3: Interactive Web Views
- View renderer with HTML templates
- Interactive elements (approve/reject, selection, forms)
- Telegram Mini Apps integration
- Two-way communication from browser back to Conduit

### Phase 4: Remote CLI
- Thin CLI client binary
- WebSocket transport via Cloudflare Tunnel
- ANSI terminal rendering
- Cross-platform distribution

### Phase 5: Refinement
- Scheduled tasks via cron
- Additional channel connectors (Slack, Discord, email, webhooks)
- Multi-user session management
- Dashboard for monitoring and configuration

## Lessons Learned

### Channel message bias (critical)

During testing, Claude responded to identical questions differently depending on whether they arrived via Telegram (`<channel>` tag) or the terminal. Telegram messages received more restrictive, dismissive responses — not because of any instruction, but as an emergent bias from the channel metadata framing.

**Mitigation**: Global CLAUDE.md instructions explicitly state that channel messages must receive identical quality responses. The only permitted difference is formatting for the display medium. This is documented in `~/.claude/CLAUDE.md` under "Channel Messages".

### Setup gotchas (for reference)

- Bun installs to `~/.bun/bin` but MCP subprocesses don't source `.bashrc` — symlink to `~/.local/bin/`
- The Telegram plugin requires `bun install` in the plugin cache directory — `/plugin install` doesn't do this automatically
- `--channels` requires the full server name: `plugin:telegram@claude-plugins-official`
