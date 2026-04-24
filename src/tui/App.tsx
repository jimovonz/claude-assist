import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ConduitConnection, type ConnectionState } from "./Connection";
import { MessageList } from "./MessageList";
import { InputArea } from "./InputArea";
import { StatusBar } from "./StatusBar";
import type { Message } from "./MessageBlock";
import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const STATE_DIR = process.env.CONDUIT_STATE_DIR ?? join(homedir(), ".local", "state", "claude-assist");

function loadMessages(userId: string): Message[] {
  try {
    const file = join(STATE_DIR, `tui-messages-${userId}.json`);
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return (data as Message[]).map((m) => ({ ...m, streaming: false }));
  } catch {
    return [];
  }
}

function saveMessages(userId: string, messages: Message[]) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const file = join(STATE_DIR, `tui-messages-${userId}.json`);
    const toSave = messages.filter((m) => !m.streaming);
    writeFileSync(file, JSON.stringify(toSave));
  } catch {}
}

function clearMessages(userId: string) {
  try {
    const file = join(STATE_DIR, `tui-messages-${userId}.json`);
    writeFileSync(file, "[]");
  } catch {}
}

interface AppProps {
  host: string;
  token: string;
}

const COMMANDS: Record<string, string> = {
  "/clear": "Reset the Claude session (fresh conversation)",
  "/context": "Show context window usage and cost",
  "/sessions": "List all active sessions",
  "/tasks": "List all scheduled tasks",
  "/task": "<id> <enable|disable|delete|run> — Manage a task",
  "/incognito": "Toggle incognito mode (bash-like appearance)",
  "/exit": "Quit the TUI",
  "/help": "Show available commands",
};

export function App({ host, token }: AppProps) {
  const { exit } = useApp();
  const [conn] = useState(() => new ConduitConnection(host, token));
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [messages, setMessages] = useState<Message[]>(() => loadMessages(conn.userId));
  const [status, setStatus] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState(false); // between send and first text chunk
  const [incognito, setIncognito] = useState(false);
  const [currentActions, setCurrentActions] = useState<{ id: string; label: string; type?: string; options?: string[] }[] | null>(null);

  // Persist messages when they change (skip during streaming)
  const prevMsgsRef = useRef(messages);
  useEffect(() => {
    if (messages !== prevMsgsRef.current) {
      prevMsgsRef.current = messages;
      if (!messages.some((m) => m.streaming)) {
        saveMessages(conn.userId, messages);
      }
    }
  }, [messages]);

  // Refs for child key handlers — single useInput dispatches to all
  const scrollHandlerRef = useRef<(input: string, key: any) => void>(undefined);
  const inputHandlerRef = useRef<(input: string, key: any) => void>(undefined);
  const streamingRef = useRef(streaming || pending);
  streamingRef.current = streaming || pending;

  // Single useInput — eliminates 3 redundant batchedUpdates per keystroke
  useInput(useCallback((input: string, key: any) => {
    // App-level shortcuts (highest priority)
    if (key.ctrl && input === "c") {
      conn.disconnect();
      exit();
      return;
    }
    if (key.ctrl && input === "l") {
      setMessages([]);
      setStatus("");
      return;
    }
    if ((key.escape || (key.ctrl && input === "x")) && streamingRef.current) {
      conn.sendCancel();
      return;
    }

    // Scroll keys → MessageList
    if (key.pageUp || key.pageDown || key.home || key.end || (key.shift && (key.upArrow || key.downArrow))) {
      scrollHandlerRef.current?.(input, key);
      return;
    }

    // Everything else → InputArea (text editing + history)
    inputHandlerRef.current?.(input, key);
  }, [conn, exit]));

  useEffect(() => {
    conn.on("state", (state: ConnectionState) => {
      setConnectionState(state);
    });

    conn.on("connected", () => {
      setStatus("");
    });

    conn.on("status", (text: string) => {
      setStatus(text);
      // Empty status signals processing is done (e.g. empty response suppressed)
      if (!text) {
        setPending(false);
        setStreaming(false);
      }
    });

    conn.on("text", (text: string) => {
      setPending(false);
      setStreaming(true);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { role: "assistant", text, streaming: true }];
        }
        return [...prev, { role: "assistant", text, streaming: true }];
      });
    });

    conn.on("text_end", () => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { ...last, streaming: false }];
        }
        return prev;
      });
    });

    conn.on("result", (text: string, actions?: { id: string; label: string; type?: string; options?: string[] }[]) => {
      setPending(false);
      setStreaming(false);
      setStatus("");

      // Append action choices to the text
      let displayText = text;
      if (actions?.length) {
        const lines: string[] = ["\n  Actions:"];
        let idx = 1;
        for (const a of actions) {
          if (a.type === "button" || !a.type) {
            lines.push(`  [${idx}] ${a.label}`);
            idx++;
          } else if (a.type === "select" && a.options) {
            lines.push(`  ${a.id} (pick one):`);
            for (const opt of a.options) {
              lines.push(`    [${idx}] ${opt}`);
              idx++;
            }
          } else if (a.type === "checkbox" && a.options) {
            lines.push(`  ${a.id} (comma-separate numbers):`);
            for (const opt of a.options) {
              lines.push(`    [${idx}] ${opt}`);
              idx++;
            }
          } else if (a.type === "text") {
            lines.push(`  [${idx}] ${a.label} (type response)`);
            idx++;
          }
        }
        displayText += lines.join("\n");
        setCurrentActions(actions);
      } else {
        setCurrentActions(null);
      }

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { role: "assistant", text: displayText, streaming: false }];
        }
        return [...prev, { role: "assistant", text: displayText, streaming: false }];
      });
    });

    conn.on("error", (text: string) => {
      setPending(false);
      setStreaming(false);
      setStatus("");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Error: ${text}`, streaming: false },
      ]);
    });

    conn.on("cancelled", () => {
      setPending(false);
      setStreaming(false);
      setStatus("");
      // Replace incomplete streaming message with cancelled indicator
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { role: "assistant" as const, text: "Cancelled", streaming: false, cancelled: true }];
        }
        return [...prev, { role: "assistant" as const, text: "Cancelled", streaming: false, cancelled: true }];
      });
    });

    conn.on("command_ok", (msg: any) => {
      switch (msg.command) {
        case "clear":
          setMessages([]);
          setStatus("");
          setMessages([{ role: "assistant", text: msg.text, streaming: false }]);
          break;
        case "sessions": {
          const lines = (msg.data as any[]).map(
            (s) => `${s.live ? "[live]" : "[idle]"} ${s.channelId} — last active: ${new Date(s.lastActivity).toLocaleTimeString()}`
          );
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: lines.length ? lines.join("\n") : "No active sessions.", streaming: false },
          ]);
          break;
        }
      }
    });

    conn.on("disconnected", () => {
      setStreaming(false);
      setStatus("Connection lost — reconnecting...");
    });

    conn.on("reconnecting", (delay: number) => {
      setStatus(`Reconnecting in ${Math.round(delay / 1000)}s...`);
    });

    conn.connect();

    return () => {
      conn.disconnect();
      conn.removeAllListeners();
    };
  }, [conn]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (connectionState !== "connected") return;

      // Handle local commands
      if (text === "/exit") {
        conn.disconnect();
        exit();
        return;
      }

      if (text === "/incognito") {
        setIncognito((prev) => !prev);
        if (!incognito) {
          // Entering incognito — clear visible messages for clean slate
          setMessages([]);
          setStatus("");
        }
        return;
      }

      if (text === "/help") {
        const helpLines = Object.entries(COMMANDS)
          .map(([cmd, desc]) => `${cmd} — ${desc}`)
          .join("\n");
        setMessages((prev) => [
          ...prev,
          { role: "user", text, streaming: false },
          { role: "assistant", text: helpLines + "\n\nEsc / Ctrl+X — Cancel current request\nCtrl+L — Clear screen\nCtrl+C — Quit", streaming: false },
        ]);
        return;
      }

      // Handle server commands — sent as regular messages, router handles them
      if (text.startsWith("/") && /^\/[a-z]/.test(text)) {
        setMessages((prev) => [...prev, { role: "user", text, streaming: false }]);
        // /clear also clears local message state
        if (text === "/clear") {
          setMessages([]);
          setStatus("");
        }
        conn.send(text);
        return;
      }

      // Handle action selection (numeric input when actions are available)
      if (currentActions && /^\d+$/.test(text)) {
        const idx = parseInt(text) - 1;
        if (idx >= 0 && idx < currentActions.length) {
          const action = currentActions[idx]!;
          setMessages((prev) => [...prev, { role: "user", text: `[${action.label}]`, streaming: false }]);
          setCurrentActions(null);
          conn.send(`[Action: ${action.label}] The user selected "${action.label}" (action: ${action.id}).`);
          return;
        }
      }

      // Regular message — also clears any pending actions
      if (currentActions) setCurrentActions(null);
      if (streaming || pending) return;
      setMessages((prev) => [...prev, { role: "user", text, streaming: false }]);
      setPending(true);
      setStatus("Sending...");
      conn.send(text);
    },
    [conn, connectionState, streaming, pending]
  );

  return (
    <Box flexDirection="column" height="100%">
      {!incognito && (
        <Box marginBottom={1}>
          <Text bold color="cyan">claude-assist TUI</Text>
          <Text dimColor> — {host}</Text>
        </Box>
      )}

      <MessageList messages={messages} incognito={incognito} onKeyRef={scrollHandlerRef} />
      {!incognito && <StatusBar connectionState={connectionState} status={status} />}
      <InputArea
        onSubmit={handleSubmit}
        disabled={connectionState !== "connected"}
        incognito={incognito}
        streaming={streaming || pending}
        status={status}
        onKeyRef={inputHandlerRef}
      />
    </Box>
  );
}
