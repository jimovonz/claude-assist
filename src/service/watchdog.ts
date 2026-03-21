import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync } from "fs";

/**
 * Lightweight sd_notify integration for systemd watchdog.
 * If not running under systemd, all calls are no-ops.
 */

let notifyFn: ((state: string) => void) | null = null;

function initNotify(): void {
  if (notifyFn !== null) return;

  // Only activate if systemd is managing us
  if (!process.env.NOTIFY_SOCKET) {
    notifyFn = () => {};
    return;
  }

  try {
    // Try loading libsystemd
    const libPaths = [
      "libsystemd.so.0",
      "libsystemd.so",
      "/usr/lib/x86_64-linux-gnu/libsystemd.so.0",
    ];

    for (const libPath of libPaths) {
      try {
        const lib = dlopen(libPath, {
          sd_notify: {
            args: [FFIType.i32, FFIType.cstring],
            returns: FFIType.i32,
          },
        });

        notifyFn = (state: string) => {
          const buf = Buffer.from(state + "\0");
          lib.symbols.sd_notify(0, ptr(buf));
        };
        return;
      } catch {
        continue;
      }
    }

    // Fallback: no libsystemd available
    notifyFn = () => {};
  } catch {
    notifyFn = () => {};
  }
}

export function sdNotify(state: string): void {
  initNotify();
  notifyFn!(state);
}

export function sdReady(): void {
  sdNotify("READY=1");
}

export function sdWatchdog(): void {
  sdNotify("WATCHDOG=1");
}

export function sdStopping(): void {
  sdNotify("STOPPING=1");
}

/**
 * Start periodic watchdog pings. Call after startup.
 * Pings at half the WatchdogSec interval.
 */
export function startWatchdog(): Timer | null {
  const watchdogUsec = process.env.WATCHDOG_USEC;
  if (!watchdogUsec) return null;

  const parsed = parseInt(watchdogUsec);
  if (isNaN(parsed) || parsed <= 0) return null;
  const intervalMs = Math.floor(parsed / 1000 / 2);
  if (intervalMs <= 0) return null;

  console.log(`[watchdog] Pinging every ${intervalMs}ms`);
  return setInterval(() => sdWatchdog(), intervalMs);
}
