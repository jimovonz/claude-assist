#!/usr/bin/env bun

import { createTask, getTask, listTasks, updateTask, deleteTask } from "../src/conduit/state";

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function output(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

switch (command) {
  case "create": {
    const name = flag("name");
    const prompt = flag("prompt");
    const schedule = flag("schedule");
    const runAt = flag("run-at");
    const user = flag("user");
    if (!name || !prompt || !user) {
      console.error("Required: --name --prompt --user (and --schedule or --run-at)");
      process.exit(1);
    }
    if (!schedule && !runAt) {
      console.error("Must provide --schedule (cron) or --run-at (ISO datetime or unix ms)");
      process.exit(1);
    }
    // Parse --run-at: accept ISO datetime string or unix timestamp in ms
    let runAtMs: number | undefined;
    if (runAt) {
      const parsed = Number(runAt);
      runAtMs = isNaN(parsed) ? new Date(runAt).getTime() : parsed;
      if (isNaN(runAtMs)) {
        console.error(`Invalid --run-at value: "${runAt}". Use ISO datetime or unix ms.`);
        process.exit(1);
      }
    }
    const task = createTask({
      name,
      prompt,
      schedule: schedule || undefined,
      runAt: runAtMs,
      telegramUserId: user,
      sessionStrategy: (flag("strategy") as "fresh" | "resume") ?? "fresh",
      notify: (flag("notify") as "always" | "auto" | "never") ?? undefined,
      model: flag("model") || undefined,
      skipCairn: args.includes("--skip-cairn") || undefined,
      contextQuery: flag("context-query") || undefined,
      contextFiles: flag("context-files") ? JSON.parse(flag("context-files")!) : undefined,
      workingDirectory: flag("cwd"),
      maxTurns: flag("max-turns") ? parseInt(flag("max-turns")!) : undefined,
    });
    output(task);
    break;
  }

  case "list": {
    const all = args.includes("--all");
    output(listTasks(!all));
    break;
  }

  case "get": {
    const id = args[1];
    if (!id) { console.error("Usage: get <id>"); process.exit(1); }
    const task = getTask(id);
    if (!task) { console.error(`Task ${id} not found`); process.exit(1); }
    output(task);
    break;
  }

  case "update": {
    const id = args[1];
    if (!id) { console.error("Usage: update <id> [--enabled true|false] [--schedule ...] [--prompt ...]"); process.exit(1); }
    const updates: Record<string, any> = {};
    if (flag("name") !== undefined) updates.name = flag("name");
    if (flag("prompt") !== undefined) updates.prompt = flag("prompt");
    if (flag("schedule") !== undefined) updates.schedule = flag("schedule");
    if (flag("enabled") !== undefined) updates.enabled = flag("enabled") === "true";
    if (flag("strategy") !== undefined) updates.sessionStrategy = flag("strategy");
    if (flag("notify") !== undefined) updates.notify = flag("notify") as any;
    if (flag("model") !== undefined) updates.model = flag("model") || null;
    if (args.includes("--skip-cairn")) updates.skipCairn = true;
    if (args.includes("--no-skip-cairn")) updates.skipCairn = false;
    if (flag("context-query") !== undefined) updates.contextQuery = flag("context-query") || null;
    if (flag("context-files") !== undefined) updates.contextFiles = JSON.parse(flag("context-files")!);
    if (flag("cwd") !== undefined) updates.workingDirectory = flag("cwd");
    if (flag("max-turns") !== undefined) updates.maxTurns = parseInt(flag("max-turns")!);
    if (flag("run-at") !== undefined) {
      const v = flag("run-at")!;
      const parsed = Number(v);
      updates.runAt = isNaN(parsed) ? new Date(v).getTime() : parsed;
    }
    const task = updateTask(id, updates);
    if (!task) { console.error(`Task ${id} not found`); process.exit(1); }
    output(task);
    break;
  }

  case "delete": {
    const id = args[1];
    if (!id) { console.error("Usage: delete <id>"); process.exit(1); }
    const ok = deleteTask(id);
    output({ deleted: ok, id });
    break;
  }

  default:
    console.error(`Usage: task-cli <create|list|get|update|delete>
  create --name "..." --prompt "..." --user "12345" --schedule "0 9 * * *" | --run-at "2026-03-27T09:00:00" [--strategy resume|fresh] [--context-files '["path"]'] [--cwd "/path"] [--max-turns 5]
  list [--all]
  get <id>
  update <id> [--name ...] [--enabled true|false] [--schedule ...] [--run-at ...] [--prompt ...]
  delete <id>`);
    process.exit(1);
}
