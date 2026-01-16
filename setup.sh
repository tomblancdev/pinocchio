#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🐳 Docker Agent MCP - Setup Script"
echo "===================================="

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi
echo "✅ Docker is running"

# Check if Claude credentials exist
if [ ! -d "$HOME/.claude" ]; then
    echo "❌ Claude credentials not found at ~/.claude"
    echo "   Please run 'claude' and login first."
    exit 1
fi
echo "✅ Claude credentials found"

# Set up environment variables
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "999")
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)
export HOST_HOME="$HOME"
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME}"
export HOST_CLAUDE_DIR="${HOST_CLAUDE_DIR:-$HOME/.claude}"
export HOST_CONFIG_DIR="${HOST_CONFIG_DIR:-$HOME/.config/docker-agent-mcp}"

echo "✅ Docker GID: $DOCKER_GID"
echo "✅ User: $HOST_UID:$HOST_GID"
echo "✅ Projects root: $PROJECTS_ROOT"

# Create config directory
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
    echo "✅ Created default config at $HOST_CONFIG_DIR/config.json"
else
    echo "✅ Config exists at $HOST_CONFIG_DIR/config.json"
fi

# Pull Docker Socket Proxy image
echo ""
echo "📦 Pulling Docker Socket Proxy image..."
docker compose pull docker-proxy

# Build MCP server image
echo ""
echo "🔨 Building MCP server image..."
docker compose build mcp-server

# Build Claude agent image
echo ""
echo "🐳 Building Claude agent image (this may take a few minutes)..."
docker compose build agent-image

# Make run script executable
chmod +x run-mcp.sh

echo ""
echo "✅ Setup complete!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Next steps:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Add the MCP server to your Claude Code config:"
echo ""
echo "   Add to ~/.claude/settings.json (or project .mcp.json):"
echo ""
echo '   "docker-agent": {'
echo "     \"command\": \"$SCRIPT_DIR/run-mcp.sh\""
echo '   }'
echo ""
echo "2. Restart Claude Code to pick up the new MCP server"
echo ""
echo "3. Available tools:"
echo "   • spawn_docker_agent  - Spawn an autonomous agent in Docker"
echo "   • manage_workspaces   - Manage allowed workspace paths"
echo "   • list_docker_agents  - List running agents"
echo "   • stop_docker_agent   - Stop a running agent"
echo ""
echo "4. First time? Add a workspace:"
echo "   manage_workspaces(action: 'approve', path: '/path/to/your/project')"
echo ""
