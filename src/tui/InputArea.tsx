import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useStdout } from "ink";
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
  onKeyRef?: React.MutableRefObject<((input: string, key: any) => void) | undefined>;
}

export function bashPrompt(): string {
  const user = userInfo().username;
  const host = hostname().split(".")[0];
  return `${user}@${host}.ai:~/Projects`;
}

/**
 * Pure display component — no useInput. Cursor managed by parent.
 */
function LineInput({
  value,
  cursor,
  placeholder,
  availableWidth,
}: {
  value: string;
  cursor: number;
  placeholder?: string;
  availableWidth: number;
}) {
  if (value.length === 0 && placeholder) {
    return <Text dimColor>{placeholder}</Text>;
  }

  const width = Math.max(1, availableWidth);

  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) {
    lines.push(value.slice(i, i + width));
  }
  if (lines.length === 0) lines.push("");

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

export function InputArea({ onSubmit, disabled, incognito, streaming, status, onKeyRef }: InputAreaProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [savedInput, setSavedInput] = useState("");
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Refs for the key handler — avoids stale closures
  const valRef = useRef(value);
  const curRef = useRef(cursor);
  const historyRef = useRef(history);
  const historyIdxRef = useRef(historyIdx);
  const savedInputRef = useRef(savedInput);
  valRef.current = value;
  curRef.current = cursor;
  historyRef.current = history;
  historyIdxRef.current = historyIdx;
  savedInputRef.current = savedInput;

  const doSubmit = useCallback((text: string) => {
    if (!text.trim()) return;
    const trimmed = text.trim();

    const h = historyRef.current;
    const newHistory = h[h.length - 1] === trimmed ? h : [...h, trimmed];
    setHistory(newHistory);
    saveHistory(newHistory);
    setHistoryIdx(-1);
    setSavedInput("");

    onSubmit(trimmed);
    setValue("");
    setCursor(0);
    valRef.current = "";
    curRef.current = 0;
  }, [onSubmit]);

  // Register consolidated key handler via ref
  const handler = useCallback((input: string, key: any) => {
    // History navigation
    if (key.upArrow && !key.shift) {
      const h = historyRef.current;
      const idx = historyIdxRef.current;
      if (h.length === 0) return;
      const newIdx = Math.min(idx + 1, h.length - 1);
      if (idx === -1) setSavedInput(valRef.current);
      setHistoryIdx(newIdx);
      const newVal = h[h.length - 1 - newIdx] ?? "";
      setValue(newVal);
      setCursor(newVal.length);
      valRef.current = newVal;
      curRef.current = newVal.length;
      return;
    }
    if (key.downArrow && !key.shift) {
      if (historyIdxRef.current <= 0) {
        setHistoryIdx(-1);
        const newVal = savedInputRef.current;
        setValue(newVal);
        setCursor(newVal.length);
        valRef.current = newVal;
        curRef.current = newVal.length;
        return;
      }
      const newIdx = historyIdxRef.current - 1;
      setHistoryIdx(newIdx);
      const h = historyRef.current;
      const newVal = h[h.length - 1 - newIdx] ?? "";
      setValue(newVal);
      setCursor(newVal.length);
      valRef.current = newVal;
      curRef.current = newVal.length;
      return;
    }

    // Text editing
    const val = valRef.current;
    const cur = curRef.current;

    if (key.return) {
      doSubmit(val);
      return;
    }

    if (key.escape || key.tab) return;

    let newVal = val;
    let newCur = cur;

    if (key.backspace || key.delete) {
      if (cur > 0) {
        newVal = val.slice(0, cur - 1) + val.slice(cur);
        newCur = cur - 1;
      }
    } else if (key.leftArrow) {
      if (key.ctrl || key.meta) {
        const before = val.slice(0, cur);
        const match = before.match(/(?:^|\s)\S*$/);
        newCur = match ? cur - match[0].length : 0;
      } else {
        newCur = Math.max(0, cur - 1);
      }
    } else if (key.rightArrow) {
      if (key.ctrl || key.meta) {
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

    // Update refs immediately
    valRef.current = newVal;
    curRef.current = newCur;

    if (newVal !== val) setValue(newVal);
    if (newCur !== cur) setCursor(newCur);
  }, [doSubmit]);

  useEffect(() => {
    if (onKeyRef) onKeyRef.current = handler;
  }, [handler, onKeyRef]);

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
          cursor={cursor}
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
        cursor={cursor}
        placeholder={disabled ? "Connecting..." : "Type a message... (Up/Down for history)"}
        availableWidth={availableWidth}
      />
    </Box>
  );
}
