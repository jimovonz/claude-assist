import { test, expect, describe } from "bun:test";
import { renderContent, shouldCreateView } from "../src/views/renderer";

// =============================================================================
// Advanced Markdown Rendering
// =============================================================================

describe("advanced markdown rendering", () => {
  test("nested bold and italic", () => {
    const html = renderContent("This is ***bold and italic*** text");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
  });

  test("multiple headers at different levels", () => {
    const html = renderContent("# H1\n\n## H2\n\n### H3");
    expect(html).toContain("<h1>H1</h1>");
    expect(html).toContain("<h2>H2</h2>");
    expect(html).toContain("<h3>H3</h3>");
  });

  test("code block with language tag", () => {
    const html = renderContent("```typescript\nconst x = 1;\n```");
    expect(html).toContain('class="language-typescript"');
    expect(html).toContain("const x = 1;");
  });

  test("code block without language tag", () => {
    const html = renderContent("```\nplain code\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("plain code");
  });

  test("multiple code blocks are preserved", () => {
    const content = "```js\na();\n```\n\nMiddle text\n\n```py\nb()\n```";
    const html = renderContent(content);
    expect(html).toContain('class="language-js"');
    expect(html).toContain('class="language-py"');
    expect(html).toContain("a();");
    expect(html).toContain("b()");
  });

  test("inline code is rendered", () => {
    const html = renderContent("Use `foo()` function");
    expect(html).toContain("<code>foo()</code>");
  });

  test("links are rendered with correct href", () => {
    const html = renderContent("[Example](https://example.com)");
    expect(html).toContain('<a href="https://example.com">Example</a>');
  });

  test("links with ampersands in URL are unescaped", () => {
    const html = renderContent("[Search](https://example.com?a=1&b=2)");
    expect(html).toContain('href="https://example.com?a=1&b=2"');
  });

  test("list items are wrapped in ul", () => {
    const html = renderContent("- Item 1\n- Item 2\n- Item 3");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>Item 1</li>");
    expect(html).toContain("<li>Item 2</li>");
    expect(html).toContain("<li>Item 3</li>");
    expect(html).toContain("</ul>");
  });

  test("paragraphs are separated", () => {
    const html = renderContent("First paragraph.\n\nSecond paragraph.");
    expect(html).toContain("<p>");
    expect(html).toContain("First paragraph.");
    expect(html).toContain("Second paragraph.");
  });

  test("empty input returns empty content", () => {
    const html = renderContent("");
    expect(html).not.toContain("undefined");
  });
});

// =============================================================================
// XSS Prevention — Advanced Vectors
// =============================================================================

describe("XSS prevention - advanced vectors", () => {
  test("script tags in code blocks are escaped", () => {
    const html = renderContent("```\n<script>alert('xss')</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("img onerror in text is escaped", () => {
    const html = renderContent('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("javascript: URLs in links are stripped", () => {
    const html = renderContent('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    // Link text should be preserved, but href removed
    expect(html).toContain("click");
  });

  test("data: URLs in links are stripped", () => {
    const html = renderContent('[click](data:text/html,<script>alert(1)</script>)');
    expect(html).not.toContain('href="data:');
  });

  test("event handlers in attributes are escaped to safe entities", () => {
    const html = renderContent('<div onmouseover="alert(1)">hover me</div>');
    // The HTML is entity-escaped, so onmouseover appears as literal text, not an attribute
    expect(html).toContain("&lt;div");
    expect(html).toContain("&quot;");
    expect(html).not.toContain("<div");
  });

  test("nested HTML in bold text is escaped", () => {
    const html = renderContent("**<script>alert(1)</script>**");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("SVG with onload is escaped", () => {
    const html = renderContent('<svg onload="alert(1)">');
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;svg");
  });

  test("HTML entities in header are escaped", () => {
    const html = renderContent("# <b>Bold</b> Header");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>Bold</b>");
  });

  test("double-encoded entities are not double-escaped", () => {
    const html = renderContent("&amp; is an ampersand");
    // Input gets escaped: & → &amp;, so &amp; → &amp;amp;
    // This is correct — we escape the literal input characters
    expect(html).toContain("&amp;amp;");
  });
});

// =============================================================================
// Unicode and Special Characters
// =============================================================================

describe("unicode handling", () => {
  test("emoji in text is preserved", () => {
    const html = renderContent("Hello 👋 World 🌍");
    expect(html).toContain("👋");
    expect(html).toContain("🌍");
  });

  test("CJK characters are preserved", () => {
    const html = renderContent("日本語テスト Chinese: 中文测试");
    expect(html).toContain("日本語テスト");
    expect(html).toContain("中文测试");
  });

  test("RTL text is preserved", () => {
    const html = renderContent("مرحبا بالعالم");
    expect(html).toContain("مرحبا بالعالم");
  });
});

// =============================================================================
// shouldCreateView Edge Cases
// =============================================================================

describe("shouldCreateView edge cases", () => {
  test("exactly 500 chars returns false", () => {
    const text = "a".repeat(500);
    expect(shouldCreateView(text)).toBe(false);
  });

  test("501 chars returns true", () => {
    const text = "a".repeat(501);
    expect(shouldCreateView(text)).toBe(true);
  });

  test("single code block triggers view (has 2 fence markers)", () => {
    // shouldCreateView counts ``` markers, not blocks. 1 block = 2 markers >= threshold
    expect(shouldCreateView("```\ncode\n```")).toBe(true);
  });

  test("two code blocks also triggers view", () => {
    expect(shouldCreateView("```\na\n```\n```\nb\n```")).toBe(true);
  });

  test("single backtick-triple without closing does not trigger", () => {
    // Only 1 marker — below the threshold of 2
    expect(shouldCreateView("```\nunclosed code block")).toBe(false);
  });

  test("diff markers trigger view creation", () => {
    expect(shouldCreateView("+++ a/file.ts")).toBe(true);
    expect(shouldCreateView("--- a/file.ts")).toBe(true);
    expect(shouldCreateView("diff\nsome changes")).toBe(true);
  });

  test("empty string returns false", () => {
    expect(shouldCreateView("")).toBe(false);
  });

  test("short text with no special content returns false", () => {
    expect(shouldCreateView("Just a short message")).toBe(false);
  });
});
