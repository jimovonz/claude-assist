import { test, expect, describe } from "bun:test";
import { stripMetadata, extractTitle, summarize } from "../src/conduit/router";

// =============================================================================
// stripMetadata — Edge Cases
// =============================================================================

describe("stripMetadata edge cases", () => {
  test("strips memory blocks with varying whitespace", () => {
    const input = "Hello\n\n  <memory>\n  - type: fact\n  - topic: test\n  </memory>  \n\nWorld";
    const result = stripMetadata(input);
    expect(result).not.toContain("<memory>");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  test("strips multiple memory blocks", () => {
    const input = "<memory>\n- first\n</memory>\nMiddle\n<memory>\n- second\n</memory>";
    const result = stripMetadata(input);
    expect(result).not.toContain("<memory>");
    expect(result).toBe("Middle");
  });

  test("strips cairn_context with attributes", () => {
    const input = 'Text before <cairn_context query="test" weight="high">entries here</cairn_context> text after';
    const result = stripMetadata(input);
    expect(result).not.toContain("cairn_context");
    expect(result).toContain("Text before");
    expect(result).toContain("text after");
  });

  test("strips nested system-reminder tags", () => {
    const input = "Hello\n<system-reminder>\nSome system info\n<inner>nested</inner>\n</system-reminder>\nWorld";
    const result = stripMetadata(input);
    expect(result).not.toContain("system-reminder");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  test("strips Sources block with multiple URLs", () => {
    const input = "Answer\n\nSources:\n- [Doc 1](https://a.com)\n- [Doc 2](https://b.com)\n";
    const result = stripMetadata(input);
    expect(result).not.toContain("Sources:");
    expect(result).toBe("Answer");
  });

  test("preserves legitimate angle brackets in code", () => {
    const input = "Use `Array<string>` for typed arrays";
    const result = stripMetadata(input);
    expect(result).toContain("Array<string>");
  });

  test("handles response that is entirely metadata", () => {
    const input = "<memory>\n- type: fact\n- content: stuff\n</memory>";
    const result = stripMetadata(input);
    expect(result).toBe("");
  });

  test("handles empty string", () => {
    expect(stripMetadata("")).toBe("");
  });

  test("handles string with only whitespace", () => {
    expect(stripMetadata("   \n\n   ")).toBe("");
  });
});

// =============================================================================
// extractTitle
// =============================================================================

describe("extractTitle", () => {
  test("extracts H1 heading", () => {
    expect(extractTitle("# My Title\n\nBody text")).toBe("My Title");
  });

  test("extracts H2 heading", () => {
    expect(extractTitle("## Subtitle\n\nBody")).toBe("Subtitle");
  });

  test("extracts H3 heading", () => {
    expect(extractTitle("### Small Header")).toBe("Small Header");
  });

  test("prefers heading over bold text", () => {
    expect(extractTitle("# Heading\n\n**Bold text**")).toBe("Heading");
  });

  test("falls back to bold text when no heading", () => {
    expect(extractTitle("Some text **Important** more text")).toBe("Important");
  });

  test("falls back to first line when no heading or bold", () => {
    expect(extractTitle("Just a simple response")).toBe("Just a simple response");
  });

  test("returns default for empty string", () => {
    expect(extractTitle("")).toBe("Claude Response");
  });

  test("truncates long titles to 80 chars", () => {
    const longTitle = "# " + "A".repeat(100);
    const result = extractTitle(longTitle);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  test("handles multiline content with heading not on first line", () => {
    const content = "Some preamble\n\n# Actual Title\n\nBody";
    expect(extractTitle(content)).toBe("Actual Title");
  });
});

// =============================================================================
// summarize — Edge Cases
// =============================================================================

describe("summarize edge cases", () => {
  test("returns full text when under maxLen", () => {
    expect(summarize("Short text")).toBe("Short text");
  });

  test("truncates with ellipsis at maxLen", () => {
    const long = "A".repeat(300);
    const result = summarize(long);
    expect(result.length).toBe(203); // 200 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  test("uses first paragraph only", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    expect(summarize(text)).toBe("First paragraph.");
  });

  test("handles single paragraph with no double newline", () => {
    expect(summarize("No paragraph break here")).toBe("No paragraph break here");
  });

  test("handles empty string", () => {
    expect(summarize("")).toBe("");
  });

  test("respects custom maxLen", () => {
    const result = summarize("A".repeat(100), 50);
    expect(result.length).toBe(53); // 50 + "..."
  });

  test("single character under maxLen returns as-is", () => {
    expect(summarize("X")).toBe("X");
  });
});
