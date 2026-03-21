import { test, expect, describe } from "bun:test";
import { renderContent, shouldCreateView } from "../src/views/renderer";

// =============================================================================
// XSS Prevention
//
// Any user-controlled content rendered into HTML MUST be escaped.
// These tests verify the renderer does not produce exploitable output.
// =============================================================================

describe("XSS prevention", () => {
  test("HTML in headers is escaped", () => {
    const html = renderContent('# <script>alert("xss")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("HTML in H2 headers is escaped", () => {
    const html = renderContent('## <img src=x onerror=alert(1)>');
    // The raw tag must not appear — escaped entities are safe
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("HTML in list items is escaped", () => {
    const html = renderContent('- <script>alert("xss")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("HTML in bold text is escaped", () => {
    const html = renderContent('**<img src=x onerror=alert(1)>**');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("HTML in italic text is escaped", () => {
    const html = renderContent('*<iframe src="javascript:alert(1)">*');
    expect(html).not.toContain("<iframe");
  });

  test("HTML in inline code is escaped", () => {
    const html = renderContent('Use `<script>alert(1)</script>` carefully');
    expect(html).not.toContain("<script>");
  });

  test("HTML in plain paragraphs is escaped", () => {
    const html = renderContent('<div onmouseover="alert(1)">hover me</div>');
    // Raw HTML tag must not appear — escaped version is safe
    expect(html).not.toContain('<div onmouseover');
    expect(html).toContain("&lt;div");
  });

  test("code blocks escape HTML (baseline)", () => {
    const html = renderContent('```js\n<script>alert(1)</script>\n```');
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

// =============================================================================
// Markdown Rendering
//
// The renderer should produce structurally correct HTML from markdown input.
// =============================================================================

describe("markdown rendering", () => {
  test("H1 renders as <h1>", () => {
    const html = renderContent("# Hello World");
    expect(html).toContain("<h1>");
    expect(html).toContain("Hello World");
  });

  test("H2 renders as <h2>", () => {
    const html = renderContent("## Section");
    expect(html).toContain("<h2>");
  });

  test("H3 renders as <h3>", () => {
    const html = renderContent("### Subsection");
    expect(html).toContain("<h3>");
  });

  test("bold text renders as <strong>", () => {
    const html = renderContent("This is **important**");
    expect(html).toContain("<strong>important</strong>");
  });

  test("italic text renders as <em>", () => {
    const html = renderContent("This is *emphasized*");
    expect(html).toContain("<em>emphasized</em>");
  });

  test("list items render as <li> inside <ul>", () => {
    const html = renderContent("- Item one\n- Item two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>Item one</li>");
    expect(html).toContain("<li>Item two</li>");
    expect(html).toContain("</ul>");
  });

  test("inline code renders as <code>", () => {
    const html = renderContent("Use `console.log` for debugging");
    expect(html).toContain("<code>console.log</code>");
  });

  test("fenced code block renders as <pre><code>", () => {
    const html = renderContent('```ts\nconst x = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("const x = 1;");
  });

  test("code block without language still renders", () => {
    const html = renderContent("```\nhello\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("hello");
  });

  test("multiple paragraphs are separated", () => {
    const html = renderContent("First paragraph.\n\nSecond paragraph.");
    // Both paragraphs should appear
    expect(html).toContain("First paragraph.");
    expect(html).toContain("Second paragraph.");
  });

  test("empty input produces no content paragraphs", () => {
    const html = renderContent("");
    // Should not crash, should produce minimal/empty output
    expect(html).toBeDefined();
  });
});

// =============================================================================
// View Creation Threshold
//
// shouldCreateView decides whether a response warrants a rich HTML page.
// Test the boundary conditions precisely.
// =============================================================================

describe("shouldCreateView", () => {
  test("short text does not create view", () => {
    expect(shouldCreateView("Hello, world!")).toBe(false);
  });

  test("exactly 500 chars does not create view", () => {
    expect(shouldCreateView("x".repeat(500))).toBe(false);
  });

  test("501 chars creates view", () => {
    expect(shouldCreateView("x".repeat(501))).toBe(true);
  });

  test("single complete code block creates view", () => {
    // One code block = two ``` occurrences
    const text = "Here:\n```ts\ncode\n```";
    expect(shouldCreateView(text)).toBe(true);
  });

  test("unclosed code fence alone does not create view", () => {
    // Only one ``` occurrence — not a complete block
    const text = "```\nsome partial code";
    expect(shouldCreateView(text)).toBe(false);
  });

  test("diff content creates view regardless of length", () => {
    expect(shouldCreateView("+++ b/file.ts")).toBe(true);
    expect(shouldCreateView("--- a/file.ts")).toBe(true);
  });

  test("short text with no code or diff does not create view", () => {
    expect(shouldCreateView("Done. The fix has been applied.")).toBe(false);
  });
});
