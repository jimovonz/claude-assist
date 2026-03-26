import { test, expect, describe } from "bun:test";
import { EdgeRelay } from "../src/service/edge-relay";

// =============================================================================
// EdgeRelay Unit Tests
//
// Tests the EdgeRelay class in isolation — no actual WebSocket connections.
// Verifies constructor setup, Channel interface compliance, and state management.
// =============================================================================

describe("EdgeRelay constructor", () => {
  test("converts http URL to ws URL", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    expect((relay as any).wsUrl).toBe("wss://example.com/ws/conduit");
  });

  test("converts http to ws", () => {
    const relay = new EdgeRelay({ edgeUrl: "http://localhost:8080" });
    expect((relay as any).wsUrl).toBe("ws://localhost:8080/ws/conduit");
  });

  test("stores API secret", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com", apiSecret: "secret123" });
    expect((relay as any).apiSecret).toBe("secret123");
  });

  test("has correct channel id and name", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    expect(relay.id).toBe("edge-tui");
    expect(relay.name).toBe("Remote TUI");
  });
});

describe("EdgeRelay lifecycle", () => {
  test("stop sets stopped flag", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    expect((relay as any).stopped).toBe(false);
    await relay.stop();
    expect((relay as any).stopped).toBe(true);
  });

  test("stop prevents future reconnection", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    (relay as any).reconnectTimer = setTimeout(() => {}, 10000);
    await relay.stop();
    expect((relay as any).stopped).toBe(true);
    // After stop, scheduleReconnect should be a no-op
    (relay as any).scheduleReconnect();
    // reconnectDelay should not have changed since stopped check returns early
    expect((relay as any).reconnectDelay).toBe(1000);
  });

  test("connected returns false when no websocket", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    expect(relay.connected).toBe(false);
  });
});

describe("EdgeRelay reconnect backoff", () => {
  test("initial reconnect delay is 1000ms", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    expect((relay as any).reconnectDelay).toBe(1000);
  });

  test("scheduleReconnect doubles delay", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    (relay as any).scheduleReconnect();
    expect((relay as any).reconnectDelay).toBe(2000);
    clearTimeout((relay as any).reconnectTimer);
  });

  test("delay caps at 30 seconds", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    (relay as any).reconnectDelay = 20000;
    (relay as any).scheduleReconnect();
    expect((relay as any).reconnectDelay).toBe(30000);
    clearTimeout((relay as any).reconnectTimer);

    (relay as any).scheduleReconnect();
    expect((relay as any).reconnectDelay).toBe(30000); // stays at cap
    clearTimeout((relay as any).reconnectTimer);
  });

  test("scheduleReconnect does nothing when stopped", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    await relay.stop();
    (relay as any).scheduleReconnect();
    expect((relay as any).reconnectTimer).toBeNull();
  });
});

describe("EdgeRelay Channel interface", () => {
  test("reply sends result message (no-op when disconnected)", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    // Should not throw when no WebSocket connected
    await relay.reply("user1", "Hello");
  });

  test("sendStatus sends status message (no-op when disconnected)", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    await relay.sendStatus("user1", "Thinking...");
  });

  test("sendStreamText sends text message (no-op when disconnected)", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    await relay.sendStreamText("user1", "Partial text");
  });

  test("sendStreamEnd sends text_end (no-op when disconnected)", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    await relay.sendStreamEnd("user1");
  });

  test("sendTyping is a no-op", async () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    await relay.sendTyping("user1");
  });
});
