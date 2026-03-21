import { spawn, type Subprocess } from "bun";

/**
 * Manages a cloudflared tunnel as a child process.
 * Auto-restarts on crash.
 */
export class TunnelManager {
  private proc: Subprocess | null = null;
  private token: string;
  private restarting = false;
  private stopped = false;

  constructor(token: string) {
    this.token = token;
  }

  start(): void {
    if (this.stopped) return;

    console.log("[tunnel] Starting cloudflared...");

    this.proc = spawn({
      cmd: [
        "cloudflared", "tunnel", "run",
        "--token", this.token,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Monitor stderr for connection info
    this.monitorOutput();

    // Auto-restart on exit
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
        // Log connection events
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
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
 * Start tunnel if CLOUDFLARE_TUNNEL_TOKEN is set.
 * Returns the manager or null.
 */
export function startTunnelIfConfigured(): TunnelManager | null {
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  if (!token) return null;

  const manager = new TunnelManager(token);
  manager.start();
  return manager;
}
