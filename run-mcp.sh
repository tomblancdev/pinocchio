#!/bin/bash
# MCP Server launcher - runs the MCP server in Docker
# This script is called by Claude Code to start the MCP server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Auto-detect system configuration
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "999")
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)
export HOST_HOME="$HOME"

# Projects root - where workspaces can be mounted from
# Override with PROJECTS_ROOT env var if you want a specific directory
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME}"

# Claude credentials location (usually ~/.claude)
export HOST_CLAUDE_DIR="${HOST_CLAUDE_DIR:-$HOME/.claude}"

# Config directory for Pinocchio
export HOST_CONFIG_DIR="${HOST_CONFIG_DIR:-$HOME/.config/pinocchio}"

# GitHub CLI config directory
export HOST_GH_CONFIG="${HOST_GH_CONFIG:-$HOME/.config/gh}"

# Ensure config directory exists
mkdir -p "$HOST_CONFIG_DIR"

# Create default config if it doesn't exist
if [ ! -f "$HOST_CONFIG_DIR/config.json" ]; then
  cat > "$HOST_CONFIG_DIR/config.json" << EOF
{
  "allowedWorkspaces": [],
  "blockedPaths": ["/etc", "/var", "/root", "/boot", "/sys", "/proc", "/dev"],
  "pendingApprovals": []
}
EOF
fi

# Run the MCP server container with stdio attached
exec docker compose run --rm -T mcp-server
