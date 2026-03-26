import { test, expect, describe, beforeEach, mock } from "bun:test";

// =============================================================================
// Mock Grammy at module level
//
// We replace the Grammy Bot with a minimal mock that captures API calls.
// This tests the TelegramChannel's behavioral contract, not Grammy internals.
// =============================================================================

const sentMessages: { chatId: number; text: string }[] = [];
const editedMessages: { chatId: number; messageId: number; text: string }[] = [];
const deletedMessages: { chatId: number; messageId: number }[] = [];
const chatActions: { chatId: number; action: string }[] = [];
let nextMessageId = 1;

function resetMocks() {
  sentMessages.length = 0;
  editedMessages.length = 0;
  deletedMessages.length = 0;
  chatActions.length = 0;
  nextMessageId = 1;
}

mock.module("grammy", () => ({
  Bot: class MockBot {
    api = {
      sendMessage: mock((chatId: number, text: string) => {
        const msg = { message_id: nextMessageId++, chat: { id: chatId } };
        sentMessages.push({ chatId, text });
        return Promise.resolve(msg);
      }),
      editMessageText: mock((chatId: number, messageId: number, text: string) => {
        editedMessages.push({ chatId, messageId, text });
        return Promise.resolve(true);
      }),
      deleteMessage: mock((chatId: number, messageId: number) => {
        deletedMessages.push({ chatId, messageId });
        return Promise.resolve(true);
      }),
      sendChatAction: mock((chatId: number, action: string) => {
        chatActions.push({ chatId, action });
        return Promise.resolve(true);
      }),
    };
    on() { return this; }
    catch() { return this; }
    start() {}
    stop() {}
  },
}));

// Import AFTER mock is registered
const { TelegramChannel, escapeHtml, buildViewsListMarkdown } = await import("../src/conduit/channels/telegram");

// =============================================================================
// Message Delivery
//
// Messages sent to Telegram must respect the 4096 character limit.
// Chunking must split on line boundaries to avoid breaking formatting.
// =============================================================================

describe("message delivery", () => {
  let channel: InstanceType<typeof TelegramChannel>;

  beforeEach(() => {
    resetMocks();
    channel = new TelegramChannel({ botToken: "test-token" });
  });

  test("short message is sent as single message", async () => {
    await channel.reply("42", "Hello there!");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe("Hello there!");
    expect(sentMessages[0].chatId).toBe(42);
  });

  test("message under 4096 chars is sent as single message", async () => {
    const text = "Line\n".repeat(800); // ~4000 chars
    await channel.reply("42", text);
    expect(sentMessages).toHaveLength(1);
  });

  test("message over 4096 chars is split into chunks", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"x".repeat(50)}`);
    const text = lines.join("\n"); // ~5800 chars
    await channel.reply("42", text);
    expect(sentMessages.length).toBeGreaterThan(1);
  });

  test("no chunk exceeds 4096 characters", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"x".repeat(50)}`);
    const text = lines.join("\n");
    await channel.reply("42", text);

    for (const msg of sentMessages) {
      expect(msg.text.length).toBeLessThanOrEqual(4096);
    }
  });

  test("single line exceeding 4096 chars is handled without data loss", async () => {
    // A single line of 5000 characters with no newlines.
    // The channel MUST either split it or send it — but no chunk should
    // exceed 4096 chars if the Telegram API is to accept it.
    const longLine = "x".repeat(5000);
    await channel.reply("42", longLine);

    // Verify no data is silently dropped
    const totalSent = sentMessages.map((m) => m.text).join("");
    expect(totalSent).toHaveLength(5000);

    // Verify no individual message exceeds Telegram's limit
    for (const msg of sentMessages) {
      expect(msg.text.length).toBeLessThanOrEqual(4096);
    }
  });

  test("all content is preserved across chunks (no dropped lines)", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `LINE-${i}`);
    const text = lines.join("\n");
    await channel.reply("42", text);

    const reassembled = sentMessages.map((m) => m.text).join("\n");
    for (const line of lines) {
      expect(reassembled).toContain(line);
    }
  });
});

// =============================================================================
// View Links
//
// When a response has an associated view, the reply must include both
// a summary and the view URL.
// =============================================================================

describe("view link delivery", () => {
  let channel: InstanceType<typeof TelegramChannel>;

  beforeEach(() => {
    resetMocks();
    channel = new TelegramChannel({ botToken: "test-token" });
  });

  test("replyWithView includes the view URL in the message", async () => {
    await channel.replyWithView("42", "Summary here", "https://example.com/view/abc123");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("https://example.com/view/abc123");
    expect(sentMessages[0].text).toContain("Summary here");
  });
});

// =============================================================================
// Status Updates
//
// Status messages provide real-time progress. They must be throttled to
// avoid Telegram rate limits (min 5s between edits), and cleaned up
// when the final reply is sent.
// =============================================================================

describe("status updates", () => {
  let channel: InstanceType<typeof TelegramChannel>;

  beforeEach(() => {
    resetMocks();
    channel = new TelegramChannel({ botToken: "test-token" });
  });

  test("first status sends a new message", async () => {
    await channel.sendStatus("42", "Thinking...");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe("Thinking...");
  });

  test("rapid status updates within 5s do not trigger immediate edits", async () => {
    await channel.sendStatus("42", "Step 1");
    // These arrive within 5s — should be queued, not edited immediately
    await channel.sendStatus("42", "Step 2");
    await channel.sendStatus("42", "Step 3");

    // Only the initial send should have happened; edits are deferred
    expect(editedMessages).toHaveLength(0);
  });

  test("reply clears pending status state", async () => {
    await channel.sendStatus("42", "Working...");
    await channel.reply("42", "Done!");

    // The reply message should be "Done!", not the status
    const lastMessage = sentMessages[sentMessages.length - 1];
    expect(lastMessage.text).toBe("Done!");
  });
});

// =============================================================================
// User Allowlist
//
// When an allowlist is configured, only listed users should trigger the
// message handler. Others are silently ignored.
// =============================================================================

describe("user allowlist", () => {
  test("allowlist is populated from config", () => {
    const channel = new TelegramChannel({
      botToken: "test-token",
      allowedUserIds: ["111", "222"],
    });
    // Verify internal state — the allowlist controls access
    const allowedSet = (channel as any).allowedUserIds as Set<string>;
    expect(allowedSet.has("111")).toBe(true);
    expect(allowedSet.has("222")).toBe(true);
    expect(allowedSet.has("333")).toBe(false);
  });

  test("addAllowedUser adds to the set, removeAllowedUser removes", () => {
    const channel = new TelegramChannel({
      botToken: "test-token",
      allowedUserIds: ["111"],
    });
    const allowedSet = (channel as any).allowedUserIds as Set<string>;

    channel.addAllowedUser("222");
    expect(allowedSet.has("222")).toBe(true);

    channel.removeAllowedUser("111");
    expect(allowedSet.has("111")).toBe(false);

    expect(allowedSet.size).toBe(1);
  });

  test("empty allowlist allows all users (no filtering)", () => {
    const channel = new TelegramChannel({
      botToken: "test-token",
      // No allowedUserIds — should allow everyone
    });
    const allowedSet = (channel as any).allowedUserIds as Set<string>;
    expect(allowedSet.size).toBe(0);
  });
});

// =============================================================================
// Telegram Utility Functions
// =============================================================================

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("handles string with no special chars", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("handles multiple special chars", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
});

describe("buildViewsListMarkdown", () => {
  test("returns header for empty views", () => {
    const result = buildViewsListMarkdown([]);
    expect(result).toContain("## Previous Responses");
  });

  test("includes view title and URL", () => {
    const views = [{
      slug: "test-abc",
      title: "Test View",
      url: "https://example.com/view/test-abc",
      localUrl: "/view/test-abc",
      createdAt: "2026-03-26T10:00:00.000Z",
      chars: 500,
    }];
    const result = buildViewsListMarkdown(views);
    expect(result).toContain("Test View");
    expect(result).toContain("https://example.com/view/test-abc");
    expect(result).toContain("500");
  });

  test("formats large char counts with K suffix", () => {
    const views = [{
      slug: "big-abc",
      title: "Big View",
      url: "/view/big-abc",
      localUrl: "/view/big-abc",
      createdAt: "2026-03-26T10:00:00.000Z",
      chars: 5000,
    }];
    const result = buildViewsListMarkdown(views);
    expect(result).toContain("5.0K");
  });

  test("groups views by day", () => {
    const views = [
      {
        slug: "a", title: "View A", url: "/a", localUrl: "/a",
        createdAt: "2026-03-26T10:00:00.000Z", chars: 100,
      },
      {
        slug: "b", title: "View B", url: "/b", localUrl: "/b",
        createdAt: "2026-03-25T10:00:00.000Z", chars: 200,
      },
    ];
    const result = buildViewsListMarkdown(views);
    // Should have day headers (### format)
    expect((result.match(/###/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test("limits to 50 views", () => {
    const views = Array.from({ length: 60 }, (_, i) => ({
      slug: `v-${i}`, title: `View ${i}`, url: `/v-${i}`, localUrl: `/v-${i}`,
      createdAt: `2026-03-26T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      chars: 100,
    }));
    const result = buildViewsListMarkdown(views);
    // Should not contain views beyond index 50
    expect(result).not.toContain("View 55");
  });
});
