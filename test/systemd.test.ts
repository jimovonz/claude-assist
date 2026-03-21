import { test, expect, describe } from "bun:test";
import { generateServiceUnit } from "../src/service/systemd";
import { homedir } from "os";

// =============================================================================
// systemd Unit Generation
//
// The generated service unit must be correct — errors here mean the service
// won't start, won't restart on crash, or won't have access to required
// binaries. Test the structural contract of the generated unit.
// =============================================================================

describe("service unit content", () => {
  const unit = generateServiceUnit();

  test("has correct service type", () => {
    expect(unit).toContain("Type=simple");
  });

  test("has WorkingDirectory pointing to project root", () => {
    expect(unit).toMatch(/WorkingDirectory=.*claude-assist/);
  });

  test("ExecStart invokes bun with the correct entrypoint", () => {
    expect(unit).toMatch(/ExecStart=.*bun run bin\/claude-assist\.ts start/);
  });

  test("has Restart=always for crash recovery", () => {
    expect(unit).toContain("Restart=always");
  });

  test("has RestartSec for delay between restarts", () => {
    expect(unit).toMatch(/RestartSec=\d+/);
  });

  test("has WatchdogSec for health monitoring", () => {
    expect(unit).toMatch(/WatchdogSec=\d+/);
  });

  test("PATH includes bun binary directory", () => {
    expect(unit).toContain(".bun/bin");
  });

  test("PATH includes directory containing claude binary", () => {
    // claude is typically in ~/.local/bin or via nvm
    // The PATH should include directories that would contain it
    expect(unit).toMatch(/PATH=.*\/(\.local\/bin|nvm)/);
  });

  test("HOME environment is set", () => {
    expect(unit).toContain(`Environment=HOME=${homedir()}`);
  });

  test("logs to journal", () => {
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
  });

  test("has SyslogIdentifier for filtering logs", () => {
    expect(unit).toContain("SyslogIdentifier=claude-assist");
  });

  test("targets network-online for startup ordering", () => {
    expect(unit).toContain("After=network-online.target");
  });

  test("installs to default.target for autostart", () => {
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("service unit structure", () => {
  const unit = generateServiceUnit();

  test("has [Unit] section", () => {
    expect(unit).toContain("[Unit]");
  });

  test("has [Service] section", () => {
    expect(unit).toContain("[Service]");
  });

  test("has [Install] section", () => {
    expect(unit).toContain("[Install]");
  });

  test("ends with newline", () => {
    expect(unit).toEndWith("\n");
  });
});
