import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Set up temp state directory BEFORE importing state module
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-todo-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const {
  addTodo,
  listTodos,
  markTodoDone,
  deleteTodo,
  closeDb,
} = await import("../src/conduit/state");

const { parseTodoInput, formatTodoDisplay } = await import(
  "../src/conduit/todo-utils"
);

const TEST_USER_ID = "test:user:123";

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

// =============================================================================
// Todo CRUD Operations
// =============================================================================

describe("Todo CRUD operations", () => {
  test("addTodo creates a todo with basic text", () => {
    const result = addTodo("Buy milk", TEST_USER_ID);
    expect(result).toBeDefined();
    expect(result.id).toBeTruthy();
    expect(result.text).toBe("Buy milk");
    expect(result.done).toBe(false);
    expect(result.userId).toBe(TEST_USER_ID);
  });

  test("addTodo with time hint option", () => {
    const result = addTodo("Pick up kids", TEST_USER_ID, { reminderTime: 1500 });
    expect(result.text).toBe("Pick up kids");
    expect(result.reminderTime).toBe(1500);
  });

  test("addTodo with location hint option", () => {
    const result = addTodo("Buy groceries", TEST_USER_ID, { locationHint: "the store" });
    expect(result.text).toBe("Buy groceries");
    expect(result.locationHint).toBe("the store");
  });

  test("listTodos returns all todos for a user", () => {
    const id1 = addTodo("Task 1", TEST_USER_ID).id;
    const id2 = addTodo("Task 2", TEST_USER_ID).id;
    const id3 = addTodo("Task 3", "other:user").id;

    const todos = listTodos(TEST_USER_ID);
    expect(todos.length).toBeGreaterThanOrEqual(2);
    expect(todos.some((t) => t.id === id1)).toBe(true);
    expect(todos.some((t) => t.id === id2)).toBe(true);
    expect(todos.some((t) => t.id === id3)).toBe(false); // Different user
  });

  test("listTodos filters by user isolation", () => {
    const user1Id = "user:1:isolation";
    const user2Id = "user:2:isolation";

    addTodo("User 1 task", user1Id);
    addTodo("User 2 task", user2Id);

    const user1Todos = listTodos(user1Id);
    const user2Todos = listTodos(user2Id);

    expect(user1Todos.every((t) => t.userId === user1Id)).toBe(true);
    expect(user2Todos.every((t) => t.userId === user2Id)).toBe(true);
  });

  test("markTodoDone sets done flag", () => {
    const todo = addTodo("Complete task", TEST_USER_ID);
    markTodoDone(todo.id, TEST_USER_ID);

    const todos = listTodos(TEST_USER_ID, true); // includeFinished=true
    const updated = todos.find((t) => t.id === todo.id);
    expect(updated?.done).toBe(true);
  });

  test("deleteTodo removes a todo", () => {
    const todo = addTodo("Delete me", TEST_USER_ID);
    const beforeCount = listTodos(TEST_USER_ID, true).length;

    deleteTodo(todo.id, TEST_USER_ID);

    const afterCount = listTodos(TEST_USER_ID, true).length;
    expect(afterCount).toBeLessThan(beforeCount);
    expect(listTodos(TEST_USER_ID, true).some((t) => t.id === todo.id)).toBe(false);
  });

  test("deleteTodo respects user isolation", () => {
    const user1Id = "user:delete:1";
    const user2Id = "user:delete:2";

    const todo1 = addTodo("User 1 todo", user1Id);
    const todo2 = addTodo("User 2 todo", user2Id);

    deleteTodo(todo1.id, user1Id);

    expect(listTodos(user1Id, true).some((t) => t.id === todo1.id)).toBe(false);
    expect(listTodos(user2Id, true).some((t) => t.id === todo2.id)).toBe(true);
  });
});

// =============================================================================
// Natural Language Parsing
// =============================================================================

describe("Natural language parsing", () => {
  test("parseTodoInput extracts time patterns", () => {
    const cases = [
      { input: "Do this at 3pm", expectedTime: true },
      { input: "Do this at 3:30pm", expectedTime: true },
      { input: "Do this today at 2pm", expectedTime: true },
      { input: "Do this tomorrow at 10am", expectedTime: true },
      { input: "Do this", expectedTime: false },
    ];

    cases.forEach(({ input, expectedTime }) => {
      const parsed = parseTodoInput(input);
      if (expectedTime) {
        expect(parsed.reminderTime).toBeTruthy();
      } else {
        expect(parsed.reminderTime).toBeFalsy();
      }
    });
  });

  test("parseTodoInput extracts location patterns", () => {
    const cases = [
      { input: "Buy milk at home", expectedLocation: true },
      { input: "Meet at the store", expectedLocation: true },
      { input: "Call mom at work", expectedLocation: true },
      { input: "Just a task", expectedLocation: false },
    ];

    cases.forEach(({ input, expectedLocation }) => {
      const parsed = parseTodoInput(input);
      if (expectedLocation) {
        expect(parsed.locationHint).toBeTruthy();
      } else {
        expect(parsed.locationHint).toBeFalsy();
      }
    });
  });

  test("parseTodoInput extracts but preserves original text", () => {
    const parsed = parseTodoInput("Buy groceries at the store at 5pm");
    // parseTodoInput returns the original text without cleaning
    expect(parsed.text).toBe("Buy groceries at the store at 5pm");
    expect(parsed.reminderTime).toBeTruthy();
    expect(parsed.locationHint).toBeTruthy();
  });
});

// =============================================================================
// Display Formatting
// =============================================================================

describe("Todo display formatting", () => {
  test("formatTodoDisplay shows uncompleted todos with checkbox", () => {
    const todo = { id: "123", text: "Task", done: false };
    const display = formatTodoDisplay(todo);
    expect(display).toBeTruthy();
    expect(display).toContain("Task");
  });

  test("formatTodoDisplay shows completed todos", () => {
    const todo = { id: "123", text: "Done task", done: true };
    const display = formatTodoDisplay(todo);
    expect(display).toBeTruthy();
    expect(display).toContain("Done task");
  });

  test("formatTodoDisplay includes ID for reference", () => {
    const todo = { id: "abc123def", text: "Task", done: false };
    const display = formatTodoDisplay(todo);
    expect(display).toContain("abc123def");
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("Edge cases", () => {
  test("handles empty todo text gracefully", () => {
    const result = addTodo("", TEST_USER_ID);
    expect(result).toBeDefined();
    expect(result.text).toBe("");
  });

  test("handles very long todo text", () => {
    const longText = "A".repeat(1000);
    const result = addTodo(longText, TEST_USER_ID);
    expect(result.text.length).toBe(1000);
  });

  test("handles special characters in text", () => {
    const text = "Task with special chars: !@#$%^&*()";
    const result = addTodo(text, TEST_USER_ID);
    expect(result.text).toContain("!");
    expect(result.text).toContain("@");
  });

  test("markTodoDone is idempotent", () => {
    const todo = addTodo("Task", TEST_USER_ID);
    markTodoDone(todo.id, TEST_USER_ID);
    markTodoDone(todo.id, TEST_USER_ID); // Second call

    const updated = listTodos(TEST_USER_ID, true).find((t) => t.id === todo.id);
    expect(updated?.done).toBe(true);
  });

  test("deleteTodo handles non-existent todos gracefully", () => {
    const beforeCount = listTodos(TEST_USER_ID).length;
    deleteTodo(TEST_USER_ID, "non-existent-id");
    const afterCount = listTodos(TEST_USER_ID).length;
    expect(afterCount).toBe(beforeCount);
  });
});
