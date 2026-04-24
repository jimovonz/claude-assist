import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// =============================================================================
// View Creation & Index — Tests with Real Temp Directory
//
// Uses a real temp directory (cleaned up after tests) to verify the full
// pipeline: slug generation, HTML rendering, file writing, index management.
// =============================================================================

// We need to set EDGE_URL to empty and point the views dir to a temp location.
// The renderer uses module-level constants, so we mock the module imports.
const TEST_VIEWS_DIR = mkdtempSync(join(tmpdir(), "claude-assist-views-test-"));

// Mock the renderer's VIEWS_DIR by re-importing with a patched module
// Since VIEWS_DIR is computed from import.meta.dir, we'll test via the
// public API and verify files appear in the right shape.

// Instead of mocking fs, we'll test the renderer functions that don't depend
// on VIEWS_DIR (renderContent, shouldCreateView are already tested), and
// test createView by verifying its contract: returns a slug string.

// We can't easily redirect VIEWS_DIR without refactoring, so we test
// the logic via integration: call createView, verify the returned slug
// matches expected patterns, and verify the view index is maintained.

const { createView, loadViewIndex, renderContent } = await import("../src/views/renderer");

afterAll(() => {
  rmSync(TEST_VIEWS_DIR, { recursive: true, force: true });
});

describe("createView", () => {
  test("returns a non-empty slug string", () => {
    const slug = createView({ content: "Hello world" });
    expect(typeof slug).toBe("string");
    expect(slug.length).toBeGreaterThan(0);
  });

  test("slug contains hex suffix for uniqueness", () => {
    const slug = createView({ content: "Test content" });
    // Slug format: [descriptive-part-]<6 hex chars>
    const hexPart = slug.slice(-6);
    expect(hexPart).toMatch(/^[a-f0-9]{6}$/);
  });

  test("slug incorporates title when provided", () => {
    const slug = createView({ content: "Body text", title: "My Custom Title" });
    expect(slug).toContain("my-custom-title");
  });

  test("slug uses content heading when title is default", () => {
    const slug = createView({ content: "# Important Header\n\nBody text", title: "Claude Response" });
    expect(slug).toContain("important-header");
  });

  test("slug strips special characters", () => {
    const slug = createView({ content: "Body", title: "Hello! @World #2024" });
    expect(slug).not.toMatch(/[!@#]/);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  test("slug truncates long titles to 50 chars", () => {
    const longTitle = "A".repeat(100);
    const slug = createView({ content: "Body", title: longTitle });
    // Slug = base (max 50) + "-" + hex (6) = max 57
    expect(slug.length).toBeLessThanOrEqual(57);
  });

  test("different calls produce different slugs (random suffix)", () => {
    const slug1 = createView({ content: "Same content" });
    const slug2 = createView({ content: "Same content" });
    expect(slug1).not.toBe(slug2);
  });

  test("creates an HTML file on disk", () => {
    const slug = createView({ content: "# Test\n\nContent here" });
    // The file is created in the module's VIEWS_DIR (not our temp dir)
    // We verify it exists at the expected path
    const viewsDir = join(import.meta.dir, "..", "views");
    const filePath = join(viewsDir, `${slug}.html`);
    expect(existsSync(filePath)).toBe(true);

    // Clean up
    try { rmSync(filePath); } catch {}
  });

  test("generated HTML contains rendered content", () => {
    const slug = createView({ content: "# Hello\n\nWorld" });
    const viewsDir = join(import.meta.dir, "..", "views");
    const filePath = join(viewsDir, `${slug}.html`);
    const html = readFileSync(filePath, "utf-8");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("World");
    expect(html).toContain("claude-assist");

    try { rmSync(filePath); } catch {}
  });

  test("generated HTML escapes title in page title tag", () => {
    const slug = createView({ content: "Body", title: '<script>alert("xss")</script>' });
    const viewsDir = join(import.meta.dir, "..", "views");
    const filePath = join(viewsDir, `${slug}.html`);
    const html = readFileSync(filePath, "utf-8");

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");

    try { rmSync(filePath); } catch {}
  });
});

describe("loadViewIndex", () => {
  test("returns an array", () => {
    const index = loadViewIndex();
    expect(Array.isArray(index)).toBe(true);
  });

  test("index grows after createView calls", () => {
    const before = loadViewIndex();
    const beforeLen = before.length;
    createView({ content: "Index test", title: "Index Entry" });
    const after = loadViewIndex();

    if (beforeLen < 100) {
      // Index not full — should grow
      expect(after.length).toBeGreaterThan(beforeLen);
    } else {
      // Index at cap — newest entry should be first (replaced oldest)
      expect(after.length).toBe(100);
      expect(after[0]!.title).toBe("Index Entry");
    }

    // Clean up the file
    const slug = after[0]!.slug;
    const viewsDir = join(import.meta.dir, "..", "views");
    try { rmSync(join(viewsDir, `${slug}.html`)); } catch {}
  });

  test("index entries have required fields", () => {
    createView({ content: "Fields test", title: "Field Check", channel: "test", userId: "user1" });
    const index = loadViewIndex();
    const latest = index[0]; // newest first

    expect(latest!.slug).toBeDefined();
    expect(latest!.title).toBe("Field Check");
    expect(typeof latest!.url).toBe("string");
    expect(typeof latest!.localUrl).toBe("string");
    expect(typeof latest!.createdAt).toBe("string");
    expect(latest!.channel).toBe("test");
    expect(latest!.userId).toBe("user1");
    expect(typeof latest!.chars).toBe("number");

    // Clean up
    const viewsDir = join(import.meta.dir, "..", "views");
    try { rmSync(join(viewsDir, `${latest!.slug}.html`)); } catch {}
  });
});

describe("renderContent HTML generation", () => {
  test("full page HTML has required structure", () => {
    // Test via createView since generateHtml is private
    const slug = createView({ content: "Test", title: "Structure Check" });
    const viewsDir = join(import.meta.dir, "..", "views");
    const html = readFileSync(join(viewsDir, `${slug}.html`), "utf-8");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html>");
    expect(html).toContain("</html>");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
    expect(html).toContain("telegram-web-app.js"); // Telegram Mini App integration

    try { rmSync(join(viewsDir, `${slug}.html`)); } catch {}
  });
});
