#!/bin/bash
set -e

# Claude Agent Entrypoint
# Runs Claude Code with Max subscription in non-interactive YOLO mode

# Check if task is provided
if [ -z "$AGENT_TASK" ]; then
    echo "ERROR: AGENT_TASK environment variable is required"
    exit 1
fi

# Claude credentials are mounted read-only at /tmp/claude-creds
CREDS_DIR="${CLAUDE_CREDS_DIR:-/tmp/claude-creds}"
if [ ! -f "$CREDS_DIR/.credentials.json" ]; then
    echo "ERROR: Claude credentials not found at $CREDS_DIR/.credentials.json"
    exit 1
fi

# Create a writeable config directory for this agent session
CLAUDE_DIR="/tmp/claude-agent"
mkdir -p "$CLAUDE_DIR"

# Copy credentials to writeable location
cp "$CREDS_DIR/.credentials.json" "$CLAUDE_DIR/"

export CLAUDE_CONFIG_DIR="$CLAUDE_DIR"

# Set HOME to a writable location (container may run as host UID, not 'agent' user)
export HOME="/tmp/agent-home"
mkdir -p "$HOME"

# Set cache directory to writable location (fixes UID mismatch)
export XDG_CACHE_HOME="/tmp/cache"
mkdir -p "$XDG_CACHE_HOME"

# Set up GitHub CLI credentials if mounted
GH_CREDS_DIR="/tmp/gh-creds"
if [ -d "$GH_CREDS_DIR" ]; then
    GH_CONFIG_DIR="/tmp/gh-config"
    mkdir -p "$GH_CONFIG_DIR"
    cp "$GH_CREDS_DIR"/* "$GH_CONFIG_DIR/" 2>/dev/null || true
    chmod 600 "$GH_CONFIG_DIR"/* 2>/dev/null || true
    export GH_CONFIG_DIR
fi

# SECURITY FIX #8: Read GitHub token from secure file instead of environment variable.
# This prevents the token from being exposed via `docker inspect`.
# The token file is mounted at /run/secrets/github_token (standard secrets location).
if [ -n "$GITHUB_TOKEN_FILE" ] && [ -f "$GITHUB_TOKEN_FILE" ]; then
    GITHUB_TOKEN=$(cat "$GITHUB_TOKEN_FILE")
    GH_TOKEN="$GITHUB_TOKEN"
    export GITHUB_TOKEN GH_TOKEN
    # Unset the file path variable (it's no longer needed and reduces info leakage)
    unset GITHUB_TOKEN_FILE
fi

# Optional: Change to specific directory if provided
if [ -n "$AGENT_WORKDIR" ] && [ -d "$AGENT_WORKDIR" ]; then
    cd "$AGENT_WORKDIR"
fi

# Configure spawn proxy MCP server for nested agent spawning
# Issue #104: Support both UDS (PINOCCHIO_API_SOCKET) and HTTP (PINOCCHIO_API_URL)
# Use --mcp-config flag to pass configuration to Claude CLI
MCP_CONFIG_FLAG=""
if [ -n "$PINOCCHIO_SESSION_TOKEN" ] && { [ -n "$PINOCCHIO_API_SOCKET" ] || [ -n "$PINOCCHIO_API_URL" ]; }; then
    MCP_CONFIG_FILE="/tmp/mcp_config.json"

    # Build env vars for spawn-proxy (only include non-empty values)
    SPAWN_ENV="\"PINOCCHIO_SESSION_TOKEN\": \"$PINOCCHIO_SESSION_TOKEN\""
    if [ -n "$PINOCCHIO_API_SOCKET" ]; then
        SPAWN_ENV="$SPAWN_ENV, \"PINOCCHIO_API_SOCKET\": \"$PINOCCHIO_API_SOCKET\""
    fi
    if [ -n "$PINOCCHIO_API_URL" ]; then
        SPAWN_ENV="$SPAWN_ENV, \"PINOCCHIO_API_URL\": \"$PINOCCHIO_API_URL\""
    fi
    if [ -n "$PINOCCHIO_HOST_WORKSPACE" ]; then
        SPAWN_ENV="$SPAWN_ENV, \"PINOCCHIO_HOST_WORKSPACE\": \"$PINOCCHIO_HOST_WORKSPACE\""
    fi

    cat > "$MCP_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "spawn-proxy": {
      "command": "/usr/local/bin/spawn-proxy",
      "args": [],
      "env": {
        $SPAWN_ENV
      }
    }
  }
}
EOF
    MCP_CONFIG_FLAG="--mcp-config $MCP_CONFIG_FILE"
    echo "[entrypoint] Spawn proxy MCP server configured (socket: ${PINOCCHIO_API_SOCKET:-none}, url: ${PINOCCHIO_API_URL:-none})"
else
    echo "[entrypoint] Spawn proxy not configured (need PINOCCHIO_SESSION_TOKEN and either PINOCCHIO_API_SOCKET or PINOCCHIO_API_URL)"
fi

echo "╔══════════════════════════════════════════╗"
echo "║       🤖 Claude Agent Starting          ║"
echo "╠══════════════════════════════════════════╣"
echo "║ Working dir: $(pwd)"
echo "║ Task: ${AGENT_TASK:0:50}..."
echo "╚══════════════════════════════════════════╝"

# Run Claude Code in print mode (non-interactive) with dangerously-skip-permissions
# --print: Run in non-interactive mode, execute the prompt and exit
# --dangerously-skip-permissions: Skip all permission prompts (YOLO mode)
# --mcp-config: Load MCP servers for nested agent spawning (if configured)
# shellcheck disable=SC2086
exec claude --print \
    --dangerously-skip-permissions \
    $MCP_CONFIG_FLAG \
    "$AGENT_TASK"
