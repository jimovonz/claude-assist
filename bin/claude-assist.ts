#!/usr/bin/env bun

import { SessionManager, Router, TelegramChannel, WebSocketChannel, closeDb } from "../src/conduit";
import { ViewServer } from "../src/views/server";
import { install, serviceCommand, statusCommand, logsCommand } from "../src/service/systemd";
import { sdReady, sdStopping, startWatchdog } from "../src/service/watchdog";
import { startTunnel } from "../src/service/tunnel";

const command = process.argv[2];
const subcommand = process.argv[3];

function loadEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const viewPort = parseInt(process.env.VIEW_PORT ?? "8099");
  const viewBaseUrl = process.env.VIEW_BASE_URL ?? `http://localhost:${viewPort}`;

  return { telegramToken: token, viewPort, viewBaseUrl };
}

async function start() {
  const env = loadEnv();

  // Set up session manager (loads persisted state from disk)
  const sessionManager = new SessionManager();

  // Set up WebSocket channel for TUI clients
  const wsChannel = new WebSocketChannel({
    authToken: process.env.TUI_AUTH_TOKEN,
    sessionManager,
  });

  // Start tunnel to get public URL before creating view server
  const localUrl = `http://localhost:${env.viewPort}`;
  const tunnel = await startTunnel(localUrl);
  const baseUrl = tunnel?.publicUrl ?? env.viewBaseUrl;

  console.log(`[conduit] View base URL: ${baseUrl}`);

  // Start view server with health provider and WebSocket support
  const viewServer = new ViewServer({
    port: env.viewPort,
    baseUrl,
    healthProvider: sessionManager,
    wsChannel,
  });
  viewServer.start();

  const router = new Router(sessionManager, viewServer);

  const telegram = new TelegramChannel({
    botToken: env.telegramToken,
  });

  router.addChannel(telegram);
  router.addChannel(wsChannel);

  // Prune idle sessions every 5 minutes
  setInterval(() => {
    const pruned = sessionManager.pruneIdle();
    if (pruned.length > 0) {
      console.log(`[conduit] Pruned idle sessions: ${pruned.join(", ")}`);
    }
  }, 5 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[conduit] Shutting down...");
    sdStopping();
    tunnel?.manager.stop();
    await router.stop();
    viewServer.stop();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await router.start();

  // Signal systemd we're ready and start watchdog
  sdReady();
  startWatchdog();

  console.log("[conduit] Service ready");
}

switch (command) {
  case "start":
    start();
    break;

  case "install":
    install();
    break;

  case "service":
    if (!subcommand || !["start", "stop", "restart"].includes(subcommand)) {
      console.error("Usage: claude-assist service <start|stop|restart>");
      process.exit(1);
    }
    serviceCommand(subcommand);
    break;

  case "status":
    statusCommand();
    break;

  case "logs":
    logsCommand(process.argv.includes("-f") || process.argv.includes("--follow"));
    break;

  case undefined:
  case "help":
    console.log(`
claude-assist — Personal AI assistant via Claude Code

Usage:
  claude-assist start              Start Conduit directly (foreground)
  claude-assist install            Install systemd user service + enable linger
  claude-assist service <action>   start | stop | restart the systemd service
  claude-assist status             Show service status
  claude-assist logs [-f]          Show service logs (follow with -f)
  claude-assist help               Show this message

Environment:
  TELEGRAM_BOT_TOKEN     Bot token from @BotFather (required)
  VIEW_PORT              Port for view server (default: 8099)
  VIEW_BASE_URL          Base URL for view links (default: http://localhost:VIEW_PORT)
`);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
