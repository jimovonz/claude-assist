/**
 * EdgeRelay — outbound WebSocket connection to the GCE edge server.
 *
 * Implements the Channel interface so the Router can route messages from
 * remote TUI clients through the edge. The conduit initiates the connection
 * (NAT-friendly), and the edge bridges between this connection and TUI clients.
 *
 * Protocol:
 *   Edge → Conduit: { userId, type: "auth"|"message"|"cancel"|"command", ... }
 *   Conduit → Edge: { userId, type: "result"|"status"|"text"|"text_end"|"error", ... }
 */

import type { Channel } from "../conduit/router";
import type { SessionManager } from "../conduit/session";
import type { ActionHandler } from "../views/server";
import type { EmailAgent } from "../conduit/email-agent";

export interface EdgeRelayConfig {
  edgeUrl: string;
  apiSecret?: string;
  sessionManager?: SessionManager;
  onAction?: ActionHandler;
  emailAgent?: EmailAgent;
}

export class EdgeRelay implements Channel {
  id = "edge-tui";
  name = "Remote TUI";

  private edgeUrl: string;
  private wsUrl: string;
  private apiSecret?: string;
  private sessionManager?: SessionManager;
  private ws: WebSocket | null = null;
  private onMessage?: (userId: string, text: string) => void;
  private reconnectTimer: Timer | null = null;
  private stopped = false;
  private reconnectDelay = 1000;
  private onAction?: ActionHandler;
  private emailAgent?: EmailAgent;
  private pingInterval: Timer | null = null;
  private lastPong = 0;

  constructor(config: EdgeRelayConfig) {
    this.edgeUrl = config.edgeUrl;
    this.wsUrl = config.edgeUrl.replace(/^http/, "ws") + "/ws/conduit";
    this.apiSecret = config.apiSecret;
    this.sessionManager = config.sessionManager;
    this.onAction = config.onAction;
    this.emailAgent = config.emailAgent;
  }

  async start(onMessage: (userId: string, text: string) => void) {
    this.onMessage = onMessage;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close(1000, "Shutting down");
      this.ws = null;
    }
  }

  private connect() {
    if (this.stopped) return;

    const headers: Record<string, string> = {};
    if (this.apiSecret) headers["Authorization"] = `Bearer ${this.apiSecret}`;

    try {
      this.ws = new WebSocket(this.wsUrl, { headers } as any);
    } catch (err: any) {
      console.error(`[edge-relay] Failed to create WebSocket: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log(`[edge-relay] Connected to edge: ${this.wsUrl}`);
      this.reconnectDelay = 1000;
      this.lastPong = Date.now();
      this.startKeepalive();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.type === "pong") {
          this.lastPong = Date.now();
          return;
        }
        this.handleEdgeMessage(data);
      } catch {}
    };

    this.ws.onclose = () => {
      console.log("[edge-relay] Disconnected from edge");
      this.stopKeepalive();
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = (event) => {
      console.error(`[edge-relay] WebSocket error`);
    };
  }

  private startKeepalive() {
    this.stopKeepalive();
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const silenceMs = Date.now() - this.lastPong;
      if (silenceMs > 90_000) {
        console.log(`[edge-relay] No pong for ${Math.round(silenceMs / 1000)}s — forcing reconnect`);
        this.stopKeepalive();
        this.ws.close();
        this.ws = null;
        this.scheduleReconnect();
        return;
      }

      this.ws.send(JSON.stringify({ type: "ping" }));
    }, 30_000);
  }

  private stopKeepalive() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    console.log(`[edge-relay] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private handleEdgeMessage(data: any) {
    // Action messages don't have userId — they have viewId
    if (data.type === "action") {
      this.handleActionMessage(data);
      return;
    }

    // Gmail push notifications don't have userId
    if (data.type === "gmail-push") {
      if (this.emailAgent) {
        this.emailAgent.handlePush(data.emailAddress, data.historyId);
      } else {
        console.log("[edge-relay] Gmail push received but no email agent configured");
      }
      return;
    }

    // OwnTracks location updates don't have userId
    if (data.type === "location") {
      this.handleLocationUpdate(data);
      return;
    }

    const userId = data.userId;
    if (!userId) return;

    switch (data.type) {
      case "auth":
        // TUI client authenticated via edge — send auth_ok back
        console.log(`[edge-relay] Remote TUI authenticated: ${userId}`);
        this.send(userId, { type: "auth_ok", userId });

        // Check for session restore
        const channelId = `${this.id}:${userId}`;
        const hasSession = this.sessionManager?.getSession(channelId);
        if (hasSession && this.onMessage) {
          this.onMessage(userId, `[Remote TUI session restored — client reconnected. Greet the user and briefly summarise what you were working on.]`);
        }
        break;

      case "message":
        if (typeof data.text === "string") {
          this.onMessage?.(userId, data.text);
        }
        break;

      case "cancel":
        const cid = `${this.id}:${userId}`;
        this.sessionManager?.abort(cid);
        this.send(userId, { type: "cancelled", aborted: true });
        console.log(`[edge-relay] Cancel from remote TUI: ${userId}`);
        break;

      case "command":
        this.handleCommand(userId, data.command);
        break;
    }
  }

  private handleCommand(userId: string, command: string) {
    const channelId = `${this.id}:${userId}`;

    switch (command) {
      case "clear":
        this.sessionManager?.removeSession(channelId);
        this.send(userId, { type: "command_ok", command: "clear", text: "Session cleared." });
        console.log(`[edge-relay] Cleared session for ${userId}`);
        break;

      case "sessions": {
        const sessions = this.sessionManager?.listSessions() ?? [];
        this.send(userId, { type: "command_ok", command: "sessions", data: sessions });
        break;
      }

      default:
        this.send(userId, { type: "error", text: `Unknown command: ${command}` });
    }
  }

  private async handleActionMessage(data: any) {
    if (!this.onAction) {
      console.log("[edge-relay] Action received but no handler configured");
      return;
    }
    const { viewId, actionId, label, value } = data;
    if (!viewId || !actionId) return;

    // Look up channelId from view index
    const { loadViewIndex } = await import("../views/renderer");
    const index = loadViewIndex();
    const view = index.find((v: any) => v.slug === viewId);
    if (!view?.channelId) {
      console.log(`[edge-relay] Action for unknown view: ${viewId}`);
      return;
    }

    console.log(`[edge-relay] Action "${actionId}" from view ${viewId} → ${view.channelId}`);
    await this.onAction(view.channelId, actionId, label ?? actionId, value);
  }

  private handleLocationUpdate(data: any) {
    const { lat, lon, timestamp, velocity, accuracy, battery } = data;
    if (lat == null || lon == null) return;

    const { storeLocationUpdate, checkGeofences } = require("../conduit/state") as typeof import("../conduit/state");

    storeLocationUpdate({ lat, lon, accuracy, velocity, battery, timestamp: timestamp ?? Math.floor(Date.now() / 1000) });

    const matched = checkGeofences(lat, lon);
    if (matched.length > 0) {
      const names = matched.map(l => l.name).join(", ");
      console.log(`[edge-relay] Location: ${lat.toFixed(4)}, ${lon.toFixed(4)} — at ${names}`);
    } else {
      console.log(`[edge-relay] Location: ${lat.toFixed(4)}, ${lon.toFixed(4)} — no geofence match`);
    }
  }

  // --- Channel interface ---

  async reply(userId: string, text: string) {
    this.send(userId, { type: "result", text });
  }

  async sendTyping(_userId: string) {
    // No-op
  }

  async sendStatus(userId: string, text: string) {
    this.send(userId, { type: "status", text });
  }

  async sendStreamText(userId: string, text: string) {
    this.send(userId, { type: "text", text });
  }

  async sendStreamEnd(userId: string) {
    this.send(userId, { type: "text_end" });
  }

  // --- Internal ---

  private send(userId: string, msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, userId }));
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
