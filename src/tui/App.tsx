import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ConduitConnection, type ConnectionState } from "./Connection";
import { MessageList } from "./MessageList";
import { InputArea } from "./InputArea";
import { StatusBar } from "./StatusBar";
import type { Message } from "./MessageBlock";

interface AppProps {
  host: string;
  token: string;
}

const COMMANDS: Record<string, string> = {
  "/clear": "Reset the Claude session (fresh conversation)",
  "/sessions": "List all active sessions",
  "/incognito": "Toggle incognito mode (bash-like appearance)",
  "/exit": "Quit the TUI",
  "/help": "Show available commands",
};

export function App({ host, token }: AppProps) {
  const { exit } = useApp();
  const [conn] = useState(() => new ConduitConnection(host, token));
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [incognito, setIncognito] = useState(false);

  // Ctrl+C to exit, Ctrl+L to clear screen, Escape to cancel
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      conn.disconnect();
      exit();
    }
    if (key.ctrl && input === "l") {
      setMessages([]);
      setStatus("");
    }
    if (key.escape && streaming) {
      conn.sendCancel();
    }
  });

  useEffect(() => {
    conn.on("state", (state: ConnectionState) => {
      setConnectionState(state);
    });

    conn.on("connected", () => {
      setStatus("");
    });

    conn.on("status", (text: string) => {
      setStatus(text);
    });

    conn.on("text", (text: string) => {
      setStreaming(true);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { role: "assistant", text, streaming: true }];
        }
        return [...prev, { role: "assistant", text, streaming: true }];
      });
    });

    conn.on("result", (text: string) => {
      setStreaming(false);
      setStatus("");
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { role: "assistant", text, streaming: false }];
        }
        return [...prev, { role: "assistant", text, streaming: false }];
      });
    });

    conn.on("error", (text: string) => {
      setStreaming(false);
      setStatus("");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Error: ${text}`, streaming: false },
      ]);
    });

    conn.on("cancelled", () => {
      setStreaming(false);
      setStatus("");
      // Remove the incomplete streaming message
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return prev.slice(0, -1);
        }
        return prev;
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
          { role: "assistant", text: helpLines + "\n\nEsc — Cancel current request\nCtrl+L — Clear screen\nCtrl+C — Quit", streaming: false },
        ]);
        return;
      }

      // Handle server commands
      if (text === "/clear" || text === "/sessions") {
        setMessages((prev) => [...prev, { role: "user", text, streaming: false }]);
        conn.sendCommand(text.slice(1)); // strip the /
        return;
      }

      // Regular message
      if (streaming) return;
      setMessages((prev) => [...prev, { role: "user", text, streaming: false }]);
      setStatus("Sending...");
      conn.send(text);
    },
    [conn, connectionState, streaming]
  );

  return (
    <Box flexDirection="column" height="100%">
      {!incognito && (
        <Box marginBottom={1}>
          <Text bold color="cyan">claude-assist TUI</Text>
          <Text dimColor> — {host}</Text>
        </Box>
      )}

      <MessageList messages={messages} incognito={incognito} />
      {!incognito && <StatusBar connectionState={connectionState} status={status} />}
      <InputArea
        onSubmit={handleSubmit}
        disabled={connectionState !== "connected"}
        incognito={incognito}
      />
    </Box>
  );
}
