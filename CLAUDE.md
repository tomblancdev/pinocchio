# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pinocchio is an MCP (Model Context Protocol) server that spawns autonomous Claude Code agents inside isolated Docker containers. The agents run in "YOLO mode" (`--dangerously-skip-permissions`) with configurable read/write access to workspaces.

## Commands

```bash
# Full setup (pulls images, builds all containers)
./setup.sh

# Build all images
docker compose build

# Build MCP server only
docker compose build mcp-server

# Build Claude agent image only
docker compose build agent-image

# Run MCP server (used by Claude Code config)
./run-mcp.sh

# Test an agent manually
docker compose run --rm agent-test

# Docker compose helper
./dc.sh [compose commands]
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ stdio (MCP protocol)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Pinocchio MCP Server Container                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              src/index.ts                                │    │
│  │  • spawn_docker_agent - creates agent containers         │    │
│  │  • get_agent_status - monitors background agents         │    │
│  │  • manage_config - workspace allowlist, GitHub settings  │    │
│  └─────────────────────────────────────────────────────────┘    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Docker API (via proxy)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Docker Socket Proxy                              │
│  (tecnativa/docker-socket-proxy)                                 │
│  • Blocks: BUILD, COMMIT, EXEC, VOLUMES, SECRETS                │
│  • Allows: CONTAINERS, IMAGES, NETWORKS                         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                Claude Agent Container                            │
│                (claude-agent:latest)                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ agent-image/entrypoint.sh                                │    │
│  │  • Copies credentials to writable location               │    │
│  │  • Runs: claude --print --dangerously-skip-permissions   │    │
│  └─────────────────────────────────────────────────────────┘    │
│  • Read-only workspace mount (default)                          │
│  • Specific paths mounted writable via overlay                  │
│  • Non-root user, CAP_DROP ALL                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Single-file MCP server with all tool implementations |
| `agent-image/Dockerfile` | Multi-language agent image (Node, Python, Go) |
| `agent-image/entrypoint.sh` | Runs Claude CLI in YOLO mode |
| `docker-compose.yml` | Defines docker-proxy, mcp-server, agent-image services |
| `run-mcp.sh` | Entry point called by Claude Code |

## Security Model

- **Workspace allowlist**: Paths must be pre-approved via `manage_config`
- **Read-only by default**: Workspace mounted `:ro`, specific paths overlaid `:rw`
- **Docker socket proxy**: Filters dangerous Docker API operations
- **Container hardening**: Non-root user, `CAP_DROP ALL`, memory limits

## Configuration

Pinocchio config stored at `~/.config/pinocchio/config.json`:
```json
{
  "allowedWorkspaces": ["/home/user/projects"],
  "blockedPaths": ["/etc", "/var", "/root", "/boot", "/sys", "/proc", "/dev"],
  "pendingApprovals": [],
  "github": { "token": "...", "defaultAccess": "none" }
}
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROJECTS_ROOT` | `$HOME` | Root for workspace verification |
| `HOST_CLAUDE_DIR` | `~/.claude` | Claude credentials location |
| `HOST_CONFIG_DIR` | `~/.config/pinocchio` | Pinocchio config |
| `ABSOLUTE_MAX_TIMEOUT` | 86400000 (24h) | Max agent timeout |
