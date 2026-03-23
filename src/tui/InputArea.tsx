import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { join } from "path";
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
  status?: string;
}

export function bashPrompt(): string {
  const user = userInfo().username;
  const host = hostname().split(".")[0];
  return `${user}@${host}.ai:~/Projects`;
}

/**
 * Custom text input with word-wrapping across multiple lines.
 * Uses a fixed height approach to avoid Ink's height miscalculation on re-render.
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
      if (key.ctrl || key.meta) {
        // Word jump left: skip to start of previous word
        const before = val.slice(0, cur);
        const match = before.match(/(?:^|\s)\S*$/);
        newCur = match ? cur - match[0].length : 0;
      } else {
        newCur = Math.max(0, cur - 1);
      }
    } else if (key.rightArrow) {
      if (key.ctrl || key.meta) {
        // Word jump right: skip to end of next word
        const after = val.slice(cur);
        const match = after.match(/^\S*\s?/);
        newCur = match ? cur + match[0].length : val.length;
      } else {
        newCur = Math.min(val.length, cur + 1);
      }
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

  if (value.length === 0 && placeholder) {
    return <Text dimColor>{placeholder}</Text>;
  }

  const width = Math.max(1, availableWidth);

  // Wrap text into lines of `width` characters
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) {
    lines.push(value.slice(i, i + width));
  }
  if (lines.length === 0) lines.push("");

  // Find which line the cursor is on
  const cursorLine = Math.floor(cursor / width);
  const cursorCol = cursor % width;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (i === cursorLine) {
          const before = line.slice(0, cursorCol);
          const cursorChar = cursorCol < line.length ? line[cursorCol] : " ";
          const after = line.slice(cursorCol + 1);
          return (
            <Text key={i}>
              {before}
              <Text inverse>{cursorChar}</Text>
              {after}
            </Text>
          );
        }
        return <Text key={i}>{line}</Text>;
      })}
    </Box>
  );
}

export function InputArea({ onSubmit, disabled, incognito, streaming, status }: InputAreaProps) {
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
    if (streaming) {
      return status ? <Text dimColor>  {status}</Text> : null;
    }
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
    <Box borderStyle="single" borderColor={disabled ? "gray" : "cyan"} paddingLeft={1} flexDirection="row" alignItems="flex-start">
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
