import { Bot } from "grammy";
import type { Channel } from "../router";

export interface TelegramConfig {
  botToken: string;
  allowedUserIds?: string[];
}

export class TelegramChannel implements Channel {
  id = "telegram";
  name = "Telegram";

  private bot: Bot;
  private allowedUserIds: Set<string>;
  private onMessage?: (userId: string, text: string) => void;
  private statusMessages = new Map<string, number>();
  private lastStatusEdit = new Map<string, number>();
  private pendingStatus = new Map<string, string>();
  private statusTimers = new Map<string, Timer>();
  // Keep typing indicator alive per user
  private typingTimers = new Map<string, Timer>();

  constructor(config: TelegramConfig) {
    this.bot = new Bot(config.botToken);
    this.allowedUserIds = new Set(config.allowedUserIds ?? []);
  }

  async start(onMessage: (userId: string, text: string) => void) {
    this.onMessage = onMessage;

    this.bot.on("message:text", (ctx) => {
      const userId = ctx.from.id.toString();

      if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
        console.log(`[telegram] Ignored message from unauthorized user: ${userId}`);
        return;
      }

      const text = ctx.message.text;
      console.log(`[telegram] Message from ${userId}: ${text.substring(0, 50)}...`);

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
    this.statusMessages.delete(userId);
    this.lastStatusEdit.delete(userId);

    const chatId = parseInt(userId);
    const maxLen = 4096;
    if (text.length <= maxLen) {
      await this.bot.api.sendMessage(chatId, text);
      return;
    }

    const lines = text.split("\n");
    let chunk = "";
    for (const line of lines) {
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
    this.statusMessages.delete(userId);
    this.lastStatusEdit.delete(userId);

    const chatId = parseInt(userId);
    await this.bot.api.sendMessage(chatId, `${summary}\n\n📄 Full response: ${viewUrl}`);
  }

  private flushPending(userId: string) {
    const timer = this.statusTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.statusTimers.delete(userId);
    }
    this.pendingStatus.delete(userId);
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
