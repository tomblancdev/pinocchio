# Nested Agent Spawning

Pinocchio supports **nested agent spawning**, allowing parent agents to spawn child agents that can themselves spawn further children. This creates hierarchical task decomposition where complex work can be divided among multiple autonomous agents.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Key Concepts](#key-concepts)
  - [Spawn Trees](#spawn-trees)
  - [Session Tokens](#session-tokens)
  - [Hierarchy Tracking](#hierarchy-tracking)
- [Configuration](#configuration)
  - [NestedSpawnConfig](#nestedspawnconfig)
  - [Environment Variables](#environment-variables)
- [Lifecycle Management](#lifecycle-management)
  - [Cascade Termination](#cascade-termination)
  - [Orphan Detection](#orphan-detection)
- [Security Model](#security-model)
- [State Persistence](#state-persistence)
- [Audit Logging](#audit-logging)

---

## Overview

Nested spawning enables a parent agent to delegate subtasks to child agents. Each child runs in its own isolated Docker container with the same security guarantees as root agents. Children can spawn their own children (grandchildren), creating a tree structure of cooperating agents.

**Key benefits:**

- **Task decomposition**: Break complex tasks into smaller, parallel subtasks
- **Resource isolation**: Each agent runs in a separate container
- **Hierarchical control**: Parents can monitor and terminate their children
- **Quota enforcement**: Prevents runaway spawning with depth and count limits

**Example use case:**

```
Root Agent: "Refactor the authentication module"
├── Child 1: "Update the login component"
├── Child 2: "Migrate password hashing"
│   ├── Grandchild 2.1: "Update hash function"
│   └── Grandchild 2.2: "Write migration script"
└── Child 3: "Update session management"
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Pinocchio MCP Server                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Session Token Manager                         │   │
│  │  • generateSessionToken() - HMAC-signed tokens                   │   │
│  │  • validateSessionToken() - Verify signature, expiry, tree       │   │
│  │  • invalidateTokensForTree() - Cleanup on tree termination       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Spawn Tree Registry                           │   │
│  │  • createSpawnTree() - Initialize new tree for root agents       │   │
│  │  • updateTreeAgentCount() - Track total agents in tree           │   │
│  │  • terminateSpawnTree() - Mark tree as terminated                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Lifecycle Manager                             │   │
│  │  • terminateWithChildren() - Cascade termination                 │   │
│  │  • detectOrphanedAgents() - Find agents with dead parents        │   │
│  │  • cleanupOrphanedAgents() - Terminate orphaned agents           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    HTTP API Server                               │   │
│  │  • POST /api/v1/spawn - Child spawn endpoint                     │   │
│  │  • Token validation, rate limiting, quota checks                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 │ Docker API
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Docker Container Pool                            │
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  Root Agent     │  │  Child Agent    │  │  Grandchild     │         │
│  │  (depth: 0)     │──│  (depth: 1)     │──│  (depth: 2)     │         │
│  │  treeId: abc    │  │  treeId: abc    │  │  treeId: abc    │         │
│  │                 │  │  parent: root   │  │  parent: child  │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Communication Flow

When a child agent is spawned:

1. **Parent agent** calls the `spawn_agent` MCP tool (via spawn-proxy)
2. **Spawn proxy** sends HTTP POST to `/api/v1/spawn` with session token
3. **MCP server** validates token, checks quotas, creates child container
4. **Child container** starts with inherited `treeId` and incremented `depth`
5. **Response** returns to parent with `agent_id` and quota information

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Parent Agent │     │ Spawn Proxy  │     │  MCP Server  │     │ Child Agent  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │                    │
       │ spawn_agent(task)  │                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │                    │ POST /api/v1/spawn │                    │
       │                    │  + Bearer token    │                    │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │                    │                    │ Validate token     │
       │                    │                    │ Check quotas       │
       │                    │                    │ Create container   │
       │                    │                    │───────────────────>│
       │                    │                    │                    │
       │                    │                    │    Agent starts    │
       │                    │                    │<───────────────────│
       │                    │                    │                    │
       │                    │  SpawnResponse     │                    │
       │                    │  (agent_id, quota) │                    │
       │                    │<───────────────────│                    │
       │                    │                    │                    │
       │  Tool result       │                    │                    │
       │<───────────────────│                    │                    │
       │                    │                    │                    │
```

---

## Key Concepts

### Spawn Trees

A **spawn tree** represents the entire hierarchy of agents starting from a single root agent. Every agent belongs to exactly one spawn tree.

```typescript
interface SpawnTree {
  treeId: string;           // Unique identifier (UUID)
  rootAgentId: string;      // ID of the root agent
  totalAgents: number;      // Count of all agents in tree
  maxDepthReached: number;  // Highest nesting depth used
  createdAt: Date;          // When tree was created
  status: "active" | "terminated";
}
```

**Tree lifecycle:**

1. **Created** when a root agent spawns (no parent)
2. **Updated** as children are added (agent count, max depth)
3. **Terminated** when root completes/fails or manually terminated
4. All tokens and child agents are invalidated on tree termination

**Tree limits:**

- `maxAgentsPerTree`: Maximum total agents allowed (default: 10)
- When limit reached, spawn requests return an error with quota info

### Session Tokens

Session tokens provide secure authentication for nested spawn requests. Each agent capable of spawning receives a cryptographically signed token.

```typescript
interface SessionToken {
  token: string;              // 32-byte hex random value
  signature: string;          // HMAC-SHA256 signature
  agentId: string;            // Owner agent ID
  treeId: string;             // Spawn tree ID
  parentAgentId?: string;     // Parent for validation
  depth: number;              // Current nesting depth
  maxDepth: number;           // Maximum allowed depth
  issuedAt: number;           // Issue timestamp (ms)
  expiresAt: number;          // Expiry timestamp (ms)
  permissions: {
    canSpawn: boolean;        // Spawn permission
    inheritGitHubToken: boolean;
  };
}
```

**Token security features:**

- **HMAC signature**: Tokens are signed with a server secret
- **Timing-safe comparison**: Prevents timing attacks during validation
- **Expiry enforcement**: Token lifetime is `min(1 hour, agent timeout)`
- **Tree binding**: Tokens are only valid for their spawn tree
- **Parent validation**: Child tokens reference parent for cascade validation

**Token validation checks:**

1. Signature verification (HMAC-SHA256)
2. Expiry check
3. Tree status (must be active)
4. Parent agent status (must be running if has parent)
5. Depth limit not exceeded

### Hierarchy Tracking

Every agent maintains hierarchy metadata:

```typescript
interface AgentMetadata {
  id: string;
  task: string;
  workspacePath: string;
  writablePaths: string[];
  startedAt: Date;
  status: "running" | "completed" | "failed";
  exitCode?: number;
  endedAt?: Date;
  output?: string;
  tokenFilePath?: string;

  // Hierarchy fields
  parentAgentId?: string;    // Parent ID (undefined for root)
  childAgentIds: string[];   // List of child IDs
  nestingDepth: number;      // 0 = root, 1 = child, 2 = grandchild
  treeId: string;            // Spawn tree identifier
  sessionToken?: string;     // Token for spawning children
}
```

**Depth calculation:**

- Root agents: `depth = 0`
- Children: `depth = parent.depth + 1`
- Maximum depth is enforced: `depth > maxDepth` prevents spawning

**Parent-child relationships:**

- Parents track their children in `childAgentIds[]`
- Children reference their parent in `parentAgentId`
- Bidirectional linking enables cascade termination and orphan detection

---

## Configuration

### NestedSpawnConfig

The nested spawning behavior is controlled by `NestedSpawnConfig`:

```typescript
interface NestedSpawnConfig {
  maxNestingDepth: number;       // Default: 2
  maxAgentsPerTree: number;      // Default: 10
  enableRecursiveSpawn: boolean; // Default: true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxNestingDepth` | 2 | Maximum hierarchy depth. Value of 2 means root + child + grandchild |
| `maxAgentsPerTree` | 10 | Maximum total agents in a single spawn tree |
| `enableRecursiveSpawn` | true | Master switch to enable/disable nested spawning |

**Depth interpretation:**

- `maxNestingDepth: 0` - Only root agents, no children allowed
- `maxNestingDepth: 1` - Root + one level of children
- `maxNestingDepth: 2` - Root + children + grandchildren (default)

### Environment Variables

Override defaults using environment variables:

| Variable | Range | Description |
|----------|-------|-------------|
| `MAX_NESTING_DEPTH` | 1-10 | Override max nesting depth |
| `MAX_AGENTS_PER_TREE` | 1-100 | Override max agents per tree |
| `ENABLE_RECURSIVE_SPAWN` | true/false | Enable/disable nested spawning |

**Inside agent containers:**

| Variable | Description |
|----------|-------------|
| `PINOCCHIO_API_URL` | URL of Pinocchio HTTP API (e.g., `http://mcp-server:3001`) |
| `PINOCCHIO_SESSION_TOKEN` | Session token for spawn authentication |

These are automatically injected when an agent has spawn permissions (`depth < maxDepth`).

---

## Lifecycle Management

### Cascade Termination

When a parent agent is terminated, all its descendants are automatically terminated in a **depth-first** order.

```typescript
interface CascadeTerminationResult {
  terminated: string[];     // Successfully terminated agent IDs
  failed: Array<{
    agentId: string;
    error: string;
  }>;
  totalProcessed: number;   // Total agents processed
}

type TerminationReason = 'cascade' | 'manual' | 'timeout' | 'orphan_cleanup';
```

**Cascade termination algorithm:**

```
terminateWithChildren(agentId):
  1. Get agent metadata
  2. For each childId in agent.childAgentIds:
     - Recursively call terminateWithChildren(childId)
  3. Stop agent container
  4. Invalidate agent's session token
  5. Clean up token file (security)
  6. Emit termination event
  7. Update agent status to 'failed'
```

**Termination triggers:**

- **Manual**: User calls terminate_agent tool
- **Timeout**: Agent exceeds configured timeout
- **Cascade**: Parent was terminated
- **Orphan cleanup**: Periodic orphan detection

**Tree-level termination:**

When the root agent completes or is terminated:
1. Entire spawn tree is marked as `terminated`
2. All tokens in the tree are invalidated
3. Tree event buffer is cleared

### Orphan Detection

Orphan detection finds and cleans up agents whose parents have died unexpectedly.

```typescript
interface OrphanedAgent {
  agentId: string;
  parentAgentId: string;
  reason: "parent_not_found" | "parent_terminated" | "tree_terminated";
}
```

**Detection reasons:**

| Reason | Description |
|--------|-------------|
| `parent_not_found` | Parent agent ID doesn't exist in registry |
| `parent_terminated` | Parent exists but is not running |
| `tree_terminated` | Agent's spawn tree has been terminated |

**Orphan detection process:**

```
detectOrphanedAgents():
  orphans = []
  for each running agent with parentAgentId:
    parent = agentMetadata.get(parentAgentId)
    if parent not found:
      orphans.add(agent, "parent_not_found")
    else if parent.status != "running":
      orphans.add(agent, "parent_terminated")

    tree = getSpawnTree(agent.treeId)
    if tree.status == "terminated":
      orphans.add(agent, "tree_terminated")

  return orphans
```

**Automatic cleanup:**

- Runs every **60 seconds** in background
- Orphaned agents are terminated with cascade (includes their children)
- Audit log entries created for each orphan cleanup

---

## Security Model

### Token Security

1. **Cryptographic generation**: Tokens use 32 bytes of cryptographically secure random data
2. **HMAC signing**: Each token is signed with a server secret key
3. **Timing-safe validation**: Token comparison uses constant-time algorithms
4. **Short expiry**: Tokens expire at `min(1 hour, agent_timeout)`
5. **Single use context**: Tokens are bound to specific agent, tree, and parent

### Spawn Validation

Before spawning a child, multiple validation checks occur:

1. **Token validation**
   - Valid HMAC signature
   - Not expired
   - Tree is active
   - Parent agent is running

2. **Quota validation**
   - `depth < maxDepth` (can spawn deeper)
   - `tree.totalAgents < maxAgentsPerTree` (tree has capacity)

3. **Workspace validation**
   - Requested workspace is in allowlist
   - Writable paths are within workspace

4. **Rate limiting**
   - HTTP endpoint: 10 requests per minute per IP
   - Prevents spawn flooding attacks

### Container Isolation

Child agents inherit the same security constraints as root agents:

- Non-root user execution
- `CAP_DROP ALL` - No Linux capabilities
- Memory limits enforced
- Read-only workspace mount (specific paths mounted writable)
- No access to host network (uses Docker network)

### Token File Cleanup

Token files are securely cleaned up:

1. Token written to temp file in container
2. On agent completion/termination, file is deleted
3. Container removal ensures no token persistence

---

## State Persistence

Pinocchio persists state across restarts:

### Agent Metadata

File: `~/.config/pinocchio/data/agents.json`

```json
{
  "agent-abc123": {
    "id": "agent-abc123",
    "task": "Refactor auth module",
    "workspacePath": "/home/user/project",
    "status": "running",
    "parentAgentId": null,
    "childAgentIds": ["agent-def456"],
    "nestingDepth": 0,
    "treeId": "tree-xyz789"
  }
}
```

### Spawn Trees

File: `~/.config/pinocchio/data/trees.json`

```json
{
  "tree-xyz789": {
    "treeId": "tree-xyz789",
    "rootAgentId": "agent-abc123",
    "totalAgents": 3,
    "maxDepthReached": 2,
    "createdAt": "2026-01-15T10:30:00Z",
    "status": "active"
  }
}
```

### Session Tokens

File: `~/.config/pinocchio/data/tokens.json`

```json
{
  "agent-abc123": {
    "token": "...",
    "signature": "...",
    "agentId": "agent-abc123",
    "treeId": "tree-xyz789",
    "depth": 0,
    "maxDepth": 2,
    "issuedAt": 1705315800000,
    "expiresAt": 1705319400000
  }
}
```

**Token cleanup:**

- Expired tokens are cleaned up every 5 minutes
- Tokens are removed when agents terminate

---

## Audit Logging

All nested spawning events are logged for debugging and security auditing:

### Spawn Events

| Event | Description |
|-------|-------------|
| `spawn.nested` | Successful nested spawn with parent-child relationship |
| `spawn.parent_not_found` | Spawn failed: parent agent doesn't exist |
| `spawn.parent_not_running` | Spawn failed: parent agent isn't running |
| `spawn.depth_limit_exceeded` | Spawn failed: exceeded max nesting depth |
| `spawn.tree_limit_exceeded` | Spawn failed: exceeded max agents per tree |

### Token Events

| Event | Description |
|-------|-------------|
| `token.generated` | New session token created |
| `token.validation_failed` | Token validation failed (general) |
| `token.signature_invalid` | Token has invalid HMAC signature |
| `token.expired` | Token has expired |

### Example Audit Log Entry

```json
{
  "timestamp": "2026-01-15T10:35:00Z",
  "event": "spawn.nested",
  "agentId": "agent-def456",
  "parentAgentId": "agent-abc123",
  "treeId": "tree-xyz789",
  "depth": 1,
  "task": "Update login component"
}
```

---

## Troubleshooting

### Common Issues

**"Depth limit exceeded"**
- The spawn tree has reached `maxNestingDepth`
- Solution: Increase `MAX_NESTING_DEPTH` or restructure task hierarchy

**"Tree agent limit exceeded"**
- The spawn tree has `maxAgentsPerTree` agents
- Solution: Increase `MAX_AGENTS_PER_TREE` or wait for agents to complete

**"Token validation failed"**
- Token may be expired, or parent agent terminated
- Solution: Check parent agent status, verify token hasn't expired

**"Parent agent not running"**
- Parent agent completed or failed before child spawn request
- Solution: Ensure parent waits for child spawn before completing

### Debug Commands

Check spawn tree status:
```bash
# View active spawn trees
cat ~/.config/pinocchio/data/trees.json | jq '.[] | select(.status == "active")'

# View agents in a specific tree
cat ~/.config/pinocchio/data/agents.json | jq '.[] | select(.treeId == "tree-xyz789")'

# View active session tokens
cat ~/.config/pinocchio/data/tokens.json | jq 'keys'
```

---

## Related Documentation

- [Nested Spawning User Guide](guides/nested-spawning-guide.md) - Getting started guide
- [Nested Spawning API Reference](api/nested-spawning-api.md) - Complete API documentation
