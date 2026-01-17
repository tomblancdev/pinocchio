# 📖 Pinocchio Usage Guide

This guide covers common usage patterns and examples for Pinocchio.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Workspace Management](#workspace-management)
- [Write Access Control](#write-access-control)
- [Background Agents](#background-agents)
- [GitHub Integration](#github-integration)
- [WebSocket Events](#websocket-events)
- [Advanced Scenarios](#advanced-scenarios)
- [Troubleshooting](#troubleshooting)

---

## Basic Usage

### Spawning Your First Agent

The simplest way to spawn an agent:

```
Claude, spawn a docker agent to analyze the code in /home/user/myproject
```

The MCP server will:
1. Check if the workspace is in the allowlist
2. If not, propose it for approval
3. Once approved, spawn the agent with read-only access

### Read-Only by Default

By default, agents can only **read** files in the workspace. This prevents accidental modifications:

```
Spawn an agent to review the code quality in /home/user/myproject
```

The agent can read all files but cannot modify anything.

---

## Workspace Management

### Viewing Workspaces

```
Use manage_config with action workspaces.list
```

Shows:
- ✅ Allowed workspaces
- ⏳ Pending approvals
- 🚫 Blocked system paths

### Approving a Workspace

When you first try to use a new workspace, it gets proposed for approval:

```
Use manage_config with action workspaces.approve and path /home/user/myproject
```

### Removing a Workspace

```
Use manage_config with action workspaces.remove and path /home/user/myproject
```

---

## Write Access Control

### Specific Files

Grant write access to specific files:

```
Spawn a docker agent to fix the bug in utils.ts
Use writable_paths: ["src/utils.ts"]
```

### Glob Patterns

Use patterns for flexible access:

```
Spawn an agent to refactor all TypeScript files
Use writable_patterns: ["src/**/*.ts", "tests/**/*.ts"]
```

### Common Patterns

| Pattern | Description |
|---------|-------------|
| `src/**/*.ts` | All TypeScript files in src |
| `*.md` | Markdown files in root only |
| `**/*.test.js` | All test files anywhere |
| `docs/**/*` | Everything in docs folder |

### Combining Paths and Patterns

```
Spawn an agent to update the API and docs
Use writable_paths: ["README.md"]
Use writable_patterns: ["src/api/**/*.ts"]
```

---

## Background Agents

### Running in Background

For long-running tasks:

```
Spawn a docker agent in background to run the full test suite
Use run_in_background: true
```

Returns immediately with an agent ID.

### Checking Status

```
Get agent status for agent claude-agent-abc123
```

Or check all agents:

```
Get agent status for all agents
```

### Status Values

| Status | Meaning |
|--------|---------|
| `running` | Agent is still executing |
| `completed` | Finished successfully |
| `failed` | Exited with error |

---

## GitHub Integration

### Setting Up GitHub Access

**Option 1: Personal Access Token (recommended)**

```
Use manage_config with action github.set_token and value ghp_xxxxxxxxxxxx
```

**Option 2: Use existing gh CLI auth**

If you're already authenticated with `gh auth login`, Pinocchio mounts your config automatically.

### Setting Default Access Level

```
Use manage_config with action github.set_default and value comment
```

### Per-Agent Access

Override the default for specific tasks:

```
Spawn an agent to create a PR for this feature
Use github_access: write
```

### Permission Levels Explained

| Level | Use Case |
|-------|----------|
| `none` | Code review, analysis (no GitHub needed) |
| `read` | Fetch PR details, check issues |
| `comment` | QA agents posting review comments |
| `write` | Creating PRs, pushing branches |
| `manage` | Scrum master tasks, milestone management |
| `admin` | Workflow modifications, repo settings |

---

## WebSocket Events

Pinocchio streams real-time events via WebSocket, enabling live monitoring of agent activity.

### Connection Details

| Setting | Default | Description |
|---------|---------|-------------|
| Port | `3001` | TCP port (`WEBSOCKET_PORT` env var) |
| Bind Address | `127.0.0.1` | Localhost only by default |
| Unix Socket | Optional | Alternative to TCP |
| Auth | `none` | `none` or `api-key` |

### Connecting

**No authentication (default):**

```javascript
const ws = new WebSocket('ws://127.0.0.1:3001');
```

**With API key:**

```javascript
const ws = new WebSocket('ws://127.0.0.1:3001', {
  headers: { Authorization: 'Bearer your-api-key' }
});
```

### Subscribing to Events

**Subscribe to all agents:**

```json
{"type": "subscribe", "agentId": "*"}
```

**Subscribe to specific agent:**

```json
{"type": "subscribe", "agentId": "claude-agent-abc123"}
```

**Filter by log level:**

```json
{"type": "subscribe", "agentId": "*", "logLevels": ["warn", "error"]}
```

Available log levels: `debug`, `info`, `warn`, `error`

**Unsubscribe:**

```json
{"type": "unsubscribe", "agentId": "*"}
```

### Event Types

#### `agent.started`

Emitted when an agent container launches.

```json
{
  "type": "event",
  "event": {
    "type": "agent.started",
    "agentId": "claude-agent-abc123",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "data": {
      "task": "Review the authentication module",
      "workspace": "/home/user/myproject"
    }
  }
}
```

#### `agent.log`

Agent output with log level.

```json
{
  "type": "event",
  "event": {
    "type": "agent.log",
    "agentId": "claude-agent-abc123",
    "timestamp": "2024-01-15T10:30:05.000Z",
    "data": {
      "level": "info",
      "message": "Reading file src/auth.ts",
      "metadata": {"file": "src/auth.ts"}
    }
  }
}
```

#### `agent.progress`

Task progress updates.

```json
{
  "type": "event",
  "event": {
    "type": "agent.progress",
    "agentId": "claude-agent-abc123",
    "timestamp": "2024-01-15T10:31:00.000Z",
    "data": {
      "progress": 45,
      "message": "Analyzing dependencies",
      "filesModified": ["src/auth.ts"]
    }
  }
}
```

#### `agent.completed`

Agent finished successfully.

```json
{
  "type": "event",
  "event": {
    "type": "agent.completed",
    "agentId": "claude-agent-abc123",
    "timestamp": "2024-01-15T10:35:00.000Z",
    "data": {
      "exitCode": 0,
      "duration": 300000,
      "filesModified": ["src/auth.ts", "src/utils.ts"]
    }
  }
}
```

#### `agent.failed`

Agent exited with error.

```json
{
  "type": "event",
  "event": {
    "type": "agent.failed",
    "agentId": "claude-agent-abc123",
    "timestamp": "2024-01-15T10:32:00.000Z",
    "data": {
      "exitCode": 1,
      "error": "Timeout exceeded",
      "duration": 120000
    }
  }
}
```

### Server Messages

| Message | Description |
|---------|-------------|
| `{"type": "subscribed", "agentId": "..."}` | Subscription confirmed |
| `{"type": "unsubscribed", "agentId": "..."}` | Unsubscription confirmed |
| `{"type": "pong"}` | Response to ping |
| `{"type": "error", "code": N, "message": "..."}` | Error occurred |

### Error Codes

| Code | Meaning |
|------|---------|
| 4001 | Invalid message format |
| 4002 | Agent not found |
| 4003 | Unauthorized |
| 4004 | Rate limited |
| 4005 | Subscription denied |

### Complete Example

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:3001');

ws.on('open', () => {
  // Subscribe to all agents, only errors and warnings
  ws.send(JSON.stringify({
    type: 'subscribe',
    agentId: '*',
    logLevels: ['warn', 'error']
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);

  if (msg.type === 'event') {
    const { event } = msg;
    switch (event.type) {
      case 'agent.started':
        console.log(`Agent ${event.agentId} started: ${event.data.task}`);
        break;
      case 'agent.log':
        console.log(`[${event.data.level}] ${event.data.message}`);
        break;
      case 'agent.progress':
        console.log(`Progress: ${event.data.progress}%`);
        break;
      case 'agent.completed':
        console.log(`Completed in ${event.data.duration}ms`);
        break;
      case 'agent.failed':
        console.error(`Failed: ${event.data.error}`);
        break;
    }
  }
});

// Keep connection alive
setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 30000);
```

### Event Buffering

Late subscribers receive buffered events for agents they subscribe to. Buffer size is configurable (default: 1000 events per agent).

---

## Advanced Scenarios

### Code Review Agent

```
Spawn a docker agent in background to:
1. Review all changed files in the PR
2. Check for security issues
3. Post comments on GitHub

Use writable_paths: []  (read-only)
Use github_access: comment
Use run_in_background: true
```

### Refactoring Agent

```
Spawn a docker agent to refactor the authentication module:
- Extract common logic to utils
- Add proper TypeScript types
- Update imports across the codebase

Use writable_patterns: ["src/**/*.ts", "src/**/*.tsx"]
Use timeout_ms: 1800000  (30 minutes)
```

### Documentation Agent

```
Spawn a docker agent to:
- Generate API documentation from code
- Update the README with new features
- Create a CHANGELOG entry

Use writable_paths: ["README.md", "CHANGELOG.md", "docs/api.md"]
Use github_access: write  (to push changes)
```

### Multi-Agent Workflow

1. **Analysis Agent** (read-only):
   ```
   Spawn agent to analyze codebase and create improvement plan
   Save to /workspace/plan.md
   Use writable_paths: ["plan.md"]
   ```

2. **Implementation Agent** (with write access):
   ```
   Spawn agent to implement the plan in plan.md
   Use writable_patterns: ["src/**/*.ts"]
   ```

3. **Review Agent** (with GitHub access):
   ```
   Spawn agent to review changes and create PR
   Use github_access: write
   ```

---

## Troubleshooting

### "Workspace not allowed"

The workspace needs to be in the allowlist:

```
Use manage_config with action workspaces.approve and path /your/path
```

### "Permission denied" in container

Check that:
1. The path is in `writable_paths` or matches `writable_patterns`
2. The host user has write permissions to the file

### Agent timeout

Increase the timeout:

```
Use timeout_ms: 3600000  (1 hour)
```

Maximum is 24 hours (86400000 ms).

### "Docker proxy unhealthy"

The Docker socket proxy may need restart:

```bash
cd /path/to/pinocchio
./dc.sh restart docker-proxy
```

### Checking Logs

```bash
# MCP server logs
./dc.sh logs mcp-server

# Docker proxy logs
./dc.sh logs docker-proxy

# Specific agent logs
docker logs claude-agent-<id>
```

### Rebuilding Images

After code changes:

```bash
./dc.sh build
```

---

## Tips & Best Practices

1. **Start read-only** - Only grant write access when needed
2. **Use specific paths** - Prefer explicit paths over broad patterns
3. **Background for long tasks** - Don't block on test suites or large refactors
4. **Minimal GitHub access** - Use the lowest level that works
5. **Check agent output** - Review what files were modified before committing

---

*Happy whale riding! 🐋*
