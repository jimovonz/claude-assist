import { spawn, type Subprocess } from "bun";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = process.env.CONDUIT_STATE_DIR ?? join(homedir(), ".local", "state", "claude-assist");
const TUNNEL_URL_FILE = join(STATE_DIR, "tunnel-url");

/**
 * Manages a cloudflared tunnel as a child process.
 * Supports both named tunnels (with token) and quick tunnels (no auth).
 * Auto-restarts on crash.
 */
export class TunnelManager {
  private proc: Subprocess | null = null;
  private stopped = false;
  private token?: string;
  private localUrl: string;
  private _publicUrl: string | null = null;
  private urlResolve?: (url: string) => void;
  private urlPromise: Promise<string>;

  constructor(opts: { token?: string; localUrl: string }) {
    this.token = opts.token;
    this.localUrl = opts.localUrl;
    this.urlPromise = new Promise((resolve) => {
      this.urlResolve = resolve;
    });
  }

  /** Resolves once the tunnel URL is known. */
  get publicUrl(): Promise<string> {
    return this.urlPromise;
  }

  start(): void {
    if (this.stopped) return;

    const cmd = this.token
      ? ["cloudflared", "tunnel", "run", "--token", this.token]
      : ["cloudflared", "tunnel", "--url", this.localUrl];

    const mode = this.token ? "named" : "quick";
    console.log(`[tunnel] Starting cloudflared (${mode})...`);

    this.proc = spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.monitorOutput();

    this.proc.exited.then((code) => {
      if (this.stopped) return;
      console.log(`[tunnel] cloudflared exited with code ${code}, restarting in 5s...`);
      setTimeout(() => this.start(), 5000);
    });
  }

  private async monitorOutput(): Promise<void> {
    if (!this.proc?.stderr) return;

    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Capture quick tunnel URL
          const urlMatch = trimmed.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (urlMatch && !this._publicUrl) {
            this._publicUrl = urlMatch[0];
            console.log(`[tunnel] Public URL: ${this._publicUrl}`);
            try {
              mkdirSync(STATE_DIR, { recursive: true });
              writeFileSync(TUNNEL_URL_FILE, this._publicUrl);
            } catch (err) {
              console.error(`[tunnel] Failed to persist URL to ${TUNNEL_URL_FILE}:`, err);
            }
            this.urlResolve?.(this._publicUrl);
          }

          if (trimmed.includes("Registered tunnel connection") ||
              trimmed.includes("error") ||
              trimmed.includes("failed")) {
            console.log(`[tunnel] ${trimmed}`);
          }
        }
      }
    } catch {
      // Stream ended
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
      console.log("[tunnel] Stopped cloudflared");
    }
  }
}

/**
 * Start a tunnel if CLOUDFLARE_TUNNEL_TOKEN is set (named tunnel)
 * or if no VIEW_BASE_URL is configured (quick tunnel as fallback).
 * Returns [manager, publicUrl] or null if a static VIEW_BASE_URL is set.
 */
export async function startTunnel(localUrl: string): Promise<{ manager: TunnelManager; publicUrl: string } | null> {
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  const staticBase = process.env.VIEW_BASE_URL;

  // If a static base URL is explicitly set and no tunnel token, no tunnel needed
  if (staticBase && !token) return null;

  // If there's a token, use named tunnel; otherwise use quick tunnel
  const manager = new TunnelManager({ token: token || undefined, localUrl });
  manager.start();

  if (token && staticBase) {
    // Named tunnel with known URL — don't wait for discovery
    return { manager, publicUrl: staticBase };
  }

  // Wait for the quick tunnel URL (with timeout)
  const publicUrl = await Promise.race([
    manager.publicUrl,
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Tunnel URL not received within 15s")), 15000)
    ),
  ]);

  return { manager, publicUrl };
}
