# Nested Spawning User Guide

This guide walks you through using Pinocchio's nested spawning feature to create hierarchies of autonomous agents that collaborate on complex tasks.

## Table of Contents

- [Introduction](#introduction)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [Enabling Nested Spawning](#enabling-nested-spawning)
  - [Your First Nested Agent](#your-first-nested-agent)
- [How Parent Agents Spawn Children](#how-parent-agents-spawn-children)
  - [The spawn_agent Tool](#the-spawn_agent-tool)
  - [Spawn Response and Quota Info](#spawn-response-and-quota-info)
  - [Waiting for Children](#waiting-for-children)
- [Designing Agent Hierarchies](#designing-agent-hierarchies)
  - [Task Decomposition Patterns](#task-decomposition-patterns)
  - [Depth Planning](#depth-planning)
  - [Parallel vs Sequential Children](#parallel-vs-sequential-children)
- [Best Practices](#best-practices)
  - [Task Design](#task-design)
  - [Error Handling](#error-handling)
  - [Resource Management](#resource-management)
- [Common Patterns](#common-patterns)
  - [Fan-Out Pattern](#fan-out-pattern)
  - [Pipeline Pattern](#pipeline-pattern)
  - [Recursive Decomposition](#recursive-decomposition)
- [Error Handling](#error-handling-1)
  - [Spawn Failures](#spawn-failures)
  - [Child Failures](#child-failures)
  - [Timeout Handling](#timeout-handling)
- [Monitoring Nested Agents](#monitoring-nested-agents)

---

## Introduction

Nested spawning allows agents to spawn child agents, enabling complex task decomposition. A parent agent can break down a large task into subtasks, spawn children to handle each subtask, and coordinate their results.

**When to use nested spawning:**

- Tasks that naturally decompose into independent subtasks
- Parallel processing of multiple files or components
- Tasks requiring different specialized approaches
- Long-running work that benefits from checkpointing

**When NOT to use nested spawning:**

- Simple, linear tasks
- Tasks that require tight coordination between steps
- When the overhead of container creation outweighs benefits

---

## Prerequisites

Before using nested spawning:

1. **Pinocchio is configured** with valid Claude credentials
2. **Docker is running** and accessible
3. **Workspace is allowlisted** via `manage_config` tool
4. **Nested spawning is enabled** (default: true)

Check your configuration:

```bash
cat ~/.config/pinocchio/config.json
```

Ensure `enableRecursiveSpawn` is not set to `false`.

---

## Getting Started

### Enabling Nested Spawning

Nested spawning is enabled by default. To verify or modify settings:

**Check current config:**
```typescript
// In Claude Code, call the manage_config tool
manage_config({
  action: "view"
})
```

**Modify nested spawn settings:**

Set environment variables before starting Pinocchio:

```bash
# Allow deeper nesting (default: 2)
export MAX_NESTING_DEPTH=3

# Allow more agents per tree (default: 10)
export MAX_AGENTS_PER_TREE=20

# Disable nested spawning entirely
export ENABLE_RECURSIVE_SPAWN=false
```

### Your First Nested Agent

Here's a simple example where a parent agent spawns a child:

**Parent task:** "Review the authentication module and refactor if needed"

The parent agent might:
1. Analyze the codebase
2. Identify areas needing work
3. Spawn a child for each area

**Example parent agent behavior:**

```
Parent Agent Analysis:
- Found 3 files needing refactoring:
  - src/auth/login.ts
  - src/auth/session.ts
  - src/auth/password.ts

Spawning children for parallel refactoring...
```

The parent calls `spawn_agent` for each file:

```typescript
// Spawn child for login.ts
spawn_agent({
  task: "Refactor src/auth/login.ts to use async/await instead of callbacks",
  workspace_path: "/home/user/project",
  writable_paths: ["src/auth/login.ts"]
})
```

---

## How Parent Agents Spawn Children

### The spawn_agent Tool

Inside an agent container, the `spawn_agent` MCP tool is available (provided by the spawn-proxy). This tool allows the agent to request child spawns.

**Tool parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | The task description for the child agent |
| `workspace_path` | string | No | Override workspace (must be allowlisted) |
| `writable_paths` | string[] | No | Paths the child can write to |
| `timeout_ms` | number | No | Child timeout in milliseconds |

**Example invocations:**

```typescript
// Basic spawn - child inherits parent's workspace
spawn_agent({
  task: "Write unit tests for the User model"
})

// Spawn with specific writable paths
spawn_agent({
  task: "Update the README with new API documentation",
  writable_paths: ["README.md", "docs/"]
})

// Spawn with custom timeout (30 minutes)
spawn_agent({
  task: "Run full test suite and report failures",
  timeout_ms: 1800000
})
```

### Spawn Response and Quota Info

When `spawn_agent` succeeds, it returns:

```typescript
interface SpawnResponse {
  agent_id: string;      // Unique ID of spawned child
  status: 'completed' | 'failed' | 'timeout';
  exit_code: number;     // Child's exit code
  output: string;        // Child's output/result
  duration_ms: number;   // How long child ran
  files_modified?: string[];  // Files the child modified
  error?: string;        // Error message if failed
  quota_info?: {
    tree_agents_remaining: number;  // How many more agents can spawn
    depth_remaining: number;         // How many more levels deep
  };
}
```

**Interpreting quota_info:**

```typescript
const result = spawn_agent({ task: "..." });

if (result.quota_info) {
  if (result.quota_info.depth_remaining === 0) {
    // This child cannot spawn grandchildren
    console.log("Child is at max depth");
  }

  if (result.quota_info.tree_agents_remaining < 3) {
    // Running low on agent quota
    console.log("Consider consolidating remaining tasks");
  }
}
```

### Waiting for Children

The `spawn_agent` tool is **synchronous** from the parent's perspective - it waits for the child to complete before returning. This simplifies coordination:

```typescript
// Parent spawns child and waits
const result = spawn_agent({
  task: "Generate API documentation for src/api/"
});

// Child has completed by this point
if (result.status === 'completed') {
  // Process child's output
  console.log("Documentation generated:", result.files_modified);
} else {
  // Handle failure
  console.log("Child failed:", result.error);
}
```

For parallel children, spawn them in sequence and collect results:

```typescript
const tasks = [
  "Test authentication module",
  "Test user management module",
  "Test billing module"
];

const results = [];
for (const task of tasks) {
  // Note: These run sequentially from parent's view
  // but each child runs in isolation
  results.push(spawn_agent({ task }));
}

// Analyze all results
const failures = results.filter(r => r.status === 'failed');
```

---

## Designing Agent Hierarchies

### Task Decomposition Patterns

**Good decomposition:**

```
Root: "Modernize the legacy codebase"
├── Child 1: "Update all JavaScript files to TypeScript"
│   ├── Grandchild 1.1: "Convert src/utils/*.js"
│   └── Grandchild 1.2: "Convert src/components/*.js"
├── Child 2: "Add comprehensive test coverage"
└── Child 3: "Update documentation"
```

**Poor decomposition (too fine-grained):**

```
Root: "Update config file"
└── Child 1: "Open config.json"
    └── Grandchild 1.1: "Find the 'port' field"
        └── Great-grandchild 1.1.1: "Change 3000 to 8080"
```

**Guideline:** Each child should represent meaningful, independent work that justifies container overhead.

### Depth Planning

With default `maxNestingDepth: 2`:

| Depth | Agent Type | Can Spawn? |
|-------|-----------|------------|
| 0 | Root agent | Yes |
| 1 | Child | Yes |
| 2 | Grandchild | No |

Plan your hierarchy within these constraints:

```
# With maxNestingDepth: 2

Depth 0 (Root):     Strategic planning, coordination
Depth 1 (Child):    Major feature or component work
Depth 2 (Grand):    Specific file or function tasks
```

If you need deeper nesting, increase `MAX_NESTING_DEPTH` (max: 10).

### Parallel vs Sequential Children

**Parallel work (independent tasks):**

Good for:
- Processing multiple independent files
- Running different types of tests
- Generating separate documentation sections

```typescript
// Spawn children for independent files
const files = ["auth.ts", "user.ts", "billing.ts"];
const results = files.map(file =>
  spawn_agent({
    task: `Add error handling to ${file}`,
    writable_paths: [`src/${file}`]
  })
);
```

**Sequential work (dependent tasks):**

When output of one child feeds into another:

```typescript
// Step 1: Analyze codebase
const analysis = spawn_agent({
  task: "Analyze codebase and identify refactoring opportunities"
});

// Step 2: Use analysis results
if (analysis.status === 'completed') {
  spawn_agent({
    task: `Refactor based on these findings: ${analysis.output}`,
    writable_paths: ["src/"]
  });
}
```

---

## Best Practices

### Task Design

**1. Clear, specific task descriptions:**

```typescript
// Bad: vague task
spawn_agent({ task: "Fix the code" });

// Good: specific task
spawn_agent({
  task: "Fix the null pointer exception in UserService.getProfile() " +
        "that occurs when the user's email is not set"
});
```

**2. Include necessary context:**

```typescript
// Provide context in the task
spawn_agent({
  task: `Update the authentication middleware to use JWT tokens. ` +
        `The current implementation uses sessions stored in Redis. ` +
        `The new JWT secret is in env.JWT_SECRET.`
});
```

**3. Specify writable paths precisely:**

```typescript
// Bad: too broad
spawn_agent({
  task: "Update tests",
  writable_paths: ["/"]  // Whole workspace!
});

// Good: minimal permissions
spawn_agent({
  task: "Update auth tests",
  writable_paths: ["tests/auth/"]
});
```

### Error Handling

**1. Always check spawn results:**

```typescript
const result = spawn_agent({ task: "..." });

switch (result.status) {
  case 'completed':
    // Success - process result.output
    break;
  case 'failed':
    // Child failed - log error, potentially retry
    console.error("Child failed:", result.error);
    break;
  case 'timeout':
    // Child timed out - task may need decomposition
    console.error("Child timed out after", result.duration_ms, "ms");
    break;
}
```

**2. Handle quota exhaustion:**

```typescript
const result = spawn_agent({ task: "..." });

if (result.error?.includes("Tree agent limit exceeded")) {
  // Can't spawn more agents - handle remaining work directly
  console.log("Quota exceeded, handling remaining tasks inline");
}

if (result.error?.includes("Depth limit exceeded")) {
  // At max depth - this agent can't spawn children
  console.log("At max depth, completing task directly");
}
```

**3. Graceful degradation:**

```typescript
async function processFiles(files: string[]) {
  for (const file of files) {
    const result = spawn_agent({
      task: `Process ${file}`,
      writable_paths: [file]
    });

    if (result.status !== 'completed') {
      // Fallback: process directly instead of spawning
      console.log(`Child failed for ${file}, processing directly`);
      await processFileDirectly(file);
    }
  }
}
```

### Resource Management

**1. Monitor quota usage:**

```typescript
const result = spawn_agent({ task: "..." });

if (result.quota_info) {
  const { tree_agents_remaining, depth_remaining } = result.quota_info;

  if (tree_agents_remaining < remainingTasks.length) {
    // Not enough quota for all tasks - batch them
    console.log("Batching remaining tasks due to quota");
  }
}
```

**2. Set appropriate timeouts:**

```typescript
// Quick task - short timeout
spawn_agent({
  task: "Lint this file",
  timeout_ms: 60000  // 1 minute
});

// Long-running task - longer timeout
spawn_agent({
  task: "Run full integration test suite",
  timeout_ms: 3600000  // 1 hour
});
```

**3. Clean up on failure:**

If a parent fails, cascade termination automatically cleans up children. However, you can proactively cancel work:

```typescript
try {
  const child1 = spawn_agent({ task: "Task 1" });
  const child2 = spawn_agent({ task: "Task 2" });
  // ...
} catch (error) {
  // Parent failure triggers automatic cascade termination
  // All children will be terminated
  throw error;
}
```

---

## Common Patterns

### Fan-Out Pattern

Spawn multiple children for parallel independent work:

```typescript
// Parent analyzes codebase
const modules = ["auth", "user", "billing", "notifications"];

// Fan out to children
const results = modules.map(module =>
  spawn_agent({
    task: `Add comprehensive logging to the ${module} module`,
    writable_paths: [`src/${module}/`]
  })
);

// Aggregate results
const successes = results.filter(r => r.status === 'completed').length;
console.log(`Completed ${successes}/${modules.length} modules`);
```

### Pipeline Pattern

Chain children where each depends on previous output:

```typescript
// Step 1: Generate interface
const step1 = spawn_agent({
  task: "Design the TypeScript interface for the new UserPreferences feature",
  writable_paths: ["src/types/"]
});

if (step1.status !== 'completed') {
  throw new Error("Interface generation failed");
}

// Step 2: Implement based on interface
const step2 = spawn_agent({
  task: `Implement UserPreferences based on the interface in src/types/. ` +
        `Interface was created: ${step1.files_modified}`,
  writable_paths: ["src/services/"]
});

// Step 3: Write tests
const step3 = spawn_agent({
  task: "Write unit tests for UserPreferences service",
  writable_paths: ["tests/"]
});
```

### Recursive Decomposition

Let children decide if they need grandchildren:

```typescript
// Parent task (depth 0)
spawn_agent({
  task: `Refactor the src/legacy/ directory. For each major component, ` +
        `spawn a child agent to handle that component. If a component is ` +
        `small enough, refactor it directly.`
});

// Child (depth 1) might spawn grandchildren or work directly
// depending on the size of its assigned component
```

---

## Error Handling

### Spawn Failures

**Quota exceeded:**

```typescript
const result = spawn_agent({ task: "..." });

if (result.error?.includes("limit exceeded")) {
  // Handle quota issues
  if (result.error.includes("Depth")) {
    // At max depth - work directly
    performTaskDirectly();
  } else if (result.error.includes("Tree agent")) {
    // Too many agents - wait for others or consolidate
    consolidateRemainingWork();
  }
}
```

**Token validation failed:**

This usually indicates the parent's token expired or was invalidated:

```typescript
if (result.error?.includes("Token validation failed")) {
  // Parent's session may have expired
  // This is unusual - check parent timeout settings
  console.error("Session token issue - parent may be timing out");
}
```

**Parent not running:**

If you see this error, the parent agent terminated before the spawn request completed:

```typescript
if (result.error?.includes("Parent agent not running")) {
  // Race condition - parent completed/failed
  // This child will be orphaned and cleaned up
}
```

### Child Failures

**Child returned error:**

```typescript
const result = spawn_agent({ task: "..." });

if (result.status === 'failed') {
  console.error("Child failed with exit code:", result.exit_code);
  console.error("Error:", result.error);
  console.error("Output:", result.output);

  // Decide: retry, skip, or fail parent
  if (isRetryableError(result.error)) {
    // Retry with modified task
    spawn_agent({ task: "...(retry)" });
  }
}
```

**Child produced unexpected output:**

```typescript
const result = spawn_agent({
  task: "Generate JSON configuration"
});

if (result.status === 'completed') {
  try {
    const config = JSON.parse(result.output);
    // Use config...
  } catch (e) {
    console.error("Child output was not valid JSON:", result.output);
    // Handle malformed output
  }
}
```

### Timeout Handling

**Child timed out:**

```typescript
const result = spawn_agent({
  task: "Process large dataset",
  timeout_ms: 300000  // 5 minutes
});

if (result.status === 'timeout') {
  console.log("Task timed out after", result.duration_ms, "ms");

  // Options:
  // 1. Retry with longer timeout
  // 2. Break task into smaller pieces
  // 3. Process subset and report partial results
}
```

**Prevent timeouts:**

```typescript
// Break large tasks into smaller chunks
const files = getLargeFileList();
const chunkSize = 10;

for (let i = 0; i < files.length; i += chunkSize) {
  const chunk = files.slice(i, i + chunkSize);
  spawn_agent({
    task: `Process files: ${chunk.join(', ')}`,
    timeout_ms: 120000  // 2 minutes per chunk
  });
}
```

---

## Monitoring Nested Agents

### Using get_agent_status

Query agent hierarchy status from Claude Code:

```typescript
// Get status of all agents
get_agent_status({})

// Get specific agent and its children
get_agent_status({ agent_id: "agent-abc123" })
```

### WebSocket Events

Subscribe to real-time events for a spawn tree:

```typescript
const ws = new WebSocket('ws://localhost:3001');

ws.send(JSON.stringify({
  type: 'subscribe',
  treeId: 'tree-xyz789'
}));

ws.onmessage = (event: MessageEvent) => {
  const data = JSON.parse(event.data);

  // All events include hierarchy info
  console.log('Agent:', data.agentId);
  console.log('Tree:', data.treeId);
  console.log('Depth:', data.depth);
  console.log('Parent:', data.parentAgentId || 'root');

  switch (data.type) {
    case 'agent.started':
      console.log('Agent started:', data.task);
      break;
    case 'agent.completed':
      console.log('Agent completed with exit code:', data.exitCode);
      break;
    case 'agent.failed':
      console.log('Agent failed:', data.error);
      break;
  }
};
```

### Command Line Monitoring

```bash
# View all running agents
docker ps --filter "label=pinocchio.agent"

# View agents in a specific tree
cat ~/.config/pinocchio/data/agents.json | \
  jq '.[] | select(.treeId == "tree-xyz789" and .status == "running")'

# View spawn tree status
cat ~/.config/pinocchio/data/trees.json | jq '.["tree-xyz789"]'

# Watch agent logs
docker logs -f <container-id>
```

---

## Summary

Nested spawning enables powerful task decomposition patterns:

1. **Enable** nested spawning (on by default)
2. **Design** your agent hierarchy within depth/quota limits
3. **Spawn** children using the `spawn_agent` tool
4. **Handle** errors and quota exhaustion gracefully
5. **Monitor** via WebSocket events or status queries

For detailed API documentation, see the [API Reference](../api/nested-spawning-api.md).
