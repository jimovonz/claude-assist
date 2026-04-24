import { spawn, type Subprocess } from "bun";
import { homedir } from "os";
import { join } from "path";
import { loadSessionState, saveSession, removeSession as removePersistedSession, type PersistedSession } from "./state";

const DEFAULT_CWD = join(homedir(), "Projects");

export type SessionEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "result"; text: string; sessionId: string; usage?: UsageInfo }
  | { type: "aborted" };

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  contextWindow: number;
}

export interface SessionOptions {
  channelId: string;
  workingDirectory?: string;
  maxTurns?: number;
  model?: string;
  disallowedTools?: string[];
  env?: Record<string, string>;
}

export interface Session {
  channelId: string;
  sessionId?: string;
  proc: Subprocess;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
  lastActivity: number;
  wasAborted?: boolean;
  lastUsage?: UsageInfo;
}

export interface SessionManagerConfig {
  idleTimeoutMs?: number;
  command?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private persistedState = new Map<string, PersistedSession>();
  private abortedChannels = new Set<string>();
  private idleTimeoutMs: number;
  private command: string;
  private startTime = Date.now();

  constructor(config: SessionManagerConfig = {}) {
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30 * 60 * 1000;
    this.command = config.command ?? "claude";
    this.persistedState = loadSessionState();
  }

  get uptime(): number {
    return Date.now() - this.startTime;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  getSession(channelId: string): (Session & { sessionId?: string }) | undefined {
    const live = this.sessions.get(channelId);
    if (live) return live;

    // Return persisted state info (no live proc) so router can access sessionId
    const persisted = this.persistedState.get(channelId);
    if (persisted) {
      return { channelId, sessionId: persisted.sessionId } as any;
    }

    return undefined;
  }

  listSessions(): { channelId: string; lastActivity: number; live: boolean }[] {
    const result: { channelId: string; lastActivity: number; live: boolean }[] = [];

    for (const [channelId, s] of this.sessions) {
      result.push({ channelId, lastActivity: s.lastActivity, live: true });
    }

    // Include persisted sessions that aren't currently live
    for (const [channelId, s] of this.persistedState) {
      if (!this.sessions.has(channelId)) {
        result.push({ channelId, lastActivity: s.lastActivity, live: false });
      }
    }

    return result;
  }

  private persistSession(channelId: string, sessionId: string, workingDirectory?: string): void {
    this.persistedState.set(channelId, {
      channelId,
      sessionId,
      lastActivity: Date.now(),
    });
    saveSession(channelId, sessionId, workingDirectory);
  }

  private spawnSession(channelId: string, options: SessionOptions): Session {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--append-system-prompt",
      `CRITICAL: You are running inside the claude-assist Conduit. NEVER run commands that stop, restart, or modify the Conduit service (systemctl, kill, pkill targeting claude-assist or this process). NEVER modify .env, systemd service files, or the claude-assist source code. You will kill yourself.

SCHEDULED TASKS: You can create scheduled or one-shot tasks that send results to the user's Telegram. Use the task CLI:

  bun ${process.cwd()}/bin/task-cli.ts create --name "..." --prompt "..." --user "<telegram_user_id>" --schedule "<cron>" | --run-at "<ISO datetime or unix ms>" [--strategy resume|fresh] [--notify always|auto|never] [--context-files '["path"]'] [--cwd "/path"] [--max-turns 5]
  bun ${process.cwd()}/bin/task-cli.ts list [--enabled]
  bun ${process.cwd()}/bin/task-cli.ts get <id>
  bun ${process.cwd()}/bin/task-cli.ts update <id> [--name ...] [--enabled true|false] [--schedule ...] [--run-at ...] [--prompt ...]
  bun ${process.cwd()}/bin/task-cli.ts delete <id>

For recurring tasks ("check X every morning"), use --schedule with standard 5-field cron expressions. For one-shot tasks ("do X at 3pm tomorrow"), use --run-at with an ISO datetime — these auto-disable after firing. Strategy "resume" keeps session context across runs; "fresh" starts clean each time. Notify controls when the user gets a Telegram notification: "always" (default), "auto" (you decide — include <notify>true</notify> or <notify>false</notify> at the start of your response to control whether the user is notified; output is always logged regardless), "never" (log only). Context files are read at fire time.

GOOGLE CALENDAR: You can create, list, and check calendar events. The user's timezone is NZDT (UTC+13). Use the Python helper:

  ~/Projects/cairn/.venv/bin/python3 -W ignore ${process.cwd()}/bin/gcal.py create --title "..." --start "2026-03-27T14:00:00" --end "2026-03-27T15:00:00" [--desc "..."] [--location "..."]
  ~/Projects/cairn/.venv/bin/python3 -W ignore ${process.cwd()}/bin/gcal.py today
  ~/Projects/cairn/.venv/bin/python3 -W ignore ${process.cwd()}/bin/gcal.py list [--days 7]
  ~/Projects/cairn/.venv/bin/python3 -W ignore ${process.cwd()}/bin/gcal.py free --date "2026-03-27"

When the user asks to schedule something ("put a meeting with Dave on Thursday at 2pm", "remind me about the dentist on April 3rd"), create a calendar event. Parse natural language dates relative to today. For events without an explicit end time, default to 30 minutes.

GMAIL: You can read and manage the user's Gmail. Use the Python helpers:

  ~/Projects/cairn/.venv/bin/python3 -W ignore ${process.cwd()}/bin/gmail-check.py [--since 24] [--max 10] [--body] [--query "from:dave"]
  ~/Projects/cairn/.venv/bin/python3 -W ignore ${process.cwd()}/bin/gmail-label.py list | create <name> | apply <id> <label> | remove <id> <label> | mark-read <id>
  ~/Projects/cairn/.venv/bin/python3 -W ignore ${process.cwd()}/bin/gmail-send.py --to <email> --subject "..." --body "..."`,
    ];

    // Resume from persisted session if available
    const persisted = this.persistedState.get(channelId);
    if (persisted?.sessionId) {
      args.push("--resume", persisted.sessionId);
      console.log(`[session] Resuming session ${persisted.sessionId} for ${channelId}`);
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.maxTurns) {
      args.push("--max-turns", options.maxTurns.toString());
    }

    if (options.disallowedTools?.length) {
      args.push("--disallowed-tools", ...options.disallowedTools);
    }

    const cwd = options.workingDirectory ?? DEFAULT_CWD;

    console.log(`[session] Spawning persistent claude process for ${channelId}`);

    const proc = spawn({
      cmd: [this.command, ...args],
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });

    const reader = proc.stdout!.getReader() as ReadableStreamDefaultReader<Uint8Array>;

    const session: Session = {
      channelId,
      proc,
      reader,
      buffer: "",
      lastActivity: Date.now(),
    };

    this.sessions.set(channelId, session);
    return session;
  }

  async *sendMessage(
    channelId: string,
    message: string,
    options: SessionOptions
  ): AsyncGenerator<SessionEvent> {
    let session = this.sessions.get(channelId);

    if (!session || session.proc.exitCode !== null) {
      if (session) {
        console.log(`[session] Process for ${channelId} died, respawning`);
      }
      session = this.spawnSession(channelId, options);
    }

    session.lastActivity = Date.now();

    const input = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    });

    (session.proc.stdin as import("bun").FileSink).write(input + "\n");
    (session.proc.stdin as import("bun").FileSink).flush();

    const decoder = new TextDecoder();
    let lastAssistantText = "";

    while (true) {
      const { done, value } = await session.reader.read();
      if (done) {
        const wasAborted = this.abortedChannels.has(channelId);
        this.abortedChannels.delete(channelId);
        this.sessions.delete(channelId);
        if (wasAborted) {
          console.log(`[session] Stream aborted for ${channelId}`);
          yield { type: "aborted" };
          return;
        }
        console.log(`[session] Stream ended for ${channelId}`);
        break;
      }

      session.buffer += decoder.decode(value, { stream: true });
      const parts = session.buffer.split("\n");
      session.buffer = parts.pop() ?? "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed);

          // Tool use — show what Claude is doing
          if (msg.type === "assistant") {
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_use") {
                  const toolName = block.name ?? "unknown";
                  const input = block.input ?? {};
                  const detail = describeToolCall(toolName, input);
                  yield { type: "status", text: detail };
                }
                if (block.type === "text" && block.text) {
                  lastAssistantText = block.text;
                  // Yield partial text for preview
                  yield { type: "text", text: block.text };
                }
              }
            }
          }

          // Final result
          if (msg.type === "result") {
            const resultText = (msg.result as string) || lastAssistantText || "";
            const sessionId = (msg.session_id as string) ?? "";
            session.lastActivity = Date.now();
            session.sessionId = sessionId;

            // Extract usage info
            const usage: UsageInfo | undefined = msg.usage ? {
              inputTokens: msg.usage.input_tokens ?? 0,
              outputTokens: msg.usage.output_tokens ?? 0,
              cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
              totalCostUsd: msg.total_cost_usd ?? 0,
              contextWindow: msg.modelUsage ? Object.values(msg.modelUsage as Record<string, any>)[0]?.contextWindow ?? 0 : 0,
            } : undefined;
            if (usage) session.lastUsage = usage;

            // Persist session ID to disk for restart recovery
            if (sessionId) {
              this.persistSession(channelId, sessionId);
            }

            console.log(`[session] Result for ${channelId}, ${resultText.length} chars`);
            yield { type: "result", text: resultText, sessionId, usage };
            return;
          }
        } catch {}
      }
    }
  }

  pruneIdle(): string[] {
    const now = Date.now();
    const pruned: string[] = [];

    for (const [channelId, session] of this.sessions) {
      if (now - session.lastActivity > this.idleTimeoutMs) {
        session.proc.kill();
        this.sessions.delete(channelId);
        pruned.push(channelId);
      }
    }

    return pruned;
  }

  removeSession(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    if (session) {
      session.proc.kill();
      this.sessions.delete(channelId);
    }
    // Remove from both in-memory state and SQLite
    this.persistedState.delete(channelId);
    removePersistedSession(channelId);
    return !!session;
  }

  getUsage(channelId: string): UsageInfo | undefined {
    return this.sessions.get(channelId)?.lastUsage;
  }

  abort(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    if (session) {
      this.abortedChannels.add(channelId);
      session.proc.kill();
      console.log(`[session] Aborted processing for ${channelId}`);
      return true;
    }
    return false;
  }
}

/**
 * Parse a single stream-json message and produce SessionEvents.
 * Exported for unit testing without subprocess dependency.
 */
export function parseStreamMessage(
  msg: any,
  lastAssistantText: string
): { events: SessionEvent[]; lastAssistantText: string } {
  const events: SessionEvent[] = [];

  if (msg.type === "assistant") {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use") {
          const toolName = block.name ?? "unknown";
          const input = block.input ?? {};
          events.push({ type: "status", text: describeToolCall(toolName, input) });
        }
        if (block.type === "text" && block.text) {
          lastAssistantText = block.text;
          events.push({ type: "text", text: block.text });
        }
      }
    }
  }

  if (msg.type === "result") {
    const resultText = (msg.result as string) || lastAssistantText || "";
    const sessionId = (msg.session_id as string) ?? "";

    const usage: UsageInfo | undefined = msg.usage ? {
      inputTokens: msg.usage.input_tokens ?? 0,
      outputTokens: msg.usage.output_tokens ?? 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
      totalCostUsd: msg.total_cost_usd ?? 0,
      contextWindow: msg.modelUsage
        ? Object.values(msg.modelUsage as Record<string, any>)[0]?.contextWindow ?? 0
        : 0,
    } : undefined;

    events.push({ type: "result", text: resultText, sessionId, usage });
  }

  return { events, lastAssistantText };
}

export function describeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `📖 Reading ${shortenPath(input.file_path as string)}`;
    case "Glob":
      return `🔍 Searching for ${input.pattern}`;
    case "Grep":
      return `🔍 Searching for "${input.pattern}" in files`;
    case "Bash":
      return `⚡ Running command...`;
    case "Edit":
      return `✏️ Editing ${shortenPath(input.file_path as string)}`;
    case "Write":
      return `📝 Writing ${shortenPath(input.file_path as string)}`;
    case "Agent":
      return `🤖 Delegating: ${(input.description as string)?.substring(0, 60) ?? "subtask"}`;
    case "WebSearch":
      return `🌐 Searching: ${input.query}`;
    case "WebFetch":
      return `🌐 Fetching URL...`;
    case "ToolSearch":
      return `🔧 Loading tools...`;
    default:
      return `⚙️ Using ${name}...`;
  }
}

export function shortenPath(path: string | undefined): string {
  if (!path) return "file";
  const parts = path.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}
