import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate state
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-ws-test-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const { WebSocketChannel } = await import("../src/conduit/channels/websocket");
const { ViewServer } = await import("../src/views/server");
const { closeDb } = await import("../src/conduit/state");

const TEST_PORT = 19100 + Math.floor(Math.random() * 900);
const TEST_TOKEN = "test-secret-token";

let server: InstanceType<typeof ViewServer>;
let channel: InstanceType<typeof WebSocketChannel>;

beforeAll(async () => {
  channel = new WebSocketChannel({ authToken: TEST_TOKEN });
  server = new ViewServer({
    port: TEST_PORT,
    baseUrl: `http://localhost:${TEST_PORT}`,
    wsChannel: channel,
  });
  server.start();
  await channel.start(() => {});
});

afterAll(() => {
  server.stop();
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

function wsUrl(): string {
  return `ws://localhost:${TEST_PORT}/ws`;
}

function connectAndAuth(token = TEST_TOKEN): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const messages: any[] = [];

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      messages.push(msg);
      if (msg.type === "auth_ok") {
        resolve({ ws, messages });
      }
      if (msg.type === "auth_fail") {
        reject(new Error(msg.reason));
      }
    };

    ws.onerror = () => reject(new Error("WebSocket error"));
    setTimeout(() => reject(new Error("Connection timeout")), 3000);
  });
}

// =============================================================================
// Authentication
// =============================================================================

describe("authentication", () => {
  test("valid token receives auth_ok with userId", async () => {
    const { ws, messages } = await connectAndAuth();
    const authMsg = messages.find((m) => m.type === "auth_ok");
    expect(authMsg).toBeDefined();
    expect(authMsg.userId).toMatch(/^tui-/);
    ws.close();
  });

  test("invalid token receives auth_fail and connection closes", async () => {
    const ws = new WebSocket(wsUrl());
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token: "wrong-token" }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
      };
      ws.onclose = () => resolve();
    });

    const failMsg = messages.find((m) => m.type === "auth_fail");
    expect(failMsg).toBeDefined();
    expect(failMsg.reason).toContain("Invalid");
  });

  test("message before auth is rejected", async () => {
    const ws = new WebSocket(wsUrl());
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        // Send message without authenticating first
        ws.send(JSON.stringify({ type: "message", text: "hello" }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
      };
      ws.onclose = () => resolve();
    });

    const failMsg = messages.find((m) => m.type === "auth_fail");
    expect(failMsg).toBeDefined();
    expect(failMsg.reason).toContain("Not authenticated");
  });
});

// =============================================================================
// Message Routing
// =============================================================================

describe("message routing", () => {
  test("user message triggers onMessage callback", async () => {
    let receivedUserId = "";
    let receivedText = "";

    // Replace the onMessage callback
    await channel.start((userId, text) => {
      receivedUserId = userId;
      receivedText = text;
    });

    const { ws } = await connectAndAuth();
    ws.send(JSON.stringify({ type: "message", text: "Hello Claude" }));

    await Bun.sleep(100);

    expect(receivedUserId).toMatch(/^tui-/);
    expect(receivedText).toBe("Hello Claude");

    ws.close();
  });
});

// =============================================================================
// Outbound Message Delivery
// =============================================================================

describe("outbound delivery", () => {
  test("reply sends result message to correct client", async () => {
    let capturedUserId = "";
    await channel.start((userId) => { capturedUserId = userId; });

    const { ws } = await connectAndAuth();
    ws.send(JSON.stringify({ type: "message", text: "hi" }));
    await Bun.sleep(100);

    const received: any[] = [];
    ws.onmessage = (event) => {
      received.push(JSON.parse(String(event.data)));
    };

    await channel.reply(capturedUserId, "Here is the answer.");
    await Bun.sleep(100);

    const result = received.find((m) => m.type === "result");
    expect(result).toBeDefined();
    expect(result.text).toBe("Here is the answer.");

    ws.close();
  });

  test("sendStatus sends status message", async () => {
    let capturedUserId = "";
    await channel.start((userId) => { capturedUserId = userId; });

    const { ws } = await connectAndAuth();
    ws.send(JSON.stringify({ type: "message", text: "hi" }));
    await Bun.sleep(100);

    const received: any[] = [];
    ws.onmessage = (event) => {
      received.push(JSON.parse(String(event.data)));
    };

    await channel.sendStatus(capturedUserId, "Reading files...");
    await Bun.sleep(100);

    const status = received.find((m) => m.type === "status");
    expect(status).toBeDefined();
    expect(status.text).toBe("Reading files...");

    ws.close();
  });

  test("sendStreamText sends text message for raw streaming", async () => {
    let capturedUserId = "";
    await channel.start((userId) => { capturedUserId = userId; });

    const { ws } = await connectAndAuth();
    ws.send(JSON.stringify({ type: "message", text: "hi" }));
    await Bun.sleep(100);

    const received: any[] = [];
    ws.onmessage = (event) => {
      received.push(JSON.parse(String(event.data)));
    };

    await channel.sendStreamText(capturedUserId, "Partial response content");
    await Bun.sleep(100);

    const text = received.find((m) => m.type === "text");
    expect(text).toBeDefined();
    expect(text.text).toBe("Partial response content");

    ws.close();
  });
});

// =============================================================================
// Connection Lifecycle
// =============================================================================

describe("connection lifecycle", () => {
  test("client disconnect cleans up state", async () => {
    const { ws } = await connectAndAuth();
    const afterConnect = channel.connectedClients;
    expect(afterConnect).toBeGreaterThanOrEqual(1);

    ws.close();
    await Bun.sleep(100);

    expect(channel.connectedClients).toBeLessThan(afterConnect);
  });

  test("invalid JSON is handled gracefully", async () => {
    const { ws } = await connectAndAuth();

    // Should not crash the server
    ws.send("not valid json {{{");
    await Bun.sleep(100);

    // Connection should still be alive
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });

  test("messages to disconnected client are silently dropped", async () => {
    let capturedUserId = "";
    await channel.start((userId) => { capturedUserId = userId; });

    const { ws } = await connectAndAuth();
    ws.send(JSON.stringify({ type: "message", text: "hi" }));
    await Bun.sleep(100);

    ws.close();
    await Bun.sleep(100);

    // Should not throw
    await channel.reply(capturedUserId, "This goes nowhere");
    await channel.sendStatus(capturedUserId, "This too");
  });
});

// =============================================================================
// No-Auth Mode
// =============================================================================

describe("no-auth mode", () => {
  test("channel without authToken accepts any token in auth message", async () => {
    const noAuthChannel = new WebSocketChannel(); // no token
    const noAuthPort = TEST_PORT + 1;
    const noAuthServer = new ViewServer({
      port: noAuthPort,
      wsChannel: noAuthChannel,
    });
    noAuthServer.start();
    await noAuthChannel.start(() => {});

    const ws = new WebSocket(`ws://localhost:${noAuthPort}/ws`);
    const messages: any[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        // Even without authToken configured, client still sends auth to register userId
        ws.send(JSON.stringify({ type: "auth", token: "anything" }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
        if (messages.some((m) => m.type === "auth_ok")) resolve();
      };
      setTimeout(resolve, 2000);
    });

    expect(messages.some((m) => m.type === "auth_ok")).toBe(true);

    ws.close();
    noAuthServer.stop();
  });
});
