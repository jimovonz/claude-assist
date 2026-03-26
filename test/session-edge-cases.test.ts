import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-session-edge-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const { SessionManager } = await import("../src/conduit/session");
const { closeDb } = await import("../src/conduit/state");

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
// Process Crash Recovery
// =============================================================================

describe("process crash recovery", () => {
  test("crashed process is respawned on next message", async () => {
    setScenario("simple", "sess-before-crash");
    const manager = makeManager();

    // First message succeeds
    const events1 = await collect(manager, "crash:recover", "First");
    expect(events1.find(e => e.type === "result")).toBeDefined();

    // Crash the process
    setScenario("crash");
    try {
      await collect(manager, "crash:recover", "Crash");
    } catch {
      // May throw or yield nothing — either is acceptable
    }

    // Process should respawn for next message
    setScenario("simple", "sess-after-crash");
    const events3 = await collect(manager, "crash:recover", "After crash");
    const result = events3.find(e => e.type === "result");
    expect(result).toBeDefined();
    expect(result!.text).toContain("After crash");

    manager.removeSession("crash:recover");
  });

  test("crash yields no result event (stream ends early)", async () => {
    setScenario("crash");
    const manager = makeManager();

    const events = await collect(manager, "crash:no-result", "Crash me");
    const results = events.filter(e => e.type === "result");
    expect(results).toHaveLength(0);
  });
});

// =============================================================================
// Abort Handling
// =============================================================================

describe("abort handling", () => {
  test("abort returns true for active session", async () => {
    setScenario("slow");
    const manager = makeManager();

    // Start a slow message, then abort
    const collectPromise = collect(manager, "abort:active", "Slow msg");

    // Give time for process to start
    await Bun.sleep(50);

    const aborted = manager.abort("abort:active");
    expect(aborted).toBe(true);

    const events = await collectPromise;
    const abortedEvent = events.find(e => e.type === "aborted");
    expect(abortedEvent).toBeDefined();
  });

  test("abort returns false for non-existent session", () => {
    const manager = makeManager();
    expect(manager.abort("nonexistent:channel")).toBe(false);
  });
});

// =============================================================================
// Tool Description
// =============================================================================

describe("tool call descriptions", () => {
  test("tool_use generates descriptive status messages", async () => {
    setScenario("tool_use");
    const manager = makeManager();

    const events = await collect(manager, "tools:desc", "Use tools");
    const statuses = events.filter(e => e.type === "status");

    // The tool_use scenario uses Read with a file path
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[0].text).toContain("📖");
    expect(statuses[0].text).toContain("Reading");

    manager.removeSession("tools:desc");
  });
});

// =============================================================================
// Multiple Concurrent Sessions
// =============================================================================

describe("concurrent sessions", () => {
  test("different channels get independent sessions", async () => {
    setScenario("simple", "sess-concurrent");
    const manager = makeManager();

    const [events1, events2] = await Promise.all([
      collect(manager, "concurrent:a", "Message A"),
      collect(manager, "concurrent:b", "Message B"),
    ]);

    const result1 = events1.find(e => e.type === "result");
    const result2 = events2.find(e => e.type === "result");

    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result1!.text).toContain("Message A");
    expect(result2!.text).toContain("Message B");
    expect(manager.activeSessionCount).toBe(2);

    manager.removeSession("concurrent:a");
    manager.removeSession("concurrent:b");
  });
});

// =============================================================================
// Usage Info
// =============================================================================

describe("usage tracking", () => {
  test("getUsage returns undefined for unknown channel", () => {
    const manager = makeManager();
    expect(manager.getUsage("unknown:channel")).toBeUndefined();
  });
});
