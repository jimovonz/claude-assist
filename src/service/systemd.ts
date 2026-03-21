import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";

const SERVICE_NAME = "claude-assist";
const SERVICE_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_FILE = join(SERVICE_DIR, `${SERVICE_NAME}.service`);

function getProjectDir(): string {
  // Resolve from this file's location back to project root
  return join(import.meta.dir, "..", "..");
}

function getBunPath(): string {
  // Check common locations
  for (const candidate of [
    join(homedir(), ".bun", "bin", "bun"),
    join(homedir(), ".local", "bin", "bun"),
    "/usr/local/bin/bun",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "bun"; // fallback to PATH
}

export function generateServiceUnit(): string {
  const projectDir = getProjectDir();
  const bunPath = getBunPath();
  const envFile = join(projectDir, ".env");

  const lines = [
    "[Unit]",
    "Description=claude-assist Conduit",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${projectDir}`,
    `ExecStart=${bunPath} run bin/claude-assist.ts start`,
    "Restart=always",
    "RestartSec=5",
    // Ensure claude, bun, cloudflared are all reachable
    `Environment=PATH=${join(homedir(), ".bun", "bin")}:${join(homedir(), ".local", "bin")}:${join(homedir(), ".nvm", "versions", "node", "v24.11.0", "bin")}:/usr/local/bin:/usr/bin:/bin`,
    `Environment=HOME=${homedir()}`,
  ];

  if (existsSync(envFile)) {
    lines.push(`EnvironmentFile=${envFile}`);
  }

  lines.push(
    "",
    "# Logging",
    "StandardOutput=journal",
    "StandardError=journal",
    `SyslogIdentifier=${SERVICE_NAME}`,
    "",
    "# Watchdog",
    "WatchdogSec=120",
    "",
    "[Install]",
    "WantedBy=default.target",
  );

  return lines.join("\n") + "\n";
}

export async function install(): Promise<void> {
  mkdirSync(SERVICE_DIR, { recursive: true });

  const unit = generateServiceUnit();
  writeFileSync(SERVICE_FILE, unit);
  console.log(`Wrote ${SERVICE_FILE}`);

  // Enable linger so user services run without login
  const linger = Bun.spawnSync({
    cmd: ["loginctl", "enable-linger", process.env.USER ?? ""],
  });
  if (linger.exitCode === 0) {
    console.log("Enabled loginctl linger (services run without login session)");
  } else {
    console.warn("Could not enable linger — you may need: sudo loginctl enable-linger $USER");
  }

  // Reload and enable
  Bun.spawnSync({ cmd: ["systemctl", "--user", "daemon-reload"] });
  console.log("Reloaded systemd user daemon");

  Bun.spawnSync({ cmd: ["systemctl", "--user", "enable", SERVICE_NAME] });
  console.log(`Enabled ${SERVICE_NAME}.service`);

  console.log(`\nInstalled. Run: claude-assist service start`);
}

export function serviceCommand(action: string): void {
  switch (action) {
    case "start":
    case "stop":
    case "restart": {
      const r = Bun.spawnSync({
        cmd: ["systemctl", "--user", action, SERVICE_NAME],
      });
      if (r.exitCode !== 0) {
        console.error(`Failed to ${action}: ${r.stderr.toString()}`);
        process.exit(1);
      }
      console.log(`Service ${action}ed`);
      // Show brief status
      statusCommand();
      break;
    }
    default:
      console.error(`Unknown service action: ${action}`);
      process.exit(1);
  }
}

export function statusCommand(): void {
  const r = Bun.spawnSync({
    cmd: ["systemctl", "--user", "status", SERVICE_NAME, "--no-pager"],
  });
  process.stdout.write(r.stdout);
}

export function logsCommand(follow: boolean): void {
  const args = ["journalctl", "--user-unit", SERVICE_NAME, "--no-pager", "-n", "100"];
  if (follow) args.push("-f");

  const proc = Bun.spawn({
    cmd: args,
    stdout: "inherit",
    stderr: "inherit",
  });

  // For -f mode, forward signals
  if (follow) {
    process.on("SIGINT", () => proc.kill());
  }
}
