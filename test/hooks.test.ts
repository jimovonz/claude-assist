import { test, expect, describe } from "bun:test";
import { runStopHook, runPromptHook } from "../src/conduit/hooks";

// =============================================================================
// Cairn Hook Integration
//
// These tests run against the REAL Cairn hooks installed on this machine.
// This validates the actual integration, not a mock.
//
// The hooks module resolves CAIRN_DIR at import time as a module-level
// constant, making it non-injectable for testing. This is itself a
// structural issue: the module cannot be tested in isolation without
// refactoring to accept the hook paths as parameters.
// =============================================================================

describe("stop hook", () => {
  test("blocks when response declares context:insufficient", async () => {
    const result = await runStopHook(
      "test-session-" + Date.now(),
      "Response.\n\n<memory>\n- type: fact\n- topic: test\n- content: test\n- complete: true\n- context: insufficient\n- context_need: test query\n</memory>",
      "/tmp"
    );

    expect(result.block).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  test("does not block when response has context:sufficient", async () => {
    const result = await runStopHook(
      "test-session-" + Date.now(),
      "All good.\n\n<memory>\n- type: fact\n- topic: test\n- content: test\n- complete: true\n- context: sufficient\n</memory>",
      "/tmp"
    );

    expect(result.block).toBe(false);
  });

  test("blocks when response is missing required memory block", async () => {
    // The real Cairn stop hook enforces that every response has a <memory> block.
    // A response without one should trigger a block with a reason explaining why.
    const result = await runStopHook(
      "test-session-" + Date.now(),
      "Here is a response with no memory block at all.",
      "/tmp"
    );

    expect(result.block).toBe(true);
    expect(result.reason).toContain("memory");
  });

  test("gracefully handles empty input without throwing", async () => {
    // Even with degenerate input, the hook must return a valid result
    // (not throw an exception that would crash the router)
    const result = await runStopHook("", "", "");
    expect(result).toHaveProperty("block");
    // block can be true or false — we just verify the contract holds
    // and the function didn't throw
  });
});

describe("prompt hook", () => {
  test("returns context string on first prompt (proactive retrieval)", async () => {
    // Cairn's prompt hook does proactive first-prompt retrieval —
    // any new session's first message triggers a broad semantic search.
    // The result may be empty if the DB has no relevant entries,
    // or may contain cairn_context XML.
    const context = await runPromptHook(
      "test-session-" + Date.now(),
      "Tell me about testing strategies"
    );
    // The hook either returns context (string with content) or empty string.
    // Both are valid — we verify the contract, not the content.
    if (context.length > 0) {
      expect(context).toContain("cairn_context");
    }
  });

  test("gracefully handles empty input without throwing", async () => {
    // Must return a string — not throw an exception
    const context = await runPromptHook("", "");
    // Empty session/message may still trigger retrieval or return empty
    if (context.length > 0) {
      expect(context).toContain("cairn_context");
    }
  });
});
