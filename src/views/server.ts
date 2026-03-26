import { join } from "path";
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import type { ServerWebSocket } from "bun";
import type { WebSocketChannel } from "../conduit/channels/websocket";

const VIEWS_DIR = join(import.meta.dir, "..", "..", "views");

export interface HealthProvider {
  uptime: number;
  activeSessionCount: number;
}

export interface ViewServerConfig {
  port?: number;
  baseUrl?: string;
  healthProvider?: HealthProvider;
  wsChannel?: WebSocketChannel;
}

export class ViewServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private _baseUrl: string;
  private healthProvider?: HealthProvider;
  private wsChannel?: WebSocketChannel;

  constructor(config: ViewServerConfig = {}) {
    this.port = config.port ?? 8099;
    this._baseUrl = config.baseUrl ?? `http://localhost:${this.port}`;
    this.healthProvider = config.healthProvider;
    this.wsChannel = config.wsChannel;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  start() {
    const wsChannel = this.wsChannel;

    this.server = Bun.serve({
      port: this.port,
      fetch: (req: Request, server: any) => {
        const url = new URL(req.url);
        if (url.pathname === "/ws" && wsChannel) {
          if (server.upgrade(req, { data: {} })) return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return this.handleRequest(req);
      },
      websocket: wsChannel ? {
        open: (ws: any) => wsChannel.handleOpen(ws),
        message: (ws: any, data: any) => wsChannel.handleMessage(ws, String(data)),
        close: (ws: any) => wsChannel.handleClose(ws),
      } : undefined,
    });

    console.log(`[views] Server listening on ${this._baseUrl}${wsChannel ? " (WebSocket on /ws)" : ""}`);

    // Clean up old views every 5 minutes
    setInterval(() => this.cleanupOldViews(), 5 * 60 * 1000);
  }

  stop() {
    this.server?.stop();
    console.log("[views] Server stopped");
  }

  getViewUrl(token: string): string {
    return `${this._baseUrl}/view/${token}`;
  }

  private handleRequest(req: Request): Response {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check
    if (path === "/health" || path === "/") {
      const health = {
        status: "ok",
        service: "claude-assist",
        uptime: this.healthProvider?.uptime ?? 0,
        activeSessions: this.healthProvider?.activeSessionCount ?? 0,
        memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        timestamp: new Date().toISOString(),
      };
      return Response.json(health);
    }

    // Serve a view (supports hex tokens and descriptive slugs)
    const match = path.match(/^\/view\/([a-z0-9-]{3,80})$/);
    if (match) {
      const token = match[1];
      const filePath = join(VIEWS_DIR, `${token}.html`);

      if (existsSync(filePath)) {
        const html = readFileSync(filePath, "utf-8");
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("View not found or expired", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Remove views older than 1 hour.
   */
  private cleanupOldViews() {
    const maxAge = 60 * 60 * 1000; // 1 hour
    const now = Date.now();

    try {
      for (const file of readdirSync(VIEWS_DIR)) {
        if (!file.endsWith(".html")) continue;
        const filePath = join(VIEWS_DIR, file);
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          unlinkSync(filePath);
          console.log(`[views] Cleaned up expired view: ${file}`);
        }
      }
    } catch {}
  }
}
