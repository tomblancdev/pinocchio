# Security Review: pinocchio

**Last Updated:** 2026-01-16
**Version:** 1.0.0
**Status:** Production Ready with Documented Mitigations

---

## Executive Summary

The pinocchio project provides an MCP server that spawns isolated Claude Code agents in Docker containers. This security review documents the implemented security controls and remaining considerations.

**Security Posture:** The system implements defense-in-depth with multiple security layers including Docker socket proxying, workspace allowlisting, read-only defaults, input validation, and configurable timeouts.

---

## Security Findings

### 1. Docker Socket Access

| Aspect | Status |
|--------|--------|
| **Risk Level** | Medium (Mitigated) |
| **Implementation** | FIXED |

**Original Concern:** Direct Docker socket access could allow container escape or host compromise.

**Implemented Mitigation:**
- Docker Socket Proxy (tecnativa/docker-socket-proxy) blocks dangerous operations
- Configured in `docker-compose.yml:2-37`

```yaml
docker-proxy:
  image: tecnativa/docker-socket-proxy:latest
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro  # Read-only
  environment:
    - CONTAINERS=1    # Allow container ops
    - IMAGES=1        # Allow image ops
    - NETWORKS=1      # Allow network ops
    - POST=1          # Allow create operations
    # BLOCKED operations:
    - BUILD=0         # No image builds
    - COMMIT=0        # No container commits
    - EXEC=0          # No exec into containers
    - VOLUMES=0       # No volume creation
    - SYSTEM=0        # No system info
    - SECRETS=0       # No secrets access
    - SWARM=0         # No swarm operations
```

**Remaining Considerations:**
- The proxy container itself runs privileged (required for socket access)
- Agents with `allow_docker=true` can create containers via the proxy
- Network policy could further restrict proxy access

---

### 2. Workspace Access Control

| Aspect | Status |
|--------|--------|
| **Risk Level** | Low (Mitigated) |
| **Implementation** | FIXED |

**Original Concern:** Agents could access arbitrary filesystem paths.

**Implemented Mitigation:**
- Workspace allowlist with dynamic management via `manage_config` tool
- Implemented in `src/index.ts:111-139`

```typescript
// System paths blocked by default
const DEFAULT_CONFIG: AgentConfig = {
  blockedPaths: ["/etc", "/var", "/root", "/boot", "/sys", "/proc", "/dev"],
};

// Allowlist validation
async function isWorkspaceAllowed(workspacePath: string) {
  // Blocks system paths
  // Requires path in allowedWorkspaces
  // Path normalization via path.resolve()
}
```

**Workspace Management Actions:**
| Action | Description |
|--------|-------------|
| `workspaces.list` | View allowed, pending, and blocked paths |
| `workspaces.propose` | Request new workspace access |
| `workspaces.approve` | Approve pending proposal |
| `workspaces.reject` | Reject pending proposal |
| `workspaces.remove` | Remove from allowlist |

**Remaining Considerations:**
- Symlinks within allowed workspaces could point outside
- Config file at `~/.config/pinocchio/config.json` should be protected

---

### 3. Read-Only Workspace by Default

| Aspect | Status |
|--------|--------|
| **Risk Level** | Low (Mitigated) |
| **Implementation** | FIXED |

**Original Concern:** Agents could modify any file in mounted workspaces.

**Implemented Mitigation:**
- Workspace mounted read-only by default
- Explicit `writable_paths` and `writable_patterns` for write access
- Implemented in `src/index.ts:567-586`

```typescript
// Default read-only mount
const binds: string[] = [
  `${workspace_path}:/workspace:ro`,  // Read-only by default
];

// Writable paths overlay the read-only mount
for (const writablePath of resolvedWritablePaths) {
  binds.push(`${writablePath}:${containerPath}:rw`);
}
```

**Write Access Control:**
| Parameter | Description |
|-----------|-------------|
| `writable_paths` | Explicit relative paths (e.g., `['src/file.ts']`) |
| `writable_patterns` | Glob patterns (e.g., `['src/**/*.ts']`) |

**Remaining Considerations:**
- Glob patterns could inadvertently grant broad access
- Users should review resolved paths before execution

---

### 4. Input Validation and Sanitization

| Aspect | Status |
|--------|--------|
| **Risk Level** | Low (Mitigated) |
| **Implementation** | FIXED |

**Original Concern:** Malicious input could cause command injection or resource abuse.

**Implemented Mitigation:**
- Container name validation in `src/index.ts:100-104`
- Task sanitization in `src/index.ts:106-109`
- Maximum task length enforced (50,000 chars)

```typescript
// Container name validation
function validateContainerName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) && name.length <= 128;
}

// Task sanitization
function sanitizeForEnv(value: string): string {
  return value.replace(/\0/g, "").slice(0, CONFIG.maxTaskLength);
}
```

**Validation Points:**
| Input | Validation |
|-------|------------|
| Container name | Alphanumeric + `_.-`, max 128 chars, must start alphanumeric |
| Task | Null bytes removed, max 50,000 chars |
| Workspace path | Must exist, must be directory, must be in allowlist |
| Timeout | Minimum 1s, maximum 24h |

**Remaining Considerations:**
- Task content is passed to Claude Code which interprets it
- Prompt injection through task content possible (inherent to LLM systems)

---

### 5. Configurable Timeouts

| Aspect | Status |
|--------|--------|
| **Risk Level** | Low (Mitigated) |
| **Implementation** | FIXED |

**Original Concern:** Runaway agents could consume resources indefinitely.

**Implemented Mitigation:**
- Default timeout: 1 hour (3,600,000 ms)
- Maximum timeout: 24 hours (86,400,000 ms)
- Configurable via `ABSOLUTE_MAX_TIMEOUT` environment variable
- Implemented in `src/index.ts:86-88, 468-470, 748-768`

```typescript
const CONFIG = {
  defaultTimeout: 3600000,    // 1 hour
  absoluteMaxTimeout: Number(process.env.ABSOLUTE_MAX_TIMEOUT) || 86400000,
};

// Enforcement
const timeout_ms = Math.min(Math.max(requestedTimeout, 1000), CONFIG.absoluteMaxTimeout);
```

**Timeout Behavior:**
- Container is stopped on timeout
- Error returned indicating timeout
- Metadata updated with failed status

**Remaining Considerations:**
- Long-running agents (up to 24h) still consume resources
- Consider per-user or per-project timeout limits for multi-tenant scenarios

---

### 6. Background Execution with Monitoring

| Aspect | Status |
|--------|--------|
| **Risk Level** | Low (Informational) |
| **Implementation** | FIXED |

**Implementation Details:**
- `run_in_background` flag for async execution
- `get_agent_status` tool for monitoring
- Agent metadata tracking in `src/index.ts:60-70`

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
}
```

**Monitoring Capabilities:**
| Feature | Description |
|---------|-------------|
| Live logs | Tail logs from running containers |
| Status tracking | running / completed / failed |
| Duration | Track execution time |
| Files modified | Parse output for file changes |

**Remaining Considerations:**
- Metadata stored in-memory only (lost on MCP server restart)
- Consider persistent storage for audit/debugging

---

### 7. GitHub Access Control

| Aspect | Status |
|--------|--------|
| **Risk Level** | Medium (Mitigated) |
| **Implementation** | FIXED |

**Original Concern:** Agents could have unlimited GitHub access.

**Implemented Mitigation:**
- 6 granular permission levels
- PAT or gh CLI credentials support
- Configurable default access level
- Implemented in `src/index.ts:25-29, 199-209, 557-577`

**Permission Levels:**
| Level | Capabilities |
|-------|--------------|
| `none` | No GitHub access (default) |
| `read` | Read repos, PRs, issues |
| `comment` | Read + post comments on PRs/issues |
| `write` | Create PRs, issues, push commits |
| `manage` | Write + milestones, projects, labels |
| `admin` | Full access (repo settings, workflows, secrets) |

**Credential Management:**
```typescript
// Via manage_config tool
github.set_token     // Store PAT
github.remove_token  // Remove PAT
github.set_default   // Set default access level
github.show          // View configuration
```

**Remaining Considerations:**
- Token stored in config file (should be protected)
- gh CLI config mounted read-only when no token set
- Access level is advisory; actual GitHub permissions depend on token scope

---

### 8. Unified Configuration Management

| Aspect | Status |
|--------|--------|
| **Risk Level** | Low (Informational) |
| **Implementation** | FIXED |

**Implementation Details:**
- Single `manage_config` tool for all configuration
- Persistent storage at `~/.config/pinocchio/config.json`
- Implemented in `src/index.ts:262-313, 905-1119`

**Configuration Sections:**
| Section | Actions |
|---------|---------|
| `workspaces` | list, propose, approve, reject, remove |
| `github` | show, set_token, remove_token, set_default |
| `settings` | show |

**Remaining Considerations:**
- Config file permissions should be restricted (600)
- Sensitive data (GitHub token) stored in plain text

---

### 9. Container Security Hardening

| Aspect | Status |
|--------|--------|
| **Risk Level** | Low (Mitigated) |
| **Implementation** | FIXED |

**Implemented Controls:**
```typescript
// Container creation in src/index.ts:588-605
{
  User: `${CONFIG.hostUid}:${CONFIG.hostGid}`,  // Non-root
  HostConfig: {
    Memory: 4 * 1024 * 1024 * 1024,  // 4GB limit
    CpuShares: 1024,
    CapDrop: ["ALL"],                 // Drop all capabilities
    CapAdd: ["CHOWN", "SETUID", "SETGID"],  // Minimal caps
    Privileged: false,
  },
}
```

**Agent Image Security (agent-image/Dockerfile):**
- Non-root user (`agent`)
- Minimal capability set
- Memory limits enforced

**Remaining Considerations:**
- `ReadonlyRootfs: false` allows container filesystem writes
- Network access unrestricted (needed for package installation)

---

### 10. Credential Handling

| Aspect | Status |
|--------|--------|
| **Risk Level** | Medium (Partially Mitigated) |
| **Implementation** | FIXED |

**Implemented Controls:**
- Claude credentials mounted read-only (`/tmp/claude-creds:ro`)
- Credentials copied to temporary location in agent
- gh CLI config mounted read-only
- Implemented in `agent-image/entrypoint.sh:14-28`

```bash
# Entrypoint credential handling
CREDS_DIR="${CLAUDE_CREDS_DIR:-/tmp/claude-creds}"
CLAUDE_DIR="/tmp/claude-agent"
mkdir -p "$CLAUDE_DIR"
cp "$CREDS_DIR/.credentials.json" "$CLAUDE_DIR/"
```

**Remaining Considerations:**
- Credentials accessible within container runtime
- Agent runs with `--dangerously-skip-permissions` (YOLO mode)
- No credential rotation mechanism

---

## Security Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Host System                              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Docker Network                            ││
│  │  ┌─────────────────────┐    ┌──────────────────────────────┐││
│  │  │  docker-proxy       │    │       MCP Server             │││
│  │  │  (tecnativa)        │◄───│  - Workspace allowlist       │││
│  │  │  ─────────────────  │    │  - Input validation          │││
│  │  │  BLOCKED:           │    │  - Timeout enforcement       │││
│  │  │  - BUILD            │    │  - manage_config tool        │││
│  │  │  - COMMIT           │    └──────────────────────────────┘││
│  │  │  - EXEC             │              │                      ││
│  │  │  - VOLUMES          │              │ Creates              ││
│  │  │  - SECRETS          │              ▼                      ││
│  │  └─────────────────────┘    ┌──────────────────────────────┐││
│  │           │                 │     Agent Container          │││
│  │           │ Limited API     │  ─────────────────────────   │││
│  │           ▼                 │  - Non-root user             │││
│  │  ┌─────────────────────┐    │  - CAP_DROP ALL              │││
│  │  │  /var/run/docker.   │    │  - 4GB memory limit          │││
│  │  │  sock (read-only)   │    │  - Read-only workspace       │││
│  │  └─────────────────────┘    │  - Specific write paths      │││
│  │                             │  - Timeout enforcement        │││
│  └─────────────────────────────└──────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Config: ~/.config/pinocchio/config.json              ││
│  │  - allowedWorkspaces[]                                       ││
│  │  - blockedPaths[]                                            ││
│  │  - github.token (optional)                                   ││
│  │  - github.defaultAccess                                      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## Recommendations

### Completed (FIXED)

1. **Docker Socket Proxy** - Implemented with tecnativa/docker-socket-proxy
2. **Workspace Allowlist** - Dynamic management with propose/approve workflow
3. **Read-Only Workspace** - Default read-only with explicit write paths
4. **Input Validation** - Container names, tasks, and paths validated
5. **Timeout Limits** - 1h default, 24h maximum, configurable
6. **Background Execution** - Async agents with status monitoring
7. **GitHub Access Levels** - 6 granular permission levels
8. **Unified Configuration** - Single manage_config tool

### Future Considerations

| Item | Priority | Description |
|------|----------|-------------|
| Credential rotation | Medium | Implement periodic credential refresh |
| Audit logging | Medium | Persist agent execution history |
| Network policies | Low | Further restrict container network access |
| Symlink protection | Low | Validate resolved paths don't escape workspace |
| Config file encryption | Low | Encrypt sensitive config data at rest |
| Rate limiting | Low | Limit agent spawning frequency |
| Resource quotas | Low | Per-user/project resource limits |

---

## Compliance Notes

- **Principle of Least Privilege**: Implemented via read-only defaults, capability dropping, and workspace allowlisting
- **Defense in Depth**: Multiple security layers (proxy, validation, isolation, timeouts)
- **Audit Trail**: Agent metadata tracked (consider persistent logging)
- **Secure Defaults**: Safe by default; explicit opt-in for elevated access

---

## References

- [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [MCP Security Considerations](https://modelcontextprotocol.io/docs/concepts/security)
