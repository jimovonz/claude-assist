import { listTasks, updateTask, type TaskDef } from "./state";
import { readFileSync, existsSync } from "fs";
import type { SessionManager } from "./session";
import type { TelegramChannel } from "./channels/telegram";
import { stripMetadata } from "./router";
import { runStopHook, runPromptHook } from "./hooks";

export interface TaskSchedulerConfig {
  sessionManager: SessionManager;
  telegram: TelegramChannel;
  tickIntervalMs?: number;
}

export class TaskScheduler {
  private sessionManager: SessionManager;
  private telegram: TelegramChannel;
  private tickInterval: Timer | null = null;
  private tickIntervalMs: number;
  private runningTasks = new Set<string>();

  constructor(config: TaskSchedulerConfig) {
    this.sessionManager = config.sessionManager;
    this.telegram = config.telegram;
    this.tickIntervalMs = config.tickIntervalMs ?? 30_000;
  }

  start() {
    this.tickInterval = setInterval(() => this.tick(), this.tickIntervalMs);
    console.log(`[scheduler] Started (tick every ${this.tickIntervalMs / 1000}s)`);
    // Run first tick immediately
    this.tick();
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log("[scheduler] Stopped");
  }

  runTask(id: string) {
    const task = listTasks().find(t => t.id === id);
    if (!task) {
      console.log(`[scheduler] Task ${id} not found`);
      return;
    }
    if (this.runningTasks.has(id)) {
      console.log(`[scheduler] Task ${id} already running`);
      return;
    }
    console.log(`[scheduler] Manual trigger: "${task.name}" (${task.id})`);
    this.fireTask(task, true);
  }

  private tick() {
    const now = new Date();
    const nowMs = now.getTime();
    const tasks = listTasks(true); // enabled only

    for (const task of tasks) {
      if (this.runningTasks.has(task.id)) continue;

      // Check if task should fire: one-shot (runAt) or recurring (cron schedule)
      let shouldFire = false;

      if (task.runAt) {
        // One-shot: fire if runAt time has passed
        shouldFire = nowMs >= task.runAt;
      } else if (task.schedule) {
        // Recurring: check cron expression
        if (!cronMatches(task.schedule, now)) continue;

        // Don't fire if already ran this minute
        if (task.lastRunAt) {
          const lastRun = new Date(task.lastRunAt);
          if (
            lastRun.getFullYear() === now.getFullYear() &&
            lastRun.getMonth() === now.getMonth() &&
            lastRun.getDate() === now.getDate() &&
            lastRun.getHours() === now.getHours() &&
            lastRun.getMinutes() === now.getMinutes()
          ) {
            continue;
          }
        }
        shouldFire = true;
      }

      if (!shouldFire) continue;

      console.log(`[scheduler] Firing task "${task.name}" (${task.id})${task.runAt ? " [one-shot]" : ""}`);
      this.fireTask(task);
    }
  }

  private async fireTask(task: TaskDef, forceNotify = false) {
    this.runningTasks.add(task.id);
    const channelId = `task:${task.id}`;

    try {
      // Build prompt with context
      let prompt = task.prompt;

      // Read context files
      if (task.contextFiles?.length) {
        const contextParts: string[] = [];
        for (const filePath of task.contextFiles) {
          if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8");
            contextParts.push(`<context_file path="${filePath}">\n${content}\n</context_file>`);
          } else {
            contextParts.push(`<context_file path="${filePath}" error="not found" />`);
          }
        }
        prompt = contextParts.join("\n") + "\n\n" + prompt;
      }

      // Inject previous run output for resume tasks
      if (task.sessionStrategy === "resume" && task.lastRunOutput) {
        prompt = `<previous_run_output>\n${task.lastRunOutput}\n</previous_run_output>\n\n` + prompt;
      }

      // Run prompt hook for Cairn memory context (unless skipped)
      if (!task.skipCairn) {
        const sessionId_pre = `task-${task.id}-${Date.now()}`;
        const hookQuery = task.contextQuery ?? prompt;
        const cairnContext = await runPromptHook(sessionId_pre, hookQuery);
        if (cairnContext) {
          prompt = `${cairnContext}\n\n${prompt}`;
          console.log(`[scheduler] Injected Cairn context for "${task.name}" (${cairnContext.length} chars, query: ${task.contextQuery ? "custom" : "prompt"})`);
        }
      }

      // Inject auto-notify instructions when notify mode is "auto"
      if (task.notify === "auto") {
        prompt += `\n\nNOTIFICATION CONTROL: Start your response with <notify>true</notify> if the user should be notified (something needs attention), or <notify>false</notify> if not (routine/healthy). Your full response is always logged regardless.`;
      }

      // For fresh strategy, clear any existing session
      if (task.sessionStrategy === "fresh") {
        this.sessionManager.removeSession(channelId);
      }

      // Fire the session
      let response = "";
      let sessionId = "";

      for await (const event of this.sessionManager.sendMessage(channelId, prompt, {
        channelId,
        workingDirectory: task.workingDirectory ?? undefined,
        maxTurns: task.maxTurns,
        model: task.model ?? undefined,
        ...(task.skipCairn ? { env: { CAIRN_MODE: "read-only" } } : {}),
      })) {
        if (event.type === "result") {
          response = event.text;
          sessionId = event.sessionId;
        }
      }

      // Resolve notify from raw response (before stripMetadata removes the tag)
      const { shouldNotify: autoNotify } = resolveNotify(task.notify, response);
      const shouldNotify = forceNotify || autoNotify;
      // Then strip all metadata for the clean output
      const output = stripMetadata(response);

      if (shouldNotify && output) {
        const dmChatId = task.notifyTarget === "dm" ? parseInt(task.telegramUserId) : undefined;
        await this.telegram.sendTaskResult(task.telegramUserId, task.name, output, channelId, dmChatId);
      } else if (output) {
        console.log(`[scheduler] Task "${task.name}" (${task.id}) — notification suppressed`);
      } else {
        console.log(`[scheduler] Task "${task.name}" produced no output`);
      }

      // Record run (always store output regardless of notify)
      updateTask(task.id, {
        lastRunAt: Date.now(),
        lastRunOutput: output || undefined,
        lastRunSessionId: sessionId || undefined,
        // Auto-disable one-shot tasks after firing
        ...(task.runAt ? { enabled: false } : {}),
      });

      // Run stop hook for memory capture (skip for read-only cairn tasks)
      if (response.length > 0 && !task.skipCairn) {
        await runStopHook(sessionId, response, task.workingDirectory ?? undefined);
      }

      console.log(`[scheduler] Task "${task.name}" (${task.id}) completed (${output.length} chars)`);
      if (output) {
        console.log(`[scheduler] Output:\n${output}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Task "${task.name}" failed: ${msg}`);
      updateTask(task.id, { lastRunAt: Date.now() });

      // Always notify on error (unless never)
      if (task.notify !== "never") try {
        await this.telegram.sendTaskResult(
          task.telegramUserId,
          task.name,
          `Task failed: ${msg}`,
          channelId
        );
      } catch (notifyErr) {
        console.error(`[scheduler] Failed to send error notification: ${notifyErr}`);
      }
    } finally {
      this.runningTasks.delete(task.id);
    }
  }
}

// --- Notify resolution ---

export function resolveNotify(mode: string, text: string): { shouldNotify: boolean; output: string } {
  if (mode === "never") return { shouldNotify: false, output: text };
  if (mode === "always") {
    // Strip <notify> tag if present but always notify
    const output = text.replace(/<notify>\s*(true|false)\s*<\/notify>\s*/i, "").trim();
    return { shouldNotify: !!output, output };
  }

  // auto mode — Claude decides via <notify> tag
  const match = text.match(/<notify>\s*(true|false)\s*<\/notify>/i);
  if (match) {
    const notify = match[1].toLowerCase() === "true";
    const output = text.replace(/<notify>\s*(true|false)\s*<\/notify>\s*/i, "").trim();
    return { shouldNotify: notify, output };
  }

  // No tag in auto mode — default to NOT notify (reduce noise)
  return { shouldNotify: false, output: text };
}

// --- Inline cron parser ---
// Standard 5-field: minute hour day-of-month month day-of-week

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // 1-indexed
  const dayOfWeek = date.getDay(); // 0=Sunday

  return (
    fieldMatches(fields[0], minute, 0, 59) &&
    fieldMatches(fields[1], hour, 0, 23) &&
    fieldMatches(fields[2], dayOfMonth, 1, 31) &&
    fieldMatches(fields[3], month, 1, 12) &&
    fieldMatches(fields[4], dayOfWeek, 0, 7) // 0 and 7 are both Sunday
  );
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    // Handle step: */5 or 1-10/2
    const [rangeStr, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (rangeStr === "*") {
      if (value % step === 0) return true;
      continue;
    }

    // Handle range: 1-5
    if (rangeStr.includes("-")) {
      const [startStr, endStr] = rangeStr.split("-");
      const start = parseInt(startStr);
      const end = parseInt(endStr);
      if (value >= start && value <= end && (value - start) % step === 0) return true;
      continue;
    }

    // Single value
    const num = parseInt(rangeStr);
    if (num === value) return true;
    // Day of week: 7 === 0 (both Sunday)
    if (max === 7 && num === 7 && value === 0) return true;
    if (max === 7 && num === 0 && value === 7) return true;
  }

  return false;
}
