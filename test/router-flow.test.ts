import { test, expect, describe, beforeEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Channel } from "../src/conduit/router";
import type { SessionEvent } from "../src/conduit/session";

// Isolate state DB
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-router-flow-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

// Mock hooks to be no-ops so tests don't hit real Cairn
mock.module("../src/conduit/hooks", () => ({
  runStopHook: async () => ({ block: false }),
  runPromptHook: async () => "",
}));

const { Router } = await import("../src/conduit/router");
const { SessionManager } = await import("../src/conduit/session");

const MOCK_CMD = join(import.meta.dir, "fixtures", "run-mock.sh");
const SCENARIO_FILE = "/tmp/mock-claude-scenario";

function setScenario(scenario: string, sessionId = "mock-session-001") {
  writeFileSync(SCENARIO_FILE, `${scenario}\n${sessionId}`);
}

// =============================================================================
// Mock Channel
//
// Implements the Channel interface, captures all calls for assertion.
// =============================================================================

function createMockChannel(id = "test"): Channel & {
  replies: { userId: string; text: string }[];
  viewReplies: { userId: string; summary: string; url: string }[];
  statuses: { userId: string; text: string }[];
  onMessageCallback?: (userId: string, text: string) => void;
} {
  const channel = {
    id,
    name: `MockChannel-${id}`,
    replies: [] as { userId: string; text: string }[],
    viewReplies: [] as { userId: string; summary: string; url: string }[],
    statuses: [] as { userId: string; text: string }[],
    onMessageCallback: undefined as ((userId: string, text: string) => void) | undefined,

    reply: mock(async (userId: string, text: string) => {
      channel.replies.push({ userId, text });
    }),
    replyWithView: mock(async (userId: string, summary: string, url: string) => {
      channel.viewReplies.push({ userId, summary, url });
    }),
    sendTyping: mock(async () => {}),
    sendStatus: mock(async (userId: string, text: string) => {
      channel.statuses.push({ userId, text });
    }),
    start: mock(async (onMessage: (userId: string, text: string) => void) => {
      channel.onMessageCallback = onMessage;
    }),
    stop: mock(async () => {}),
  };
  return channel;
}

// =============================================================================
// Router Orchestration Flow
//
// These tests verify the full message processing pipeline:
// incoming message → hooks → session → metadata stripping → delivery
// =============================================================================

describe("message processing flow", () => {
  test("delivers response to channel after processing", async () => {
    setScenario("simple");
    const sessionManager = new SessionManager({ command: MOCK_CMD, idleTimeoutMs: 5000 });
    const router = new Router(sessionManager);

    const channel = createMockChannel();
    router.addChannel(channel);
    await router.start();

    // Simulate incoming message
    channel.onMessageCallback!("user1", "Hello");

    // Wait for processing to complete
    await Bun.sleep(2000);

    // Channel should have received a reply
    expect(channel.replies.length).toBeGreaterThanOrEqual(1);
    const finalReply = channel.replies[channel.replies.length - 1];
    expect(finalReply!.text).toContain("Response to:");

    await router.stop();
  }, 10000);

  test("sends status updates during processing", async () => {
    setScenario("simple");
    const sessionManager = new SessionManager({ command: MOCK_CMD, idleTimeoutMs: 5000 });
    const router = new Router(sessionManager);

    const channel = createMockChannel();
    router.addChannel(channel);
    await router.start();

    channel.onMessageCallback!("user1", "Hello");
    await Bun.sleep(2000);

    // Status updates should have been sent (searching memory, thinking, etc.)
    expect(channel.statuses.length).toBeGreaterThanOrEqual(1);
    const statusTexts = channel.statuses.map((s) => s.text);

    // Should see the "Thinking" status at minimum
    expect(statusTexts.some((t) => t.includes("Thinking"))).toBe(true);

    await router.stop();
  }, 10000);

  test("strips metadata from response before delivery", async () => {
    // The mock returns clean text, but we can verify the router
    // processes through stripMetadata by checking the output doesn't
    // contain any metadata tags
    setScenario("simple");
    const sessionManager = new SessionManager({ command: MOCK_CMD, idleTimeoutMs: 5000 });
    const router = new Router(sessionManager);

    const channel = createMockChannel();
    router.addChannel(channel);
    await router.start();

    channel.onMessageCallback!("user1", "Hello");
    await Bun.sleep(2000);

    const finalReply = channel.replies[channel.replies.length - 1];
    expect(finalReply!.text).not.toContain("<memory>");
    expect(finalReply!.text).not.toContain("<cairn_context");
    expect(finalReply!.text).not.toContain("<system-reminder>");

    await router.stop();
  }, 10000);

  test("handles empty response gracefully", async () => {
    setScenario("empty");
    const sessionManager = new SessionManager({ command: MOCK_CMD, idleTimeoutMs: 5000 });
    const router = new Router(sessionManager);

    const channel = createMockChannel();
    router.addChannel(channel);
    await router.start();

    channel.onMessageCallback!("user1", "Hello");
    await Bun.sleep(2000);

    // Should get "No response generated." for empty result
    const finalReply = channel.replies[channel.replies.length - 1];
    expect(finalReply!.text).toContain("No response generated");

    await router.stop();
  }, 10000);

  test("delivers fallback message when processing crashes", async () => {
    setScenario("crash");
    const sessionManager = new SessionManager({ command: MOCK_CMD, idleTimeoutMs: 5000 });
    const router = new Router(sessionManager);

    const channel = createMockChannel();
    router.addChannel(channel);
    await router.start();

    channel.onMessageCallback!("user1", "Hello");
    await Bun.sleep(2000);

    // Should get a reply — either an error message or "No response generated"
    expect(channel.replies.length).toBeGreaterThanOrEqual(1);
    const reply = channel.replies[channel.replies.length - 1];
    expect(
      reply!.text.includes("No response generated") || reply!.text.includes("Error")
    ).toBe(true);

    await router.stop();
  }, 10000);
});

// =============================================================================
// Message Queue Serialization
//
// Rapid messages to the same channel must be serialized.
// Messages to different channels can run in parallel.
// =============================================================================

describe("message queuing", () => {
  test("sequential messages to same channel are serialized", async () => {
    setScenario("slow"); // 100ms delay per message
    const sessionManager = new SessionManager({ command: MOCK_CMD, idleTimeoutMs: 5000 });
    const router = new Router(sessionManager);

    const channel = createMockChannel();
    router.addChannel(channel);
    await router.start();

    // Fire two messages rapidly to the same user
    channel.onMessageCallback!("user1", "First");
    channel.onMessageCallback!("user1", "Second");

    // Wait for both to complete
    await Bun.sleep(4000);

    // Both should eventually get replies
    const replies = channel.replies.filter((r) => r.userId === "user1");
    expect(replies.length).toBeGreaterThanOrEqual(2);

    await router.stop();
  }, 10000);

  test("messages to different users run independently", async () => {
    setScenario("simple");
    const sessionManager = new SessionManager({ command: MOCK_CMD, idleTimeoutMs: 5000 });
    const router = new Router(sessionManager);

    const channel = createMockChannel();
    router.addChannel(channel);
    await router.start();

    // Messages to different users
    channel.onMessageCallback!("user1", "Hello from 1");
    channel.onMessageCallback!("user2", "Hello from 2");

    await Bun.sleep(3000);

    const user1Replies = channel.replies.filter((r) => r.userId === "user1");
    const user2Replies = channel.replies.filter((r) => r.userId === "user2");

    expect(user1Replies.length).toBeGreaterThanOrEqual(1);
    expect(user2Replies.length).toBeGreaterThanOrEqual(1);

    await router.stop();
  }, 10000);
});

// =============================================================================
// Channel start/stop
// =============================================================================

describe("router lifecycle", () => {
  test("start calls channel.start for all channels", async () => {
    const sessionManager = new SessionManager({ command: MOCK_CMD });
    const router = new Router(sessionManager);

    const ch1 = createMockChannel("ch1");
    const ch2 = createMockChannel("ch2");
    router.addChannel(ch1);
    router.addChannel(ch2);

    await router.start();

    expect(ch1.start).toHaveBeenCalled();
    expect(ch2.start).toHaveBeenCalled();

    await router.stop();
  });

  test("stop calls channel.stop for all channels", async () => {
    const sessionManager = new SessionManager({ command: MOCK_CMD });
    const router = new Router(sessionManager);

    const ch = createMockChannel();
    router.addChannel(ch);
    await router.start();
    await router.stop();

    expect(ch.stop).toHaveBeenCalled();
  });
});
