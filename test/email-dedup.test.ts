import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolated state DB for email dedup tests
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-email-dedup-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const {
  isEmailProcessed,
  markEmailProcessed,
  cleanupOldEmails,
  closeDb,
} = await import("../src/conduit/state");

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

// =============================================================================
// Email Dedup — processed_emails table
//
// The email agent must not re-process emails it has already seen.
// Tracking survives restarts via SQLite persistence.
// =============================================================================

describe("isEmailProcessed", () => {
  test("returns false for unseen email ID", () => {
    expect(isEmailProcessed("unseen-email-001")).toBe(false);
  });

  test("returns true after marking as processed", () => {
    markEmailProcessed("seen-email-001");
    expect(isEmailProcessed("seen-email-001")).toBe(true);
  });

  test("different email IDs are independent", () => {
    markEmailProcessed("email-a");
    expect(isEmailProcessed("email-a")).toBe(true);
    expect(isEmailProcessed("email-b")).toBe(false);
  });
});

describe("markEmailProcessed", () => {
  test("marking same email twice does not throw (INSERT OR IGNORE)", () => {
    markEmailProcessed("dup-email-001");
    expect(() => markEmailProcessed("dup-email-001")).not.toThrow();
    expect(isEmailProcessed("dup-email-001")).toBe(true);
  });

  test("handles special characters in email IDs", () => {
    const specialId = "msg-123/abc+test@example.com";
    markEmailProcessed(specialId);
    expect(isEmailProcessed(specialId)).toBe(true);
  });

  test("handles empty string email ID", () => {
    markEmailProcessed("");
    expect(isEmailProcessed("")).toBe(true);
  });
});

describe("cleanupOldEmails", () => {
  test("does not remove recently processed emails", () => {
    markEmailProcessed("recent-email-001");
    cleanupOldEmails(); // default 7 day retention
    expect(isEmailProcessed("recent-email-001")).toBe(true);
  });

  test("removes emails older than specified max age", () => {
    markEmailProcessed("old-email-001");
    // Clean up with 0ms max age — everything is "old"
    cleanupOldEmails(0);
    expect(isEmailProcessed("old-email-001")).toBe(false);
  });

  test("preserves emails within retention window while removing old ones", () => {
    // Mark two emails
    markEmailProcessed("keeper-001");

    // Clean with 0ms window removes everything
    cleanupOldEmails(0);
    expect(isEmailProcessed("keeper-001")).toBe(false);

    // Mark a new one after cleanup
    markEmailProcessed("keeper-002");
    // Clean with large window keeps it
    cleanupOldEmails(7 * 24 * 60 * 60 * 1000);
    expect(isEmailProcessed("keeper-002")).toBe(true);
  });
});

describe("email dedup integration", () => {
  test("full workflow: check → mark → check → cleanup → check", () => {
    const emailId = "workflow-email-001";

    // Initially unseen
    expect(isEmailProcessed(emailId)).toBe(false);

    // Mark as processed
    markEmailProcessed(emailId);
    expect(isEmailProcessed(emailId)).toBe(true);

    // Still seen after redundant mark
    markEmailProcessed(emailId);
    expect(isEmailProcessed(emailId)).toBe(true);

    // Cleanup with 0ms removes it
    cleanupOldEmails(0);
    expect(isEmailProcessed(emailId)).toBe(false);
  });

  test("batch processing: multiple emails marked then checked", () => {
    const ids = ["batch-1", "batch-2", "batch-3", "batch-4", "batch-5"];

    for (const id of ids) {
      markEmailProcessed(id);
    }

    for (const id of ids) {
      expect(isEmailProcessed(id)).toBe(true);
    }

    // One not in batch
    expect(isEmailProcessed("batch-6")).toBe(false);
  });
});
