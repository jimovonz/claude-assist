#!/usr/bin/env bash
# Wrapper that ignores claude CLI args and runs mock-claude instead.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$DIR/mock-claude.ts"
