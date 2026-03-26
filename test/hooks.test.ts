import { test, expect, describe } from "bun:test";
import {
  parseStopHookOutput,
  parsePromptHookOutput,
  buildStopHookInput,
  buildPromptHookInput,
} from "../src/conduit/hooks";

// =============================================================================
// Cairn Hook Tests — Pure Function Testing
//
// Tests the parsing and input-building logic without spawning any subprocess.
// The run* functions are thin wrappers (spawn → parse), so testing the parse
// and build functions covers all the decision logic.
// =============================================================================

// =============================================================================
// Stop Hook Output Parsing
// =============================================================================

describe("parseStopHookOutput", () => {
  test("returns block:false for empty stdout", () => {
    expect(parseStopHookOutput("")).toEqual({ block: false });
  });

  test("returns block:false for whitespace-only stdout", () => {
    expect(parseStopHookOutput("   \n  \n  ")).toEqual({ block: false });
  });

  test("returns block:true when decision is 'block' with reason", () => {
    const stdout = JSON.stringify({ decision: "block", reason: "Missing memory block" });
    const result = parseStopHookOutput(stdout);
    expect(result.block).toBe(true);
    expect(result.reason).toBe("Missing memory block");
  });

  test("returns block:false when decision is 'block' without reason", () => {
    // Both decision:"block" AND reason are required
    const stdout = JSON.stringify({ decision: "block" });
    expect(parseStopHookOutput(stdout)).toEqual({ block: false });
  });

  test("returns block:false when decision is 'allow'", () => {
    const stdout = JSON.stringify({ decision: "allow" });
    expect(parseStopHookOutput(stdout)).toEqual({ block: false });
  });

  test("returns block:false when decision is missing", () => {
    const stdout = JSON.stringify({ reason: "some reason" });
    expect(parseStopHookOutput(stdout)).toEqual({ block: false });
  });

  test("returns block:false for non-JSON stdout", () => {
    expect(parseStopHookOutput("not json at all")).toEqual({ block: false });
  });

  test("returns block:false for malformed JSON", () => {
    expect(parseStopHookOutput('{"decision": "block", reason')).toEqual({ block: false });
  });

  test("handles stdout with leading/trailing whitespace", () => {
    const json = JSON.stringify({ decision: "block", reason: "test" });
    const stdout = `  \n  ${json}  \n  `;
    const result = parseStopHookOutput(stdout);
    expect(result.block).toBe(true);
    expect(result.reason).toBe("test");
  });

  test("preserves full reason string including long content", () => {
    const longReason = "CAIRN CONTEXT: " + "x".repeat(5000);
    const stdout = JSON.stringify({ decision: "block", reason: longReason });
    const result = parseStopHookOutput(stdout);
    expect(result.block).toBe(true);
    expect(result.reason).toBe(longReason);
    expect(result.reason!.length).toBe(longReason.length);
  });

  test("handles reason with special characters", () => {
    const reason = 'Missing: keywords\n\nUse <memory>\n- keywords: a, b\n</memory>';
    const stdout = JSON.stringify({ decision: "block", reason });
    const result = parseStopHookOutput(stdout);
    expect(result.block).toBe(true);
    expect(result.reason).toBe(reason);
  });

  test("handles extra fields in JSON gracefully", () => {
    const stdout = JSON.stringify({
      decision: "block",
      reason: "test",
      extraField: true,
      nested: { data: [1, 2, 3] },
    });
    const result = parseStopHookOutput(stdout);
    expect(result.block).toBe(true);
    expect(result.reason).toBe("test");
  });

  test("returns block:false for empty JSON object", () => {
    expect(parseStopHookOutput("{}")).toEqual({ block: false });
  });

  test("returns block:false for JSON array", () => {
    expect(parseStopHookOutput("[1,2,3]")).toEqual({ block: false });
  });

  test("returns block:false for JSON null", () => {
    expect(parseStopHookOutput("null")).toEqual({ block: false });
  });
});

// =============================================================================
// Prompt Hook Output Parsing
// =============================================================================

describe("parsePromptHookOutput", () => {
  test("returns empty string for empty stdout", () => {
    expect(parsePromptHookOutput("")).toBe("");
  });

  test("returns empty string for whitespace-only stdout", () => {
    expect(parsePromptHookOutput("  \n  ")).toBe("");
  });

  test("extracts additionalContext from hookSpecificOutput", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        additionalContext: "<cairn_context>relevant data</cairn_context>",
      },
    });
    expect(parsePromptHookOutput(stdout)).toBe("<cairn_context>relevant data</cairn_context>");
  });

  test("returns empty string when hookSpecificOutput has no additionalContext", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: {} });
    expect(parsePromptHookOutput(stdout)).toBe("");
  });

  test("returns empty string when hookSpecificOutput is missing", () => {
    const stdout = JSON.stringify({ someOtherField: true });
    expect(parsePromptHookOutput(stdout)).toBe("");
  });

  test("returns empty string when additionalContext is null", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { additionalContext: null },
    });
    expect(parsePromptHookOutput(stdout)).toBe("");
  });

  test("returns empty string for non-JSON stdout", () => {
    expect(parsePromptHookOutput("not json")).toBe("");
  });

  test("returns empty string for malformed JSON", () => {
    expect(parsePromptHookOutput('{"hookSpecificOutput":')).toBe("");
  });

  test("handles large context strings", () => {
    const largeContext = "<cairn_context>" + "a".repeat(10000) + "</cairn_context>";
    const stdout = JSON.stringify({
      hookSpecificOutput: { additionalContext: largeContext },
    });
    const result = parsePromptHookOutput(stdout);
    expect(result).toBe(largeContext);
    expect(result.length).toBe(largeContext.length);
  });

  test("handles context with XML-like content", () => {
    const context = '<cairn_context query="test">\n  <entry id="42">memory data</entry>\n</cairn_context>';
    const stdout = JSON.stringify({
      hookSpecificOutput: { additionalContext: context },
    });
    expect(parsePromptHookOutput(stdout)).toBe(context);
  });

  test("handles stdout with leading/trailing whitespace", () => {
    const json = JSON.stringify({
      hookSpecificOutput: { additionalContext: "context" },
    });
    expect(parsePromptHookOutput(`  ${json}  `)).toBe("context");
  });

  test("returns empty string for empty JSON object", () => {
    expect(parsePromptHookOutput("{}")).toBe("");
  });

  test("returns empty string for JSON null", () => {
    expect(parsePromptHookOutput("null")).toBe("");
  });
});

// =============================================================================
// Stop Hook Input Building
// =============================================================================

describe("buildStopHookInput", () => {
  test("produces valid JSON with all required fields", () => {
    const input = JSON.parse(buildStopHookInput("sess-1", "Hello world", "/home/user", false));
    expect(input.session_id).toBe("sess-1");
    expect(input.last_assistant_message).toBe("Hello world");
    expect(input.cwd).toBe("/home/user");
    expect(input.stop_hook_active).toBe(false);
    expect(input.transcript_path).toBe("");
  });

  test("sets stop_hook_active to true for continuations", () => {
    const input = JSON.parse(buildStopHookInput("sess", "msg", "/tmp", true));
    expect(input.stop_hook_active).toBe(true);
  });

  test("preserves special characters in assistant message", () => {
    const message = 'Line 1\nLine 2\n<memory>\n- type: "fact"\n</memory>';
    const input = JSON.parse(buildStopHookInput("sess", message, "/tmp", false));
    expect(input.last_assistant_message).toBe(message);
  });

  test("handles empty strings", () => {
    const input = JSON.parse(buildStopHookInput("", "", "", false));
    expect(input.session_id).toBe("");
    expect(input.last_assistant_message).toBe("");
    expect(input.cwd).toBe("");
  });

  test("handles unicode content", () => {
    const message = "日本語テスト 🎉 مرحبا";
    const input = JSON.parse(buildStopHookInput("sess", message, "/tmp", false));
    expect(input.last_assistant_message).toBe(message);
  });
});

// =============================================================================
// Prompt Hook Input Building
// =============================================================================

describe("buildPromptHookInput", () => {
  test("produces valid JSON with all required fields", () => {
    const input = JSON.parse(buildPromptHookInput("sess-1", "How do I test?"));
    expect(input.session_id).toBe("sess-1");
    expect(input.user_message).toBe("How do I test?");
  });

  test("handles empty strings", () => {
    const input = JSON.parse(buildPromptHookInput("", ""));
    expect(input.session_id).toBe("");
    expect(input.user_message).toBe("");
  });

  test("preserves special characters", () => {
    const message = "What does `foo()` do?\n\nAlso check <memory> blocks.";
    const input = JSON.parse(buildPromptHookInput("sess", message));
    expect(input.user_message).toBe(message);
  });
});
