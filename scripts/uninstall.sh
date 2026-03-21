#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="claude-assist"
SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
STATE_DIR="$HOME/.local/state/claude-assist"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
info()   { printf "  %s\n" "$*"; }

echo "=== claude-assist uninstaller ==="
echo

# --- Stop and disable service ---

if systemctl --user is-active "$SERVICE_NAME" &>/dev/null; then
  echo "Stopping service..."
  systemctl --user stop "$SERVICE_NAME"
  green "Service stopped"
else
  info "Service not running"
fi

if systemctl --user is-enabled "$SERVICE_NAME" &>/dev/null; then
  echo "Disabling service..."
  systemctl --user disable "$SERVICE_NAME"
  green "Service disabled"
else
  info "Service not enabled"
fi

# --- Remove service file ---

if [[ -f "$SERVICE_FILE" ]]; then
  rm "$SERVICE_FILE"
  systemctl --user daemon-reload
  green "Removed $SERVICE_FILE"
else
  info "No service file found"
fi

# --- Remove state ---

if [[ -d "$STATE_DIR" ]]; then
  echo
  yellow "State directory exists: $STATE_DIR"
  info "Contains: session database (conduit.db)"
  read -rp "  Remove state directory? [y/N] " answer
  if [[ "${answer,,}" == "y" ]]; then
    rm -rf "$STATE_DIR"
    green "Removed $STATE_DIR"
  else
    info "Kept $STATE_DIR"
  fi
else
  info "No state directory found"
fi

echo
green "Uninstall complete"
info "The project directory was not removed."
info "To fully remove: rm -rf $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
