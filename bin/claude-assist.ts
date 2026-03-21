#!/usr/bin/env bun

import { SessionManager, Router, TelegramChannel } from "../src/conduit";
import { ViewServer } from "../src/views/server";

const command = process.argv[2];

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

  // Start view server
  const viewServer = new ViewServer({
    port: env.viewPort,
    baseUrl: env.viewBaseUrl,
  });
  viewServer.start();

  // Set up session manager and router
  const sessionManager = new SessionManager();
  const router = new Router(sessionManager, viewServer);

  const telegram = new TelegramChannel({
    botToken: env.telegramToken,
  });

  router.addChannel(telegram);

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
    await router.stop();
    viewServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await router.start();
}

switch (command) {
  case "start":
    start();
    break;
  case undefined:
  case "help":
    console.log(`
claude-assist — Personal AI assistant via Claude Code

Usage:
  claude-assist start    Start Conduit (session manager + channels + view server)
  claude-assist help     Show this message

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
