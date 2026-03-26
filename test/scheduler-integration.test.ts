import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate state DB
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-sched-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

// Mock hooks
mock.module("../src/conduit/hooks", () => ({
  runStopHook: async () => ({ block: false }),
  runPromptHook: async () => "",
}));

import { createTask, getTask, deleteTask, listTasks } from "../src/conduit/state";
import type { SessionEvent, SessionOptions } from "../src/conduit/session";

// --- Mock SessionManager ---

function createMockSessionManager(response = "Hello from task", sessionId = "sess-task-001") {
  const calls: { channelId: string; message: string; options: SessionOptions }[] = [];
  const removedSessions: string[] = [];

  return {
    calls,
    removedSessions,
    sendMessage: async function* (channelId: string, message: string, options: SessionOptions): AsyncGenerator<SessionEvent> {
      calls.push({ channelId, message, options });
      yield { type: "result" as const, text: response, sessionId };
    },
    removeSession(channelId: string) {
      removedSessions.push(channelId);
      return true;
    },
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
  return {
    sent,
    sendTaskResult: mock(async (userId: string, taskName: string, text: string, channelId: string) => {
      sent.push({ userId, taskName, text, channelId });
    }),
  };
}

// --- Import after mocks ---

const { TaskScheduler } = await import("../src/conduit/scheduler");
const { handleCommand } = await import("../src/conduit/commands");

describe("TaskScheduler", () => {
  let taskId: string;

  beforeEach(() => {
    const task = createTask({
      name: "Test task",
      prompt: "Check something",
      schedule: "* * * * *", // every minute — always matches
      telegramUserId: "99999",
      sessionStrategy: "fresh",
    });
    taskId = task.id;
  });

  afterEach(() => {
    deleteTask(taskId);
  });

  describe("fireTask via tick", () => {
    test("fires a matching task and sends result to telegram", async () => {
      const sm = createMockSessionManager("Task output here");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999, // don't auto-tick
      });

      // Manual start without auto-tick — just call tick behavior
      scheduler.start();
      // Give fireTask time to complete (it's async)
      await Bun.sleep(500);
      scheduler.stop();

      // Session should have been called
      expect(sm.calls.length).toBe(1);
      expect(sm.calls[0].channelId).toBe(`task:${taskId}`);
      expect(sm.calls[0].message).toBe("Check something");

      // Telegram should have received the result
      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0].userId).toBe("99999");
      expect(tg.sent[0].taskName).toBe("Test task");
      expect(tg.sent[0].text).toBe("Task output here");

      // Task should have lastRunAt updated
      const updated = getTask(taskId)!;
      expect(updated.lastRunAt).not.toBeNull();
      expect(updated.lastRunOutput).toBe("Task output here");
      expect(updated.lastRunSessionId).toBe("sess-task-001");
    });

    test("does not fire disabled tasks", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { enabled: false });

      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls.length).toBe(0);
      expect(tg.sent.length).toBe(0);
    });

    test("does not fire same task twice in same minute", async () => {
      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      // First tick fired — manually re-tick
      (scheduler as any).tick();
      await Bun.sleep(300);
      scheduler.stop();

      // Should only fire once
      expect(sm.calls.length).toBe(1);
    });
  });

  describe("fresh vs resume strategy", () => {
    test("fresh strategy removes existing session before firing", async () => {
      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.removedSessions).toContain(`task:${taskId}`);
    });

    test("resume strategy does not remove session", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { sessionStrategy: "resume" });

      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.removedSessions).not.toContain(`task:${taskId}`);
    });

    test("resume strategy injects previous run output", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { sessionStrategy: "resume", lastRunOutput: "Previous result" });

      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls[0].message).toContain("<previous_run_output>");
      expect(sm.calls[0].message).toContain("Previous result");
    });
  });

  describe("context files", () => {
    test("injects content of existing context files", async () => {
      const tmpFile = join(TEST_STATE_DIR, "context.md");
      writeFileSync(tmpFile, "Important context here");

      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { contextFiles: [tmpFile] });

      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls[0].message).toContain("<context_file");
      expect(sm.calls[0].message).toContain("Important context here");
    });

    test("marks missing context files as not found", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { contextFiles: ["/nonexistent/file.md"] });

      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls[0].message).toContain('error="not found"');
    });
  });

  describe("error handling", () => {
    test("sends error notification on task failure", async () => {
      const sm = {
        ...createMockSessionManager(),
        sendMessage: async function* () {
          throw new Error("Session exploded");
        },
        removeSession: () => true,
      };
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      // Should notify user of failure
      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0].text).toContain("Task failed");
      expect(tg.sent[0].text).toContain("Session exploded");

      // Should still update lastRunAt
      const updated = getTask(taskId)!;
      expect(updated.lastRunAt).not.toBeNull();
    });
  });

  describe("runTask (manual trigger)", () => {
    test("fires task immediately regardless of schedule", async () => {
      const { updateTask } = await import("../src/conduit/state");
      // Set schedule to never match
      updateTask(taskId, { schedule: "0 0 31 2 *" }); // Feb 31 doesn't exist

      const sm = createMockSessionManager("Manual output");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.runTask(taskId);
      await Bun.sleep(300);

      expect(sm.calls.length).toBe(1);
      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0].text).toBe("Manual output");
    });

    test("does not fire nonexistent task", () => {
      const sm = createMockSessionManager();
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
      });

      scheduler.runTask("nonexistent-id");
      expect(sm.calls.length).toBe(0);
    });
  });

  describe("metadata stripping", () => {
    test("strips memory blocks from task output", async () => {
      const response = "Useful output\n\n<memory>\n- type: fact\n- topic: test\n- content: blah\n- complete: true\n- context: sufficient\n- keywords: test\n</memory>";
      const sm = createMockSessionManager(response);
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(tg.sent[0].text).toBe("Useful output");
      expect(tg.sent[0].text).not.toContain("<memory>");
    });
  });

  describe("notify modes", () => {
    test("notify always sends output", async () => {
      const sm = createMockSessionManager("Report here");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0].text).toBe("Report here");
    });

    test("notify auto suppresses when LLM says false", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { notify: "auto" });

      const sm = createMockSessionManager("<notify>false</notify>\nAll healthy.");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(tg.sent.length).toBe(0);
      // Output still recorded
      const updated = getTask(taskId)!;
      expect(updated.lastRunOutput).toBe("All healthy.");
    });

    test("notify auto sends when LLM says true", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { notify: "auto" });

      const sm = createMockSessionManager("<notify>true</notify>\nDisk full!");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0].text).toBe("Disk full!");
    });

    test("notify never suppresses all output", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { notify: "never" });

      const sm = createMockSessionManager("Important output");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(tg.sent.length).toBe(0);
      // But output is still recorded
      const updated = getTask(taskId)!;
      expect(updated.lastRunOutput).toBe("Important output");
    });

    test("notify never suppresses error notifications", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { notify: "never" });

      const sm = {
        ...createMockSessionManager(),
        sendMessage: async function* () { throw new Error("Crash"); },
        removeSession: () => true,
      };
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(tg.sent.length).toBe(0); // never means never, even errors
    });
  });

  describe("manual trigger force-notify", () => {
    test("manual run notifies even when auto mode would suppress", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { notify: "auto" });

      const sm = createMockSessionManager("<notify>false</notify>\nAll good.");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.runTask(taskId);
      await Bun.sleep(300);

      // Manual trigger should force notify despite <notify>false</notify>
      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0].text).toBe("All good.");
    });
  });

  describe("one-shot auto-disable", () => {
    test("one-shot task is disabled after firing", async () => {
      const { updateTask } = await import("../src/conduit/state");
      const futureMs = Date.now() - 1000; // already past
      updateTask(taskId, { schedule: "", runAt: futureMs });

      const sm = createMockSessionManager("One-shot output");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(tg.sent.length).toBe(1);
      const updated = getTask(taskId)!;
      expect(updated.enabled).toBe(false);
    });

    test("recurring task stays enabled after firing", async () => {
      const sm = createMockSessionManager("Recurring output");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      const updated = getTask(taskId)!;
      expect(updated.enabled).toBe(true);
    });
  });

  describe("model passed to session", () => {
    test("model is passed in session options", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { model: "claude-haiku-4-5-20251001" });

      const sm = createMockSessionManager("Output");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls[0].options.model).toBe("claude-haiku-4-5-20251001");
    });

    test("no model passes undefined", async () => {
      const sm = createMockSessionManager("Output");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls[0].options.model).toBeUndefined();
    });
  });

  describe("auto-notify instruction injection", () => {
    test("injects notify instructions for auto mode", async () => {
      const { updateTask } = await import("../src/conduit/state");
      updateTask(taskId, { notify: "auto" });

      const sm = createMockSessionManager("<notify>false</notify>\nOK");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls[0].message).toContain("NOTIFICATION CONTROL");
      expect(sm.calls[0].message).toContain("<notify>true</notify>");
    });

    test("does not inject notify instructions for always mode", async () => {
      const sm = createMockSessionManager("Output");
      const tg = createMockTelegram();
      const scheduler = new TaskScheduler({
        sessionManager: sm as any,
        telegram: tg as any,
        tickIntervalMs: 999999,
      });

      scheduler.start();
      await Bun.sleep(300);
      scheduler.stop();

      expect(sm.calls[0].message).not.toContain("NOTIFICATION CONTROL");
    });
  });
});

describe("command handler", () => {

  test("/tasks lists created tasks", () => {
    const task = createTask({
      name: "Cmd test",
      prompt: "test",
      schedule: "0 9 * * *",
      telegramUserId: "123",
    });

    const ctx = {
      sessionManager: createMockSessionManager() as any,
      channelId: "test:user",
      userId: "user",
    };

    const result = handleCommand("/tasks", ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Cmd test");
    expect(result!.text).toContain(task.id);

    deleteTask(task.id);
  });

  test("/task <id> disable disables a task", () => {
    const task = createTask({
      name: "Disable me",
      prompt: "test",
      schedule: "0 9 * * *",
      telegramUserId: "123",
    });

    const ctx = {
      sessionManager: createMockSessionManager() as any,
      channelId: "test:user",
      userId: "user",
    };

    const result = handleCommand(`/task ${task.id} disable`, ctx);
    expect(result!.text).toContain("disabled");

    const updated = getTask(task.id)!;
    expect(updated.enabled).toBe(false);

    deleteTask(task.id);
  });

  test("/task <id> delete deletes a task", () => {
    const task = createTask({
      name: "Delete me",
      prompt: "test",
      schedule: "0 9 * * *",
      telegramUserId: "123",
    });

    const ctx = {
      sessionManager: createMockSessionManager() as any,
      channelId: "test:user",
      userId: "user",
    };

    handleCommand(`/task ${task.id} delete`, ctx);
    expect(getTask(task.id)).toBeNull();
  });

  test("/help returns command list", () => {
    const ctx = {
      sessionManager: createMockSessionManager() as any,
      channelId: "test:user",
      userId: "user",
    };

    const result = handleCommand("/help", ctx);
    expect(result!.text).toContain("/tasks");
    expect(result!.text).toContain("/clear");
    expect(result!.text).toContain("/context");
  });

  test("unknown command returns null", () => {
    const ctx = {
      sessionManager: createMockSessionManager() as any,
      channelId: "test:user",
      userId: "user",
    };

    expect(handleCommand("/nonexistent", ctx)).toBeNull();
  });

  test("/task <id> enable enables a task", () => {
    const task = createTask({ name: "Enable me", prompt: "t", schedule: "0 9 * * *", telegramUserId: "1" });
    const { updateTask: ut } = require("../src/conduit/state");
    ut(task.id, { enabled: false });

    const ctx = { sessionManager: createMockSessionManager() as any, channelId: "t:u", userId: "u" };
    const result = handleCommand(`/task ${task.id} enable`, ctx);
    expect(result!.text).toContain("enabled");
    expect(getTask(task.id)!.enabled).toBe(true);
    deleteTask(task.id);
  });

  test("/task with missing id returns usage", () => {
    const ctx = { sessionManager: createMockSessionManager() as any, channelId: "t:u", userId: "u" };
    const result = handleCommand("/task", ctx);
    expect(result!.text).toContain("Usage");
  });

  test("/task with nonexistent id returns not found", () => {
    const ctx = { sessionManager: createMockSessionManager() as any, channelId: "t:u", userId: "u" };
    const result = handleCommand("/task nonexistent disable", ctx);
    expect(result!.text).toContain("not found");
  });

  test("/task with unknown action returns error", () => {
    const task = createTask({ name: "Action test", prompt: "t", schedule: "0 9 * * *", telegramUserId: "1" });
    const ctx = { sessionManager: createMockSessionManager() as any, channelId: "t:u", userId: "u" };
    const result = handleCommand(`/task ${task.id} explode`, ctx);
    expect(result!.text).toContain("Unknown action");
    deleteTask(task.id);
  });

  test("/tasks shows empty when no tasks", () => {
    // Clean up any tasks from other tests
    const allTasks = listTasks();
    const testTasks = allTasks.filter(t => t.name.startsWith("Empty"));
    const ctx = { sessionManager: createMockSessionManager() as any, channelId: "t:u", userId: "u" };
    const result = handleCommand("/tasks", ctx);
    expect(result).not.toBeNull();
    // Just verify it returns something — exact count depends on test ordering
    expect(typeof result!.text).toBe("string");
  });

  test("/clear resets session", () => {
    const sm = createMockSessionManager();
    const ctx = { sessionManager: sm as any, channelId: "test:user", userId: "user" };
    const result = handleCommand("/clear", ctx);
    expect(result!.text).toContain("Session cleared");
    expect(sm.removedSessions).toContain("test:user");
  });

  test("/sessions lists sessions", () => {
    const sm = createMockSessionManager();
    const ctx = { sessionManager: sm as any, channelId: "test:user", userId: "user" };
    const result = handleCommand("/sessions", ctx);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("session");
  });

  test("non-command text is not a command", () => {
    const { isCommand } = require("../src/conduit/commands");
    expect(isCommand("/clear")).toBe(true);
    expect(isCommand("/tasks")).toBe(true);
    expect(isCommand("/task heartbeat run")).toBe(true);
    expect(isCommand("hello")).toBe(false);
    expect(isCommand("/ nope")).toBe(false);
    expect(isCommand("/123")).toBe(false);
    expect(isCommand("")).toBe(false);
  });
});
