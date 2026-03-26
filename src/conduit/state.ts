import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

const STATE_DIR = process.env.CONDUIT_STATE_DIR ?? join(homedir(), ".local", "state", "claude-assist");
const DB_PATH = join(STATE_DIR, "conduit.db");

let _db: Database | null = null;

function db(): Database {
  if (_db) return _db;

  mkdirSync(STATE_DIR, { recursive: true });
  _db = new Database(DB_PATH, { create: true });
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 3000");

  _db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      channel_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      working_directory TEXT,
      last_activity INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      message_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  console.log(`[state] Database at ${DB_PATH}`);
  return _db;
}

export interface PersistedSession {
  channelId: string;
  sessionId: string;
  lastActivity: number;
  workingDirectory?: string;
  createdAt?: number;
  messageCount?: number;
}

export function loadSessionState(): Map<string, PersistedSession> {
  const map = new Map<string, PersistedSession>();

  try {
    const rows = db().query(
      "SELECT channel_id, session_id, last_activity, working_directory, created_at, message_count FROM sessions"
    ).all() as any[];

    for (const row of rows) {
      map.set(row.channel_id, {
        channelId: row.channel_id,
        sessionId: row.session_id,
        lastActivity: row.last_activity,
        workingDirectory: row.working_directory,
        createdAt: row.created_at,
        messageCount: row.message_count,
      });
    }

    if (map.size > 0) {
      console.log(`[state] Loaded ${map.size} persisted session(s)`);
    }
  } catch (err) {
    console.error("[state] Failed to load sessions:", err);
  }

  return map;
}

export function saveSession(channelId: string, sessionId: string, workingDirectory?: string): void {
  try {
    db().run(
      `INSERT INTO sessions (channel_id, session_id, last_activity, working_directory, message_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(channel_id) DO UPDATE SET
         session_id = excluded.session_id,
         last_activity = excluded.last_activity,
         working_directory = COALESCE(excluded.working_directory, sessions.working_directory),
         message_count = sessions.message_count + 1`,
      [channelId, sessionId, Date.now(), workingDirectory ?? null]
    );
  } catch (err) {
    console.error("[state] Failed to save session:", err);
  }
}

export function removeSession(channelId: string): void {
  try {
    db().run("DELETE FROM sessions WHERE channel_id = ?", [channelId]);
  } catch (err) {
    console.error("[state] Failed to remove session:", err);
  }
}

// --- Helpers ---

function slugify(name: string, existingIds: string[]): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40);
  if (!base) return crypto.randomUUID().slice(0, 8);
  if (!existingIds.includes(base)) return base;
  // Deduplicate with numeric suffix
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existingIds.includes(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 4)}`;
}

// --- Scheduled Tasks ---

export interface TaskDef {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  runAt: number | null;
  telegramUserId: string;
  sessionStrategy: "fresh" | "resume";
  notify: "always" | "auto" | "never";
  model: string | null;
  skipCairn: boolean;
  contextQuery: string | null;
  contextFiles: string[] | null;
  workingDirectory: string | null;
  enabled: boolean;
  maxTurns: number;
  lastRunAt: number | null;
  lastRunOutput: string | null;
  lastRunSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

let _tasksTableReady = false;
function ensureTasksTable(): void {
  if (_tasksTableReady) return;
  db().run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL DEFAULT '',
      run_at INTEGER,
      telegram_user_id TEXT NOT NULL,
      session_strategy TEXT NOT NULL DEFAULT 'fresh',
      notify TEXT NOT NULL DEFAULT 'always',
      model TEXT,
      skip_cairn INTEGER NOT NULL DEFAULT 0,
      context_query TEXT,
      context_files TEXT,
      working_directory TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_turns INTEGER DEFAULT 5,
      last_run_at INTEGER,
      last_run_output TEXT,
      last_run_session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
  `);

  // Migrations for existing databases
  try { db().run("ALTER TABLE tasks ADD COLUMN run_at INTEGER"); } catch {}
  try { db().run("ALTER TABLE tasks ADD COLUMN notify TEXT NOT NULL DEFAULT 'always'"); } catch {}
  try { db().run("ALTER TABLE tasks ADD COLUMN model TEXT"); } catch {}
  try { db().run("ALTER TABLE tasks ADD COLUMN skip_cairn INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db().run("ALTER TABLE tasks ADD COLUMN context_query TEXT"); } catch {}

  _tasksTableReady = true;
}

function rowToTask(row: any): TaskDef {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    runAt: row.run_at,
    telegramUserId: row.telegram_user_id,
    sessionStrategy: row.session_strategy as "fresh" | "resume",
    notify: (row.notify as "always" | "auto" | "never") ?? "always",
    model: row.model ?? null,
    skipCairn: !!row.skip_cairn,
    contextQuery: row.context_query ?? null,
    contextFiles: row.context_files ? JSON.parse(row.context_files) : null,
    workingDirectory: row.working_directory,
    enabled: !!row.enabled,
    maxTurns: row.max_turns ?? 5,
    lastRunAt: row.last_run_at,
    lastRunOutput: row.last_run_output,
    lastRunSessionId: row.last_run_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTask(task: {
  name: string;
  prompt: string;
  schedule?: string;
  runAt?: number;
  telegramUserId: string;
  sessionStrategy?: "fresh" | "resume";
  notify?: "always" | "auto" | "never";
  model?: string;
  skipCairn?: boolean;
  contextQuery?: string;
  contextFiles?: string[];
  workingDirectory?: string;
  maxTurns?: number;
}): TaskDef {
  ensureTasksTable();
  if (!task.schedule && !task.runAt) {
    throw new Error("Task must have either a schedule (cron) or runAt (timestamp)");
  }
  const id = slugify(task.name, listTasks().map(t => t.id));
  const now = Date.now();
  db().run(
    `INSERT INTO tasks (id, name, prompt, schedule, run_at, telegram_user_id, session_strategy, notify, model, skip_cairn, context_query, context_files, working_directory, max_turns, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      task.name,
      task.prompt,
      task.schedule ?? "",
      task.runAt ?? null,
      task.telegramUserId,
      task.sessionStrategy ?? "fresh",
      task.notify ?? "always",
      task.model ?? null,
      task.skipCairn ? 1 : 0,
      task.contextQuery ?? null,
      task.contextFiles ? JSON.stringify(task.contextFiles) : null,
      task.workingDirectory ?? null,
      task.maxTurns ?? 5,
      now,
      now,
    ]
  );
  return getTask(id)!;
}

export function getTask(id: string): TaskDef | null {
  ensureTasksTable();
  const row = db().query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return row ? rowToTask(row) : null;
}

export function listTasks(enabledOnly = false): TaskDef[] {
  ensureTasksTable();
  const query = enabledOnly
    ? "SELECT * FROM tasks WHERE enabled = 1 ORDER BY created_at"
    : "SELECT * FROM tasks ORDER BY created_at";
  const rows = db().query(query).all() as any[];
  return rows.map(rowToTask);
}

export function updateTask(id: string, updates: Partial<{
  name: string;
  prompt: string;
  schedule: string;
  runAt: number | null;
  enabled: boolean;
  sessionStrategy: "fresh" | "resume";
  notify: "always" | "auto" | "never";
  model: string | null;
  skipCairn: boolean;
  contextQuery: string | null;
  contextFiles: string[];
  workingDirectory: string;
  maxTurns: number;
  lastRunAt: number;
  lastRunOutput: string;
  lastRunSessionId: string;
}>): TaskDef | null {
  ensureTasksTable();
  const sets: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
  if (updates.prompt !== undefined) { sets.push("prompt = ?"); values.push(updates.prompt); }
  if (updates.schedule !== undefined) { sets.push("schedule = ?"); values.push(updates.schedule); }
  if (updates.runAt !== undefined) { sets.push("run_at = ?"); values.push(updates.runAt); }
  if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
  if (updates.sessionStrategy !== undefined) { sets.push("session_strategy = ?"); values.push(updates.sessionStrategy); }
  if (updates.notify !== undefined) { sets.push("notify = ?"); values.push(updates.notify); }
  if (updates.model !== undefined) { sets.push("model = ?"); values.push(updates.model); }
  if (updates.skipCairn !== undefined) { sets.push("skip_cairn = ?"); values.push(updates.skipCairn ? 1 : 0); }
  if (updates.contextQuery !== undefined) { sets.push("context_query = ?"); values.push(updates.contextQuery); }
  if (updates.contextFiles !== undefined) { sets.push("context_files = ?"); values.push(JSON.stringify(updates.contextFiles)); }
  if (updates.workingDirectory !== undefined) { sets.push("working_directory = ?"); values.push(updates.workingDirectory); }
  if (updates.maxTurns !== undefined) { sets.push("max_turns = ?"); values.push(updates.maxTurns); }
  if (updates.lastRunAt !== undefined) { sets.push("last_run_at = ?"); values.push(updates.lastRunAt); }
  if (updates.lastRunOutput !== undefined) { sets.push("last_run_output = ?"); values.push(updates.lastRunOutput); }
  if (updates.lastRunSessionId !== undefined) { sets.push("last_run_session_id = ?"); values.push(updates.lastRunSessionId); }

  if (sets.length === 0) return getTask(id);

  sets.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);

  db().run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, values);
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  ensureTasksTable();
  const result = db().run("DELETE FROM tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
