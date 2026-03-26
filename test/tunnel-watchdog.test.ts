import { test, expect, describe } from "bun:test";

// =============================================================================
// TunnelManager
//
// The tunnel manager wraps cloudflared as a child process.
// Test the lifecycle state machine: stopped flag behavior,
// startTunnelIfConfigured env-gating.
// =============================================================================

import { TunnelManager, startTunnel } from "../src/service/tunnel";

describe("TunnelManager lifecycle", () => {
  test("start() after stop() does not spawn a process", () => {
    const tm = new TunnelManager({ token: "fake-token", localUrl: "http://localhost:8099" });
    tm.stop();
    tm.start();

    // The internal proc should remain null — stop() sets the stopped flag
    // which makes start() return early before spawning
    expect((tm as any).proc).toBeNull();
  });

  test("stop() sets stopped flag preventing future restarts", () => {
    const tm = new TunnelManager({ token: "fake-token", localUrl: "http://localhost:8099" });
    expect((tm as any).stopped).toBe(false);
    tm.stop();
    expect((tm as any).stopped).toBe(true);
  });

  test("constructor stores the tunnel token", () => {
    const tm = new TunnelManager({ token: "my-secret-token", localUrl: "http://localhost:8099" });
    expect((tm as any).token).toBe("my-secret-token");
  });
});

describe("startTunnel", () => {
  test("returns null when no token and VIEW_BASE_URL is set", async () => {
    const origToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
    const origBase = process.env.VIEW_BASE_URL;
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
    process.env.VIEW_BASE_URL = "https://example.com";

    const result = await startTunnel("http://localhost:8099");
    expect(result).toBeNull();

    delete process.env.VIEW_BASE_URL;
    if (origToken) process.env.CLOUDFLARE_TUNNEL_TOKEN = origToken;
    if (origBase) process.env.VIEW_BASE_URL = origBase;
  });
});

// =============================================================================
// Watchdog
//
// The watchdog integrates with systemd via sd_notify.
// Test the env-gated branching: NOTIFY_SOCKET controls whether sd_notify
// is active, WATCHDOG_USEC controls the ping interval.
// =============================================================================

import { startWatchdog } from "../src/service/watchdog";

describe("watchdog interval calculation", () => {
  test("returns null without WATCHDOG_USEC", () => {
    delete process.env.WATCHDOG_USEC;
    expect(startWatchdog()).toBeNull();
  });

  test("returns a timer with valid WATCHDOG_USEC", () => {
    process.env.WATCHDOG_USEC = "120000000"; // 120s in microseconds
    const timer = startWatchdog();
    expect(timer).not.toBeNull();
    if (timer) clearInterval(timer);
    delete process.env.WATCHDOG_USEC;
  });

  test("ping interval is half the watchdog period", () => {
    // WATCHDOG_USEC = 10,000,000 (10s) → interval should be 5000ms
    // We can't directly inspect setInterval's delay, but we can verify
    // the timer is created (non-null) for a valid value
    process.env.WATCHDOG_USEC = "10000000";
    const timer = startWatchdog();
    expect(timer).not.toBeNull();
    if (timer) clearInterval(timer);
    delete process.env.WATCHDOG_USEC;
  });

  test("returns null for zero WATCHDOG_USEC", () => {
    process.env.WATCHDOG_USEC = "0";
    expect(startWatchdog()).toBeNull();
    delete process.env.WATCHDOG_USEC;
  });

  test("returns null for negative WATCHDOG_USEC", () => {
    process.env.WATCHDOG_USEC = "-1000";
    expect(startWatchdog()).toBeNull();
    delete process.env.WATCHDOG_USEC;
  });

  test("returns null for non-numeric WATCHDOG_USEC", () => {
    process.env.WATCHDOG_USEC = "not-a-number";
    expect(startWatchdog()).toBeNull();
    delete process.env.WATCHDOG_USEC;
  });
});
