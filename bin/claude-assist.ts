#!/usr/bin/env bun

import { SessionManager, Router, TelegramChannel, WebSocketChannel, closeDb } from "../src/conduit";
import { TaskScheduler } from "../src/conduit/scheduler";
import { EmailAgent, setupWatchRenewal } from "../src/conduit/email-agent";
import { ViewServer } from "../src/views/server";
import { install, serviceCommand, statusCommand, logsCommand } from "../src/service/systemd";
import { sdReady, sdStopping, startWatchdog } from "../src/service/watchdog";
import { startTunnel } from "../src/service/tunnel";
import { EdgeRelay } from "../src/service/edge-relay";

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

  // Start tunnel for local TUI access (always, unless explicitly disabled)
  const localUrl = `http://localhost:${env.viewPort}`;
  const tunnel = await startTunnel(localUrl);
  const edgeUrl = process.env.EDGE_URL;
  // Edge URL takes priority for view links (stable), tunnel is fallback
  const baseUrl = edgeUrl ?? tunnel?.publicUrl ?? env.viewBaseUrl;
  if (edgeUrl) console.log(`[conduit] Edge server: ${edgeUrl}`);

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
    sessionManager,
  });

  router.addChannel(telegram);
  router.addChannel(wsChannel);

  // Email agent for Gmail push notification processing
  const ownerId = process.env.TELEGRAM_OWNER_ID ?? "";
  const emailAgent = new EmailAgent({
    sessionManager,
    telegram,
    telegramUserId: ownerId,
  });

  // Edge relay for remote TUI access via GCE
  let edgeRelay: EdgeRelay | null = null;
  if (edgeUrl) {
    edgeRelay = new EdgeRelay({
      edgeUrl,
      apiSecret: process.env.EDGE_API_SECRET,
      sessionManager,
      emailAgent,
    });
    router.addChannel(edgeRelay);
  }

  // Ensure Gmail watch renewal task exists
  setupWatchRenewal();

  // Start task scheduler
  const scheduler = new TaskScheduler({ sessionManager, telegram });
  router.setScheduler(scheduler);
  scheduler.start();

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
    scheduler.stop();
    tunnel?.manager.stop();
    if (edgeRelay) await edgeRelay.stop();
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

  // Notify owner of restart via Telegram (delayed to allow edge relay to connect)
  if (ownerId) {
    setTimeout(async () => {
      const { Bot } = await import("grammy");
      const notifyBot = new Bot(env.telegramToken);
      const edgeStatus = edgeRelay?.connected ? "edge connected" : "edge not connected";
      await notifyBot.api.sendMessage(parseInt(ownerId),
        `🔄 claude-assist restarted\n${edgeStatus}`
      ).catch((e: any) => console.error(`[conduit] Failed to send restart notification: ${e.message}`));
    }, 5000);
  }
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
  TELEGRAM_OWNER_ID      Telegram user ID for restart notifications
  VIEW_PORT              Port for view server (default: 8099)
  VIEW_BASE_URL          Base URL for view links (default: http://localhost:VIEW_PORT)
  EDGE_URL               GCE edge server URL for remote TUI access
  EDGE_API_SECRET        Bearer token for edge API
  TUI_AUTH_TOKEN          WebSocket auth token for TUI clients
  CAIRN_DIR              Path to cairn repo (default: ~/Projects/cairn)
  CLOUDFLARE_TUNNEL_TOKEN  Named tunnel token from cloudflared
`);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
