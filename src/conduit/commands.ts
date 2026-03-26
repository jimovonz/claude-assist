import type { SessionManager } from "./session";
import { listTasks, getTask, updateTask, deleteTask, type TaskDef } from "./state";
import type { TaskScheduler } from "./scheduler";

export interface CommandResult {
  text: string;
  data?: unknown;
}

export interface CommandContext {
  sessionManager: SessionManager;
  scheduler?: TaskScheduler;
  channelId: string;
  userId: string;
}

export function isCommand(text: string): boolean {
  return text.startsWith("/") && /^\/[a-z]/.test(text);
}

export function handleCommand(text: string, ctx: CommandContext): CommandResult | null {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/clear":
      return cmdClear(ctx);
    case "/context":
      return cmdContext(ctx);
    case "/sessions":
      return cmdSessions(ctx);
    case "/tasks":
      return cmdTasks();
    case "/task":
      return cmdTask(parts.slice(1), ctx);
    case "/help":
      return cmdHelp();
    default:
      return null; // not a known command — pass through to Claude
  }
}

function cmdClear(ctx: CommandContext): CommandResult {
  ctx.sessionManager.removeSession(ctx.channelId);
  return { text: "Session cleared. Next message starts fresh." };
}

function cmdContext(ctx: CommandContext): CommandResult {
  const usage = ctx.sessionManager.getUsage(ctx.channelId);
  if (!usage) {
    return { text: "No usage data yet — send a message first." };
  }
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const pct = usage.contextWindow > 0
    ? ((totalInput + usage.outputTokens) / usage.contextWindow * 100).toFixed(1)
    : "?";
  const text = [
    `Context: ${pct}% of ${(usage.contextWindow / 1000).toFixed(0)}K`,
    `In: ${(totalInput / 1000).toFixed(1)}K (${(usage.cacheReadTokens / 1000).toFixed(1)}K cached)`,
    `Out: ${(usage.outputTokens / 1000).toFixed(1)}K`,
    `Cost: $${usage.totalCostUsd.toFixed(2)}`,
  ].join("\n");
  return { text, data: usage };
}

function cmdSessions(ctx: CommandContext): CommandResult {
  const sessions = ctx.sessionManager.listSessions();
  if (sessions.length === 0) {
    return { text: "No active sessions.", data: [] };
  }
  const lines = sessions.map((s) => {
    const ago = Math.round((Date.now() - s.lastActivity) / 1000);
    const status = s.live ? "live" : "persisted";
    return `  ${s.channelId} (${status}, ${ago}s ago)`;
  });
  return {
    text: `Sessions (${sessions.length}):\n${lines.join("\n")}`,
    data: sessions,
  };
}

function cmdTasks(): CommandResult {
  const tasks = listTasks();
  if (tasks.length === 0) {
    return { text: "No scheduled tasks.", data: [] };
  }
  const lines = tasks.map(formatTask);
  return {
    text: `Scheduled tasks (${tasks.length}):\n\n${lines.join("\n\n")}`,
    data: tasks,
  };
}

function formatTask(t: TaskDef): string {
  const status = t.enabled ? "enabled" : "disabled";
  const lastRun = t.lastRunAt
    ? new Date(t.lastRunAt).toLocaleString("en-NZ", { dateStyle: "short", timeStyle: "short" })
    : "never";
  const scheduleInfo = t.runAt
    ? `Run at: ${new Date(t.runAt).toLocaleString("en-NZ", { dateStyle: "short", timeStyle: "short" })} (one-shot)`
    : `Schedule: ${t.schedule}`;
  return [
    `  [${t.id}] ${t.name} (${status})`,
    `  ${scheduleInfo} | Strategy: ${t.sessionStrategy} | Notify: ${t.notify}`,
    `  Last run: ${lastRun}`,
  ].join("\n");
}

function cmdTask(args: string[], ctx: CommandContext): CommandResult {
  if (args.length < 2) {
    return { text: "Usage: /task <id> <enable|disable|delete|run>" };
  }

  const [id, action] = args;
  const task = getTask(id);
  if (!task) {
    return { text: `Task "${id}" not found.` };
  }

  switch (action.toLowerCase()) {
    case "enable": {
      updateTask(id, { enabled: true });
      return { text: `Task "${task.name}" enabled.` };
    }
    case "disable": {
      updateTask(id, { enabled: false });
      return { text: `Task "${task.name}" disabled.` };
    }
    case "delete": {
      deleteTask(id);
      return { text: `Task "${task.name}" deleted.` };
    }
    case "run": {
      if (!ctx.scheduler) {
        return { text: "Scheduler not available." };
      }
      ctx.scheduler.runTask(id);
      return { text: `Task "${task.name}" triggered.` };
    }
    default:
      return { text: `Unknown action "${action}". Use: enable, disable, delete, run` };
  }
}

function cmdHelp(): CommandResult {
  const text = [
    "Available commands:",
    "  /clear      — Reset session (fresh conversation)",
    "  /context    — Show context window usage and cost",
    "  /sessions   — List all active sessions",
    "  /tasks      — List all scheduled tasks",
    "  /task <id> <enable|disable|delete|run> — Manage a task",
    "  /help       — Show this message",
  ].join("\n");
  return { text };
}
