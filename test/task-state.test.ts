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
