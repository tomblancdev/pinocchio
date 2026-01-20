# Nested Spawning API Reference

Complete API reference for Pinocchio's nested agent spawning feature.

## Table of Contents

- [MCP Tools](#mcp-tools)
  - [spawn_agent](#spawn_agent)
  - [spawn_docker_agent (with parent)](#spawn_docker_agent-with-parent)
  - [get_agent_status](#get_agent_status)
  - [terminate_agent](#terminate_agent)
- [HTTP API](#http-api)
  - [POST /api/v1/spawn](#post-apiv1spawn)
- [WebSocket API](#websocket-api)
  - [Connection](#connection)
  - [Events](#events)
  - [Hierarchy Fields](#hierarchy-fields)
- [Types Reference](#types-reference)
  - [NestedSpawnConfig](#nestedspawnconfig)
  - [SessionToken](#sessiontoken)
  - [SpawnTree](#spawntree)
  - [AgentMetadata](#agentmetadata)
  - [CascadeTerminationResult](#cascadeterminationresult)
  - [OrphanedAgent](#orphanedagent)
- [Error Codes](#error-codes)

---

## MCP Tools

### spawn_agent

**Available in:** Agent containers (via spawn-proxy MCP server)

Spawns a child agent from within a running agent container.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task` | string | Yes | - | Task description for the child agent |
| `workspace_path` | string | No | Parent's workspace | Override workspace path (must be allowlisted) |
| `writable_paths` | string[] | No | `[]` | Paths the child can write to |
| `timeout_ms` | number | No | 3600000 (1h) | Child agent timeout in milliseconds |

#### Response

```typescript
interface SpawnAgentResponse {
  agent_id: string;
  status: 'completed' | 'failed' | 'timeout';
  exit_code: number;
  output: string;
  duration_ms: number;
  files_modified?: string[];
  error?: string;
  quota_info?: {
    tree_agents_remaining: number;
    depth_remaining: number;
  };
}
```

#### Example

```typescript
// Basic spawn
const result = await spawn_agent({
  task: "Write unit tests for UserService"
});

// With options
const result = await spawn_agent({
  task: "Refactor authentication module",
  workspace_path: "/home/user/project",
  writable_paths: ["src/auth/", "tests/auth/"],
  timeout_ms: 1800000
});
```

#### Errors

| Error | Cause |
|-------|-------|
| `Nested spawning is disabled` | `enableRecursiveSpawn` is false |
| `Depth limit exceeded` | Agent is at `maxNestingDepth` |
| `Tree agent limit exceeded` | Tree has `maxAgentsPerTree` agents |
| `Parent agent not found` | Parent was terminated |
| `Parent agent not running` | Parent completed/failed |
| `Token validation failed` | Invalid or expired session token |
| `Workspace not allowed` | Requested workspace not in allowlist |

---

### spawn_docker_agent (with parent)

**Available in:** Claude Code (main MCP server)

The `spawn_docker_agent` tool accepts an optional `parent_agent_id` parameter for explicit parent-child relationships.

#### Additional Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `parent_agent_id` | string | No | ID of the parent agent for nested spawning |

#### Example

```typescript
// Spawn as child of existing agent
const result = await spawn_docker_agent({
  task: "Process data files",
  workspace_path: "/home/user/project",
  parent_agent_id: "agent-abc123"
});
```

When `parent_agent_id` is provided:
- Child inherits parent's `treeId`
- Child's `nestingDepth` = parent's depth + 1
- Parent's `childAgentIds` array is updated
- Quota checks are performed against the tree

---

### get_agent_status

**Available in:** Claude Code (main MCP server)

Query agent status including hierarchy information.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | No | Specific agent ID to query |

#### Response

```typescript
interface AgentStatusResponse {
  agents: Array<{
    id: string;
    task: string;
    workspacePath: string;
    writablePaths: string[];
    startedAt: string;
    status: "running" | "completed" | "failed";
    exitCode?: number;
    endedAt?: string;
    output?: string;

    // Hierarchy fields
    parentAgentId?: string;
    childAgentIds: string[];
    nestingDepth: number;
    treeId: string;
  }>;
}
```

#### Example Response

```json
{
  "agents": [
    {
      "id": "agent-abc123",
      "task": "Refactor authentication",
      "workspacePath": "/home/user/project",
      "writablePaths": ["src/"],
      "startedAt": "2026-01-15T10:30:00Z",
      "status": "running",
      "parentAgentId": null,
      "childAgentIds": ["agent-def456", "agent-ghi789"],
      "nestingDepth": 0,
      "treeId": "tree-xyz001"
    },
    {
      "id": "agent-def456",
      "task": "Update login component",
      "workspacePath": "/home/user/project",
      "writablePaths": ["src/auth/login.ts"],
      "startedAt": "2026-01-15T10:31:00Z",
      "status": "running",
      "parentAgentId": "agent-abc123",
      "childAgentIds": [],
      "nestingDepth": 1,
      "treeId": "tree-xyz001"
    }
  ]
}
```

---

### terminate_agent

**Available in:** Claude Code (main MCP server)

Terminates an agent and all its descendants (cascade termination).

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | Yes | ID of agent to terminate |

#### Response

```typescript
interface TerminateAgentResponse {
  success: boolean;
  terminated: string[];           // All terminated agent IDs
  failed: Array<{
    agentId: string;
    error: string;
  }>;
  totalProcessed: number;
}
```

#### Behavior

1. Recursively terminates all descendants (depth-first)
2. Invalidates session tokens for all terminated agents
3. Cleans up token files
4. Updates parent's `childAgentIds` if applicable
5. Checks if entire tree should be terminated

---

## HTTP API

### POST /api/v1/spawn

**Endpoint for child agents to spawn grandchildren.**

Used internally by the spawn-proxy MCP server running inside agent containers.

#### URL

```
POST http://mcp-server:3001/api/v1/spawn
```

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer <session_token>` |
| `Content-Type` | Yes | `application/json` |

#### Request Body

```typescript
interface SpawnRequest {
  task: string;              // Required: task description
  workspace_path?: string;   // Optional: override workspace
  writable_paths?: string[]; // Optional: writable paths
  timeout_ms?: number;       // Optional: timeout in ms
}
```

#### Response

**Success (200):**

```typescript
interface SpawnResponse {
  agent_id: string;
  status: 'completed' | 'failed' | 'timeout';
  exit_code: number;
  output: string;
  duration_ms: number;
  files_modified?: string[];
  error?: string;
  quota_info?: {
    tree_agents_remaining: number;
    depth_remaining: number;
  };
}
```

**Error (4xx/5xx):**

```typescript
interface SpawnErrorResponse {
  error: string;
  code: string;
  quota_info?: {
    tree_agents_remaining: number;
    depth_remaining: number;
  };
}
```

#### Error Codes

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `INVALID_REQUEST` | Missing or invalid request body |
| 401 | `UNAUTHORIZED` | Missing or invalid Authorization header |
| 401 | `TOKEN_EXPIRED` | Session token has expired |
| 401 | `TOKEN_INVALID` | Session token signature invalid |
| 403 | `SPAWN_DISABLED` | Nested spawning is disabled |
| 403 | `DEPTH_EXCEEDED` | Maximum nesting depth reached |
| 403 | `QUOTA_EXCEEDED` | Maximum agents per tree reached |
| 403 | `PARENT_NOT_RUNNING` | Parent agent is not running |
| 403 | `WORKSPACE_NOT_ALLOWED` | Workspace not in allowlist |
| 429 | `RATE_LIMITED` | Too many requests (10/min/IP) |
| 500 | `INTERNAL_ERROR` | Server error |

#### Rate Limiting

- **Limit:** 10 requests per minute per IP address
- **Response on limit:** HTTP 429 with `Retry-After` header

#### Example

```bash
curl -X POST http://mcp-server:3001/api/v1/spawn \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Write tests for User model",
    "writable_paths": ["tests/"],
    "timeout_ms": 300000
  }'
```

---

## WebSocket API

### Connection

```
ws://localhost:3001
```

### Events

All events include hierarchy fields for nested spawning context.

#### agent.started

Emitted when an agent starts.

```typescript
interface AgentStartedEvent {
  type: 'agent.started';
  agentId: string;
  timestamp: string;
  task: string;
  workspacePath: string;

  // Hierarchy fields
  parentAgentId?: string;  // undefined for root agents
  treeId: string;
  depth: number;
}
```

#### agent.log

Emitted for agent output/logs.

```typescript
interface AgentLogEvent {
  type: 'agent.log';
  agentId: string;
  timestamp: string;
  message: string;
  level: 'info' | 'warn' | 'error';

  // Hierarchy fields
  parentAgentId?: string;
  treeId: string;
  depth: number;
}
```

#### agent.progress

Emitted for progress updates.

```typescript
interface AgentProgressEvent {
  type: 'agent.progress';
  agentId: string;
  timestamp: string;
  progress: number;      // 0-100
  description?: string;

  // Hierarchy fields
  parentAgentId?: string;
  treeId: string;
  depth: number;
}
```

#### agent.completed

Emitted when an agent completes successfully.

```typescript
interface AgentCompletedEvent {
  type: 'agent.completed';
  agentId: string;
  timestamp: string;
  exitCode: number;
  output: string;
  durationMs: number;
  filesModified?: string[];

  // Hierarchy fields
  parentAgentId?: string;
  treeId: string;
  depth: number;
}
```

#### agent.failed

Emitted when an agent fails.

```typescript
interface AgentFailedEvent {
  type: 'agent.failed';
  agentId: string;
  timestamp: string;
  exitCode: number;
  error: string;
  output?: string;

  // Hierarchy fields
  parentAgentId?: string;
  treeId: string;
  depth: number;
}
```

#### agent.terminated

Emitted when an agent is manually terminated.

```typescript
interface AgentTerminatedEvent {
  type: 'agent.terminated';
  agentId: string;
  timestamp: string;
  reason: 'cascade' | 'manual' | 'timeout' | 'orphan_cleanup';
  terminatedBy?: string;  // Agent ID that initiated termination

  // Hierarchy fields
  parentAgentId?: string;
  treeId: string;
  depth: number;
}
```

### Hierarchy Fields

All WebSocket events include these hierarchy fields:

| Field | Type | Description |
|-------|------|-------------|
| `parentAgentId` | string? | Parent agent ID, undefined for root |
| `treeId` | string | Spawn tree identifier |
| `depth` | number | Nesting depth (0 = root) |

### Subscribing to Tree Events

Subscribe to all events for a spawn tree:

```typescript
const ws = new WebSocket('ws://localhost:3001');

// Subscribe to specific tree
ws.send(JSON.stringify({
  type: 'subscribe',
  treeId: 'tree-xyz789'
}));

// Subscribe to all trees
ws.send(JSON.stringify({
  type: 'subscribe',
  treeId: '*'
}));

// Unsubscribe
ws.send(JSON.stringify({
  type: 'unsubscribe',
  treeId: 'tree-xyz789'
}));
```

### Getting Buffered Events

Retrieve historical events for a tree:

```typescript
ws.send(JSON.stringify({
  type: 'getBufferedEvents',
  treeId: 'tree-xyz789'
}));

// Response
{
  type: 'bufferedEvents',
  treeId: 'tree-xyz789',
  events: [
    { type: 'agent.started', ... },
    { type: 'agent.log', ... },
    ...
  ]
}
```

---

## Types Reference

### NestedSpawnConfig

Configuration for nested spawning behavior.

```typescript
interface NestedSpawnConfig {
  maxNestingDepth: number;       // Default: 2
  maxAgentsPerTree: number;      // Default: 10
  enableRecursiveSpawn: boolean; // Default: true
}
```

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `maxNestingDepth` | number | 2 | 0-10 | Maximum hierarchy depth (0 = no children) |
| `maxAgentsPerTree` | number | 10 | 1-100 | Maximum agents in one spawn tree |
| `enableRecursiveSpawn` | boolean | true | - | Master switch for nested spawning |

### SessionToken

Cryptographically signed token for spawn authentication.

```typescript
interface SessionToken {
  token: string;              // 32-byte hex random value
  signature: string;          // HMAC-SHA256 signature
  agentId: string;            // Agent this token belongs to
  treeId: string;             // Spawn tree ID
  parentAgentId?: string;     // Parent agent ID (if not root)
  depth: number;              // Current nesting depth
  maxDepth: number;           // Maximum allowed depth
  issuedAt: number;           // Unix timestamp (ms)
  expiresAt: number;          // Expiry timestamp (ms)
  permissions: {
    canSpawn: boolean;        // Can spawn children
    inheritGitHubToken: boolean;
  };
}
```

**Token lifetime:** `min(1 hour, agent_timeout)`

**Security properties:**
- Cryptographically random token value
- HMAC-SHA256 signed with server secret
- Timing-safe comparison during validation
- Bound to specific tree and parent

### SpawnTree

Tracks all agents in a spawn hierarchy.

```typescript
interface SpawnTree {
  treeId: string;                        // Unique tree ID (UUID)
  rootAgentId: string;                   // ID of root agent
  totalAgents: number;                   // Count of all agents
  maxDepthReached: number;               // Highest depth used
  createdAt: Date;                       // Creation timestamp
  status: "active" | "terminated";       // Tree lifecycle status
}
```

**Tree states:**
- `active`: Tree is running, new agents can spawn
- `terminated`: Tree is done, all tokens invalidated

### AgentMetadata

Complete agent state including hierarchy.

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

  // Hierarchy tracking
  parentAgentId?: string;        // Parent ID (undefined = root)
  childAgentIds: string[];       // Array of child IDs
  nestingDepth: number;          // 0 = root, 1 = child, etc.
  treeId: string;                // Spawn tree ID
  sessionToken?: string;         // Token for spawning (if can spawn)
}
```

### CascadeTerminationResult

Result of cascade termination operation.

```typescript
interface CascadeTerminationResult {
  terminated: string[];          // Successfully terminated IDs
  failed: Array<{
    agentId: string;
    error: string;
  }>;
  totalProcessed: number;        // Total agents processed
}
```

### OrphanedAgent

Agent detected as orphaned.

```typescript
interface OrphanedAgent {
  agentId: string;
  parentAgentId: string;
  reason: "parent_not_found" | "parent_terminated" | "tree_terminated";
}
```

**Orphan reasons:**
- `parent_not_found`: Parent ID doesn't exist
- `parent_terminated`: Parent exists but not running
- `tree_terminated`: Spawn tree was terminated

### QuotaInfo

Remaining spawn quota information.

```typescript
interface QuotaInfo {
  tree_agents_remaining: number;  // Agents that can still spawn
  depth_remaining: number;        // Levels that can still be created
}
```

### QuotaConfig

Quota configuration (server-side).

```typescript
interface QuotaConfig {
  maxAgentsPerTree: number;       // From NestedSpawnConfig
  maxConcurrentAgents: number;    // Global concurrent limit
}
```

---

## Error Codes

### Spawn Errors

| Code | HTTP Status | Description | Resolution |
|------|-------------|-------------|------------|
| `SPAWN_DISABLED` | 403 | Nested spawning disabled | Set `ENABLE_RECURSIVE_SPAWN=true` |
| `DEPTH_EXCEEDED` | 403 | At max nesting depth | Increase `MAX_NESTING_DEPTH` or restructure |
| `QUOTA_EXCEEDED` | 403 | Tree has max agents | Increase `MAX_AGENTS_PER_TREE` or wait |
| `PARENT_NOT_FOUND` | 403 | Parent doesn't exist | Check parent agent status |
| `PARENT_NOT_RUNNING` | 403 | Parent terminated | Parent completed before spawn |
| `WORKSPACE_NOT_ALLOWED` | 403 | Workspace not allowlisted | Add workspace via manage_config |

### Token Errors

| Code | HTTP Status | Description | Resolution |
|------|-------------|-------------|------------|
| `UNAUTHORIZED` | 401 | Missing Authorization header | Include `Bearer <token>` |
| `TOKEN_INVALID` | 401 | Invalid signature | Token was tampered or wrong |
| `TOKEN_EXPIRED` | 401 | Token expired | Token lifetime exceeded |
| `TOKEN_TREE_INVALID` | 401 | Tree terminated | Spawn tree was terminated |
| `TOKEN_PARENT_INVALID` | 401 | Parent not running | Parent terminated |

### Validation Errors

| Code | HTTP Status | Description | Resolution |
|------|-------------|-------------|------------|
| `INVALID_REQUEST` | 400 | Malformed request body | Check JSON syntax |
| `MISSING_TASK` | 400 | No task provided | Include `task` field |
| `INVALID_TIMEOUT` | 400 | Timeout out of range | Use 1ms - 86400000ms |
| `INVALID_WORKSPACE` | 400 | Invalid workspace path | Use absolute path |

### Rate Limiting

| Code | HTTP Status | Description | Resolution |
|------|-------------|-------------|------------|
| `RATE_LIMITED` | 429 | Too many requests | Wait per `Retry-After` header |

**Rate limit:** 10 requests per minute per IP address

---

## Environment Variables

### Server Configuration

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `MAX_NESTING_DEPTH` | 2 | 1-10 | Maximum spawn depth |
| `MAX_AGENTS_PER_TREE` | 10 | 1-100 | Maximum agents per tree |
| `ENABLE_RECURSIVE_SPAWN` | true | true/false | Enable nested spawning |
| `ABSOLUTE_MAX_TIMEOUT` | 86400000 | - | Max agent timeout (24h) |

### Agent Container Environment

Automatically injected when agent can spawn:

| Variable | Description |
|----------|-------------|
| `PINOCCHIO_API_URL` | HTTP API URL (`http://mcp-server:3001`) |
| `PINOCCHIO_SESSION_TOKEN` | Session token for authentication |

---

## Audit Log Events

### Spawn Events

| Event | Fields | Description |
|-------|--------|-------------|
| `spawn.nested` | agentId, parentAgentId, treeId, depth, task | Child spawned |
| `spawn.parent_not_found` | parentAgentId | Parent doesn't exist |
| `spawn.parent_not_running` | parentAgentId, parentStatus | Parent terminated |
| `spawn.depth_limit_exceeded` | depth, maxDepth, treeId | Depth limit hit |
| `spawn.tree_limit_exceeded` | totalAgents, maxAgents, treeId | Tree limit hit |

### Token Events

| Event | Fields | Description |
|-------|--------|-------------|
| `token.generated` | agentId, treeId, depth, expiresAt | Token created |
| `token.validation_failed` | reason, agentId | General validation failure |
| `token.signature_invalid` | agentId | HMAC mismatch |
| `token.expired` | agentId, expiredAt | Token past expiry |

### Termination Events

| Event | Fields | Description |
|-------|--------|-------------|
| `terminate.cascade` | agentId, reason, terminatedCount | Cascade termination |
| `terminate.orphan` | agentId, parentAgentId, reason | Orphan cleanup |
| `tree.terminated` | treeId, rootAgentId, totalAgents | Tree terminated |
