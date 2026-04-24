import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Set up temp state directory BEFORE importing state module
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-todo-cmd-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const { addTodo, listTodos, markTodoDone, deleteTodo, closeDb } = await import(
  "../src/conduit/state"
);

const TEST_USER_ID = "test:cmd:user";

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

// =============================================================================
// Integration Tests: /todo Command Flow
// =============================================================================

describe("/todo command integration", () => {
  test("can add, list, and mark todos in sequence", () => {
    // User adds a todo
    const todo1 = addTodo("Buy groceries", TEST_USER_ID);
    expect(todo1.id).toBeTruthy();
    expect(todo1.text).toBe("Buy groceries");

    // User lists todos
    const todos = listTodos(TEST_USER_ID);
    expect(todos.length).toBeGreaterThan(0);
    expect(todos.some((t) => t.id === todo1.id)).toBe(true);

    // User marks it done
    const markSuccess = markTodoDone(todo1.id, TEST_USER_ID);
    expect(markSuccess).toBe(true);

    // Verify it's marked done
    const finished = listTodos(TEST_USER_ID, true);
    const updated = finished.find((t) => t.id === todo1.id);
    expect(updated?.done).toBe(true);
  });

  test("can manage multiple todos for same user", () => {
    const t1 = addTodo("Task 1", TEST_USER_ID);
    const t2 = addTodo("Task 2", TEST_USER_ID);
    const t3 = addTodo("Task 3", TEST_USER_ID);

    const allTodos = listTodos(TEST_USER_ID);
    expect(allTodos.length).toBeGreaterThanOrEqual(3);

    // Mark one done
    markTodoDone(t2.id, TEST_USER_ID);

    // Delete one
    deleteTodo(t3.id, TEST_USER_ID);

    // Verify state (check active todos only)
    const remaining = listTodos(TEST_USER_ID);
    expect(remaining.some((t) => t.id === t1.id)).toBe(true);
    expect(remaining.some((t) => t.id === t2.id)).toBe(false); // marked done, so not in active list
    expect(remaining.some((t) => t.id === t3.id)).toBe(false); // deleted, so not in list

    // Verify t2 is in finished list
    const finished = listTodos(TEST_USER_ID, true);
    expect(finished.some((t) => t.id === t2.id && t.done)).toBe(true);
  });

  test("supports time hints for reminders", () => {
    const todo = addTodo("Call mom", TEST_USER_ID, { reminderTime: 1700000000000 });
    expect(todo.reminderTime).toBe(1700000000000);

    const todos = listTodos(TEST_USER_ID);
    const found = todos.find((t) => t.id === todo.id);
    expect(found?.reminderTime).toBe(1700000000000);
  });

  test("supports location hints for context", () => {
    const todo = addTodo("Pick up dry cleaning", TEST_USER_ID, { locationHint: "downtown" });
    expect(todo.locationHint).toBe("downtown");

    const todos = listTodos(TEST_USER_ID);
    const found = todos.find((t) => t.id === todo.id);
    expect(found?.locationHint).toBe("downtown");
  });

  test("supports custom source for multi-channel input", () => {
    const emailTodo = addTodo("Email follow-up", TEST_USER_ID, { source: "email" });
    const calendarTodo = addTodo("Meeting prep", TEST_USER_ID, { source: "calendar" });
    const manualTodo = addTodo("Quick note", TEST_USER_ID, { source: "manual" });

    expect(emailTodo.source).toBe("email");
    expect(calendarTodo.source).toBe("calendar");
    expect(manualTodo.source).toBe("manual");
  });
});

// =============================================================================
// User Experience: Realistic Workflows
// =============================================================================

describe("realistic user workflows", () => {
  test("morning routine: add and check todos", () => {
    const user = "workflow:morning";

    // User adds several morning tasks
    addTodo("Drink coffee", user);
    addTodo("Check emails", user);
    addTodo("Review calendar", user);

    // Check what needs to be done
    const pending = listTodos(user);
    expect(pending.length).toBe(3);

    // Start completing them
    if (pending[0]) {
      markTodoDone(pending[0].id, user);
    }

    // See remaining work
    const remaining = listTodos(user);
    expect(remaining.length).toBe(2);
  });

  test("shopping workflow: add items with locations", () => {
    const user = "workflow:shopping";

    addTodo("Milk", user, { locationHint: "grocery" });
    addTodo("Bread", user, { locationHint: "grocery" });
    addTodo("Gas", user, { locationHint: "gas station" });

    const items = listTodos(user);
    expect(items.filter((t) => t.locationHint === "grocery").length).toBe(2);
    expect(items.filter((t) => t.locationHint === "gas station").length).toBe(1);
  });

  test("time-based reminders workflow", () => {
    const user = "workflow:timed";
    const now = Date.now();

    // Add todos with specific times
    addTodo("9am standup", user, { reminderTime: now + 3600000 }); // 1 hour from now
    addTodo("Lunch break", user, { reminderTime: now + 7200000 }); // 2 hours from now
    addTodo("EOD review", user, { reminderTime: now + 28800000 }); // 8 hours from now

    const todos = listTodos(user);
    const withTimes = todos.filter((t) => t.reminderTime);
    expect(withTimes.length).toBe(3);

    // Todos should be ordered by reminder time
    expect(withTimes[0]!.reminderTime).toBeLessThanOrEqual(withTimes[1]!.reminderTime!);
  });
});
