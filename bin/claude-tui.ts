#!/usr/bin/env bun

import React from "react";
import { render } from "ink";
import { App } from "../src/tui/App";

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
claude-tui — Terminal client for claude-assist Conduit

Usage:
  claude-tui [options]

Options:
  --host <url>     Conduit URL (default: http://localhost:8099)
  --token <token>  Authentication token (or set CONDUIT_TOKEN / TUI_AUTH_TOKEN)
  --help, -h       Show this message

Environment:
  CONDUIT_HOST     Conduit URL (default: http://localhost:8099)
  CONDUIT_TOKEN    Authentication token
  TUI_AUTH_TOKEN   Authentication token (fallback)
`);
  process.exit(0);
}

const host = getArg("--host") ?? process.env.CONDUIT_HOST ?? "http://conduit.alimento.co.nz";
const token = getArg("--token") ?? process.env.CONDUIT_TOKEN ?? process.env.TUI_AUTH_TOKEN ?? "";

render(React.createElement(App, { host, token }));
