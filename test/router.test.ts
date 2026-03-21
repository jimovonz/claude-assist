import { test, expect, describe } from "bun:test";
import { stripMetadata, summarize } from "../src/conduit/router";

// =============================================================================
// stripMetadata
//
// Claude responses contain metadata blocks that must be removed before
// delivering to the user. The stripping must handle all real-world formats
// Claude produces, including edge cases.
// =============================================================================

describe("stripMetadata", () => {
  test("removes multi-line memory block", () => {
    const input = `Here is the answer.

<memory>
- type: fact
- topic: testing
- content: some memory
- complete: true
</memory>`;

    expect(stripMetadata(input)).toBe("Here is the answer.");
  });

  test("removes single-line memory block", () => {
    // Claude's memory instructions explicitly allow: <memory>complete: true</memory>
    const input = "Done.\n\n<memory>complete: true</memory>";
    expect(stripMetadata(input)).toBe("Done.");
  });

  test("removes memory block with no surrounding whitespace", () => {
    const input = "Answer here.\n<memory>\n- complete: true\n</memory>";
    const result = stripMetadata(input);
    expect(result).not.toContain("<memory>");
    expect(result).toContain("Answer here.");
  });

  test("removes cairn_context tags", () => {
    const input = `<cairn_context query="test" current_project="foo">
  <scope level="project" name="foo" weight="high">
    <entry id="1" reliability="strong" days="0">some context</entry>
  </scope>
</cairn_context>

Here is my response.`;

    const result = stripMetadata(input);
    expect(result).not.toContain("cairn_context");
    expect(result).not.toContain("some context");
    expect(result).toContain("Here is my response.");
  });

  test("removes system-reminder tags", () => {
    const input = `<system-reminder>
You have tools available.
</system-reminder>

The answer is 42.`;

    const result = stripMetadata(input);
    expect(result).not.toContain("system-reminder");
    expect(result).toContain("The answer is 42.");
  });

  test("removes Sources block", () => {
    const input = `Here is the info.

Sources:
- [Doc A](https://example.com/a)
- [Doc B](https://example.com/b)`;

    const result = stripMetadata(input);
    expect(result).not.toContain("Sources:");
    expect(result).not.toContain("example.com");
    expect(result).toContain("Here is the info.");
  });

  test("preserves normal content with no metadata", () => {
    const input = "This is a clean response with **formatting** and `code`.";
    expect(stripMetadata(input)).toBe(input);
  });

  test("handles response with multiple metadata types", () => {
    const input = `<cairn_context query="q" current_project="p">
  <scope level="global" weight="low"><entry id="1" reliability="strong" days="0">ctx</entry></scope>
</cairn_context>

The answer is here.

<memory>
- type: fact
- complete: true
</memory>`;

    const result = stripMetadata(input);
    expect(result).toBe("The answer is here.");
  });

  test("handles empty input", () => {
    expect(stripMetadata("")).toBe("");
  });

  test("handles input that is only metadata", () => {
    const input = `<memory>
- type: fact
- complete: true
</memory>`;

    expect(stripMetadata(input)).toBe("");
  });
});

// =============================================================================
// summarize
//
// Produces a short summary from the first paragraph of a response,
// truncated to a maximum length.
// =============================================================================

describe("summarize", () => {
  test("returns full first paragraph when short", () => {
    const text = "All tests pass.\n\nHere are the details...";
    expect(summarize(text)).toBe("All tests pass.");
  });

  test("truncates first paragraph at maxLen with ellipsis", () => {
    const longPara = "A".repeat(300) + "\n\nSecond paragraph.";
    const result = summarize(longPara);
    expect(result.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result).toEndWith("...");
  });

  test("respects custom maxLen", () => {
    const text = "This is a moderately long first paragraph that exceeds fifty characters easily.";
    const result = summarize(text, 50);
    expect(result.length).toBeLessThanOrEqual(53); // 50 + "..."
  });

  test("handles single paragraph (no double newline)", () => {
    const text = "Just one paragraph with no break.";
    expect(summarize(text)).toBe(text);
  });

  test("handles empty string", () => {
    const result = summarize("");
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });
});
