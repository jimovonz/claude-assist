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

  _db.run(`
    CREATE TABLE IF NOT EXISTS processed_emails (
      email_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      reminder_time INTEGER,
      location_hint TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      done INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
  `);

  console.log(`[state] Database at ${DB_PATH}`);
  return _db;
}

// --- Processed emails (dedup for email agent) ---

export function isEmailProcessed(emailId: string): boolean {
  const row = db().query("SELECT 1 FROM processed_emails WHERE email_id = ?").get(emailId);
  return !!row;
}

export function markEmailProcessed(emailId: string): void {
  db().run("INSERT OR IGNORE INTO processed_emails (email_id) VALUES (?)", emailId);
}

export function cleanupOldEmails(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  db().run("DELETE FROM processed_emails WHERE processed_at < ?", cutoff);
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

// --- Locations (named places + geofences) ---

let _locationTablesReady = false;
function ensureLocationTables(): void {
  if (_locationTablesReady) return;

  db().run(`
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      radius_m REAL NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
  `);

  db().run(`
    CREATE TABLE IF NOT EXISTS location_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      accuracy REAL,
      velocity REAL,
      battery REAL,
      timestamp INTEGER NOT NULL,
      received_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
  `);

  db().run(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      reminder_time INTEGER,
      location_hint TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      done INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
    )
  `);

  _locationTablesReady = true;
}

export interface LocationDef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  createdAt: number;
}

export interface LocationUpdate {
  lat: number;
  lon: number;
  accuracy?: number;
  velocity?: number;
  battery?: number;
  timestamp: number;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function createLocation(name: string, lat: number, lon: number, radiusM = 100): LocationDef {
  ensureLocationTables();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 40);
  db().run(
    "INSERT OR REPLACE INTO locations (id, name, lat, lon, radius_m) VALUES (?, ?, ?, ?, ?)",
    [id, name, lat, lon, radiusM]
  );
  return { id, name, lat, lon, radiusM, createdAt: Date.now() };
}

export function listLocations(): LocationDef[] {
  ensureLocationTables();
  const rows = db().query("SELECT * FROM locations ORDER BY name").all() as any[];
  return rows.map(r => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon, radiusM: r.radius_m, createdAt: r.created_at }));
}

export function getLocation(id: string): LocationDef | null {
  ensureLocationTables();
  const row = db().query("SELECT * FROM locations WHERE id = ?").get(id) as any;
  return row ? { id: row.id, name: row.name, lat: row.lat, lon: row.lon, radiusM: row.radius_m, createdAt: row.created_at } : null;
}

export function deleteLocation(id: string): boolean {
  ensureLocationTables();
  return db().run("DELETE FROM locations WHERE id = ?", [id]).changes > 0;
}

export function storeLocationUpdate(update: LocationUpdate): void {
  ensureLocationTables();
  db().run(
    "INSERT INTO location_history (lat, lon, accuracy, velocity, battery, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    [update.lat, update.lon, update.accuracy ?? null, update.velocity ?? null, update.battery ?? null, update.timestamp]
  );
  // Keep last 1000 entries
  db().run("DELETE FROM location_history WHERE id NOT IN (SELECT id FROM location_history ORDER BY received_at DESC LIMIT 1000)");
}

export function getLatestLocation(): LocationUpdate | null {
  ensureLocationTables();
  const row = db().query("SELECT * FROM location_history ORDER BY received_at DESC LIMIT 1").get() as any;
  return row ? { lat: row.lat, lon: row.lon, accuracy: row.accuracy, velocity: row.velocity, battery: row.battery, timestamp: row.timestamp } : null;
}

export function checkGeofences(lat: number, lon: number): LocationDef[] {
  ensureLocationTables();
  const locations = listLocations();
  return locations.filter(loc => haversineM(lat, lon, loc.lat, loc.lon) <= loc.radiusM);
}

export function distanceToLocation(lat: number, lon: number, locationId: string): number | null {
  const loc = getLocation(locationId);
  if (!loc) return null;
  return haversineM(lat, lon, loc.lat, loc.lon);
}

// --- Todos (Personal Reminder System) ---

export interface TodoItem {
  id: string;
  text: string;
  reminderTime?: number;
  locationHint?: string;
  source: "manual" | "email" | "calendar" | "telegram";
  done: boolean;
  userId: string;
  createdAt: number;
  updatedAt: number;
}

export function addTodo(text: string, userId: string, options?: { reminderTime?: number; locationHint?: string; source?: string }): TodoItem {
  const id = crypto.randomUUID().slice(0, 12);
  const now = Date.now();
  const source = options?.source ?? "manual";

  db().run(
    `INSERT INTO todos (id, text, reminder_time, location_hint, source, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, text, options?.reminderTime ?? null, options?.locationHint ?? null, source, userId, now, now]
  );

  return {
    id,
    text,
    reminderTime: options?.reminderTime,
    locationHint: options?.locationHint,
    source: source as any,
    done: false,
    userId,
    createdAt: now,
    updatedAt: now,
  };
}

export function listTodos(userId: string, includeFinished = false): TodoItem[] {
  const query = includeFinished
    ? "SELECT * FROM todos WHERE user_id = ? ORDER BY reminder_time, created_at"
    : "SELECT * FROM todos WHERE user_id = ? AND done = 0 ORDER BY reminder_time, created_at";

  const rows = db().query(query).all(userId) as any[];
  return rows.map(r => ({
    id: r.id,
    text: r.text,
    reminderTime: r.reminder_time,
    locationHint: r.location_hint,
    source: r.source,
    done: r.done === 1,
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function markTodoDone(todoId: string, userId: string): boolean {
  const result = db().run(
    "UPDATE todos SET done = 1, updated_at = ? WHERE id = ? AND user_id = ?",
    [Date.now(), todoId, userId]
  );
  return result.changes > 0;
}

export function deleteTodo(todoId: string, userId: string): boolean {
  const result = db().run(
    "DELETE FROM todos WHERE id = ? AND user_id = ?",
    [todoId, userId]
  );
  return result.changes > 0;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
  _tasksTableReady = false;
  _locationTablesReady = false;
}
