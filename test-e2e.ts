#!/usr/bin/env bun

/**
 * End-to-end test: Telegram → Conduit → Claude CLI → response
 * Uses the full stack including view server.
 */

import { SessionManager, Router, TelegramChannel } from "./src/conduit";
import { ViewServer } from "./src/views/server";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

// Start view server
const viewPort = parseInt(process.env.VIEW_PORT ?? "8099");
const viewBaseUrl = process.env.VIEW_BASE_URL ?? `http://localhost:${viewPort}`;
const viewServer = new ViewServer({ port: viewPort, baseUrl: viewBaseUrl });
viewServer.start();
console.log(`View URLs will use: ${viewBaseUrl}`);

const sessionManager = new SessionManager();
const router = new Router(sessionManager, viewServer);

const telegram = new TelegramChannel({
  botToken: token,
});

router.addChannel(telegram);

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await router.stop();
  viewServer.stop();
  process.exit(0);
});

console.log("Starting Conduit e2e test (full stack + views)...");
console.log("DM your bot on Telegram to test.\n");

await router.start();
