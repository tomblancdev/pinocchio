# 🐋 Pinocchio

> *"Inside the whale, but still got work to do"*

**Pinocchio** is an MCP (Model Context Protocol) server that spawns autonomous Claude Code agents inside isolated Docker containers. Like the wooden puppet trapped in Monstro's belly, your AI agents run safely contained within the whale. 🎭

## ✨ Features

- **🔒 Secure by Default** - Agents run in isolated containers with read-only workspaces
- **🐳 Docker Socket Proxy** - Limited Docker API access blocks dangerous operations
- **📁 Workspace Allowlist** - Only approved directories can be accessed
- **✍️ Granular Write Access** - Explicit paths/patterns for write permissions
- **⏱️ Configurable Timeouts** - Prevent runaway agents (default: 1h, max: 24h)
- **🔄 Background Execution** - Run agents async with status monitoring
- **🐙 GitHub Integration** - 6 permission levels from read-only to admin
- **⚙️ Unified Configuration** - Single tool for all settings

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Claude Code CLI (`claude` command)
- Claude API credentials (`~/.claude/.credentials.json`)

### Installation

```bash
# Clone the repository
git clone https://github.com/tomblancdev/pinocchio.git
cd pinocchio

# Run setup (builds images and shows config instructions)
./setup.sh
```

### Configure Claude Code

Add to your Claude Code MCP settings (`~/.config/claude-code/settings.json`):

```json
{
  "mcpServers": {
    "docker-agent": {
      "command": "/path/to/pinocchio/run-mcp.sh"
    }
  }
}
```

### First Run

Restart Claude Code and try:

```
Hey Claude, spawn a docker agent to list files in my current project
```

## 🛠️ Available Tools

### `spawn_docker_agent`

Spawn an autonomous Claude agent in a Docker container.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | string | What the agent should do |
| `workspace_path` | string | Absolute path to mount |
| `writable_paths` | string[] | Specific files/dirs for write access |
| `writable_patterns` | string[] | Glob patterns for write access (e.g., `src/**/*.ts`) |
| `timeout_ms` | number | Timeout in milliseconds (default: 1h) |
| `run_in_background` | boolean | Run async, check with `get_agent_status` |
| `github_access` | string | Permission level: none/read/comment/write/manage/admin |
| `allow_docker` | boolean | Allow agent to spawn sub-containers |

### `get_agent_status`

Check status of background agents.

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | string | Optional: specific agent ID |

### `manage_config`

Unified configuration management.

**Workspace management:**
- `workspaces.list` - View allowed, pending, and blocked paths
- `workspaces.propose` - Request access to a new workspace
- `workspaces.approve` - Approve a pending request
- `workspaces.reject` - Reject a pending request
- `workspaces.remove` - Remove from allowlist

**GitHub configuration:**
- `github.show` - View GitHub settings
- `github.set_token` - Store a Personal Access Token
- `github.remove_token` - Remove stored token
- `github.set_default` - Set default access level

**Settings:**
- `settings.show` - View all settings

## 🔐 Security

Pinocchio implements defense-in-depth security:

| Layer | Protection |
|-------|------------|
| Docker Socket Proxy | Blocks BUILD, COMMIT, EXEC, VOLUMES, SECRETS |
| Workspace Allowlist | Only approved paths accessible |
| Read-Only Default | Explicit opt-in for write access |
| Container Hardening | Non-root, CAP_DROP ALL, memory limits |
| Input Validation | Container names, tasks, paths sanitized |
| Timeout Enforcement | Prevents resource exhaustion |

See [security-review.md](./security-review.md) for the full security assessment.

## 📁 Project Structure

```
pinocchio/
├── src/
│   └── index.ts          # MCP server implementation
├── agent-image/
│   ├── Dockerfile        # Claude agent container image
│   └── entrypoint.sh     # Agent startup script
├── docker-compose.yml    # Service definitions
├── run-mcp.sh           # MCP launcher script
├── setup.sh             # Installation helper
├── security-review.md   # Security assessment
└── README.md
```

## 🐙 GitHub Access Levels

| Level | Capabilities |
|-------|--------------|
| `none` | No GitHub access (default) |
| `read` | Read repos, PRs, issues |
| `comment` | Read + post comments |
| `write` | Create PRs, issues, push commits |
| `manage` | Write + milestones, projects, labels |
| `admin` | Full access (settings, workflows, secrets) |

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECTS_ROOT` | `$HOME` | Root directory for workspaces |
| `HOST_CLAUDE_DIR` | `~/.claude` | Claude credentials location |
| `HOST_CONFIG_DIR` | `~/.config/docker-agent-mcp` | Pinocchio config directory |
| `HOST_GH_CONFIG` | `~/.config/gh` | GitHub CLI config |
| `ABSOLUTE_MAX_TIMEOUT` | 86400000 | Maximum timeout (24h) |

## 🤝 Contributing

Contributions welcome! Please read the security review before making changes to security-sensitive code.

## 📜 License

MIT

---

*Named after Pinocchio, who found himself inside Monstro the whale - much like our AI agents running inside Docker. 🐋*
