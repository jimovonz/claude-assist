import { EventEmitter } from "events";
import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";

export type ConnectionState = "disconnected" | "connecting" | "authenticating" | "connected";

export interface ConduitMessage {
  type: "auth_ok" | "auth_fail" | "status" | "text" | "result" | "error" | "ping" | "cancelled";
  text?: string;
  reason?: string;
  userId?: string;
  aborted?: boolean;
}

const STATE_DIR = process.env.CONDUIT_STATE_DIR ?? join(homedir(), ".local", "state", "claude-assist");
const USER_ID_FILE = join(STATE_DIR, "tui-user-id");

function getOrCreateUserId(): string {
  try {
    const id = readFileSync(USER_ID_FILE, "utf-8").trim();
    if (id) return id;
  } catch {
    // File doesn't exist yet — will create below
  }
  const id = `tui-${randomBytes(8).toString("hex")}`;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(USER_ID_FILE, id);
  } catch (err) {
    console.error(`[tui] Failed to persist userId to ${USER_ID_FILE}:`, err);
  }
  return id;
}

export class ConduitConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = "disconnected";
  private url: string;
  private token: string;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: Timer | null = null;
  readonly userId: string;

  constructor(url: string, token: string) {
    super();
    this.url = url;
    this.token = token;
    this.userId = getOrCreateUserId();
  }

  get state(): ConnectionState {
    return this._state;
  }

  connect() {
    if (this.ws) return;

    this.shouldReconnect = true;
    this._state = "connecting";
    this.emit("state", this._state);

    const wsUrl = this.url.replace(/^http/, "ws") + "/ws";
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this._state = "authenticating";
      this.emit("state", this._state);
      this.ws!.send(JSON.stringify({ type: "auth", token: this.token, userId: this.userId }));
    };

    this.ws.onmessage = (event) => {
      let msg: ConduitMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (msg.type) {
        case "auth_ok":
          this._state = "connected";
          this.emit("state", this._state);
          this.emit("connected", msg.userId);
          break;
        case "auth_fail":
          this.shouldReconnect = false; // Don't retry bad credentials
          this.emit("error", msg.reason ?? "Authentication failed");
          this.disconnect();
          break;
        case "status":
          this.emit("status", msg.text);
          break;
        case "text":
          this.emit("text", msg.text);
          break;
        case "result":
          this.emit("result", msg.text);
          break;
        case "error":
          this.emit("error", msg.text);
          break;
        case "cancelled":
          this.emit("cancelled", msg.aborted);
          break;
        case "command_ok":
          this.emit("command_ok", msg);
          break;
        case "ping":
          break;
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this._state = "disconnected";
      this.emit("state", this._state);
      this.emit("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  send(text: string) {
    if (this._state !== "connected" || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "message", text }));
  }

  sendCommand(command: string) {
    if (this._state !== "connected" || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "command", command }));
  }

  sendCancel() {
    if (this._state !== "connected" || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "cancel" }));
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._state = "disconnected";
    this.emit("state", this._state);
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;

    this.reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    this.emit("reconnecting", delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
