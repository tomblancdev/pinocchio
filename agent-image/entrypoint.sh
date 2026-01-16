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

# Optional: Change to specific directory if provided
if [ -n "$AGENT_WORKDIR" ] && [ -d "$AGENT_WORKDIR" ]; then
    cd "$AGENT_WORKDIR"
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
exec claude --print \
    --dangerously-skip-permissions \
    "$AGENT_TASK"
