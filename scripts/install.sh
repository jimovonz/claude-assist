#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="claude-assist"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
info()   { printf "  %s\n" "$*"; }

echo "=== claude-assist installer ==="
echo

# --- Prerequisites ---

check_bin() {
  if ! command -v "$1" &>/dev/null; then
    red "Missing: $1"
    info "$2"
    return 1
  fi
  green "Found: $1 ($(command -v "$1"))"
}

MISSING=0
check_bin bun   "Install from https://bun.sh"                           || MISSING=1
check_bin claude "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview" || MISSING=1

if [[ $MISSING -eq 1 ]]; then
  echo
  red "Install missing prerequisites and re-run."
  exit 1
fi

# Optional
check_bin cloudflared "Optional: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/" || true
echo

# --- Dependencies ---

echo "Installing dependencies..."
(cd "$PROJECT_DIR" && bun install)
green "Dependencies installed"
echo

# --- Environment ---

ENV_FILE="$PROJECT_DIR/.env"
ENV_EXAMPLE="$PROJECT_DIR/.env.example"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    yellow "Created .env from .env.example — edit it with your TELEGRAM_BOT_TOKEN"
  else
    red "No .env.example found"
    exit 1
  fi
else
  green ".env already exists"
fi

# Check for token
if ! grep -q 'TELEGRAM_BOT_TOKEN=.' "$ENV_FILE" 2>/dev/null; then
  yellow "TELEGRAM_BOT_TOKEN is not set in .env"
  info "Get one from @BotFather on Telegram and add it to $ENV_FILE"
  echo
fi

# --- systemd service ---

echo "Installing systemd user service..."
bun run "$PROJECT_DIR/bin/claude-assist.ts" install
echo

# --- Verify ---

echo "=== Installation complete ==="
echo
info "Edit your config:   $ENV_FILE"
info "Start the service:  claude-assist service start"
info "Check status:        claude-assist status"
info "Follow logs:         claude-assist logs -f"
echo
info "Or run directly:     bun run start"
