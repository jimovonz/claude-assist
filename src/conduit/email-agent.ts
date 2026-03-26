/**
 * EmailAgent — processes Gmail push notifications.
 *
 * When Gmail sends a push notification (via Pub/Sub → edge → WebSocket),
 * the agent fetches new messages and runs them through Claude for:
 * - Classification and labeling
 * - Calendar event detection
 * - Actionable notification to Telegram
 *
 * Uses Python helper scripts for Gmail/Calendar API access.
 */

import { spawn } from "bun";
import { join } from "path";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import type { SessionManager } from "./session";
import type { TelegramChannel } from "./channels/telegram";
import { stripMetadata } from "./router";
import { runStopHook } from "./hooks";

const PYTHON = join(homedir(), "Projects", "cairn", ".venv", "bin", "python3");
const BIN_DIR = join(import.meta.dir, "..", "..", "bin");
const STATE_DIR = join(homedir(), ".local", "state", "claude-assist");
const HISTORY_FILE = join(STATE_DIR, "gmail-history-id.txt");
const CONTEXT_FILE = join(import.meta.dir, "..", "..", "email-agent.md");

export interface EmailAgentConfig {
  sessionManager: SessionManager;
  telegram: TelegramChannel;
  telegramUserId: string;
  model?: string;
}

export class EmailAgent {
  private sessionManager: SessionManager;
  private telegram: TelegramChannel;
  private telegramUserId: string;
  private model: string;
  private processing = false;
  private channelId = "email-agent:processor";

  constructor(config: EmailAgentConfig) {
    this.sessionManager = config.sessionManager;
    this.telegram = config.telegram;
    this.telegramUserId = config.telegramUserId;
    this.model = config.model ?? "claude-haiku-4-5-20251001";
  }

  /**
   * Handle a Gmail push notification from the edge server.
   * Called when EdgeRelay receives type: "gmail-push".
   */
  async handlePush(emailAddress: string, historyId: string) {
    if (this.processing) {
      console.log("[email-agent] Already processing, skipping push");
      return;
    }

    this.processing = true;
    console.log(`[email-agent] Push received: ${emailAddress} historyId=${historyId}`);

    try {
      // Save the latest historyId
      this.saveHistoryId(historyId);

      // Fetch recent unread emails
      const emails = await this.fetchUnread();
      if (!emails.length) {
        console.log("[email-agent] No unread messages to process");
        return;
      }

      console.log(`[email-agent] Processing ${emails.length} unread message(s)`);

      // Load context file for classification rules
      const context = this.loadContext();

      // Build prompt with emails and context
      const emailSummaries = emails.map((e: any) => {
        return `---
ID: ${e.id}
From: ${e.from}
To: ${e.to}
Subject: ${e.subject}
Date: ${e.date}
Snippet: ${e.snippet}
Current Labels: ${e.labels.join(", ")}
${e.body ? `Body:\n${e.body.substring(0, 1500)}` : ""}
---`;
      }).join("\n\n");

      const prompt = `${context}

## Emails to process

${emailSummaries}

Process each email according to the instructions in the context above. For each email, output a JSON action block:

\`\`\`json
{
  "actions": [
    {
      "emailId": "<id>",
      "classification": "<category>",
      "labels": ["<label1>", "<label2>"],
      "notify": true/false,
      "notifyReason": "<why this needs attention>",
      "calendarEvent": null | { "title": "...", "start": "ISO", "end": "ISO", "description": "..." },
      "summary": "<one-line summary>"
    }
  ]
}
\`\`\`

After the JSON block, if any emails have notify:true, write a human-readable Telegram notification summarizing only those actionable emails.`;

      // Send to Claude
      let response = "";
      let sessionId = "";

      // Clear session for fresh processing each time
      this.sessionManager.removeSession(this.channelId);

      for await (const event of this.sessionManager.sendMessage(this.channelId, prompt, {
        channelId: this.channelId,
        model: this.model,
        maxTurns: 5,
      })) {
        if (event.type === "result") {
          response = event.text;
          sessionId = event.sessionId;
        }
      }

      if (!response) {
        console.log("[email-agent] No response from Claude");
        return;
      }

      // Parse actions from response
      const actions = this.parseActions(response);
      if (actions.length > 0) {
        await this.executeActions(actions);
      }

      // Send notification for actionable items
      const cleaned = stripMetadata(response);
      // Extract just the human-readable notification part (after the JSON block)
      const notificationText = this.extractNotification(cleaned);
      if (notificationText) {
        await this.telegram.sendTaskResult(
          this.telegramUserId,
          "Email Agent",
          notificationText,
          this.channelId
        );
      }

      // Run stop hook for memory capture
      if (response.length > 0) {
        await runStopHook(sessionId, response, join(homedir(), "Projects"));
      }

      console.log(`[email-agent] Processed ${emails.length} emails, ${actions.length} actions`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[email-agent] Error: ${msg}`);
    } finally {
      this.processing = false;
    }
  }

  private async fetchUnread(): Promise<any[]> {
    const result = await this.runScript("gmail-check.py", ["--since", "1", "--max", "10", "--body"]);
    try {
      return JSON.parse(result);
    } catch {
      console.error("[email-agent] Failed to parse gmail-check output");
      return [];
    }
  }

  private parseActions(response: string): any[] {
    // Extract JSON block from response
    const match = response.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!match) return [];

    try {
      const parsed = JSON.parse(match[1]);
      return parsed.actions ?? [];
    } catch (err) {
      console.error("[email-agent] Failed to parse actions JSON:", err);
      return [];
    }
  }

  private extractNotification(cleaned: string): string {
    // Remove the JSON code block, keep the human-readable part
    const withoutJson = cleaned.replace(/```json[\s\S]*?```/g, "").trim();
    return withoutJson || "";
  }

  private async executeActions(actions: any[]) {
    for (const action of actions) {
      try {
        // Apply labels
        if (action.labels?.length) {
          for (const label of action.labels) {
            // Prefix with "CA/" for claude-assist managed labels
            const fullLabel = label.startsWith("CA/") ? label : `CA/${label}`;
            await this.runScript("gmail-label.py", ["apply", action.emailId, fullLabel]);
            console.log(`[email-agent] Applied label "${fullLabel}" to ${action.emailId}`);
          }
        }

        // Create calendar event
        if (action.calendarEvent) {
          const evt = action.calendarEvent;
          const args = ["create", "--title", evt.title, "--start", evt.start, "--end", evt.end];
          if (evt.description) args.push("--desc", evt.description);
          if (evt.location) args.push("--location", evt.location);
          await this.runScript("gcal.py", args);
          console.log(`[email-agent] Created calendar event: "${evt.title}"`);
        }
      } catch (err) {
        console.error(`[email-agent] Action failed for ${action.emailId}:`, err);
      }
    }
  }

  private loadContext(): string {
    if (existsSync(CONTEXT_FILE)) {
      return readFileSync(CONTEXT_FILE, "utf-8");
    }
    return "# Email Agent\nClassify emails and notify on actionable items.";
  }

  private saveHistoryId(historyId: string) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, historyId);
  }

  private loadHistoryId(): string | null {
    if (existsSync(HISTORY_FILE)) {
      return readFileSync(HISTORY_FILE, "utf-8").trim();
    }
    return null;
  }

  private async runScript(script: string, args: string[]): Promise<string> {
    const proc = spawn({
      cmd: [PYTHON, "-W", "ignore", join(BIN_DIR, script), ...args],
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (proc.exitCode !== 0) {
      throw new Error(`${script} failed (exit ${proc.exitCode}): ${stderr}`);
    }

    return stdout.trim();
  }
}

/**
 * Create the watch renewal scheduled task if it doesn't exist.
 */
export function setupWatchRenewal() {
  // Import dynamically to avoid circular dependencies
  import("./state").then(({ getTask, createTask }) => {
    if (!getTask("gmail-watch-renew")) {
      createTask({
        name: "Gmail Watch Renew",
        prompt: `Renew the Gmail push notification watch by running:
~/Projects/cairn/.venv/bin/python3 -W ignore ~/Projects/claude-assist/bin/gmail-watch.py start

Report the result.`,
        schedule: "0 0 */3 * *", // every 3 days (watch expires after 7)
        telegramUserId: process.env.TELEGRAM_OWNER_ID ?? "",
        notify: "never",
        model: "claude-haiku-4-5-20251001",
        skipCairn: true,
      });
      console.log("[email-agent] Created gmail-watch-renew scheduled task");
    }
  });
}
