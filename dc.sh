#!/bin/bash
# Wrapper script to run docker compose with correct environment variables
# Usage: ./dc.sh build, ./dc.sh up, etc.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Set environment variables (same as run-mcp.sh)
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "999")
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)
export HOST_HOME="$HOME"
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME}"
export HOST_CLAUDE_DIR="${HOST_CLAUDE_DIR:-$HOME/.claude}"
export HOST_CONFIG_DIR="${HOST_CONFIG_DIR:-$HOME/.config/docker-agent-mcp}"

# Run docker compose with all arguments passed through
exec docker compose "$@"
