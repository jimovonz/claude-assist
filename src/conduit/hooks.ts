import { spawn } from "bun";
import { homedir } from "os";
import { join } from "path";

const CAIRN_DIR = process.env.CAIRN_DIR ?? join(homedir(), "Projects", "cairn");
const PYTHON = process.env.CAIRN_PYTHON ?? join(CAIRN_DIR, ".venv", "bin", "python3");
const STOP_HOOK = join(CAIRN_DIR, "hooks", "stop_hook.py");
const PROMPT_HOOK = join(CAIRN_DIR, "hooks", "prompt_hook.py");

/**
 * Run the Cairn stop hook: parse <memory> blocks, store in DB,
 * check for context:insufficient, handle continuation logic.
 *
 * Returns { block: boolean, reason?: string, contextQuery?: string }
 */
export async function runStopHook(
  sessionId: string,
  assistantMessage: string,
  cwd: string,
  isContinuation = false
): Promise<{ block: boolean; reason?: string }> {
  const input = JSON.stringify({
    session_id: sessionId,
    last_assistant_message: assistantMessage,
    cwd,
    stop_hook_active: isContinuation,
    transcript_path: "",
  });

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

    // Hook signals block by printing JSON with decision:"block" to stdout (exit 0)
    // or by exiting with code 2
    if (stdout.trim()) {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.decision === "block" && result.reason) {
          console.log(`[hooks] Stop hook blocked: ${result.reason.substring(0, 100)}`);
          return { block: true, reason: result.reason };
        }
      } catch {
        // Not JSON — ignore
      }
    }

    return { block: false };
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
  const input = JSON.stringify({
    session_id: sessionId,
    user_message: userMessage,
  });

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

    if (stdout.trim()) {
      try {
        const result = JSON.parse(stdout.trim());
        const context = result.hookSpecificOutput?.additionalContext ?? "";
        if (context) {
          console.log(`[hooks] Prompt hook injected context (${context.length} chars)`);
        }
        return context;
      } catch {
        return "";
      }
    }

    return "";
  } catch (err) {
    console.error("[hooks] Prompt hook error:", err);
    return "";
  }
}
