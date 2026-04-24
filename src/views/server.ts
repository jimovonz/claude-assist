import { join } from "path";
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import type { ServerWebSocket } from "bun";
import type { WebSocketChannel } from "../conduit/channels/websocket";
import { loadViewIndex } from "./renderer";

const VIEWS_DIR = join(import.meta.dir, "..", "..", "views");

export interface HealthProvider {
  uptime: number;
  activeSessionCount: number;
}

export type ActionHandler = (channelId: string, actionId: string, actionLabel: string, value?: string) => Promise<void>;

export interface ViewServerConfig {
  port?: number;
  baseUrl?: string;
  healthProvider?: HealthProvider;
  wsChannel?: WebSocketChannel;
  onAction?: ActionHandler;
}

export class ViewServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private _baseUrl: string;
  private healthProvider?: HealthProvider;
  private wsChannel?: WebSocketChannel;
  private onAction?: ActionHandler;

  constructor(config: ViewServerConfig = {}) {
    this.port = config.port ?? 8099;
    this._baseUrl = config.baseUrl ?? `http://localhost:${this.port}`;
    this.healthProvider = config.healthProvider;
    this.wsChannel = config.wsChannel;
    this.onAction = config.onAction;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  setActionHandler(handler: ActionHandler) {
    this.onAction = handler;
  }

  start() {
    const wsChannel = this.wsChannel;

    const serveOptions: any = {
      port: this.port,
      fetch: (req: Request, server: any): Response | Promise<Response> => {
        const url = new URL(req.url);
        if (url.pathname === "/ws" && wsChannel) {
          if (server.upgrade(req, { data: {} })) return new Response(null, { status: 101 });
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return this.handleRequest(req);
      },
    };
    if (wsChannel) {
      serveOptions.websocket = {
        open: (ws: any) => wsChannel.handleOpen(ws),
        message: (ws: any, data: any) => wsChannel.handleMessage(ws, String(data)),
        close: (ws: any) => wsChannel.handleClose(ws),
      };
    }
    this.server = Bun.serve(serveOptions);

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

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Action endpoint
    if (path === "/api/action" && req.method === "POST") {
      return this.handleAction(req);
    }

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

  private async handleAction(req: Request): Promise<Response> {
    try {
      const body = await req.json() as { viewId?: string; actionId?: string; label?: string; value?: string };
      if (!body.viewId || !body.actionId) {
        return Response.json({ error: "Missing viewId or actionId" }, { status: 400 });
      }

      // Look up which session created this view
      const index = loadViewIndex();
      const view = index.find(v => v.slug === body.viewId);
      if (!view?.channelId) {
        return Response.json({ error: "View not found or no session to route to" }, { status: 404 });
      }

      if (!this.onAction) {
        return Response.json({ error: "Action handler not configured" }, { status: 503 });
      }

      await this.onAction(view.channelId, body.actionId, body.label ?? body.actionId, body.value);
      console.log(`[views] Action "${body.actionId}" from view ${body.viewId} → ${view.channelId}`);
      return Response.json({ ok: true, message: `Action "${body.label ?? body.actionId}" sent` });
    } catch (err: any) {
      console.error(`[views] Action error: ${err.message}`);
      return Response.json({ error: err.message }, { status: 500 });
    }
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
