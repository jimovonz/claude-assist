import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate state DB for session tests
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-session-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const { SessionManager } = await import("../src/conduit/session");
const { closeDb, loadSessionState } = await import("../src/conduit/state");

const MOCK_CMD = join(import.meta.dir, "fixtures", "run-mock.sh");
const SCENARIO_FILE = "/tmp/mock-claude-scenario";

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

function setScenario(scenario: string, sessionId = "mock-session-001") {
  writeFileSync(SCENARIO_FILE, `${scenario}\n${sessionId}`);
}

function makeManager(idleTimeoutMs = 5000) {
  return new SessionManager({ command: MOCK_CMD, idleTimeoutMs });
}

async function collect(manager: InstanceType<typeof SessionManager>, channelId: string, message: string) {
  const events: any[] = [];
  for await (const event of manager.sendMessage(channelId, message, { channelId })) {
    events.push(event);
  }
  return events;
}

// =============================================================================
// Stream-JSON Protocol Parsing
//
// SessionManager must correctly parse the stream-json protocol from the
// claude subprocess and yield typed SessionEvents.
// =============================================================================

describe("stream-json parsing", () => {
  test("simple response yields text and result events", async () => {
    setScenario("simple", "sess-simple");
    const manager = makeManager();

    const events = await collect(manager, "parse:simple", "Hello");

    const textEvents = events.filter((e) => e.type === "text");
    const resultEvents = events.filter((e) => e.type === "result");

    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents[0].text).toContain("Response to: Hello");

    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].text).toContain("Response to: Hello");
    expect(resultEvents[0].sessionId).toBe("sess-simple");

    manager.removeSession("parse:simple");
  });

  test("tool_use events yield status events with tool description", async () => {
    setScenario("tool_use", "sess-tool");
    const manager = makeManager();

    const events = await collect(manager, "parse:tool", "Read a file");

    const statusEvents = events.filter((e) => e.type === "status");
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents[0].text).toContain("Reading");
    expect(statusEvents[0].text).toContain("main.ts");

    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].text).toBe("I read the file.");

    manager.removeSession("parse:tool");
  });

  test("multiple text blocks all yield separate text events", async () => {
    setScenario("multi_text", "sess-multi");
    const manager = makeManager();

    const events = await collect(manager, "parse:multi", "Go");

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    expect(textEvents[0].text).toBe("First part.");
    expect(textEvents[1].text).toBe("Second part.");

    manager.removeSession("parse:multi");
  });

  test("empty result yields result event with empty text", async () => {
    setScenario("empty", "sess-empty");
    const manager = makeManager();

    const events = await collect(manager, "parse:empty", "Go");

    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].text).toBe("");

    manager.removeSession("parse:empty");
  });
});

// =============================================================================
// Session Lifecycle
// =============================================================================

describe("session lifecycle", () => {
  test("getSession returns undefined for unknown channel", () => {
    const manager = makeManager();
    expect(manager.getSession("nonexistent")).toBeUndefined();
  });

  test("activeSessionCount is 0 initially", () => {
    const manager = makeManager();
    expect(manager.activeSessionCount).toBe(0);
  });

  test("sendMessage creates a live session", async () => {
    setScenario("simple");
    const manager = makeManager();

    await collect(manager, "life:create", "Hi");

    const session = manager.getSession("life:create");
    expect(session).toBeDefined();
    expect(session!.channelId).toBe("life:create");
    expect(manager.activeSessionCount).toBe(1);

    manager.removeSession("life:create");
  });

  test("removeSession kills and removes from live sessions", async () => {
    setScenario("simple");
    const manager = makeManager();

    await collect(manager, "life:remove", "Hi");

    const removed = manager.removeSession("life:remove");
    expect(removed).toBe(true);
    expect(manager.activeSessionCount).toBe(0);
  });

  test("removeSession returns false for non-existent", () => {
    const manager = makeManager();
    expect(manager.removeSession("ghost")).toBe(false);
  });

  test("session is recreated after removal", async () => {
    setScenario("simple", "sess-first");
    const manager = makeManager();

    await collect(manager, "life:recreate", "First");
    expect(manager.activeSessionCount).toBe(1);

    // Remove the session (simulates what pruneIdle does)
    manager.removeSession("life:recreate");
    expect(manager.activeSessionCount).toBe(0);

    // Next message should create a fresh session
    setScenario("simple", "sess-second");
    const events = await collect(manager, "life:recreate", "Second");

    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    expect(result!.text).toContain("Response to: Second");
    expect(result!.sessionId).toBe("sess-second");

    manager.removeSession("life:recreate");
  });
});

// =============================================================================
// Idle Pruning
// =============================================================================

describe("idle pruning", () => {
  test("prunes sessions past the timeout", async () => {
    setScenario("simple");
    const manager = makeManager(1); // 1ms timeout

    await collect(manager, "prune:idle", "Hi");
    await Bun.sleep(10);

    const pruned = manager.pruneIdle();
    expect(pruned).toContain("prune:idle");
    expect(manager.activeSessionCount).toBe(0);
  });

  test("does not prune active sessions", async () => {
    setScenario("simple");
    const manager = makeManager(60000);

    await collect(manager, "prune:active", "Hi");

    const pruned = manager.pruneIdle();
    expect(pruned).not.toContain("prune:active");
    expect(manager.activeSessionCount).toBe(1);

    manager.removeSession("prune:active");
  });
});

// =============================================================================
// Session Persistence
// =============================================================================

describe("session persistence", () => {
  test("result persists session ID to SQLite", async () => {
    setScenario("simple", "sess-persisted-abc");
    const manager = makeManager();

    await collect(manager, "persist:check", "Hi");

    const state = loadSessionState();
    expect(state.get("persist:check")?.sessionId).toBe("sess-persisted-abc");

    manager.removeSession("persist:check");
  });

  test("uptime increases over time", async () => {
    const manager = makeManager();
    const t1 = manager.uptime;
    await Bun.sleep(20);
    const t2 = manager.uptime;
    expect(t2).toBeGreaterThan(t1);
  });

  test("listSessions includes both live and persisted sessions", async () => {
    setScenario("simple");
    const manager = makeManager();

    await collect(manager, "list:live", "Hi");

    const sessions = manager.listSessions();
    const liveSession = sessions.find((s) => s.channelId === "list:live" && s.live);
    expect(liveSession).toBeDefined();

    manager.removeSession("list:live");
  });
});
