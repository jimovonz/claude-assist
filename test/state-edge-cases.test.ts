import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-state-edge-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const { loadSessionState, saveSession, removeSession, closeDb } = await import(
  "../src/conduit/state"
);

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

// =============================================================================
// Special Characters in IDs
// =============================================================================

describe("special characters in channel IDs", () => {
  test("channel ID with colons", () => {
    saveSession("telegram:user:123:extra", "sess-colon");
    const sessions = loadSessionState();
    expect(sessions.get("telegram:user:123:extra")?.sessionId).toBe("sess-colon");
  });

  test("channel ID with unicode", () => {
    saveSession("telegram:用户123", "sess-unicode");
    const sessions = loadSessionState();
    expect(sessions.get("telegram:用户123")?.sessionId).toBe("sess-unicode");
  });

  test("very long channel ID", () => {
    const longId = "channel:" + "a".repeat(500);
    saveSession(longId, "sess-long");
    const sessions = loadSessionState();
    expect(sessions.get(longId)?.sessionId).toBe("sess-long");
  });

  test("empty session ID is stored", () => {
    saveSession("telegram:empty-sess", "");
    const sessions = loadSessionState();
    expect(sessions.get("telegram:empty-sess")?.sessionId).toBe("");
  });
});

// =============================================================================
// Concurrent Writes
// =============================================================================

describe("concurrent database operations", () => {
  test("rapid sequential saves don't corrupt data", () => {
    for (let i = 0; i < 50; i++) {
      saveSession(`rapid:${i}`, `sess-${i}`);
    }
    const sessions = loadSessionState();
    for (let i = 0; i < 50; i++) {
      expect(sessions.get(`rapid:${i}`)?.sessionId).toBe(`sess-${i}`);
    }
  });

  test("interleaved save and remove operations", () => {
    saveSession("interleave:a", "sess-a");
    saveSession("interleave:b", "sess-b");
    removeSession("interleave:a");
    saveSession("interleave:c", "sess-c");
    removeSession("interleave:b");

    const sessions = loadSessionState();
    expect(sessions.has("interleave:a")).toBe(false);
    expect(sessions.has("interleave:b")).toBe(false);
    expect(sessions.get("interleave:c")?.sessionId).toBe("sess-c");
  });
});

// =============================================================================
// Message Count Accuracy
// =============================================================================

describe("message count accuracy", () => {
  test("count is accurate after many saves", () => {
    const channelId = "count:accuracy";
    for (let i = 1; i <= 10; i++) {
      saveSession(channelId, `sess-${i}`);
    }
    const sessions = loadSessionState();
    expect(sessions.get(channelId)?.messageCount).toBe(10);
  });

  test("count resets after remove and re-create", () => {
    saveSession("count:reset", "sess-1");
    saveSession("count:reset", "sess-2");
    expect(loadSessionState().get("count:reset")?.messageCount).toBe(2);

    removeSession("count:reset");
    saveSession("count:reset", "sess-new");
    expect(loadSessionState().get("count:reset")?.messageCount).toBe(1);
  });
});

// =============================================================================
// Working Directory Edge Cases
// =============================================================================

describe("working directory edge cases", () => {
  test("working directory with spaces", () => {
    saveSession("wd:spaces", "sess-1", "/home/user/My Projects/test dir");
    const sessions = loadSessionState();
    expect(sessions.get("wd:spaces")?.workingDirectory).toBe("/home/user/My Projects/test dir");
  });

  test("null-ish working directory preserves previous", () => {
    saveSession("wd:preserve", "sess-1", "/original/path");
    saveSession("wd:preserve", "sess-2"); // no working directory
    const sessions = loadSessionState();
    expect(sessions.get("wd:preserve")?.workingDirectory).toBe("/original/path");
  });
});
