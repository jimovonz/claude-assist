import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// =============================================================================
// View Server HTTP Contract
//
// The view server exposes two endpoints: /health and /view/:token.
// These tests verify the HTTP contract with a real Bun.serve instance.
// =============================================================================

// Set up isolated views directory
const TEST_VIEWS_DIR = mkdtempSync(join(tmpdir(), "claude-assist-views-"));
const TEST_PORT = 18099 + Math.floor(Math.random() * 1000);

// We import ViewServer and manually set up test views
const { ViewServer } = await import("../src/views/server");

let server: InstanceType<typeof ViewServer>;
let baseUrl: string;

beforeAll(() => {
  server = new ViewServer({
    port: TEST_PORT,
    baseUrl: `http://localhost:${TEST_PORT}`,
  });
  server.start();
  baseUrl = `http://localhost:${TEST_PORT}`;
});

afterAll(() => {
  server.stop();
  rmSync(TEST_VIEWS_DIR, { recursive: true, force: true });
});

describe("health endpoint", () => {
  test("GET /health returns JSON with status ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("claude-assist");
  });

  test("GET /health includes uptime", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test("GET /health includes memory usage", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    expect(typeof body.memoryMB).toBe("number");
    expect(body.memoryMB).toBeGreaterThan(0);
  });

  test("GET /health includes timestamp in ISO format", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("GET / returns same health data as /health", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("view serving", () => {
  test("GET /view/<valid-token> returns HTML", async () => {
    // Create a view file in the views directory used by the server
    // The server looks for views in PROJECT_ROOT/views/
    const viewsDir = join(import.meta.dir, "..", "views");
    mkdirSync(viewsDir, { recursive: true });
    const token = "aabbccddee112233aabb4455";
    writeFileSync(join(viewsDir, `${token}.html`), "<html><body>Test</body></html>");

    const res = await fetch(`${baseUrl}/view/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Test");
  });

  test("GET /view/<nonexistent-token> returns 404", async () => {
    const res = await fetch(`${baseUrl}/view/000000000000000000000000`);
    expect(res.status).toBe(404);
  });

  test("GET /view/<malformed-token> returns 404", async () => {
    // Token must be exactly 24 hex chars
    const res = await fetch(`${baseUrl}/view/too-short`);
    expect(res.status).toBe(404);
  });

  test("GET /view/<token-with-path-traversal> returns 404", async () => {
    const res = await fetch(`${baseUrl}/view/../../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  test("token regex rejects non-hex characters", async () => {
    const res = await fetch(`${baseUrl}/view/gghhiijjkkll112233aabb44`);
    expect(res.status).toBe(404);
  });
});

describe("unknown routes", () => {
  test("GET /unknown returns 404", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  test("GET /view/ without token returns 404", async () => {
    const res = await fetch(`${baseUrl}/view/`);
    expect(res.status).toBe(404);
  });
});
