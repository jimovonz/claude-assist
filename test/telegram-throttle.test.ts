import { test, expect, describe, beforeEach, mock } from "bun:test";

// =============================================================================
// Status Throttle Flush
//
// The Telegram channel enforces a 5-second cooldown between status edits.
// Updates within the cooldown are queued, and only the LATEST one is
// delivered when the timer fires. This tests the actual timer behavior.
// =============================================================================

const sentMessages: { chatId: number; text: string }[] = [];
const editedMessages: { chatId: number; messageId: number; text: string }[] = [];
let nextMessageId = 1;

function resetMocks() {
  sentMessages.length = 0;
  editedMessages.length = 0;
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
      deleteMessage: mock(() => Promise.resolve(true)),
      sendChatAction: mock(() => Promise.resolve(true)),
    };
    on() { return this; }
    catch() { return this; }
    start() {}
    stop() {}
  },
}));

const { TelegramChannel } = await import("../src/conduit/channels/telegram");

describe("status throttle flush", () => {
  let channel: InstanceType<typeof TelegramChannel>;

  beforeEach(() => {
    resetMocks();
    channel = new TelegramChannel({ botToken: "test-token" });
  });

  test("deferred status is actually delivered after cooldown", async () => {
    // First status — sends immediately
    await channel.sendStatus("42", "Step 1");
    expect(sentMessages).toHaveLength(1);

    // Rapid update within 5s — queued
    await channel.sendStatus("42", "Step 2");
    expect(editedMessages).toHaveLength(0); // not yet

    // Wait for the cooldown timer to fire (5s + buffer)
    await Bun.sleep(5500);

    // The deferred flush should have edited the message
    expect(editedMessages.length).toBeGreaterThanOrEqual(1);
    const lastEdit = editedMessages[editedMessages.length - 1];
    expect(lastEdit.text).toBe("Step 2");

    await channel.stop();
  }, 10000);

  test("only the latest queued status is delivered (intermediate dropped)", async () => {
    await channel.sendStatus("42", "Step 1"); // sent immediately
    await channel.sendStatus("42", "Step 2"); // queued
    await channel.sendStatus("42", "Step 3"); // replaces Step 2 in queue
    await channel.sendStatus("42", "Step 4"); // replaces Step 3 in queue

    // Wait for cooldown
    await Bun.sleep(5500);

    // Only "Step 4" should have been delivered (latest wins)
    const editTexts = editedMessages.map((e) => e.text);
    expect(editTexts).toContain("Step 4");
    expect(editTexts).not.toContain("Step 2");
    expect(editTexts).not.toContain("Step 3");

    await channel.stop();
  }, 10000);

  test("reply clears pending status so it is never delivered", async () => {
    await channel.sendStatus("42", "Working...");
    await channel.sendStatus("42", "Still working..."); // queued

    // Reply arrives before the timer fires
    await channel.reply("42", "Done!");

    // Wait past the cooldown
    await Bun.sleep(5500);

    // "Still working..." should NOT have been edited in — it was cleared
    const editTexts = editedMessages.map((e) => e.text);
    expect(editTexts).not.toContain("Still working...");

    // Final message should be "Done!"
    const lastSent = sentMessages[sentMessages.length - 1];
    expect(lastSent.text).toBe("Done!");

    await channel.stop();
  }, 10000);

  test("status after sufficient delay edits immediately without timer", async () => {
    await channel.sendStatus("42", "Step 1");

    // Wait for cooldown to pass
    await Bun.sleep(5100);

    // Now send another status — should edit immediately (no timer needed)
    await channel.sendStatus("42", "Step 2");
    expect(editedMessages.length).toBeGreaterThanOrEqual(1);
    const lastEdit = editedMessages[editedMessages.length - 1];
    expect(lastEdit.text).toBe("Step 2");

    await channel.stop();
  }, 10000);
});
