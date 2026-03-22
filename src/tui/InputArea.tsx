import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const HISTORY_FILE = join(
  process.env.CONDUIT_STATE_DIR ?? join(homedir(), ".local", "state", "claude-assist"),
  "tui-history.json"
);
const MAX_HISTORY = 100;

function loadHistory(): string[] {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveHistory(history: string[]) {
  try {
    const dir = HISTORY_FILE.replace(/\/[^/]+$/, "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch {}
}

interface InputAreaProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export function InputArea({ onSubmit, disabled }: InputAreaProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [savedInput, setSavedInput] = useState("");

  useInput((_input, key) => {
    if (key.upArrow && !key.shift) {
      if (history.length === 0) return;
      const newIdx = Math.min(historyIdx + 1, history.length - 1);
      if (historyIdx === -1) setSavedInput(value);
      setHistoryIdx(newIdx);
      setValue(history[history.length - 1 - newIdx]);
    }
    if (key.downArrow && !key.shift) {
      if (historyIdx <= 0) {
        setHistoryIdx(-1);
        setValue(savedInput);
        return;
      }
      const newIdx = historyIdx - 1;
      setHistoryIdx(newIdx);
      setValue(history[history.length - 1 - newIdx]);
    }
  });

  const handleSubmit = (text: string) => {
    if (!text.trim()) return;
    const trimmed = text.trim();

    // Add to history (deduplicate last entry)
    const newHistory = history[history.length - 1] === trimmed
      ? history
      : [...history, trimmed];
    setHistory(newHistory);
    saveHistory(newHistory);
    setHistoryIdx(-1);
    setSavedInput("");

    onSubmit(trimmed);
    setValue("");
  };

  return (
    <Box borderStyle="single" borderColor={disabled ? "gray" : "cyan"} paddingLeft={1}>
      <Text bold color="cyan">&gt; </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={disabled ? "Connecting..." : "Type a message... (Up/Down for history)"}
      />
    </Box>
  );
}
