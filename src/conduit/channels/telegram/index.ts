import { Bot } from "grammy";
import type { Channel } from "../router";
import type { SessionManager } from "../session";
import { loadViewIndex, createViewAsync, type ViewRecord } from "../../../views/renderer";

const EDGE_URL = process.env.EDGE_URL ?? "";

export interface TelegramConfig {
  botToken: string;
  allowedUserIds?: string[];
  sessionManager?: SessionManager;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildViewsListMarkdown(views: ViewRecord[]): string {
  const lines: string[] = ["## Previous Responses\n"];

  let currentDay = "";
  for (const v of views.slice(0, 50)) {
    const date = new Date(v.createdAt);
    const day = date.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
    const time = date.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false });
    const size = v.chars > 1000 ? `${(v.chars / 1000).toFixed(1)}K` : `${v.chars}`;

    if (day !== currentDay) {
      lines.push(`\n### ${day}\n`);
      currentDay = day;
    }

    lines.push(`- [${v.title}](${v.url}) — ${time} (${size} chars)`);
  }

  return lines.join("\n");
}

export class TelegramChannel implements Channel {
  id = "telegram";
  name = "Telegram";

  private bot: Bot;
  private allowedUserIds: Set<string>;
  private sessionManager?: SessionManager;
  private onMessage?: (userId: string, text: string, channelIdOverride?: string) => void;
  private statusMessages = new Map<string, number>();
  private lastStatusEdit = new Map<string, number>();
  private pendingStatus = new Map<string, string>();
  private statusTimers = new Map<string, Timer>();
  // Keep typing indicator alive per user
  private typingTimers = new Map<string, Timer>();
  // Task reply routing: messageId → taskChannelId
  private taskReplyMap = new Map<number, string>();
  private taskReplyOrder: number[] = []; // bounded FIFO

  constructor(config: TelegramConfig) {
    this.bot = new Bot(config.botToken);
    this.allowedUserIds = new Set(config.allowedUserIds ?? []);
    this.sessionManager = config.sessionManager;
  }

  async start(onMessage: (userId: string, text: string, channelIdOverride?: string) => void) {
    this.onMessage = onMessage;

    this.bot.on("message:text", async (ctx) => {
      const userId = ctx.from.id.toString();

      if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
        console.log(`[telegram] Ignored message from unauthorized user: ${userId}`);
        return;
      }

      const text = ctx.message.text;
      console.log(`[telegram] Message from ${userId}: ${text.substring(0, 50)}...`);

      // Check if this is a reply to a task message
      const replyTo = ctx.message.reply_to_message?.message_id;
      if (replyTo && this.taskReplyMap.has(replyTo)) {
        const taskChannelId = this.taskReplyMap.get(replyTo)!;
        console.log(`[telegram] Reply to task message → routing to ${taskChannelId}`);
        this.onMessage?.(userId, text, taskChannelId);
        return;
      }

      // Handle /views locally (needs Telegram-specific view creation)
      const trimmed = text.trim();
      if (trimmed === "/views") {
        const chatId = parseInt(userId);
        const views = loadViewIndex();
        if (views.length === 0) {
          this.bot.api.sendMessage(chatId, "No views yet.").catch(() => {});
        } else {
          const content = buildViewsListMarkdown(views);
          try {
            const { token, url: edgeUrl } = await createViewAsync({
              content, title: "Previous Responses", channel: "telegram", userId,
            });
            const baseUrl = EDGE_URL || `http://localhost:8099`;
            const viewUrl = edgeUrl ?? `${baseUrl}/view/${token}`;
            this.bot.api.sendMessage(chatId, `📄 Previous responses: ${viewUrl}`).catch(() => {});
          } catch (err: any) {
            this.bot.api.sendMessage(chatId, `Error generating views page: ${err.message}`).catch(() => {});
          }
        }
        return;
      }

      // All other commands (/clear, /context, /tasks, /task, /help, etc.)
      // are handled centrally by the Router
      this.onMessage?.(userId, text);
    });

    this.bot.catch((err) => {
      console.error(`[telegram] Error: ${err.message}`);
      if (err.message?.includes("409")) {
        console.log("[telegram] 409 conflict — retrying in 5s...");
        setTimeout(() => {
          this.bot.start({
            onStart: (info) => console.log(`[telegram] Reconnected as @${info.username}`),
          });
        }, 5000);
      }
    });

    this.bot.start({
      onStart: (info) => {
        console.log(`[telegram] Polling as @${info.username}`);
      },
    });
  }

  async sendTyping(userId: string) {
    const chatId = parseInt(userId);
    await this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }

  /**
   * Start a persistent typing indicator for this user.
   * Keeps "typing..." visible until stopTyping() is called.
   */
  startTyping(userId: string) {
    this.stopTyping(userId);
    this.sendTyping(userId);
    const timer = setInterval(() => this.sendTyping(userId), 4000);
    this.typingTimers.set(userId, timer);
  }

  stopTyping(userId: string) {
    const timer = this.typingTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(userId);
    }
  }

  /**
   * Send or update a status message. Enforces min 5s between edits.
   * Queues updates that arrive too fast — latest always wins.
   */
  async sendStatus(userId: string, text: string) {
    const chatId = parseInt(userId);
    const now = Date.now();
    const lastEdit = this.lastStatusEdit.get(userId) ?? 0;
    const elapsed = now - lastEdit;

    const existing = this.statusMessages.get(userId);

    // First message — send immediately
    if (!existing) {
      const msg = await this.bot.api.sendMessage(chatId, text);
      this.statusMessages.set(userId, msg.message_id);
      this.lastStatusEdit.set(userId, now);
      this.startTyping(userId);
      return;
    }

    // Too soon — queue it
    if (elapsed < 5000) {
      this.pendingStatus.set(userId, text);

      // Set a timer to flush when the cooldown expires (if not already set)
      if (!this.statusTimers.has(userId)) {
        const delay = 5000 - elapsed;
        const timer = setTimeout(() => {
          this.statusTimers.delete(userId);
          const pending = this.pendingStatus.get(userId);
          if (pending) {
            this.pendingStatus.delete(userId);
            this.flushStatus(userId, pending);
          }
        }, delay);
        this.statusTimers.set(userId, timer);
      }
      return;
    }

    // Enough time passed — edit now
    await this.flushStatus(userId, text);
  }

  private async flushStatus(userId: string, text: string) {
    const chatId = parseInt(userId);
    const msgId = this.statusMessages.get(userId);

    if (msgId) {
      try {
        await this.bot.api.editMessageText(chatId, msgId, text);
        this.lastStatusEdit.set(userId, Date.now());
      } catch {
        // Edit failed — delete old message, send new one
        try { await this.bot.api.deleteMessage(chatId, msgId); } catch {}
        const msg = await this.bot.api.sendMessage(chatId, text);
        this.statusMessages.set(userId, msg.message_id);
        this.lastStatusEdit.set(userId, Date.now());
      }
    }
  }

  async reply(userId: string, text: string) {
    // Flush any pending status update first
    this.flushPending(userId);
    this.stopTyping(userId);
    await this.deleteStatusMessage(userId);

    const chatId = parseInt(userId);
    const maxLen = 4096;
    if (text.length <= maxLen) {
      await this.bot.api.sendMessage(chatId, text);
      return;
    }

    const lines = text.split("\n");
    let chunk = "";
    for (const line of lines) {
      // Handle single lines that exceed maxLen by splitting at maxLen
      if (line.length > maxLen) {
        if (chunk) {
          await this.bot.api.sendMessage(chatId, chunk);
          chunk = "";
        }
        for (let i = 0; i < line.length; i += maxLen) {
          await this.bot.api.sendMessage(chatId, line.slice(i, i + maxLen));
        }
        continue;
      }
      if (chunk.length + line.length + 1 > maxLen) {
        if (chunk) await this.bot.api.sendMessage(chatId, chunk);
        chunk = line;
      } else {
        chunk += (chunk ? "\n" : "") + line;
      }
    }
    if (chunk) await this.bot.api.sendMessage(chatId, chunk);
  }

  async replyWithView(userId: string, summary: string, viewUrl: string) {
    this.flushPending(userId);
    this.stopTyping(userId);
    await this.deleteStatusMessage(userId);

    const chatId = parseInt(userId);
    await this.bot.api.sendMessage(chatId, `${summary}\n\n📄 Full response: ${viewUrl}`);
  }

  async clearStatus(userId: string) {
    this.flushPending(userId);
    this.stopTyping(userId);
    await this.deleteStatusMessage(userId);
  }

  private async deleteStatusMessage(userId: string) {
    const chatId = parseInt(userId);
    const msgId = this.statusMessages.get(userId);
    if (msgId) {
      try { await this.bot.api.deleteMessage(chatId, msgId); } catch {}
    }
    this.statusMessages.delete(userId);
    this.lastStatusEdit.delete(userId);
  }

  private flushPending(userId: string) {
    const timer = this.statusTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.statusTimers.delete(userId);
    }
    this.pendingStatus.delete(userId);
  }

  async sendTaskResult(userId: string, taskName: string, text: string, taskChannelId: string) {
    const chatId = parseInt(userId);
    const header = `📋 Scheduled Task: ${taskName}`;
    const full = `${header}\n\n${text}`;
    const maxLen = 4096;

    let lastMsgId: number | undefined;

    // Check if this should be a view (long/rich content)
    const { shouldCreateView, createViewAsync } = await import("../../../views/renderer");
    if (shouldCreateView(text)) {
      try {
        const viewContent = `# ${header}\n\n${text}`;
        const { token, url: edgeUrl } = await createViewAsync({
          content: viewContent,
          title: taskName,
          channelId: taskChannelId,
          channel: "telegram",
          userId,
        });
        const baseUrl = EDGE_URL || "http://localhost:8099";
        const viewUrl = edgeUrl ?? `${baseUrl}/view/${token}`;
        // Send summary + view link
        const firstPara = text.split("\n\n")[0];
        const summary = firstPara.length > 200 ? firstPara.substring(0, 200) + "..." : firstPara;
        const msg = await this.bot.api.sendMessage(chatId, `${header}\n\n${summary}\n\n📄 Full report: ${viewUrl}`);
        lastMsgId = msg.message_id;
      } catch (err: any) {
        console.error(`[telegram] View creation failed for task result, falling back to text: ${err.message}`);
        // Fall through to plain text
      }
    }

    // Plain text fallback (or short content)
    if (!lastMsgId) {
      if (full.length <= maxLen) {
        const msg = await this.bot.api.sendMessage(chatId, full);
        lastMsgId = msg.message_id;
      } else {
        const lines = full.split("\n");
        let chunk = "";
        for (const line of lines) {
          if (chunk.length + line.length + 1 > maxLen) {
            if (chunk) {
              const msg = await this.bot.api.sendMessage(chatId, chunk);
              lastMsgId = msg.message_id;
            }
            chunk = line;
          } else {
            chunk += (chunk ? "\n" : "") + line;
          }
        }
        if (chunk) {
          const msg = await this.bot.api.sendMessage(chatId, chunk);
          lastMsgId = msg.message_id;
        }
      }
    }

    // Track for reply routing (bounded to 100 entries)
    if (lastMsgId) {
      this.taskReplyMap.set(lastMsgId, taskChannelId);
      this.taskReplyOrder.push(lastMsgId);
      while (this.taskReplyOrder.length > 100) {
        const old = this.taskReplyOrder.shift()!;
        this.taskReplyMap.delete(old);
      }
    }
  }

  async stop() {
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    for (const timer of this.statusTimers.values()) clearTimeout(timer);
    this.bot.stop();
  }

  addAllowedUser(userId: string) {
    this.allowedUserIds.add(userId);
  }

  removeAllowedUser(userId: string) {
    this.allowedUserIds.delete(userId);
  }
}
