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

export function closeDb(): void {
  _db?.close();
  _db = null;
}
