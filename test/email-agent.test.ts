import { test, expect, describe, mock, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate state DB
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-email-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

// Mock hooks
mock.module("../src/conduit/hooks", () => ({
  runStopHook: async () => ({ block: false }),
  runPromptHook: async () => "",
}));

import type { SessionEvent, SessionOptions } from "../src/conduit/session";

// --- Mock SessionManager ---

function createMockSessionManager(response = "processed") {
  const calls: { channelId: string; message: string; options: SessionOptions }[] = [];
  return {
    calls,
    sendMessage: async function* (channelId: string, message: string, options: SessionOptions): AsyncGenerator<SessionEvent> {
      calls.push({ channelId, message, options });
      yield { type: "result" as const, text: response, sessionId: "sess-email" };
    },
    removeSession: () => true,
    getSession: () => undefined,
    listSessions: () => [],
    getUsage: () => undefined,
    abort: () => false,
    pruneIdle: () => [],
    get uptime() { return 1000; },
    get activeSessionCount() { return 0; },
  };
}

// --- Mock TelegramChannel ---

function createMockTelegram() {
  const sent: { userId: string; taskName: string; text: string; channelId: string }[] = [];
  const directMessages: { chatId: number; text: string }[] = [];
  return {
    sent,
    directMessages,
    sendTaskResult: mock(async (userId: string, taskName: string, text: string, channelId: string) => {
      sent.push({ userId, taskName, text, channelId });
    }),
    sendDirect: mock(async (chatId: number, text: string) => {
      directMessages.push({ chatId, text });
    }),
    reply: mock(async () => {}),
  };
}

const { EmailAgent } = await import("../src/conduit/email-agent");

describe("EmailAgent", () => {
  describe("handlePush", () => {
    test("handles push notification without crashing", async () => {
      const sm = createMockSessionManager(`\`\`\`json
{"actions": [{"emailId": "abc", "classification": "Marketing", "labels": ["CA/Marketing"], "notify": false, "notifyReason": "", "calendarEvent": null, "summary": "Promo email"}]}
\`\`\``);
      const tg = createMockTelegram();
      const agent = new EmailAgent({
        sessionManager: sm as any,
        telegram: tg as any,
        telegramUserId: "12345",
      });

      // This will try to call gmail-check.py which may fail in test env
      // but should not throw
      await agent.handlePush("test@example.com", "12345");
      // The processing flag should be reset
      expect((agent as any).processing).toBe(false);
    });

    test("skips if already processing", async () => {
      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const agent = new EmailAgent({
        sessionManager: sm as any,
        telegram: tg as any,
        telegramUserId: "12345",
      });

      (agent as any).processing = true;
      await agent.handlePush("test@example.com", "12345");
      // Should have skipped — no session calls
      expect(sm.calls.length).toBe(0);
      (agent as any).processing = false;
    });
  });

  describe("parseActions", () => {
    test("extracts actions from JSON code block", () => {
      const response = `Here's my analysis:

\`\`\`json
{
  "actions": [
    {"emailId": "abc123", "classification": "Personal", "labels": ["CA/Personal", "CA/Actionable"], "notify": true, "notifyReason": "From Dave, needs reply", "calendarEvent": null, "summary": "Dave asks about dinner"},
    {"emailId": "def456", "classification": "Marketing", "labels": ["CA/Marketing"], "notify": false, "notifyReason": "", "calendarEvent": null, "summary": "Temu sale"}
  ]
}
\`\`\`

📧 **Dave Smith** — Asking about dinner plans this weekend. Needs your reply.`;

      const actions = (EmailAgent.prototype as any).parseActions.call({}, response);
      expect(actions).toHaveLength(2);
      expect(actions[0].emailId).toBe("abc123");
      expect(actions[0].classification).toBe("Personal");
      expect(actions[0].notify).toBe(true);
      expect(actions[0].labels).toEqual(["CA/Personal", "CA/Actionable"]);
      expect(actions[1].notify).toBe(false);
    });

    test("returns empty array for no JSON block", () => {
      const actions = (EmailAgent.prototype as any).parseActions.call({}, "No JSON here");
      expect(actions).toEqual([]);
    });

    test("returns empty array for invalid JSON", () => {
      const actions = (EmailAgent.prototype as any).parseActions.call({}, "```json\n{invalid}\n```");
      expect(actions).toEqual([]);
    });

    test("handles response with calendar event", () => {
      const response = `\`\`\`json
{
  "actions": [
    {
      "emailId": "evt123",
      "classification": "Work",
      "labels": ["CA/Work", "CA/Time-Sensitive"],
      "notify": true,
      "notifyReason": "Meeting scheduled for Thursday",
      "calendarEvent": {
        "title": "Team Standup",
        "start": "2026-03-27T10:00:00+13:00",
        "end": "2026-03-27T10:30:00+13:00",
        "description": "Weekly team standup with engineering"
      },
      "summary": "Meeting invite from Sarah"
    }
  ]
}
\`\`\``;

      const actions = (EmailAgent.prototype as any).parseActions.call({}, response);
      expect(actions).toHaveLength(1);
      expect(actions[0].calendarEvent).not.toBeNull();
      expect(actions[0].calendarEvent.title).toBe("Team Standup");
      expect(actions[0].calendarEvent.start).toContain("2026-03-27");
    });
  });

  describe("extractNotification", () => {
    test("extracts text after JSON block", () => {
      const cleaned = `\`\`\`json
{"actions": []}
\`\`\`

📧 **Important Email** — Dave needs your reply about the project.`;

      const notification = (EmailAgent.prototype as any).extractNotification.call({}, cleaned);
      expect(notification).toContain("Important Email");
      expect(notification).toContain("Dave");
      expect(notification).not.toContain("json");
    });

    test("returns empty string when only JSON block", () => {
      const cleaned = `\`\`\`json
{"actions": []}
\`\`\``;

      const notification = (EmailAgent.prototype as any).extractNotification.call({}, cleaned);
      expect(notification).toBe("");
    });

    test("returns full text when no JSON block", () => {
      const notification = (EmailAgent.prototype as any).extractNotification.call({}, "Just plain text");
      expect(notification).toBe("Just plain text");
    });
  });

  describe("configuration", () => {
    test("uses default model haiku", () => {
      const agent = new EmailAgent({
        sessionManager: createMockSessionManager() as any,
        telegram: createMockTelegram() as any,
        telegramUserId: "123",
      });
      expect((agent as any).model).toBe("claude-haiku-4-5-20251001");
    });

    test("accepts custom model", () => {
      const agent = new EmailAgent({
        sessionManager: createMockSessionManager() as any,
        telegram: createMockTelegram() as any,
        telegramUserId: "123",
        model: "claude-opus-4-6",
      });
      expect((agent as any).model).toBe("claude-opus-4-6");
    });

    test("channelId is email-agent:processor", () => {
      const agent = new EmailAgent({
        sessionManager: createMockSessionManager() as any,
        telegram: createMockTelegram() as any,
        telegramUserId: "123",
      });
      expect((agent as any).channelId).toBe("email-agent:processor");
    });
  });
});

describe("EmailAgent dedup integration", () => {
  // Tests the full flow: handlePush filters already-processed emails
  // and marks new ones as processed after completion.

  test("skips already-processed emails and only sends new ones to Claude", async () => {
    const { markEmailProcessed, isEmailProcessed, closeDb: _ } = await import("../src/conduit/state");

    const emails = [
      { id: "old-001", from: "a@test.com", to: "me@test.com", subject: "Old", date: "2026-03-27", snippet: "Old email", labels: ["INBOX"], body: "old body" },
      { id: "new-001", from: "b@test.com", to: "me@test.com", subject: "New", date: "2026-03-27", snippet: "New email", labels: ["INBOX"], body: "new body" },
      { id: "new-002", from: "c@test.com", to: "me@test.com", subject: "Also New", date: "2026-03-27", snippet: "Another", labels: ["INBOX"], body: "another body" },
    ];

    // Pre-mark old-001 as processed
    markEmailProcessed("old-001");

    const response = `\`\`\`json
{"actions": [
  {"emailId": "new-001", "classification": "Personal", "labels": ["CA/Personal"], "notify": false, "notifyReason": "", "calendarEvent": null, "summary": "Test"},
  {"emailId": "new-002", "classification": "Work", "labels": ["CA/Work"], "notify": false, "notifyReason": "", "calendarEvent": null, "summary": "Test2"}
]}
\`\`\``;

    const sm = createMockSessionManager(response);
    const tg = createMockTelegram();
    const agent = new EmailAgent({
      sessionManager: sm as any,
      telegram: tg as any,
      telegramUserId: "12345",
    });

    // Override fetchUnread to return our test emails
    (agent as any).fetchUnread = async () => emails;
    // Override runScript to no-op (don't call real gmail-label.py)
    (agent as any).runScript = async () => "";

    await agent.handlePush("test@example.com", "99999");

    // Claude should only have seen new-001 and new-002 (not old-001)
    expect(sm.calls).toHaveLength(1);
    const prompt = sm.calls[0]!.message;
    expect(prompt).not.toContain("old-001");
    expect(prompt).toContain("new-001");
    expect(prompt).toContain("new-002");

    // All processed emails should now be marked
    expect(isEmailProcessed("new-001")).toBe(true);
    expect(isEmailProcessed("new-002")).toBe(true);
    expect(isEmailProcessed("old-001")).toBe(true); // was already marked
  });

  test("returns early when all emails already processed", async () => {
    const { markEmailProcessed } = await import("../src/conduit/state");

    markEmailProcessed("seen-a");
    markEmailProcessed("seen-b");

    const sm = createMockSessionManager();
    const tg = createMockTelegram();
    const agent = new EmailAgent({
      sessionManager: sm as any,
      telegram: tg as any,
      telegramUserId: "12345",
    });

    (agent as any).fetchUnread = async () => [
      { id: "seen-a", from: "x@test.com", to: "me@test.com", subject: "X", date: "2026-03-27", snippet: "", labels: [], body: "" },
      { id: "seen-b", from: "y@test.com", to: "me@test.com", subject: "Y", date: "2026-03-27", snippet: "", labels: [], body: "" },
    ];

    await agent.handlePush("test@example.com", "100");

    // No Claude session should have been created
    expect(sm.calls).toHaveLength(0);
  });

  test("marks emails as processed even when no actions returned", async () => {
    const { isEmailProcessed } = await import("../src/conduit/state");

    const sm = createMockSessionManager("No actionable emails found.");
    const tg = createMockTelegram();
    const agent = new EmailAgent({
      sessionManager: sm as any,
      telegram: tg as any,
      telegramUserId: "12345",
    });

    (agent as any).fetchUnread = async () => [
      { id: "noaction-001", from: "z@test.com", to: "me@test.com", subject: "Z", date: "2026-03-27", snippet: "", labels: [], body: "" },
    ];
    (agent as any).runScript = async () => "";

    await agent.handlePush("test@example.com", "101");

    // Email should still be marked even though no JSON actions were parsed
    expect(isEmailProcessed("noaction-001")).toBe(true);
  });
});

describe("Gmail helper scripts", () => {
  // These test that the scripts exist and have correct shebang/structure
  // Actual API calls are not tested (require credentials)

  test("gmail-check.py exists and is valid Python", async () => {
    const scriptPath = join(import.meta.dir, "..", "bin", "gmail-check.py");
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("#!/usr/bin/env python3");
    expect(content).toContain("def main()");
    expect(content).toContain("argparse");
    expect(content).toContain("--since");
    expect(content).toContain("--body");
    expect(content).toContain("--query");
    expect(content).toContain("--id");
  });

  test("gmail-label.py exists and supports all operations", () => {
    const content = readFileSync(join(import.meta.dir, "..", "bin", "gmail-label.py"), "utf-8");
    expect(content).toContain("cmd_list");
    expect(content).toContain("cmd_create");
    expect(content).toContain("cmd_apply");
    expect(content).toContain("cmd_remove");
    expect(content).toContain("cmd_mark_read");
    expect(content).toContain("find_label_id");
  });

  test("gmail-send.py exists and supports replies", () => {
    const content = readFileSync(join(import.meta.dir, "..", "bin", "gmail-send.py"), "utf-8");
    expect(content).toContain("--to");
    expect(content).toContain("--subject");
    expect(content).toContain("--body");
    expect(content).toContain("--reply-to");
    expect(content).toContain("In-Reply-To");
    expect(content).toContain("threadId");
  });

  test("gmail-watch.py exists and supports start/stop/status", () => {
    const content = readFileSync(join(import.meta.dir, "..", "bin", "gmail-watch.py"), "utf-8");
    expect(content).toContain("cmd_start");
    expect(content).toContain("cmd_stop");
    expect(content).toContain("cmd_status");
    expect(content).toContain("users().watch");
    expect(content).toContain("gmail-notifications");
  });

  test("gcal.py exists and supports all operations", () => {
    const content = readFileSync(join(import.meta.dir, "..", "bin", "gcal.py"), "utf-8");
    expect(content).toContain("cmd_list");
    expect(content).toContain("cmd_today");
    expect(content).toContain("cmd_create");
    expect(content).toContain("cmd_free");
    expect(content).toContain("calendarId");
  });
});

describe("email-agent.md context file", () => {
  test("exists and contains classification rules", () => {
    const content = readFileSync(join(import.meta.dir, "..", "email-agent.md"), "utf-8");
    expect(content).toContain("CA/Personal");
    expect(content).toContain("CA/Work");
    expect(content).toContain("CA/Marketing");
    expect(content).toContain("CA/Newsletter");
    expect(content).toContain("CA/Actionable");
    expect(content).toContain("CA/Time-Sensitive");
    expect(content).toContain("CA/FYI");
  });

  test("contains notification rules", () => {
    const content = readFileSync(join(import.meta.dir, "..", "email-agent.md"), "utf-8");
    expect(content).toContain("personally addressed");
    expect(content).toContain("requires action");
    expect(content).toContain("DO notify");
    expect(content).toContain("DO NOT notify");
  });

  test("contains calendar event rules", () => {
    const content = readFileSync(join(import.meta.dir, "..", "email-agent.md"), "utf-8");
    expect(content).toContain("Calendar Event Detection");
    expect(content).toContain("specific future date");
    expect(content).toContain("Do NOT create events for");
  });

  test("contains output format specification", () => {
    const content = readFileSync(join(import.meta.dir, "..", "email-agent.md"), "utf-8");
    expect(content).toContain("emailId");
    expect(content).toContain("classification");
    expect(content).toContain("calendarEvent");
    expect(content).toContain("notify");
  });
});

describe("watch renewal task", () => {
  test("setupWatchRenewal creates task if not exists", async () => {
    const { setupWatchRenewal } = await import("../src/conduit/email-agent");
    const { getTask, deleteTask } = await import("../src/conduit/state");

    // Clean up if exists from previous test run
    deleteTask("gmail-watch-renew");

    process.env.TELEGRAM_OWNER_ID = "12345";
    await setupWatchRenewal();

    // Give it a moment to execute the dynamic import
    await Bun.sleep(100);

    const task = getTask("gmail-watch-renew");
    expect(task).not.toBeNull();
    expect(task!.schedule).toBe("0 0 */3 * *");
    expect(task!.notify).toBe("never");
    expect(task!.skipCairn).toBe(true);

    deleteTask("gmail-watch-renew");
  });
});
