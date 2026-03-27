import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolated state DB for location integration tests
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-edge-relay-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

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

// =============================================================================
// handleLocationUpdate integration
//
// Tests the full flow: OwnTracks message → parse → storeLocationUpdate →
// checkGeofences. Uses real SQLite state module via CONDUIT_STATE_DIR.
// =============================================================================

const {
  createLocation,
  getLatestLocation,
  listLocations,
  closeDb,
} = await import("../src/conduit/state");

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

describe("handleLocationUpdate integration", () => {
  test("stores location update and it appears in history", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    const handler = (relay as any).handleLocationUpdate.bind(relay);

    handler({ lat: -37.7, lon: 176.2, accuracy: 5, timestamp: 1000000 });

    const latest = getLatestLocation();
    expect(latest).not.toBeNull();
    expect(latest!.lat).toBe(-37.7);
    expect(latest!.lon).toBe(176.2);
    expect(latest!.accuracy).toBe(5);
  });

  test("skips update with missing lat/lon", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    const handler = (relay as any).handleLocationUpdate.bind(relay);

    const before = getLatestLocation();
    handler({ lon: 176.2 }); // no lat
    handler({ lat: -37.7 }); // no lon
    handler({}); // neither
    const after = getLatestLocation();

    // Latest should not have changed (still the one from prior test)
    expect(after!.lat).toBe(before!.lat);
  });

  test("generates timestamp when not provided", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    const handler = (relay as any).handleLocationUpdate.bind(relay);

    const now = Math.floor(Date.now() / 1000);
    handler({ lat: -36.0, lon: 175.0 }); // no timestamp

    const latest = getLatestLocation();
    expect(latest!.timestamp).toBeGreaterThanOrEqual(now - 2);
    expect(latest!.timestamp).toBeLessThanOrEqual(now + 2);
  });

  test("logs geofence match when inside radius", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    const handler = (relay as any).handleLocationUpdate.bind(relay);

    // Create a geofence and send update inside it
    createLocation("Edge Test Home", -37.7, 176.2, 500);

    // Capture console.log
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    handler({ lat: -37.7, lon: 176.2, timestamp: 2000000 });

    console.log = origLog;

    const matchLog = logs.find(l => l.includes("Edge Test Home"));
    expect(matchLog).toBeDefined();
  });

  test("logs no match when outside all geofences", () => {
    const relay = new EdgeRelay({ edgeUrl: "https://example.com" });
    const handler = (relay as any).handleLocationUpdate.bind(relay);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    // Point far from any defined location
    handler({ lat: 0, lon: 0, timestamp: 3000000 });

    console.log = origLog;

    const noMatchLog = logs.find(l => l.includes("no geofence match"));
    expect(noMatchLog).toBeDefined();
  });
});
