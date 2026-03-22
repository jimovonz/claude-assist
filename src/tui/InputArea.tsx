import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { join, basename } from "path";
import { homedir, hostname, userInfo } from "os";
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
  incognito?: boolean;
  streaming?: boolean;
}

export function bashPrompt(): string {
  const user = userInfo().username;
  const host = hostname().split(".")[0];
  return `${user}@${host}.ai:~/Projects`;
}

/**
 * Custom text input that prevents wrapping by showing only the tail
 * of the input that fits within the available terminal width.
 * This avoids the ink-text-input v6 wrapping bug where Ink
 * miscalculates output height on re-render.
 */
function LineInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  prefix,
  availableWidth,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  prefix?: string;
  availableWidth: number;
}) {
  const [cursor, setCursor] = useState(value.length);
  // Refs to avoid stale closures in useInput — keystrokes can arrive
  // faster than React re-renders, so we read/write refs for the latest state.
  const valRef = useRef(value);
  const curRef = useRef(cursor);

  // Sync ref when parent changes value externally (history nav)
  useEffect(() => {
    valRef.current = value;
    curRef.current = value.length;
    setCursor(value.length);
  }, [value]);

  useInput((input, key) => {
    const val = valRef.current;
    const cur = curRef.current;

    if (key.return) {
      onSubmit(val);
      return;
    }

    // Ignore keys handled by parent (escape, up/down arrows, tab)
    if (key.escape || key.upArrow || key.downArrow || key.tab) return;

    let newVal = val;
    let newCur = cur;

    if (key.backspace || key.delete) {
      if (cur > 0) {
        newVal = val.slice(0, cur - 1) + val.slice(cur);
        newCur = cur - 1;
      }
    } else if (key.leftArrow) {
      newCur = Math.max(0, cur - 1);
    } else if (key.rightArrow) {
      newCur = Math.min(val.length, cur + 1);
    } else if (key.ctrl && input === "a") {
      newCur = 0;
    } else if (key.ctrl && input === "e") {
      newCur = val.length;
    } else if (key.ctrl && input === "k") {
      newVal = val.slice(0, cur);
    } else if (key.ctrl && input === "u") {
      newVal = val.slice(cur);
      newCur = 0;
    } else if (key.ctrl && input === "w") {
      const before = val.slice(0, cur);
      const trimmed = before.replace(/\S+\s*$/, "");
      newVal = trimmed + val.slice(cur);
      newCur = trimmed.length;
    } else if (input && !key.ctrl && !key.meta) {
      newVal = val.slice(0, cur) + input + val.slice(cur);
      newCur = cur + input.length;
    }

    // Update refs immediately so the next keystroke (before re-render) sees fresh state
    valRef.current = newVal;
    curRef.current = newCur;

    if (newVal !== val) onChange(newVal);
    if (newCur !== cur) setCursor(newCur);
  });

  // Render: show only what fits in availableWidth
  // Reserve 1 char for the cursor block
  const maxChars = Math.max(1, availableWidth - 1);

  if (value.length === 0 && placeholder) {
    return <Text dimColor>{placeholder}</Text>;
  }

  // Determine visible window around cursor
  let visibleStart: number;
  let visibleEnd: number;

  if (value.length <= maxChars) {
    // Everything fits
    visibleStart = 0;
    visibleEnd = value.length;
  } else {
    // Scroll to keep cursor visible
    // Try to show text ending at cursor position
    visibleEnd = Math.min(value.length, cursor + Math.floor(maxChars / 4));
    visibleStart = Math.max(0, visibleEnd - maxChars);
    // Ensure cursor is visible
    if (cursor < visibleStart) {
      visibleStart = cursor;
      visibleEnd = Math.min(value.length, visibleStart + maxChars);
    }
  }

  const before = value.slice(visibleStart, cursor);
  const cursorChar = cursor < value.length ? value[cursor] : " ";
  const after = value.slice(cursor + 1, visibleEnd);

  return (
    <Text>
      {visibleStart > 0 ? <Text dimColor>{"…"}</Text> : null}
      <Text>{visibleStart > 0 ? before.slice(1) : before}</Text>
      <Text inverse>{cursorChar}</Text>
      <Text>{after}</Text>
    </Text>
  );
}

export function InputArea({ onSubmit, disabled, incognito, streaming }: InputAreaProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [savedInput, setSavedInput] = useState("");
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  useInput((_input, key) => {
    if (key.upArrow && !key.shift) {
      if (history.length === 0) return;
      const newIdx = Math.min(historyIdx + 1, history.length - 1);
      if (historyIdx === -1) setSavedInput(value);
      setHistoryIdx(newIdx);
      setValue(history[history.length - 1 - newIdx] ?? "");
    }
    if (key.downArrow && !key.shift) {
      if (historyIdx <= 0) {
        setHistoryIdx(-1);
        setValue(savedInput);
        return;
      }
      const newIdx = historyIdx - 1;
      setHistoryIdx(newIdx);
      setValue(history[history.length - 1 - newIdx] ?? "");
    }
  });

  const handleSubmit = (text: string) => {
    if (!text.trim()) return;
    const trimmed = text.trim();

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

  if (incognito) {
    if (streaming) return null;
    const prompt = `${bashPrompt()}$ `;
    const availableWidth = columns - prompt.length;
    return (
      <Box>
        <Text color="green">{prompt}</Text>
        <LineInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          prefix={prompt}
          availableWidth={availableWidth}
        />
      </Box>
    );
  }

  // Normal mode: border (2) + paddingLeft (1) + "> " (2) = 5 chars of overhead
  const normalOverhead = 5;
  const availableWidth = columns - normalOverhead;

  return (
    <Box borderStyle="single" borderColor={disabled ? "gray" : "cyan"} paddingLeft={1}>
      <Text bold color="cyan">&gt; </Text>
      <LineInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={disabled ? "Connecting..." : "Type a message... (Up/Down for history)"}
        availableWidth={availableWidth}
      />
    </Box>
  );
}
