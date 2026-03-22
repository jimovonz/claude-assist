import { SessionManager, type SessionEvent } from "./session";
import { runStopHook, runPromptHook } from "./hooks";
import { createView, shouldCreateView } from "../views/renderer";
import type { ViewServer } from "../views/server";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_CWD = join(homedir(), "Projects");

export function stripMetadata(text: string): string {
  return text
    .replace(/^\s*<memory>[\s\S]*?<\/memory>\s*$/gm, "")
    .replace(/<cairn_context[\s\S]*?<\/cairn_context>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/^Sources:\n(- \[.*?\]\(.*?\)\n?)*/gm, "")
    .trim();
}

export function summarize(text: string, maxLen = 200): string {
  const firstPara = text.split("\n\n")[0];
  if (firstPara.length <= maxLen) return firstPara;
  return firstPara.substring(0, maxLen) + "...";
}

const HEARTBEAT_MESSAGES = [
  "Still working on this...",
  "Processing, hang tight...",
  "Almost there...",
  "Crunching through it...",
  "Working through the details...",
  "Digging deeper...",
  "Pulling it together...",
  "Bear with me...",
];

function randomHeartbeat(): string {
  return HEARTBEAT_MESSAGES[Math.floor(Math.random() * HEARTBEAT_MESSAGES.length)];
}

export interface Channel {
  id: string;
  name: string;
  maxTurns?: number;
  disallowedTools?: string[];
  reply(userId: string, text: string): Promise<void>;
  replyWithView?(userId: string, summary: string, viewUrl: string): Promise<void>;
  sendTyping(userId: string): Promise<void>;
  sendStatus?(userId: string, text: string): Promise<void>;
  sendStreamText?(userId: string, text: string): Promise<void>;
  start(onMessage: (userId: string, text: string) => void): Promise<void>;
  stop(): Promise<void>;
}

export class Router {
  private sessionManager: SessionManager;
  private channels = new Map<string, Channel>();
  private messageQueues = new Map<string, Promise<void>>();
  private viewServer: ViewServer | null = null;

  constructor(sessionManager: SessionManager, viewServer?: ViewServer) {
    this.sessionManager = sessionManager;
    this.viewServer = viewServer ?? null;
  }

  addChannel(channel: Channel) {
    this.channels.set(channel.id, channel);
  }

  async start() {
    for (const channel of this.channels.values()) {
      await channel.start((userId, text) => {
        this.handleMessage(channel, userId, text);
      });
      console.log(`[conduit] Channel started: ${channel.name}`);
    }

    console.log(`[conduit] Router running with ${this.channels.size} channel(s)`);
  }

  async stop() {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
    console.log("[conduit] Router stopped");
  }

  private async handleMessage(channel: Channel, userId: string, text: string) {
    const channelId = `${channel.id}:${userId}`;

    const previous = this.messageQueues.get(channelId) ?? Promise.resolve();
    const current = previous.then(() => this.processMessage(channel, channelId, userId, text));
    this.messageQueues.set(channelId, current.catch(() => {}));
    await current;
  }

  private async processMessage(channel: Channel, channelId: string, userId: string, text: string) {
    const existing = this.sessionManager.getSession(channelId);
    // Use the Claude session ID if we have one, otherwise generate a fresh one
    // so the prompt hook's first_prompt check works correctly
    const sessionId = existing?.sessionId ?? `conduit-${channelId}-${Date.now()}`;
    console.log(`[conduit] ${channelId} → "${text.substring(0, 50)}" (session: ${existing ? "existing" : "new"})`);

    const updateStatus = channel.sendStatus?.bind(channel) ?? channel.reply.bind(channel);
    let currentStatus = "";

    const setStatus = async (text: string) => {
      currentStatus = text;
      await updateStatus(userId, text).catch(() => {});
    };

    // Heartbeat timer — if no update for 15s, replace status with heartbeat
    let lastUpdateTime = Date.now();
    const heartbeatInterval = setInterval(async () => {
      if (Date.now() - lastUpdateTime > 14000) {
        await setStatus(`⏳ ${randomHeartbeat()}`);
        lastUpdateTime = Date.now();
      }
    }, 5000);

    const touch = () => { lastUpdateTime = Date.now(); };

    try {
      // Pre-message hook
      await setStatus("🔍 Searching memory...");
      touch();
      const cairnContext = await runPromptHook(sessionId, text);

      let prompt = text;
      if (cairnContext) {
        await setStatus("📡 Found relevant context");
        touch();
        prompt = `${cairnContext}\n\n${text}`;
        console.log(`[conduit] Injected Cairn context (${cairnContext.length} chars)`);
      }

      await setStatus("🤔 Thinking...");
      touch();

      // Stream events from Claude
      let response = "";
      let currentSessionId = "";
      let lastPreview = "";
      let aborted = false;

      for await (const event of this.sessionManager.sendMessage(channelId, prompt, {
        channelId,
        maxTurns: channel.maxTurns,
        disallowedTools: channel.disallowedTools,
      })) {
        touch();

        switch (event.type) {
          case "status":
            await setStatus(event.text);
            console.log(`[conduit] ${event.text}`);
            break;

          case "text":
            if (channel.sendStreamText) {
              const cleaned = stripMetadata(event.text);
              if (cleaned) await channel.sendStreamText(userId, cleaned);
            } else {
              // Fallback: show truncated preview via status
              const preview = event.text.length > 200
                ? event.text.substring(0, 200) + "..."
                : event.text;
              if (preview !== lastPreview) {
                lastPreview = preview;
                await setStatus(`💬 ${preview}`);
              }
            }
            break;

          case "result":
            response = event.text;
            currentSessionId = event.sessionId;
            break;

          case "aborted":
            aborted = true;
            break;
        }
      }

      if (aborted) {
        clearInterval(heartbeatInterval);
        console.log(`[conduit] Processing aborted for ${channelId}`);
        return;
      }

      // Post-message hook
      let stopResult = { block: false, reason: undefined as string | undefined };
      if (response.length > 0) {
        await setStatus("🪨 Storing to memory...");
        touch();
        stopResult = await runStopHook(currentSessionId, response, DEFAULT_CWD);
      }

      if (stopResult.block && stopResult.reason) {
        await setStatus("🪨 Following the cairn...");
        touch();
        console.log(`[conduit] Stop hook blocked — re-prompting with context`);

        for await (const event of this.sessionManager.sendMessage(
          channelId,
          `The following context was retrieved from the Cairn memory system in response to your context: insufficient declaration. Use this context to answer the user's original question.\n\n${stopResult.reason}\n\nNow please answer the user's original question using this context.`,
          { channelId }
        )) {
          touch();
          if (event.type === "status") await setStatus(event.text);
          if (event.type === "text") {
            if (channel.sendStreamText) {
              const cleaned = stripMetadata(event.text);
              if (cleaned) await channel.sendStreamText(userId, cleaned);
            } else {
              const p = event.text.length > 200 ? event.text.substring(0, 200) + "..." : event.text;
              await setStatus(`💬 ${p}`);
            }
          }
          if (event.type === "result") {
            response = event.text;
            currentSessionId = event.sessionId;
          }
        }

        await runStopHook(currentSessionId, response, DEFAULT_CWD, true);
      }

      clearInterval(heartbeatInterval);

      const cleaned = stripMetadata(response);
      console.log(`[conduit] Response (${cleaned.length} chars), session: ${currentSessionId}`);

      if (!cleaned) {
        await channel.reply(userId, "No response generated.");
        return;
      }

      // Final reply — bypass status queue, deliver immediately
      if (this.viewServer && channel.replyWithView && shouldCreateView(cleaned)) {
        const summary = summarize(cleaned);
        const token = createView({ content: cleaned });
        const viewUrl = this.viewServer.getViewUrl(token);
        console.log(`[conduit] Created view: ${viewUrl}`);
        await channel.replyWithView(userId, summary, viewUrl);
      } else {
        await channel.reply(userId, cleaned);
      }
    } catch (err) {
      clearInterval(heartbeatInterval);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[conduit] Error handling message on ${channel.name}:`, errorMsg);
      await channel.reply(userId, `Error: ${errorMsg}`);
    }
  }
}
