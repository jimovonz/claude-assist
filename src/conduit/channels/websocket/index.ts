import { randomBytes } from "crypto";
import type { ServerWebSocket } from "bun";
import type { Channel } from "../router";
import type { SessionManager } from "../session";

export interface WebSocketChannelConfig {
  authToken?: string;
  sessionManager?: SessionManager;
}

interface ClientState {
  userId: string;
  authenticated: boolean;
}

export class WebSocketChannel implements Channel {
  id = "tui";
  name = "TUI";

  private authToken?: string;
  private sessionManager?: SessionManager;
  private clients = new Map<ServerWebSocket<ClientState>, ClientState>();
  private userSockets = new Map<string, ServerWebSocket<ClientState>>();
  private onMessage?: (userId: string, text: string) => void;
  private pingInterval: Timer | null = null;

  constructor(config: WebSocketChannelConfig = {}) {
    this.authToken = config.authToken;
    this.sessionManager = config.sessionManager;
  }

  async start(onMessage: (userId: string, text: string) => void) {
    this.onMessage = onMessage;

    // Keepalive ping every 30s
    this.pingInterval = setInterval(() => {
      const ping = JSON.stringify({ type: "ping" });
      for (const ws of this.userSockets.values()) {
        ws.send(ping);
      }
    }, 30000);

    console.log(`[tui] WebSocket channel ready${this.authToken ? " (auth required)" : ""}`);
  }

  async stop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const ws of this.clients.keys()) {
      ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
    this.userSockets.clear();
  }

  // --- Channel interface: outbound to client ---

  async reply(userId: string, text: string) {
    this.send(userId, { type: "result", text });
  }

  // No replyWithView — TUI always gets full inline responses.
  // The Router checks for this method and falls back to reply().

  async sendTyping(_userId: string) {
    // No-op for TUI — status updates cover this
  }

  async sendStatus(userId: string, text: string) {
    this.send(userId, { type: "status", text });
  }

  async clearStatus(userId: string) {
    this.send(userId, { type: "status", text: "" });
  }

  async sendStreamText(userId: string, text: string) {
    this.send(userId, { type: "text", text });
  }

  async sendStreamEnd(userId: string) {
    this.send(userId, { type: "text_end" });
  }

  // --- WebSocket handlers: called by ViewServer ---

  handleOpen(ws: ServerWebSocket<ClientState>) {
    const state: ClientState = {
      userId: "",
      authenticated: !this.authToken, // auto-auth if no token configured
    };
    ws.data = state;
    this.clients.set(ws, state);

    if (state.authenticated) {
      // No auth token configured — still wait for client auth message to get userId
      // Don't assign userId here; handleMessage auth path will handle it
      console.log(`[tui] Client connected (no auth required, awaiting userId)`);
    }
  }

  handleMessage(ws: ServerWebSocket<ClientState>, data: string) {
    const state = this.clients.get(ws);
    if (!state) return;

    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
      return;
    }

    // Auth handshake
    if (msg.type === "auth") {
      if (state.userId) return; // already fully set up

      // Validate token if auth is required
      if (this.authToken && msg.token !== this.authToken) {
        ws.send(JSON.stringify({ type: "auth_fail", reason: "Invalid token" }));
        ws.close(4001, "Authentication failed");
        console.log(`[tui] Auth failed from client`);
        return;
      }

      state.authenticated = true;
      // Use client-provided userId for session persistence, fallback to random
      state.userId = (typeof msg.userId === "string" && msg.userId)
        ? msg.userId
        : `tui-${randomBytes(4).toString("hex")}`;
      // Close any existing socket for this userId (reconnect replaces old connection)
      const existing = this.userSockets.get(state.userId);
      if (existing && existing !== ws) {
        existing.close(4002, "Replaced by new connection");
      }
      this.userSockets.set(state.userId, ws);
      ws.send(JSON.stringify({ type: "auth_ok", userId: state.userId }));

      // Detect session restoration: existing Claude session for this user
      const channelId = `${this.id}:${state.userId}`;
      const hasSession = this.sessionManager?.getSession(channelId);
      console.log(`[tui] Client authenticated: ${state.userId}${hasSession ? " (session restore)" : ""}`);

      // Auto-fire greeting on reconnect — streams summary before user can type
      if (hasSession && this.onMessage) {
        this.onMessage(state.userId, `[${this.name} session restored — client reconnected. Greet the user and briefly summarise what you were working on.]`);
      }
      return;
    }

    // All other messages require auth
    if (!state.authenticated) {
      ws.send(JSON.stringify({ type: "auth_fail", reason: "Not authenticated" }));
      ws.close(4001, "Not authenticated");
      return;
    }

    // Cancel current processing
    if (msg.type === "cancel") {
      const channelId = `${this.id}:${state.userId}`;
      const aborted = this.sessionManager?.abort(channelId) ?? false;
      ws.send(JSON.stringify({ type: "cancelled", aborted }));
      console.log(`[tui] Cancel requested by ${state.userId}, aborted: ${aborted}`);
      return;
    }

    // Commands
    if (msg.type === "command") {
      this.handleCommand(ws, state, msg.command);
      return;
    }

    // User message
    if (msg.type === "message" && typeof msg.text === "string") {
      this.onMessage?.(state.userId, msg.text);
    }
  }

  private handleCommand(ws: ServerWebSocket<ClientState>, state: ClientState, command: string) {
    const channelId = `${this.id}:${state.userId}`;

    switch (command) {
      case "clear": {
        if (this.sessionManager) {
          this.sessionManager.removeSession(channelId);
          console.log(`[tui] Cleared session for ${state.userId}`);
        }
        ws.send(JSON.stringify({ type: "command_ok", command: "clear", text: "Session cleared. Next message starts fresh." }));
        break;
      }
      case "sessions": {
        const sessions = this.sessionManager?.listSessions() ?? [];
        const list = sessions.map((s) => ({
          channelId: s.channelId,
          lastActivity: s.lastActivity,
          live: s.live,
        }));
        ws.send(JSON.stringify({ type: "command_ok", command: "sessions", data: list }));
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", text: `Unknown command: ${command}` }));
    }
  }

  handleClose(ws: ServerWebSocket<ClientState>) {
    const state = this.clients.get(ws);
    if (state?.userId) {
      this.userSockets.delete(state.userId);
      console.log(`[tui] Client disconnected: ${state.userId}`);
    }
    this.clients.delete(ws);
  }

  // --- Internal ---

  private send(userId: string, msg: object) {
    const ws = this.userSockets.get(userId);
    if (ws) {
      ws.send(JSON.stringify(msg));
    }
  }

  get connectedClients(): number {
    return this.userSockets.size;
  }
}
