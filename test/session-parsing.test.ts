import { test, expect, describe } from "bun:test";
import {
  parseStreamMessage,
  describeToolCall,
  shortenPath,
  type SessionEvent,
} from "../src/conduit/session";

// =============================================================================
// Stream-JSON Message Parsing — Unit Tests
//
// Tests the core parsing logic without any subprocess dependency.
// Each test feeds a raw message object and verifies the produced events.
// =============================================================================

describe("parseStreamMessage", () => {
  // --- Assistant text messages ---

  test("extracts text event from assistant message", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    };
    const { events, lastAssistantText } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "text", text: "Hello world" });
    expect(lastAssistantText).toBe("Hello world");
  });

  test("extracts multiple text blocks from single assistant message", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      },
    };
    const { events, lastAssistantText } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text", text: "First" });
    expect(events[1]).toEqual({ type: "text", text: "Second" });
    expect(lastAssistantText).toBe("Second"); // last one wins
  });

  test("ignores text blocks with empty text", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(0);
  });

  test("ignores text blocks with missing text field", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text" }] },
    };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(0);
  });

  // --- Tool use messages ---

  test("extracts status event from tool_use", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/home/user/project/main.ts" },
        }],
      },
    };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("status");
    expect((events[0] as any).text).toContain("Reading");
    expect((events[0] as any).text).toContain("main.ts");
  });

  test("handles tool_use without name", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", input: {} }] },
    };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(1);
    expect((events[0] as any).text).toContain("unknown");
  });

  test("handles mixed content: tool_use followed by text", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: {} },
          { type: "text", text: "Done running" },
        ],
      },
    };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("status");
    expect(events[1]).toEqual({ type: "text", text: "Done running" });
  });

  // --- Result messages ---

  test("extracts result event with text and sessionId", () => {
    const msg = {
      type: "result",
      result: "Final answer",
      session_id: "sess-abc",
    };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("result");
    expect((events[0] as any).text).toBe("Final answer");
    expect((events[0] as any).sessionId).toBe("sess-abc");
  });

  test("result falls back to lastAssistantText when result is empty", () => {
    const msg = { type: "result", result: "", session_id: "sess-1" };
    const { events } = parseStreamMessage(msg, "Previous text");
    expect((events[0] as any).text).toBe("Previous text");
  });

  test("result falls back to lastAssistantText when result is missing", () => {
    const msg = { type: "result", session_id: "sess-1" };
    const { events } = parseStreamMessage(msg, "Fallback text");
    expect((events[0] as any).text).toBe("Fallback text");
  });

  test("result is empty string when both result and lastAssistantText are empty", () => {
    const msg = { type: "result", result: "", session_id: "sess-1" };
    const { events } = parseStreamMessage(msg, "");
    expect((events[0] as any).text).toBe("");
  });

  test("result extracts usage info when present", () => {
    const msg = {
      type: "result",
      result: "Answer",
      session_id: "sess-1",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
      total_cost_usd: 0.05,
    };
    const { events } = parseStreamMessage(msg, "");
    const result = events[0] as any;
    expect(result.usage).toBeDefined();
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(500);
    expect(result.usage.cacheReadTokens).toBe(200);
    expect(result.usage.cacheCreationTokens).toBe(100);
    expect(result.usage.totalCostUsd).toBe(0.05);
  });

  test("result has no usage when usage field is missing", () => {
    const msg = { type: "result", result: "Answer", session_id: "sess-1" };
    const { events } = parseStreamMessage(msg, "");
    expect((events[0] as any).usage).toBeUndefined();
  });

  test("result handles missing session_id", () => {
    const msg = { type: "result", result: "Answer" };
    const { events } = parseStreamMessage(msg, "");
    expect((events[0] as any).sessionId).toBe("");
  });

  // --- Edge cases ---

  test("unknown message type produces no events", () => {
    const msg = { type: "system", info: "something" };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(0);
  });

  test("assistant message with no content array produces no events", () => {
    const msg = { type: "assistant", message: {} };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(0);
  });

  test("assistant message with null content produces no events", () => {
    const msg = { type: "assistant", message: { content: null } };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(0);
  });

  test("assistant message with non-array content produces no events", () => {
    const msg = { type: "assistant", message: { content: "string" } };
    const { events } = parseStreamMessage(msg, "");
    expect(events).toHaveLength(0);
  });

  test("preserves lastAssistantText across calls", () => {
    const msg1 = {
      type: "assistant",
      message: { content: [{ type: "text", text: "First chunk" }] },
    };
    const r1 = parseStreamMessage(msg1, "");
    expect(r1.lastAssistantText).toBe("First chunk");

    const msg2 = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Second chunk" }] },
    };
    const r2 = parseStreamMessage(msg2, r1.lastAssistantText);
    expect(r2.lastAssistantText).toBe("Second chunk");

    // Result should use the latest
    const msg3 = { type: "result", result: "", session_id: "s" };
    const r3 = parseStreamMessage(msg3, r2.lastAssistantText);
    expect((r3.events[0] as any).text).toBe("Second chunk");
  });
});

// =============================================================================
// Tool Call Descriptions
// =============================================================================

describe("describeToolCall", () => {
  test("Read shows file path", () => {
    const desc = describeToolCall("Read", { file_path: "/home/user/src/main.ts" });
    expect(desc).toContain("📖");
    expect(desc).toContain("Reading");
    expect(desc).toContain("main.ts");
  });

  test("Glob shows pattern", () => {
    const desc = describeToolCall("Glob", { pattern: "**/*.ts" });
    expect(desc).toContain("🔍");
    expect(desc).toContain("**/*.ts");
  });

  test("Grep shows pattern", () => {
    const desc = describeToolCall("Grep", { pattern: "TODO" });
    expect(desc).toContain("🔍");
    expect(desc).toContain("TODO");
  });

  test("Bash shows generic message", () => {
    const desc = describeToolCall("Bash", { command: "ls -la" });
    expect(desc).toContain("⚡");
    expect(desc).toContain("Running command");
  });

  test("Edit shows file path", () => {
    const desc = describeToolCall("Edit", { file_path: "/src/foo.ts" });
    expect(desc).toContain("✏️");
    expect(desc).toContain("Editing");
  });

  test("Write shows file path", () => {
    const desc = describeToolCall("Write", { file_path: "/src/new.ts" });
    expect(desc).toContain("📝");
    expect(desc).toContain("Writing");
  });

  test("Agent shows description", () => {
    const desc = describeToolCall("Agent", { description: "Search codebase for pattern" });
    expect(desc).toContain("🤖");
    expect(desc).toContain("Search codebase");
  });

  test("Agent truncates long descriptions", () => {
    const longDesc = "A".repeat(100);
    const desc = describeToolCall("Agent", { description: longDesc });
    expect(desc.length).toBeLessThan(100);
  });

  test("WebSearch shows query", () => {
    const desc = describeToolCall("WebSearch", { query: "bun testing" });
    expect(desc).toContain("🌐");
    expect(desc).toContain("bun testing");
  });

  test("WebFetch shows generic message", () => {
    const desc = describeToolCall("WebFetch", { url: "https://example.com" });
    expect(desc).toContain("🌐");
    expect(desc).toContain("Fetching");
  });

  test("ToolSearch shows loading message", () => {
    const desc = describeToolCall("ToolSearch", {});
    expect(desc).toContain("🔧");
    expect(desc).toContain("Loading tools");
  });

  test("unknown tool shows tool name", () => {
    const desc = describeToolCall("CustomTool", {});
    expect(desc).toContain("⚙️");
    expect(desc).toContain("CustomTool");
  });

  test("Read with no file_path shows 'file'", () => {
    const desc = describeToolCall("Read", {});
    expect(desc).toContain("file");
  });
});

// =============================================================================
// Path Shortening
// =============================================================================

describe("shortenPath", () => {
  test("shortens deep paths to last 2 segments", () => {
    expect(shortenPath("/home/user/project/src/main.ts")).toBe(".../src/main.ts");
  });

  test("keeps short paths as-is", () => {
    expect(shortenPath("src/main.ts")).toBe("src/main.ts");
  });

  test("returns 'file' for undefined", () => {
    expect(shortenPath(undefined)).toBe("file");
  });

  test("returns 'file' for empty string (falsy)", () => {
    // empty string is falsy, so it hits the !path check
    expect(shortenPath("")).toBe("file");
  });

  test("handles single segment path", () => {
    expect(shortenPath("file.ts")).toBe("file.ts");
  });

  test("handles exactly 2 segments", () => {
    expect(shortenPath("dir/file.ts")).toBe("dir/file.ts");
  });

  test("handles exactly 3 segments (triggers shortening)", () => {
    expect(shortenPath("a/b/c.ts")).toBe(".../b/c.ts");
  });
});
