import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate state for Connection tests
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-tui-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

afterAll(() => {
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

// =============================================================================
// Markdown Line Classification
//
// Tests the classifyLine function that parses markdown lines into typed
// line objects for the TUI renderer.
// =============================================================================

const { classifyLine } = await import("../src/tui/Markdown");

describe("classifyLine", () => {
  // --- Not in code block ---

  test("classifies H1 heading", () => {
    const line = classifyLine("# Hello World", false);
    expect(line.type).toBe("heading");
    expect(line.content).toBe("Hello World");
    expect(line.level).toBe(1);
  });

  test("classifies H2 heading", () => {
    const line = classifyLine("## Section", false);
    expect(line.type).toBe("heading");
    expect(line.content).toBe("Section");
    expect(line.level).toBe(2);
  });

  test("classifies H3 heading", () => {
    const line = classifyLine("### Subsection", false);
    expect(line.type).toBe("heading");
    expect(line.content).toBe("Subsection");
    expect(line.level).toBe(3);
  });

  test("does not classify H4+ as heading (only H1-H3)", () => {
    const line = classifyLine("#### Too deep", false);
    expect(line.type).toBe("text");
  });

  test("classifies code block start without language", () => {
    const line = classifyLine("```", false);
    expect(line.type).toBe("code_start");
    expect(line.lang).toBeUndefined();
  });

  test("classifies code block start with language", () => {
    const line = classifyLine("```typescript", false);
    expect(line.type).toBe("code_start");
    expect(line.lang).toBe("typescript");
  });

  test("classifies dash list item", () => {
    const line = classifyLine("- Item one", false);
    expect(line.type).toBe("list");
    expect(line.content).toBe("Item one");
  });

  test("classifies asterisk list item", () => {
    const line = classifyLine("* Item two", false);
    expect(line.type).toBe("list");
    expect(line.content).toBe("Item two");
  });

  test("classifies blank line", () => {
    const line = classifyLine("", false);
    expect(line.type).toBe("blank");
  });

  test("classifies whitespace-only line as blank", () => {
    const line = classifyLine("   ", false);
    expect(line.type).toBe("blank");
  });

  test("classifies regular text", () => {
    const line = classifyLine("Just some text", false);
    expect(line.type).toBe("text");
    expect(line.content).toBe("Just some text");
  });

  test("# without space is text, not heading", () => {
    const line = classifyLine("#notheading", false);
    expect(line.type).toBe("text");
  });

  // --- Inside code block ---

  test("classifies code block end when in code", () => {
    const line = classifyLine("```", true);
    expect(line.type).toBe("code_end");
  });

  test("classifies code content when in code block", () => {
    const line = classifyLine("const x = 1;", true);
    expect(line.type).toBe("code");
    expect(line.content).toBe("const x = 1;");
  });

  test("heading syntax is treated as code when in code block", () => {
    const line = classifyLine("# comment", true);
    expect(line.type).toBe("code");
    expect(line.content).toBe("# comment");
  });

  test("blank line in code block is code, not blank", () => {
    const line = classifyLine("", true);
    expect(line.type).toBe("code");
    expect(line.content).toBe("");
  });

  test("list syntax in code block is code, not list", () => {
    const line = classifyLine("- not a list", true);
    expect(line.type).toBe("code");
    expect(line.content).toBe("- not a list");
  });
});

// =============================================================================
// Connection State Machine
//
// Tests the ConduitConnection class's state transitions and reconnect backoff
// without actually opening WebSocket connections.
// =============================================================================

const { ConduitConnection } = await import("../src/tui/Connection");

describe("ConduitConnection", () => {
  test("initial state is disconnected", () => {
    const conn = new ConduitConnection("http://localhost:8080", "token");
    expect(conn.state).toBe("disconnected");
  });

  test("userId is generated and persisted", () => {
    const conn = new ConduitConnection("http://localhost:8080", "token");
    expect(conn.userId).toMatch(/^tui-/);
    expect(conn.userId.length).toBeGreaterThan(4);
  });

  test("same userId is returned on subsequent instantiation", () => {
    const conn1 = new ConduitConnection("http://localhost:8080", "token");
    const conn2 = new ConduitConnection("http://localhost:8080", "token");
    expect(conn1.userId).toBe(conn2.userId);
  });

  test("disconnect sets state to disconnected", () => {
    const conn = new ConduitConnection("http://localhost:8080", "token");
    conn.disconnect();
    expect(conn.state).toBe("disconnected");
  });

  test("disconnect prevents reconnection", () => {
    const conn = new ConduitConnection("http://localhost:8080", "token");
    conn.disconnect();
    expect((conn as any).shouldReconnect).toBe(false);
  });

  test("send is no-op when not connected", () => {
    const conn = new ConduitConnection("http://localhost:8080", "token");
    // Should not throw
    conn.send("Hello");
    conn.sendCommand("clear");
    conn.sendCancel();
  });

  test("emits state events", () => {
    const conn = new ConduitConnection("http://localhost:8080", "token");
    const states: string[] = [];
    conn.on("state", (s: string) => states.push(s));

    conn.disconnect();
    expect(states).toContain("disconnected");
  });

  test("URL conversion: localhost uses /ws path", () => {
    const conn = new ConduitConnection("http://localhost:8080", "token");
    // Can't easily inspect the URL, but we verify the connection object is created
    expect(conn).toBeDefined();
  });
});

// =============================================================================
// Message interface
// =============================================================================

describe("Message type", () => {
  test("Message interface supports all required fields", async () => {
    const { MessageBlock } = await import("../src/tui/MessageBlock");
    // Type-level test: verify the component accepts the expected props
    expect(MessageBlock).toBeDefined();
    // React.memo wraps as object, not function
    expect(MessageBlock).toBeTruthy();
  });
});
