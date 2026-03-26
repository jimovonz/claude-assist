import { test, expect, describe, beforeEach } from "bun:test";
import { createTask, getTask, listTasks, updateTask, deleteTask } from "../src/conduit/state";

describe("task CRUD", () => {
  let taskId: string;

  beforeEach(() => {
    const task = createTask({
      name: "Test task",
      prompt: "Say hello",
      schedule: "0 9 * * *",
      telegramUserId: "12345",
      sessionStrategy: "fresh",
      maxTurns: 3,
    });
    taskId = task.id;
  });

  test("create returns valid task", () => {
    const task = getTask(taskId)!;
    expect(task).not.toBeNull();
    expect(task.name).toBe("Test task");
    expect(task.prompt).toBe("Say hello");
    expect(task.schedule).toBe("0 9 * * *");
    expect(task.telegramUserId).toBe("12345");
    expect(task.sessionStrategy).toBe("fresh");
    expect(task.enabled).toBe(true);
    expect(task.maxTurns).toBe(3);
    expect(task.lastRunAt).toBeNull();
  });

  test("list includes created task", () => {
    const tasks = listTasks();
    expect(tasks.some(t => t.id === taskId)).toBe(true);
  });

  test("list enabled only", () => {
    const enabledTasks = listTasks(true);
    expect(enabledTasks.some(t => t.id === taskId)).toBe(true);

    updateTask(taskId, { enabled: false });
    const afterDisable = listTasks(true);
    expect(afterDisable.some(t => t.id === taskId)).toBe(false);
  });

  test("update modifies fields", () => {
    updateTask(taskId, { name: "Updated", schedule: "*/5 * * * *", enabled: false });
    const task = getTask(taskId)!;
    expect(task.name).toBe("Updated");
    expect(task.schedule).toBe("*/5 * * * *");
    expect(task.enabled).toBe(false);
  });

  test("update run tracking", () => {
    const now = Date.now();
    updateTask(taskId, { lastRunAt: now, lastRunOutput: "Hello!", lastRunSessionId: "sess-123" });
    const task = getTask(taskId)!;
    expect(task.lastRunAt).toBe(now);
    expect(task.lastRunOutput).toBe("Hello!");
    expect(task.lastRunSessionId).toBe("sess-123");
  });

  test("delete removes task", () => {
    expect(deleteTask(taskId)).toBe(true);
    expect(getTask(taskId)).toBeNull();
    expect(deleteTask(taskId)).toBe(false); // already deleted
  });
});

describe("slug ID generation", () => {
  test("creates slug from name", () => {
    const task = createTask({
      name: "Morning Email Check",
      prompt: "test",
      schedule: "0 9 * * *",
      telegramUserId: "123",
    });
    expect(task.id).toBe("morning-email-check");
    deleteTask(task.id);
  });

  test("deduplicates with numeric suffix", () => {
    const task1 = createTask({ name: "Dup Test", prompt: "t", schedule: "0 9 * * *", telegramUserId: "1" });
    const task2 = createTask({ name: "Dup Test", prompt: "t", schedule: "0 9 * * *", telegramUserId: "1" });
    expect(task1.id).toBe("dup-test");
    expect(task2.id).toBe("dup-test-2");
    deleteTask(task1.id);
    deleteTask(task2.id);
  });

  test("handles special characters", () => {
    const task = createTask({ name: "Check Gmail!! (urgent)", prompt: "t", schedule: "0 9 * * *", telegramUserId: "1" });
    expect(task.id).toBe("check-gmail-urgent");
    deleteTask(task.id);
  });

  test("truncates long names", () => {
    const task = createTask({ name: "A".repeat(80), prompt: "t", schedule: "0 9 * * *", telegramUserId: "1" });
    expect(task.id.length).toBeLessThanOrEqual(40);
    deleteTask(task.id);
  });
});

describe("one-shot scheduling (runAt)", () => {
  test("creates task with runAt", () => {
    const futureTime = Date.now() + 60000;
    const task = createTask({
      name: "One-shot test",
      prompt: "Do something",
      runAt: futureTime,
      telegramUserId: "123",
    });
    expect(task.runAt).toBe(futureTime);
    expect(task.schedule).toBe("");
    deleteTask(task.id);
  });

  test("rejects task with neither schedule nor runAt", () => {
    expect(() => createTask({
      name: "Invalid task",
      prompt: "test",
      telegramUserId: "123",
    })).toThrow("must have either a schedule");
  });

  test("allows task with only schedule", () => {
    const task = createTask({ name: "Cron only", prompt: "t", schedule: "0 9 * * *", telegramUserId: "1" });
    expect(task.schedule).toBe("0 9 * * *");
    expect(task.runAt).toBeNull();
    deleteTask(task.id);
  });
});

describe("notify field", () => {
  test("defaults to always", () => {
    const task = createTask({ name: "Notify default", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    expect(task.notify).toBe("always");
    deleteTask(task.id);
  });

  test("can be set to auto", () => {
    const task = createTask({ name: "Notify auto", prompt: "t", schedule: "* * * * *", telegramUserId: "1", notify: "auto" });
    expect(task.notify).toBe("auto");
    deleteTask(task.id);
  });

  test("can be set to never", () => {
    const task = createTask({ name: "Notify never", prompt: "t", schedule: "* * * * *", telegramUserId: "1", notify: "never" });
    expect(task.notify).toBe("never");
    deleteTask(task.id);
  });

  test("can be updated", () => {
    const task = createTask({ name: "Notify update", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    updateTask(task.id, { notify: "auto" });
    expect(getTask(task.id)!.notify).toBe("auto");
    deleteTask(task.id);
  });
});

describe("model field", () => {
  test("defaults to null", () => {
    const task = createTask({ name: "Model default", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    expect(task.model).toBeNull();
    deleteTask(task.id);
  });

  test("can be set on creation", () => {
    const task = createTask({ name: "Model set", prompt: "t", schedule: "* * * * *", telegramUserId: "1", model: "claude-haiku-4-5-20251001" });
    expect(task.model).toBe("claude-haiku-4-5-20251001");
    deleteTask(task.id);
  });

  test("can be updated", () => {
    const task = createTask({ name: "Model update", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    updateTask(task.id, { model: "claude-opus-4-6" });
    expect(getTask(task.id)!.model).toBe("claude-opus-4-6");
    deleteTask(task.id);
  });

  test("can be cleared to null", () => {
    const task = createTask({ name: "Model clear", prompt: "t", schedule: "* * * * *", telegramUserId: "1", model: "claude-haiku-4-5-20251001" });
    updateTask(task.id, { model: null });
    expect(getTask(task.id)!.model).toBeNull();
    deleteTask(task.id);
  });
});

describe("skipCairn field", () => {
  test("defaults to false", () => {
    const task = createTask({ name: "Cairn default", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    expect(task.skipCairn).toBe(false);
    deleteTask(task.id);
  });

  test("can be set on creation", () => {
    const task = createTask({ name: "Cairn skip", prompt: "t", schedule: "* * * * *", telegramUserId: "1", skipCairn: true });
    expect(task.skipCairn).toBe(true);
    deleteTask(task.id);
  });

  test("can be toggled", () => {
    const task = createTask({ name: "Cairn toggle", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    updateTask(task.id, { skipCairn: true });
    expect(getTask(task.id)!.skipCairn).toBe(true);
    updateTask(task.id, { skipCairn: false });
    expect(getTask(task.id)!.skipCairn).toBe(false);
    deleteTask(task.id);
  });
});

describe("contextQuery field", () => {
  test("defaults to null", () => {
    const task = createTask({ name: "CQ default", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    expect(task.contextQuery).toBeNull();
    deleteTask(task.id);
  });

  test("can be set on creation", () => {
    const task = createTask({ name: "CQ set", prompt: "t", schedule: "* * * * *", telegramUserId: "1", contextQuery: "known issues" });
    expect(task.contextQuery).toBe("known issues");
    deleteTask(task.id);
  });

  test("can be updated", () => {
    const task = createTask({ name: "CQ update", prompt: "t", schedule: "* * * * *", telegramUserId: "1" });
    updateTask(task.id, { contextQuery: "system health exceptions" });
    expect(getTask(task.id)!.contextQuery).toBe("system health exceptions");
    deleteTask(task.id);
  });

  test("can be cleared to null", () => {
    const task = createTask({ name: "CQ clear", prompt: "t", schedule: "* * * * *", telegramUserId: "1", contextQuery: "query" });
    updateTask(task.id, { contextQuery: null });
    expect(getTask(task.id)!.contextQuery).toBeNull();
    deleteTask(task.id);
  });
});
