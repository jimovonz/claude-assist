#!/usr/bin/env bun
/**
 * Mock claude subprocess that speaks the stream-json protocol.
 *
 * Reads newline-delimited JSON from stdin (user messages).
 * Writes newline-delimited JSON to stdout (assistant events, results).
 *
 * Behavior is controlled by a scenario file at /tmp/mock-claude-scenario.
 * Re-reads the scenario file on each message (so tests can change it mid-session).
 */

import { readFileSync } from "fs";

function readScenario(): { scenario: string; sessionId: string } {
  try {
    const lines = readFileSync("/tmp/mock-claude-scenario", "utf-8").trim().split("\n");
    return { scenario: lines[0] ?? "simple", sessionId: lines[1] ?? "mock-session-001" };
  } catch {
    return { scenario: "simple", sessionId: "mock-session-001" };
  }
}

function emit(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Read lines from stdin, yielding each complete line
async function* readLines(): AsyncGenerator<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }
}

async function handleMessage(raw: string) {
  const { scenario, sessionId } = readScenario();
  const input = JSON.parse(raw);
  const userText = input.message?.content?.[0]?.text ?? "";

  switch (scenario) {
    case "simple":
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: `Response to: ${userText}` }] },
      });
      emit({ type: "result", result: `Response to: ${userText}`, session_id: sessionId });
      break;

    case "tool_use":
      emit({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Read",
            input: { file_path: "/home/user/project/src/main.ts" },
          }],
        },
      });
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "I read the file." }] },
      });
      emit({ type: "result", result: "I read the file.", session_id: sessionId });
      break;

    case "multi_text":
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "First part." }] },
      });
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "Second part." }] },
      });
      emit({ type: "result", result: "Second part.", session_id: sessionId });
      break;

    case "empty":
      emit({ type: "result", result: "", session_id: sessionId });
      break;

    case "slow":
      await Bun.sleep(100);
      emit({ type: "result", result: `Slow response to: ${userText}`, session_id: sessionId });
      break;

    case "crash":
      process.exit(1);
  }
}

async function main() {
  for await (const line of readLines()) {
    await handleMessage(line);
  }
}

main();
