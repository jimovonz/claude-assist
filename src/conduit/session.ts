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
  disallowedTools?: string[];
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
      "CRITICAL: You are running inside the claude-assist Conduit. NEVER run commands that stop, restart, or modify the Conduit service (systemctl, kill, pkill targeting claude-assist or this process). NEVER modify .env, systemd service files, or the claude-assist source code. You will kill yourself.",
    ];

    // Resume from persisted session if available
    const persisted = this.persistedState.get(channelId);
    if (persisted?.sessionId) {
      args.push("--resume", persisted.sessionId);
      console.log(`[session] Resuming session ${persisted.sessionId} for ${channelId}`);
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
    });

    const reader = proc.stdout!.getReader();

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

    session.proc.stdin!.write(input + "\n");
    session.proc.stdin!.flush();

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
            const resultText = (msg.result as string) ?? "";
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
      return true;
    }
    return false;
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

function describeToolCall(name: string, input: Record<string, unknown>): string {
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

function shortenPath(path: string | undefined): string {
  if (!path) return "file";
  const parts = path.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}
