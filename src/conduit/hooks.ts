import { spawn } from "bun";
import { homedir } from "os";
import { join } from "path";

const CAIRN_DIR = process.env.CAIRN_DIR ?? join(homedir(), "Projects", "cairn");
const PYTHON = process.env.CAIRN_PYTHON ?? join(CAIRN_DIR, ".venv", "bin", "python3");
const STOP_HOOK = join(CAIRN_DIR, "hooks", "stop_hook.py");
const PROMPT_HOOK = join(CAIRN_DIR, "hooks", "prompt_hook.py");

export type StopHookResult = { block: boolean; reason?: string };

/**
 * Parse stop hook stdout into a result.
 * Exported for testing — this is the core decision logic.
 */
export function parseStopHookOutput(stdout: string): StopHookResult {
  const trimmed = stdout.trim();
  if (!trimmed) return { block: false };

  try {
    const result = JSON.parse(trimmed);
    if (result.decision === "block" && result.reason) {
      return { block: true, reason: result.reason };
    }
  } catch {
    // Not JSON — ignore
  }

  return { block: false };
}

/**
 * Parse prompt hook stdout into a context string.
 * Exported for testing — this is the core extraction logic.
 */
export function parsePromptHookOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  try {
    const result = JSON.parse(trimmed);
    return result.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

/**
 * Build the JSON input for the stop hook subprocess.
 * Exported for testing.
 */
export function buildStopHookInput(
  sessionId: string,
  assistantMessage: string,
  cwd: string,
  isContinuation: boolean
): string {
  return JSON.stringify({
    session_id: sessionId,
    last_assistant_message: assistantMessage,
    cwd,
    stop_hook_active: isContinuation,
    transcript_path: "",
  });
}

/**
 * Build the JSON input for the prompt hook subprocess.
 * Exported for testing.
 */
export function buildPromptHookInput(sessionId: string, userMessage: string): string {
  return JSON.stringify({
    session_id: sessionId,
    user_message: userMessage,
  });
}

/**
 * Run the Cairn stop hook: parse <memory> blocks, store in DB,
 * check for context:insufficient, handle continuation logic.
 *
 * Returns { block: boolean, reason?: string }
 */
export async function runStopHook(
  sessionId: string,
  assistantMessage: string,
  cwd: string,
  isContinuation = false
): Promise<StopHookResult> {
  const input = buildStopHookInput(sessionId, assistantMessage, cwd, isContinuation);

  try {
    const proc = spawn({
      cmd: [PYTHON, STOP_HOOK],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(input);
    proc.stdin.end();

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = parseStopHookOutput(stdout);

    if (result.block) {
      console.log(`[hooks] Stop hook blocked: ${result.reason!.substring(0, 100)}`);
    }

    return result;
  } catch (err) {
    console.error("[hooks] Stop hook error:", err);
    return { block: false };
  }
}

/**
 * Run the Cairn prompt hook: search for relevant context on first message,
 * inject staged cross-project context.
 *
 * Returns additional context string to prepend, or empty string.
 */
export async function runPromptHook(
  sessionId: string,
  userMessage: string
): Promise<string> {
  const input = buildPromptHookInput(sessionId, userMessage);

  try {
    const proc = spawn({
      cmd: [PYTHON, PROMPT_HOOK],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(input);
    proc.stdin.end();

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const context = parsePromptHookOutput(stdout);

    if (context) {
      console.log(`[hooks] Prompt hook injected context (${context.length} chars)`);
    }

    return context;
  } catch (err) {
    console.error("[hooks] Prompt hook error:", err);
    return "";
  }
}
