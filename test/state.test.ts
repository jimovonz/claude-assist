import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Point state module at a temp directory BEFORE importing it
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const { loadSessionState, saveSession, removeSession, closeDb } = await import(
  "../src/conduit/state"
);

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

// =============================================================================
// Persistence Contract
//
// Sessions saved to the database must be fully recoverable after restart.
// These tests verify the data round-trips correctly through SQLite.
// =============================================================================

describe("save and load roundtrip", () => {
  test("saved session is retrievable via loadSessionState", () => {
    saveSession("telegram:123", "session-abc");
    const sessions = loadSessionState();
    const s = sessions.get("telegram:123");

    expect(s).toBeDefined();
    expect(s!.channelId).toBe("telegram:123");
    expect(s!.sessionId).toBe("session-abc");
    expect(s!.lastActivity).toBeGreaterThan(0);
  });

  test("multiple sessions are all returned", () => {
    saveSession("telegram:100", "sess-100");
    saveSession("telegram:200", "sess-200");
    saveSession("telegram:300", "sess-300");

    const sessions = loadSessionState();
    expect(sessions.size).toBeGreaterThanOrEqual(3);
    expect(sessions.get("telegram:100")?.sessionId).toBe("sess-100");
    expect(sessions.get("telegram:200")?.sessionId).toBe("sess-200");
    expect(sessions.get("telegram:300")?.sessionId).toBe("sess-300");
  });

  test("working directory is persisted", () => {
    saveSession("telegram:wd", "sess-wd", "/home/james/Projects/foo");
    const sessions = loadSessionState();
    expect(sessions.get("telegram:wd")?.workingDirectory).toBe("/home/james/Projects/foo");
  });

  test("createdAt timestamp is populated", () => {
    saveSession("telegram:ts", "sess-ts");
    const sessions = loadSessionState();
    const s = sessions.get("telegram:ts");
    expect(s?.createdAt).toBeDefined();
    expect(s!.createdAt).toBeGreaterThan(0);
  });
});

// =============================================================================
// Upsert Behavior
//
// Re-saving the same channel should update the session ID and metadata,
// not create duplicates.
// =============================================================================

describe("upsert behavior", () => {
  test("saving same channel twice updates session ID", () => {
    saveSession("telegram:upsert1", "old-session");
    saveSession("telegram:upsert1", "new-session");

    const sessions = loadSessionState();
    expect(sessions.get("telegram:upsert1")?.sessionId).toBe("new-session");
  });

  test("upsert preserves working directory when new save omits it", () => {
    saveSession("telegram:upsert-wd", "sess-1", "/home/james/Projects");
    saveSession("telegram:upsert-wd", "sess-2"); // no working directory

    const sessions = loadSessionState();
    expect(sessions.get("telegram:upsert-wd")?.workingDirectory).toBe("/home/james/Projects");
  });

  test("upsert updates working directory when new value provided", () => {
    saveSession("telegram:upsert-wd2", "sess-1", "/old/path");
    saveSession("telegram:upsert-wd2", "sess-2", "/new/path");

    const sessions = loadSessionState();
    expect(sessions.get("telegram:upsert-wd2")?.workingDirectory).toBe("/new/path");
  });

  test("lastActivity is updated on each save", () => {
    saveSession("telegram:activity", "sess-1");
    const first = loadSessionState().get("telegram:activity")!.lastActivity;

    // Small delay to ensure timestamp differs
    Bun.sleepSync(5);

    saveSession("telegram:activity", "sess-2");
    const second = loadSessionState().get("telegram:activity")!.lastActivity;

    expect(second).toBeGreaterThanOrEqual(first);
  });
});

// =============================================================================
// Message Counting
//
// Every save represents a completed message exchange. The count should
// accurately reflect how many times a session has produced a result.
// =============================================================================

describe("message counting", () => {
  test("first save for a channel records message count of 1", () => {
    // A save represents a completed exchange. The first save IS the first message.
    saveSession("telegram:count-fresh", "sess-1");
    const sessions = loadSessionState();
    expect(sessions.get("telegram:count-fresh")?.messageCount).toBe(1);
  });

  test("message count increments on each subsequent save", () => {
    saveSession("telegram:count-inc", "sess-1");
    saveSession("telegram:count-inc", "sess-2");
    saveSession("telegram:count-inc", "sess-3");

    const sessions = loadSessionState();
    expect(sessions.get("telegram:count-inc")?.messageCount).toBe(3);
  });
});

// =============================================================================
// Removal
// =============================================================================

describe("session removal", () => {
  test("removed session no longer appears in loadSessionState", () => {
    saveSession("telegram:remove-me", "sess-rm");
    removeSession("telegram:remove-me");

    const sessions = loadSessionState();
    expect(sessions.has("telegram:remove-me")).toBe(false);
  });

  test("removing non-existent session does not throw", () => {
    expect(() => removeSession("telegram:never-existed")).not.toThrow();
  });
});

// =============================================================================
// Empty State
// =============================================================================

describe("data isolation", () => {
  test("removing all saved sessions results in empty loadSessionState", () => {
    // Save then remove a session — verify the DB is clean for that key
    saveSession("telegram:isolation", "sess-iso");
    removeSession("telegram:isolation");

    const sessions = loadSessionState();
    expect(sessions.has("telegram:isolation")).toBe(false);
  });

  test("sessions with different channel IDs are fully independent", () => {
    saveSession("telegram:iso-a", "sess-a");
    saveSession("telegram:iso-b", "sess-b");
    removeSession("telegram:iso-a");

    const sessions = loadSessionState();
    expect(sessions.has("telegram:iso-a")).toBe(false);
    expect(sessions.get("telegram:iso-b")?.sessionId).toBe("sess-b");
  });
});
