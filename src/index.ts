#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Docker from "dockerode";
import { v4 as uuidv4 } from "uuid";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { glob } from "glob";
import * as crypto from "crypto";

// SECURITY FIX #8: Directory for secure token files
// Tokens are written to files instead of passed via environment variables
// to prevent exposure in `docker inspect` output
const SECURE_TOKEN_DIR = path.join(os.tmpdir(), "pinocchio-tokens");

// SECURITY FIX #8.1: Track which token files have been cleaned up to prevent double cleanup race condition.
// Multiple code paths (foreground completion, background monitor, error handlers) can trigger cleanup.
// Using a Set ensures each token file is only deleted once, avoiding race conditions.
const cleanedTokenFiles = new Set<string>();

// Config file path
const CONFIG_FILE = path.join(os.homedir(), ".config", "pinocchio", "config.json");

// RELIABILITY FIX #4: Persistent agent state file path
// Agent metadata is now persisted to disk so it survives MCP server restarts
const AGENTS_STATE_FILE = path.join(os.homedir(), ".config", "pinocchio", "agents.json");

// Config file structure
interface AgentConfig {
  allowedWorkspaces: string[];
  blockedPaths: string[];
  pendingApprovals: { path: string; proposedAt: string; reason?: string }[];
  // GitHub configuration
  github?: {
    token?: string;           // PAT for GitHub API (preferred over gh CLI)
    defaultAccess?: "none" | "read" | "comment" | "write" | "manage" | "admin";
  };
}

// Default config
const DEFAULT_CONFIG: AgentConfig = {
  allowedWorkspaces: [],
  blockedPaths: ["/etc", "/var", "/root", "/boot", "/sys", "/proc", "/dev"],
  pendingApprovals: [],
};

// Load config from file
async function loadConfig(): Promise<AgentConfig> {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// Save config to file
async function saveConfig(config: AgentConfig): Promise<void> {
  const dir = path.dirname(CONFIG_FILE);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  // SECURITY FIX #2: Set restrictive permissions (600) on config file.
  // The config may contain sensitive data like GitHub PAT tokens.
  // Mode 0o600 = owner read/write only, no group or world access.
  // Also ensure the directory has 0o700 permissions (owner rwx only).
  await fs.chmod(CONFIG_FILE, 0o600);
  await fs.chmod(dir, 0o700);
}

// RELIABILITY FIX #4: Serializable agent metadata for persistence
// Dates are stored as ISO strings for JSON compatibility
interface PersistedAgentMetadata {
  id: string;
  task: string;
  workspacePath: string;
  writablePaths: string[];
  startedAt: string;  // ISO date string
  status: "running" | "completed" | "failed";
  exitCode?: number;
  endedAt?: string;   // ISO date string
  output?: string;
}

// RELIABILITY FIX #4: Load agent state from disk on startup
// This restores agent metadata so status can be retrieved after MCP server restarts
// RELIABILITY FIX #4.1: Back up corrupted files for debugging before starting fresh
async function loadAgentState(): Promise<void> {
  try {
    const data = await fs.readFile(AGENTS_STATE_FILE, "utf-8");
    let persisted: PersistedAgentMetadata[];

    try {
      persisted = JSON.parse(data);
    } catch (parseError) {
      // RELIABILITY FIX #4.1: JSON parse failed - back up corrupted file for debugging
      const backupFile = `${AGENTS_STATE_FILE}.corrupted.${Date.now()}`;
      console.error(`[pinocchio] State file corrupted, backing up to: ${backupFile}`);
      try {
        await fs.copyFile(AGENTS_STATE_FILE, backupFile);
        await fs.chmod(backupFile, 0o600);
      } catch (backupError) {
        console.error(`[pinocchio] Warning: Could not create backup: ${backupError}`);
      }
      console.error(`[pinocchio] Starting with fresh state due to parse error: ${parseError}`);
      return;
    }

    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    for (const item of persisted) {
      const startedAt = new Date(item.startedAt);
      const endedAt = item.endedAt ? new Date(item.endedAt) : undefined;

      // RELIABILITY FIX #4: Clean up old metadata (older than 24 hours)
      // This prevents the state file from growing indefinitely
      const referenceTime = endedAt || startedAt;
      if (now.getTime() - referenceTime.getTime() > maxAge) {
        console.error(`[pinocchio] Cleaning up old agent metadata: ${item.id}`);
        continue;
      }

      // Restore metadata with Date objects
      const metadata: AgentMetadata = {
        id: item.id,
        task: item.task,
        workspacePath: item.workspacePath,
        writablePaths: item.writablePaths,
        startedAt,
        status: item.status,
        exitCode: item.exitCode,
        endedAt,
        output: item.output,
      };

      // If agent was marked as running but server restarted, mark as failed
      if (metadata.status === "running") {
        metadata.status = "failed";
        metadata.endedAt = now;
        metadata.output = (metadata.output || "") + "\n[pinocchio] Agent marked as failed due to MCP server restart";
        console.error(`[pinocchio] Marking orphaned running agent as failed: ${item.id}`);
      }

      agentMetadata.set(item.id, metadata);
    }

    console.error(`[pinocchio] Loaded ${agentMetadata.size} agent(s) from state file`);
  } catch (error) {
    // File doesn't exist or is invalid - start fresh
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[pinocchio] Warning: Could not load agent state: ${error}`);
    }
  }
}

// RELIABILITY FIX #4: Save agent state to disk
// Called when agent metadata changes (start, complete, fail)
// RELIABILITY FIX #4.1: Use atomic write pattern (temp file + rename) to prevent corruption
async function saveAgentState(): Promise<void> {
  try {
    const dir = path.dirname(AGENTS_STATE_FILE);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Convert Map to array with dates as ISO strings
    const persisted: PersistedAgentMetadata[] = [];
    for (const [, metadata] of agentMetadata) {
      persisted.push({
        id: metadata.id,
        task: metadata.task,
        workspacePath: metadata.workspacePath,
        writablePaths: metadata.writablePaths,
        startedAt: metadata.startedAt.toISOString(),
        status: metadata.status,
        exitCode: metadata.exitCode,
        endedAt: metadata.endedAt?.toISOString(),
        output: metadata.output,
      });
    }

    // RELIABILITY FIX #4.1: Write to temp file first, then atomic rename
    // fs.rename is atomic on the same filesystem, preventing partial writes
    const tempFile = `${AGENTS_STATE_FILE}.tmp.${process.pid}`;
    await fs.writeFile(tempFile, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    await fs.chmod(tempFile, 0o600);
    await fs.rename(tempFile, AGENTS_STATE_FILE);
  } catch (error) {
    console.error(`[pinocchio] Warning: Could not save agent state: ${error}`);
  }
}

// Docker client
const docker = new Docker();

// Agent metadata for tracking
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
  // SECURITY FIX #8: Track token file path for cleanup
  tokenFilePath?: string;
}

// Track running agents and their metadata
const runningAgents = new Map<string, Docker.Container>();
const agentMetadata = new Map<string, AgentMetadata>();

// SECURITY FIX #5: Rate limiting configuration to prevent DoS attacks.
// Limits how many agents can run concurrently and how fast they can be spawned.
const RATE_LIMIT = {
  maxConcurrentAgents: Number(process.env.MAX_CONCURRENT_AGENTS) || 5,
  maxSpawnsPerMinute: Number(process.env.MAX_SPAWNS_PER_MINUTE) || 10,
};

// SECURITY FIX #5.1: Track spawn timestamps using a circular buffer for O(1) operations.
// Using an object with head/tail indices avoids O(n) shift() operations.
interface SpawnRateTracker {
  timestamps: number[];
  head: number;  // Index of oldest timestamp
  tail: number;  // Index of next write position
  count: number; // Number of valid entries
}

const spawnRateTracker: SpawnRateTracker = {
  timestamps: new Array(100).fill(0), // Pre-allocated circular buffer
  head: 0,
  tail: 0,
  count: 0,
};

// SECURITY FIX #5.1: Track pending reservations to prevent race conditions.
// When a spawn request passes the concurrent limit check, we reserve a slot
// immediately before container creation to prevent TOCTOU races.
const pendingReservations = new Set<string>();

// Helper to add a timestamp to the circular buffer
function recordSpawnTimestamp(timestamp: number): void {
  spawnRateTracker.timestamps[spawnRateTracker.tail] = timestamp;
  spawnRateTracker.tail = (spawnRateTracker.tail + 1) % spawnRateTracker.timestamps.length;
  if (spawnRateTracker.count < spawnRateTracker.timestamps.length) {
    spawnRateTracker.count++;
  } else {
    // Buffer is full, advance head
    spawnRateTracker.head = (spawnRateTracker.head + 1) % spawnRateTracker.timestamps.length;
  }
}

// Helper to clean old timestamps and count recent spawns
function getRecentSpawnCount(cutoffTime: number): number {
  let count = 0;
  let newHead = spawnRateTracker.head;
  let foundNewHead = false;

  for (let i = 0; i < spawnRateTracker.count; i++) {
    const idx = (spawnRateTracker.head + i) % spawnRateTracker.timestamps.length;
    const timestamp = spawnRateTracker.timestamps[idx];

    if (timestamp >= cutoffTime) {
      if (!foundNewHead) {
        newHead = idx;
        foundNewHead = true;
      }
      count++;
    }
  }

  // Update head to skip expired entries
  if (foundNewHead) {
    const skipped = (newHead - spawnRateTracker.head + spawnRateTracker.timestamps.length) % spawnRateTracker.timestamps.length;
    spawnRateTracker.head = newHead;
    spawnRateTracker.count -= skipped;
  } else if (spawnRateTracker.count > 0) {
    // All entries expired
    spawnRateTracker.head = spawnRateTracker.tail;
    spawnRateTracker.count = 0;
  }

  return count;
}

// Helper to get the oldest recent timestamp (for wait time calculation)
function getOldestRecentTimestamp(cutoffTime: number): number | null {
  for (let i = 0; i < spawnRateTracker.count; i++) {
    const idx = (spawnRateTracker.head + i) % spawnRateTracker.timestamps.length;
    const timestamp = spawnRateTracker.timestamps[idx];
    if (timestamp >= cutoffTime) {
      return timestamp;
    }
  }
  return null;
}

// Configuration
const CONFIG = {
  imageName: "claude-agent:latest",
  // When running in Docker, HOME is /root; credentials are mounted there
  claudeConfigPath: process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), ".claude"),
  // Host home directory for mounting into agent containers
  hostHomePath: process.env.HOST_HOME || os.homedir(),
  // Host user ID for container permissions (to read credentials)
  hostUid: process.env.HOST_UID || "1000",
  hostGid: process.env.HOST_GID || "989",
  // Timeout defaults (in ms)
  defaultTimeout: 3600000, // 1 hour default
  absoluteMaxTimeout: Number(process.env.ABSOLUTE_MAX_TIMEOUT) || 86400000, // 24h hard limit (configurable via env)
  resourceLimits: {
    memory: 4 * 1024 * 1024 * 1024, // 4GB
    cpuShares: 1024, // Default CPU shares
  },
  // Docker proxy address for agents
  dockerProxyHost: process.env.DOCKER_HOST || "",
  // Max task length to prevent abuse
  maxTaskLength: 50000,
};

// SECURITY FIX #8: Create a secure token file for a container
// Returns the path to the created token file on the host
async function createSecureTokenFile(agentId: string, token: string): Promise<string> {
  // Ensure the secure token directory exists with restricted permissions
  await fs.mkdir(SECURE_TOKEN_DIR, { recursive: true, mode: 0o700 });

  // Generate a unique filename using agent ID and random suffix
  const randomSuffix = crypto.randomBytes(8).toString("hex");
  const tokenFileName = `${agentId}-${randomSuffix}.token`;
  const tokenFilePath = path.join(SECURE_TOKEN_DIR, tokenFileName);

  // Write token to file with restrictive permissions (owner read-only)
  await fs.writeFile(tokenFilePath, token, { mode: 0o400 });

  return tokenFilePath;
}

// SECURITY FIX #8: Clean up token file after container stops
// SECURITY FIX #8.1: Added cleanup flag to prevent double cleanup race condition.
// Multiple code paths can trigger cleanup (foreground completion, background monitor, error handlers).
// The cleanedTokenFiles Set ensures each file is only deleted once.
async function cleanupTokenFile(tokenFilePath: string): Promise<void> {
  // SECURITY FIX #8.1: Check if already cleaned up to prevent race condition
  if (cleanedTokenFiles.has(tokenFilePath)) {
    return;
  }
  cleanedTokenFiles.add(tokenFilePath);

  try {
    await fs.unlink(tokenFilePath);
    console.error(`[pinocchio] Cleaned up token file: ${tokenFilePath}`);
  } catch (error) {
    // Ignore errors if file doesn't exist or already deleted
    // This can happen in race conditions or if file was manually removed
  }
}

// SECURITY FIX #8.1: Clean up stale token files on startup.
// If the MCP server is killed (SIGKILL) or crashes, token files may persist in /tmp/pinocchio-tokens/.
// This function removes any leftover token files from previous sessions to prevent token leakage.
async function cleanupStaleTokenFiles(): Promise<void> {
  try {
    // Check if the token directory exists
    await fs.access(SECURE_TOKEN_DIR);

    // Read all files in the directory
    const files = await fs.readdir(SECURE_TOKEN_DIR);

    if (files.length > 0) {
      console.error(`[pinocchio] Cleaning up ${files.length} stale token file(s) from previous session`);

      for (const file of files) {
        // Only delete .token files to be safe
        if (file.endsWith(".token")) {
          const filePath = path.join(SECURE_TOKEN_DIR, file);
          try {
            await fs.unlink(filePath);
            console.error(`[pinocchio] Removed stale token file: ${file}`);
          } catch (unlinkError) {
            console.error(`[pinocchio] Warning: Could not remove stale token file ${file}`);
          }
        }
      }
    }
  } catch (error) {
    // Directory doesn't exist or not accessible - that's fine, nothing to clean up
  }
}

// Input validation helpers
function validateContainerName(name: string): boolean {
  // Docker container names: alphanumeric, underscores, hyphens, dots
  // Must start with alphanumeric
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) && name.length <= 128;
}

function sanitizeForEnv(value: string): string {
  // Remove null bytes and limit length
  return value.replace(/\0/g, "").slice(0, CONFIG.maxTaskLength);
}

async function isWorkspaceAllowed(workspacePath: string): Promise<{ allowed: boolean; reason?: string }> {
  // SECURITY FIX #1: Resolve symlinks before validation to prevent symlink escape attacks.
  // An attacker could create a symlink inside an allowed workspace pointing to a blocked path.
  // Using fs.realpath() resolves all symlinks, ensuring we validate the actual target path.
  let realPath: string;
  try {
    realPath = await fs.realpath(workspacePath);
  } catch (error) {
    // If path doesn't exist, fall back to path.resolve() for the check
    // (the path might be created later, so we validate the resolved form)
    realPath = path.resolve(workspacePath);
  }

  const config = await loadConfig();

  // Block system paths
  for (const blocked of config.blockedPaths) {
    if (realPath === blocked || realPath.startsWith(blocked + "/")) {
      return { allowed: false, reason: `System path "${blocked}" is not allowed` };
    }
  }

  // Check allowlist - also resolve symlinks in allowlist entries for consistent comparison
  const isInAllowlist = await (async () => {
    for (const allowed of config.allowedWorkspaces) {
      let normalizedAllowed: string;
      try {
        normalizedAllowed = await fs.realpath(allowed);
      } catch {
        normalizedAllowed = path.resolve(allowed);
      }
      if (realPath === normalizedAllowed || realPath.startsWith(normalizedAllowed + "/")) {
        return true;
      }
    }
    return false;
  })();

  if (!isInAllowlist) {
    const allowedList = config.allowedWorkspaces.length > 0
      ? config.allowedWorkspaces.join(", ")
      : "(none configured)";
    return {
      allowed: false,
      reason: `Path not in allowlist. Allowed: ${allowedList}. Use 'propose_workspace' to request access.`
    };
  }

  return { allowed: true };
}

// Tool definitions
const TOOLS = [
  {
    name: "spawn_docker_agent",
    description: `Spawn an isolated Claude Code agent in a Docker container to work on a task.

The agent runs with full autonomy (YOLO mode) inside a secured container with:
- Read-only access to your Claude Max credentials
- Configurable network access (disabled by default for security)
- **Read-only workspace by default** - agent can only read files unless writable paths are specified
- Optional Docker access via secure proxy for running tests/builds

**Security Model:**
- Workspace is mounted READ-ONLY by default
- Use 'writable_paths' or 'writable_patterns' to allow writing to specific files/folders
- This ensures agents can only modify what you explicitly allow

**Examples:**
- Review code: no writable paths needed (read-only)
- Fix a bug: writable_paths: ['src/buggy-file.ts']
- Run tests: writable_patterns: ['**/*.test.ts', 'coverage/']`,
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "The task for the agent to complete",
        },
        workspace_path: {
          type: "string",
          description: "Absolute path to the project directory to mount as workspace",
        },
        container_name: {
          type: "string",
          description: "Optional custom name for the container (alphanumeric, hyphens, underscores only)",
        },
        timeout_ms: {
          type: "number",
          description: `Timeout in milliseconds (default: 1 hour, max: 24 hours)`,
        },
        allow_docker: {
          type: "boolean",
          description: "Allow the agent to use Docker via secure proxy (for running tests, builds). Default: false",
        },
        allow_network: {
          type: "boolean",
          description: "Allow the agent to access the network (for package installations, API calls). Default: false for security. Enable if the task requires internet access.",
        },
        writable_paths: {
          type: "array",
          items: { type: "string" },
          description: "Explicit paths (relative to workspace) that the agent can write to. Example: ['src/file.ts', 'tests/']",
        },
        writable_patterns: {
          type: "array",
          items: { type: "string" },
          description: "Glob patterns (relative to workspace) for writable files. Example: ['src/**/*.ts', '*.md']",
        },
        run_in_background: {
          type: "boolean",
          description: "Run agent in background. Returns immediately with agent ID. Use get_agent_status to check progress. Default: false",
        },
        github_access: {
          type: "string",
          enum: ["none", "read", "comment", "write", "manage", "admin"],
          description: `GitHub access level (credentials from config or gh CLI):
- none: No GitHub access (default)
- read: Read repos, PRs, issues
- comment: Read + post comments on PRs/issues
- write: Create PRs, issues, push commits
- manage: Write + milestones, projects, labels (for PM/Scrum)
- admin: Full access (repo settings, workflows, secrets)`,
        },
      },
      required: ["task", "workspace_path"],
    },
  },
  {
    name: "list_docker_agents",
    description: "List all running Claude agent containers",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_agent_status",
    description: `Get the status and output of a running or completed agent.

Returns:
- Current status (running/completed/failed)
- Task progress and logs
- Files modified (if completed)
- Duration and resource usage

Use this to check on background agents or get detailed results.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description: "The agent ID to check (returned by spawn_docker_agent)",
        },
        tail_lines: {
          type: "number",
          description: "Number of log lines to return (default: 100, use 0 for all)",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "stop_docker_agent",
    description: "Stop a running Claude agent container",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description: "The agent ID or container name to stop",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "manage_config",
    description: `Manage Pinocchio configuration (workspaces, GitHub, settings).

**Sections:**
- workspaces: Manage allowed workspace paths
- github: Configure GitHub access and credentials
- settings: View/modify general settings

**Workspace Actions:**
- workspaces.list: Show allowed workspaces and pending proposals
- workspaces.propose: Request adding a new workspace
- workspaces.approve: Approve a pending proposal
- workspaces.reject: Reject a pending proposal
- workspaces.remove: Remove from allowlist

**GitHub Actions:**
- github.show: Display GitHub configuration
- github.set_token: Store a GitHub PAT
- github.remove_token: Remove stored token
- github.set_default: Set default access level

**Settings Actions:**
- settings.show: Display all settings`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          description: "Action in format 'section.action' (e.g., 'workspaces.list', 'github.set_token')",
        },
        path: {
          type: "string",
          description: "Workspace path (for workspace actions)",
        },
        reason: {
          type: "string",
          description: "Reason for workspace proposal",
        },
        token: {
          type: "string",
          description: "GitHub PAT (for github.set_token)",
        },
        default_access: {
          type: "string",
          enum: ["none", "read", "comment", "write", "manage", "admin"],
          description: "Default GitHub access level (for github.set_default)",
        },
      },
      required: ["action"],
    },
  },
];

// Create MCP server
const server = new Server(
  {
    name: "pinocchio",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "spawn_docker_agent":
      return await spawnDockerAgent(args as {
        task: string;
        workspace_path: string;
        container_name?: string;
        timeout_ms?: number;
        allow_docker?: boolean;
        allow_network?: boolean;
        writable_paths?: string[];
        writable_patterns?: string[];
        run_in_background?: boolean;
        github_access?: "none" | "read" | "comment" | "write" | "manage" | "admin";
      });

    case "list_docker_agents":
      return await listDockerAgents();

    case "get_agent_status":
      return await getAgentStatus(args as { agent_id: string; tail_lines?: number });

    case "stop_docker_agent":
      return await stopDockerAgent(args as { agent_id: string });

    case "manage_config":
      return await manageConfig(args as {
        action: string;
        path?: string;
        reason?: string;
        token?: string;
        default_access?: "none" | "read" | "comment" | "write" | "manage" | "admin";
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// SECURITY FIX #7: Dangerous glob pattern blocklist.
// These patterns are overly permissive and could grant write access to the entire workspace.
const DANGEROUS_GLOB_PATTERNS = [
  "**/*",        // Matches everything recursively
  "**",          // Matches everything recursively
  "**/",         // Matches all directories recursively
  "*",           // Matches all files in root
  ".",           // Current directory
  "..",          // Parent directory
  "**/../*",     // Parent traversal
  "../*",        // Parent traversal
  "**/..*",      // Hidden traversal patterns
];

// Validate glob pattern for security
function validateGlobPattern(pattern: string): { valid: boolean; reason?: string } {
  // Normalize the pattern for comparison
  const normalized = pattern.trim();

  // Check against dangerous patterns
  for (const dangerous of DANGEROUS_GLOB_PATTERNS) {
    if (normalized === dangerous) {
      return { valid: false, reason: `Pattern "${pattern}" is too permissive and could grant excessive write access` };
    }
  }

  // Check for parent directory traversal
  if (normalized.includes("..")) {
    return { valid: false, reason: `Pattern "${pattern}" contains parent directory traversal (..)` };
  }

  // Check if pattern starts with / (absolute path in glob context)
  if (normalized.startsWith("/")) {
    return { valid: false, reason: `Pattern "${pattern}" must be relative to workspace, not absolute` };
  }

  return { valid: true };
}

// Resolve glob patterns to actual file paths
async function resolveWritablePaths(
  workspacePath: string,
  explicitPaths: string[] = [],
  patterns: string[] = []
): Promise<{ paths: string[]; errors: string[] }> {
  const resolvedPaths = new Set<string>();
  const errors: string[] = [];

  // Add explicit paths (relative to workspace)
  for (const p of explicitPaths) {
    // Check for path traversal in explicit paths
    if (p.includes("..")) {
      errors.push(`Path "${p}" contains parent directory traversal (..)`);
      continue;
    }
    const fullPath = path.join(workspacePath, p);
    // Ensure resolved path is still within workspace
    const realFullPath = path.resolve(fullPath);
    const realWorkspace = path.resolve(workspacePath);
    if (!realFullPath.startsWith(realWorkspace + "/") && realFullPath !== realWorkspace) {
      errors.push(`Path "${p}" resolves outside workspace`);
      continue;
    }
    try {
      await fs.access(fullPath);
      resolvedPaths.add(fullPath);
    } catch {
      // Path doesn't exist yet - that's OK, agent might create it
      resolvedPaths.add(fullPath);
    }
  }

  // SECURITY FIX #7: Validate glob patterns before resolving
  for (const pattern of patterns) {
    const validation = validateGlobPattern(pattern);
    if (!validation.valid) {
      errors.push(validation.reason!);
      continue;
    }

    const matches = await glob(pattern, {
      cwd: workspacePath,
      absolute: true,
      nodir: false,
    });
    for (const match of matches) {
      // Additional check: ensure matches are within workspace
      const realMatch = path.resolve(match);
      const realWorkspace = path.resolve(workspacePath);
      if (realMatch.startsWith(realWorkspace + "/") || realMatch === realWorkspace) {
        resolvedPaths.add(match);
      }
    }
  }

  return { paths: Array.from(resolvedPaths), errors };
}

// Format duration in human readable format
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

// Parse agent output for structured summary
function parseAgentOutput(output: string): { summary: string; filesModified: string[]; actions: string[] } {
  const lines = output.split("\n");
  const filesModified: string[] = [];
  const actions: string[] = [];

  // Extract files that were likely modified (heuristic)
  for (const line of lines) {
    if (line.includes("Created file") || line.includes("Updated file") || line.includes("Modified")) {
      const match = line.match(/(?:Created|Updated|Modified)[:\s]+([^\s]+)/i);
      if (match) filesModified.push(match[1]);
    }
    if (line.includes("Writing to") || line.includes("Saved")) {
      const match = line.match(/(?:Writing to|Saved)[:\s]+([^\s]+)/i);
      if (match) filesModified.push(match[1]);
    }
  }

  // Get last meaningful lines as summary
  const meaningfulLines = lines.filter(l => l.trim() && !l.startsWith("╔") && !l.startsWith("║") && !l.startsWith("╚"));
  const summary = meaningfulLines.slice(-5).join("\n");

  return { summary, filesModified: [...new Set(filesModified)], actions };
}

// Spawn a Docker agent
async function spawnDockerAgent(args: {
  task: string;
  workspace_path: string;
  container_name?: string;
  timeout_ms?: number;
  allow_docker?: boolean;
  allow_network?: boolean;
  writable_paths?: string[];
  writable_patterns?: string[];
  run_in_background?: boolean;
  github_access?: "none" | "read" | "comment" | "write" | "manage" | "admin";
}) {
  // Generate agent ID early so we can use it for reservation
  const agentId = args.container_name || `claude-agent-${uuidv4().slice(0, 8)}`;

  // Validate container name if provided
  if (args.container_name && !validateContainerName(args.container_name)) {
    return {
      content: [{
        type: "text" as const,
        text: `## Invalid container name\n\n**Error:** Container name must be alphanumeric with hyphens/underscores only, max 128 chars.`,
      }],
      isError: true,
    };
  }

  // SECURITY FIX #5.1: Check concurrent agent limit with reservation to prevent race conditions.
  // We include pending reservations in the count to prevent TOCTOU races where multiple
  // concurrent requests could all pass the check before any container is created.
  const totalActiveSlots = runningAgents.size + pendingReservations.size;
  if (totalActiveSlots >= RATE_LIMIT.maxConcurrentAgents) {
    // SECURITY FIX #5.1: Generic error message to avoid information disclosure
    return {
      content: [{
        type: "text" as const,
        text: `## Rate Limit Exceeded\n\n**Error:** Too many agents are currently active. Please wait for existing agents to complete or stop them using \`stop_docker_agent\`.`,
      }],
      isError: true,
    };
  }

  // SECURITY FIX #5.1: Reserve a slot immediately to prevent race conditions.
  // This reservation is released if container creation fails.
  pendingReservations.add(agentId);

  // SECURITY FIX #5.1: Check spawn rate limit using efficient circular buffer.
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  // Get count of spawns in the last minute (also cleans up old entries)
  const recentSpawnCount = getRecentSpawnCount(oneMinuteAgo);

  // Check if we've exceeded the spawns-per-minute limit
  if (recentSpawnCount >= RATE_LIMIT.maxSpawnsPerMinute) {
    // Release the reservation since we're rejecting
    pendingReservations.delete(agentId);

    const oldestTimestamp = getOldestRecentTimestamp(oneMinuteAgo);
    const waitSeconds = oldestTimestamp
      ? Math.ceil((oldestTimestamp + 60000 - now) / 1000)
      : 60;

    // SECURITY FIX #5.1: Generic error message to avoid information disclosure
    return {
      content: [{
        type: "text" as const,
        text: `## Rate Limit Exceeded\n\n**Error:** Too many agents spawned recently. Please wait ${waitSeconds} seconds before spawning another agent.`,
      }],
      isError: true,
    };
  }

  // NOTE: Spawn timestamp is NOT recorded here. It will be recorded AFTER successful
  // container start to ensure failed attempts don't count against the rate limit.
  // See SECURITY FIX #5.1 below where recordSpawnTimestamp() is called.

  const {
    task,
    workspace_path,
    allow_docker = false,
    allow_network = false,
    writable_paths = [],
    writable_patterns = [],
    run_in_background = false,
  } = args;

  // Load config for GitHub settings
  const config = await loadConfig();
  const github_access = args.github_access || config.github?.defaultAccess || "none";

  // Apply timeout limits: default 1h, max 24h (configurable via env)
  const requestedTimeout = args.timeout_ms ?? CONFIG.defaultTimeout;
  const timeout_ms = Math.min(Math.max(requestedTimeout, 1000), CONFIG.absoluteMaxTimeout);

  // Validate workspace path against allowlist
  const workspaceCheck = await isWorkspaceAllowed(workspace_path);
  if (!workspaceCheck.allowed) {
    // SECURITY FIX #5.1: Release reservation on early return
    pendingReservations.delete(agentId);
    return {
      content: [{
        type: "text" as const,
        text: `## Workspace path not allowed\n\n**Error:** ${workspaceCheck.reason}`,
      }],
      isError: true,
    };
  }

  // Sanitize task string
  const sanitizedTask = sanitizeForEnv(task);
  if (sanitizedTask.length === 0) {
    // SECURITY FIX #5.1: Release reservation on early return
    pendingReservations.delete(agentId);
    return {
      content: [{
        type: "text" as const,
        text: `## Invalid task\n\n**Error:** Task cannot be empty.`,
      }],
      isError: true,
    };
  }

  // SECURITY FIX #8: Track token file path for cleanup (declared outside try for catch block access)
  let tokenFilePath: string | null = null;

  try {
    // Verify workspace path exists
    const stats = await fs.stat(workspace_path);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${workspace_path}`);
    }

    // Verify Claude config exists
    try {
      await fs.stat(CONFIG.claudeConfigPath);
    } catch {
      throw new Error(
        `Claude config not found at ${CONFIG.claudeConfigPath}. Please login to Claude first.`
      );
    }

    // Resolve writable paths from explicit paths and glob patterns
    const { paths: resolvedWritablePaths, errors: pathErrors } = await resolveWritablePaths(
      workspace_path,
      writable_paths,
      writable_patterns
    );

    // If there were validation errors with writable paths/patterns, report them
    if (pathErrors.length > 0) {
      // SECURITY FIX #5.1: Release reservation on early return
      pendingReservations.delete(agentId);
      return {
        content: [{
          type: "text" as const,
          text: `## Invalid writable paths/patterns\n\n**Errors:**\n${pathErrors.map(e => `- ${e}`).join("\n")}\n\n` +
            `Please fix the patterns and try again. Avoid overly permissive patterns like \`**/*\` or \`*\`.`,
        }],
        isError: true,
      };
    }

    const hasWritablePaths = resolvedWritablePaths.length > 0;
    const accessMode = hasWritablePaths ? "read-only + specific writes" : "read-only";

    console.error(`[pinocchio] Starting agent: ${agentId}`);
    console.error(`[pinocchio] Workspace: ${workspace_path}`);
    console.error(`[pinocchio] Access mode: ${accessMode}`);
    console.error(`[pinocchio] Writable paths: ${resolvedWritablePaths.length > 0 ? resolvedWritablePaths.join(", ") : "(none)"}`);
    console.error(`[pinocchio] Timeout: ${timeout_ms}ms`);
    console.error(`[pinocchio] Docker access: ${allow_docker}`);
    console.error(`[pinocchio] Network access: ${allow_network}`);
    console.error(`[pinocchio] GitHub access: ${github_access}`);
    console.error(`[pinocchio] Task: ${sanitizedTask.slice(0, 100)}...`);

    // Build environment variables
    const envVars = [
      `AGENT_TASK=${sanitizedTask}`,
      `AGENT_WORKDIR=/workspace`,
      `HOME=/home/agent`,
      `WORKSPACE_MODE=${hasWritablePaths ? "restricted" : "readonly"}`,
    ];

    // If agent needs Docker access, pass the proxy host
    if (allow_docker && CONFIG.dockerProxyHost) {
      envVars.push(`DOCKER_HOST=${CONFIG.dockerProxyHost}`);
    }

    // If GitHub access is requested, set up credentials
    if (github_access !== "none") {
      envVars.push(`GITHUB_ACCESS_LEVEL=${github_access}`);
      // SECURITY FIX #8: Instead of passing token via env var (visible in docker inspect),
      // write it to a secure file and mount it into the container.
      // The entrypoint.sh will read the token from this file.
      //
      // SECURITY FIX #8.1: Note on GITHUB_TOKEN_FILE env var exposure:
      // The GITHUB_TOKEN_FILE env var reveals that a token file exists at /run/secrets/github_token,
      // but this is acceptable because:
      // 1. It only reveals the file PATH, not the token VALUE
      // 2. The file is mounted read-only with 0400 permissions inside the container
      // 3. The host-side token file has 0400 permissions and is in a 0700 directory
      // 4. The token file is deleted after container completion
      // 5. Using /run/secrets/ is a Docker best practice for secrets management
      // An attacker would need container access to read the file, at which point they
      // could also intercept API calls, so the env var exposure is not a security concern.
      if (config.github?.token) {
        tokenFilePath = await createSecureTokenFile(agentId, config.github.token);
        // Tell the container where to find the token file
        envVars.push(`GITHUB_TOKEN_FILE=/run/secrets/github_token`);
      }
    }

    // Build bind mounts
    // Workspace is mounted read-only by default for security
    const binds: string[] = [
      `${workspace_path}:/workspace:ro`,
      // Mount Claude credentials read-only
      `${CONFIG.hostHomePath}/.claude:/tmp/claude-creds:ro`,
    ];

    // Mount gh CLI config if GitHub access is needed and no token is set
    if (github_access !== "none" && !config.github?.token) {
      binds.push(`${CONFIG.hostHomePath}/.config/gh:/tmp/gh-creds:ro`);
    }

    // SECURITY FIX #8: Mount token file into container at secure location
    // Using /run/secrets/ which is a standard location for secrets in containers
    if (tokenFilePath) {
      binds.push(`${tokenFilePath}:/run/secrets/github_token:ro`);
    }

    // Add writable path mounts (these overlay the read-only workspace)
    for (const writablePath of resolvedWritablePaths) {
      // Convert host path to container path
      const relativePath = path.relative(workspace_path, writablePath);
      const containerPath = path.join("/workspace", relativePath);
      binds.push(`${writablePath}:${containerPath}:rw`);
    }

    // Create container with security hardening
    const container = await docker.createContainer({
      Image: CONFIG.imageName,
      name: agentId,
      User: `${CONFIG.hostUid}:${CONFIG.hostGid}`,
      Env: envVars,
      HostConfig: {
        Binds: binds,
        Memory: CONFIG.resourceLimits.memory,
        CpuShares: CONFIG.resourceLimits.cpuShares,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "SETUID", "SETGID"],
        Privileged: false,
        ReadonlyRootfs: false,
        // Network isolation: use docker-proxy network when Docker access is needed,
        // bridge network when general network access is allowed,
        // or "none" for fully isolated containers (most secure default).
        NetworkMode: allow_docker ? "pinocchio_docker-proxy" : (allow_network ? "bridge" : "none"),
        SecurityOpt: ["no-new-privileges:true"],
      },
      WorkingDir: "/workspace",
    });

    // Track the agent
    runningAgents.set(agentId, container);

    // Store metadata
    // SECURITY FIX #8: Include tokenFilePath for cleanup when container stops
    const metadata: AgentMetadata = {
      id: agentId,
      task: sanitizedTask,
      workspacePath: workspace_path,
      writablePaths: resolvedWritablePaths,
      startedAt: new Date(),
      status: "running",
      tokenFilePath: tokenFilePath || undefined,
    };
    agentMetadata.set(agentId, metadata);

    // RELIABILITY FIX #4: Persist state when agent starts
    await saveAgentState();

    // Start the container
    await container.start();

    // SECURITY FIX #5.1: Record spawn timestamp ONLY after successful container start.
    // This ensures failed attempts don't count against the rate limit.
    recordSpawnTimestamp(Date.now());

    // SECURITY FIX #5.1: Release the reservation now that the agent is tracked in runningAgents.
    pendingReservations.delete(agentId);

    // If background mode, return immediately
    if (run_in_background) {
      // Start background monitoring
      monitorAgent(agentId, container, timeout_ms);

      return {
        content: [{
          type: "text" as const,
          text: `## 🚀 Agent Started (Background)\n\n` +
            `| Property | Value |\n` +
            `|----------|-------|\n` +
            `| **Agent ID** | \`${agentId}\` |\n` +
            `| **Workspace** | ${workspace_path} |\n` +
            `| **Access Mode** | ${accessMode} |\n` +
            `| **Timeout** | ${formatDuration(timeout_ms)} |\n\n` +
            `Use \`get_agent_status(agent_id: "${agentId}")\` to check progress.`,
        }],
      };
    }

    // Foreground mode: wait for completion
    const result = await waitForContainer(container, timeout_ms);
    const endTime = new Date();
    const duration = endTime.getTime() - metadata.startedAt.getTime();

    // Get logs
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });

    const output = logs.toString("utf-8");
    const parsed = parseAgentOutput(output);

    // Update metadata
    metadata.status = result.StatusCode === 0 ? "completed" : "failed";
    metadata.exitCode = result.StatusCode;
    metadata.endedAt = endTime;
    metadata.output = output;

    // RELIABILITY FIX #4: Persist state when agent completes
    await saveAgentState();

    // Clean up container (keep metadata for status queries)
    try {
      await container.remove({ force: true });
    } catch (e) {
      // Ignore removal errors
    }
    runningAgents.delete(agentId);

    // SECURITY FIX #8: Clean up the token file from the host filesystem
    if (tokenFilePath) {
      await cleanupTokenFile(tokenFilePath);
    }

    // Build structured output
    const statusEmoji = result.StatusCode === 0 ? "✅" : "❌";
    const filesSection = parsed.filesModified.length > 0
      ? `\n**Files Modified:**\n${parsed.filesModified.map(f => `- ${f}`).join("\n")}\n`
      : "";

    return {
      content: [{
        type: "text" as const,
        text: `## ${statusEmoji} Agent ${agentId} ${result.StatusCode === 0 ? "Completed" : "Failed"}\n\n` +
          `| Property | Value |\n` +
          `|----------|-------|\n` +
          `| **Exit Code** | ${result.StatusCode} |\n` +
          `| **Duration** | ${formatDuration(duration)} |\n` +
          `| **Workspace** | ${workspace_path} |\n` +
          `| **Writable Paths** | ${resolvedWritablePaths.length > 0 ? resolvedWritablePaths.length + " paths" : "read-only"} |\n` +
          filesSection +
          `\n**Summary:**\n${parsed.summary}\n\n` +
          `<details><summary>Full Output</summary>\n\n\`\`\`\n${output}\n\`\`\`\n</details>`,
      }],
    };
  } catch (error) {
    // SECURITY FIX #5.1: Release reservation on error (it may not have been released yet
    // if the error occurred before container.start() succeeded).
    pendingReservations.delete(agentId);

    // Clean up on error
    runningAgents.delete(agentId);
    const metadata = agentMetadata.get(agentId);
    if (metadata) {
      metadata.status = "failed";
      metadata.endedAt = new Date();
      // RELIABILITY FIX #4: Persist state when agent fails
      await saveAgentState();
    }

    // SECURITY FIX #8: Clean up token file on error
    // Use the local variable since metadata may not have been set yet
    if (tokenFilePath) {
      await cleanupTokenFile(tokenFilePath);
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text" as const,
        text: `## ❌ Agent ${agentId} Failed\n\n**Error:** ${errorMessage}`,
      }],
      isError: true,
    };
  }
}

// Monitor a background agent
async function monitorAgent(agentId: string, container: Docker.Container, timeout: number) {
  try {
    const result = await waitForContainer(container, timeout);
    const metadata = agentMetadata.get(agentId);

    if (metadata) {
      metadata.status = result.StatusCode === 0 ? "completed" : "failed";
      metadata.exitCode = result.StatusCode;
      metadata.endedAt = new Date();

      // Get and store output
      const logs = await container.logs({ stdout: true, stderr: true, follow: false });
      metadata.output = logs.toString("utf-8");

      // RELIABILITY FIX #4: Persist state when background agent completes
      await saveAgentState();

      // SECURITY FIX #8: Clean up token file after container completes
      if (metadata.tokenFilePath) {
        await cleanupTokenFile(metadata.tokenFilePath);
      }
    }

    // Clean up container
    try {
      await container.remove({ force: true });
    } catch (e) {
      // Ignore
    }
    runningAgents.delete(agentId);
  } catch (error) {
    const metadata = agentMetadata.get(agentId);
    if (metadata) {
      metadata.status = "failed";
      metadata.endedAt = new Date();
      metadata.output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      // RELIABILITY FIX #4: Persist state when background agent fails
      await saveAgentState();

      // SECURITY FIX #8: Clean up token file even on error
      if (metadata.tokenFilePath) {
        await cleanupTokenFile(metadata.tokenFilePath);
      }
    }
    runningAgents.delete(agentId);
  }
}

// Wait for container with timeout
async function waitForContainer(
  container: Docker.Container,
  timeout: number
): Promise<{ StatusCode: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      container.stop().catch(() => {});
      reject(new Error(`Agent timed out after ${timeout}ms`));
    }, timeout);

    container.wait((err, result) => {
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

// List running agents
async function listDockerAgents() {
  const containers = await docker.listContainers({
    filters: { name: ["claude-agent"] },
  });

  if (containers.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No Claude agents are currently running.",
        },
      ],
    };
  }

  const list = containers
    .map((c) => `- **${c.Names[0]}** (${c.State}) - ${c.Status}`)
    .join("\n");

  return {
    content: [
      {
        type: "text" as const,
        text: `## Running Claude Agents\n\n${list}`,
      },
    ],
  };
}

// SECURITY FIX #14: Validate agent_id format to prevent injection attacks.
// Agent IDs should match Docker container naming conventions.
function validateAgentId(agentId: string): { valid: boolean; reason?: string } {
  if (!agentId || typeof agentId !== "string") {
    return { valid: false, reason: "Agent ID is required" };
  }
  // Agent IDs follow Docker container naming: alphanumeric, underscores, hyphens, dots
  // Must start with alphanumeric, max 128 chars (same as validateContainerName)
  if (!validateContainerName(agentId)) {
    return { valid: false, reason: "Invalid agent ID format. Must be alphanumeric with hyphens/underscores only, max 128 chars." };
  }
  return { valid: true };
}

// Get agent status and output
async function getAgentStatus(args: { agent_id: string; tail_lines?: number }) {
  const { agent_id, tail_lines = 100 } = args;

  // SECURITY FIX #14: Validate agent_id format before use
  const idValidation = validateAgentId(agent_id);
  if (!idValidation.valid) {
    return {
      content: [{
        type: "text" as const,
        text: `## Invalid Agent ID\n\n**Error:** ${idValidation.reason}`,
      }],
      isError: true,
    };
  }

  // Check metadata first
  const metadata = agentMetadata.get(agent_id);

  if (!metadata) {
    return {
      content: [{
        type: "text" as const,
        text: `## ❓ Agent Not Found\n\nNo agent found with ID: \`${agent_id}\`\n\nUse \`list_docker_agents\` to see running agents.`,
      }],
      isError: true,
    };
  }

  const duration = (metadata.endedAt || new Date()).getTime() - metadata.startedAt.getTime();
  const statusEmoji = metadata.status === "completed" ? "✅" :
                      metadata.status === "failed" ? "❌" : "🔄";

  // If still running, try to get live logs
  let output = metadata.output || "";
  if (metadata.status === "running") {
    const container = runningAgents.get(agent_id);
    if (container) {
      try {
        const logs = await container.logs({
          stdout: true,
          stderr: true,
          follow: false,
          tail: tail_lines || undefined,
        });
        output = logs.toString("utf-8");
      } catch {
        output = "(Unable to fetch live logs)";
      }
    }
  }

  // Parse output for summary
  const parsed = parseAgentOutput(output);

  // Truncate output if needed
  const outputLines = output.split("\n");
  const displayOutput = tail_lines > 0 && outputLines.length > tail_lines
    ? outputLines.slice(-tail_lines).join("\n")
    : output;

  const filesSection = parsed.filesModified.length > 0
    ? `\n**Files Modified:**\n${parsed.filesModified.map(f => `- ${f}`).join("\n")}\n`
    : "";

  return {
    content: [{
      type: "text" as const,
      text: `## ${statusEmoji} Agent Status: ${metadata.status.toUpperCase()}\n\n` +
        `| Property | Value |\n` +
        `|----------|-------|\n` +
        `| **Agent ID** | \`${agent_id}\` |\n` +
        `| **Status** | ${metadata.status} |\n` +
        `| **Duration** | ${formatDuration(duration)} |\n` +
        `| **Exit Code** | ${metadata.exitCode ?? "n/a"} |\n` +
        `| **Workspace** | ${metadata.workspacePath} |\n` +
        `| **Writable Paths** | ${metadata.writablePaths.length} |\n` +
        `| **Task** | ${metadata.task.slice(0, 80)}${metadata.task.length > 80 ? "..." : ""} |\n` +
        filesSection +
        `\n**Output** (last ${tail_lines} lines):\n\`\`\`\n${displayOutput}\n\`\`\``,
    }],
  };
}

// Stop a running agent
async function stopDockerAgent(args: { agent_id: string }) {
  const { agent_id } = args;

  // SECURITY FIX #14: Validate agent_id format before use
  const idValidation = validateAgentId(agent_id);
  if (!idValidation.valid) {
    return {
      content: [{
        type: "text" as const,
        text: `## Invalid Agent ID\n\n**Error:** ${idValidation.reason}`,
      }],
      isError: true,
    };
  }

  try {
    const container = docker.getContainer(agent_id);
    await container.stop();
    await container.remove({ force: true });
    runningAgents.delete(agent_id);

    // RELIABILITY FIX #4: Update and persist metadata when agent is manually stopped
    const metadata = agentMetadata.get(agent_id);
    if (metadata && metadata.status === "running") {
      metadata.status = "failed";
      metadata.endedAt = new Date();
      metadata.output = (metadata.output || "") + "\n[pinocchio] Agent manually stopped by user";
      await saveAgentState();
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Agent ${agent_id} has been stopped and removed.`,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to stop agent ${agent_id}: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

// Unified config management
async function manageConfig(args: {
  action: string;
  path?: string;
  reason?: string;
  token?: string;
  default_access?: "none" | "read" | "comment" | "write" | "manage" | "admin";
}) {
  const { action, path: workspacePath, reason, token, default_access } = args;
  const config = await loadConfig();

  // Parse action into section and subaction
  const [section, subaction] = action.includes(".") ? action.split(".") : ["", action];

  // Handle workspace actions
  if (section === "workspaces" || (!section && ["list", "propose", "approve", "reject", "remove"].includes(subaction))) {
    const wsAction = subaction as "list" | "propose" | "approve" | "reject" | "remove";

    switch (wsAction) {
      case "list": {
        const allowed = config.allowedWorkspaces.length > 0
          ? config.allowedWorkspaces.map(p => `  ✅ ${p}`).join("\n")
          : "  (none)";
        const pending = config.pendingApprovals.length > 0
          ? config.pendingApprovals.map(p =>
              `  ⏳ ${p.path}${p.reason ? ` - "${p.reason}"` : ""} (proposed: ${p.proposedAt})`
            ).join("\n")
          : "  (none)";
        const blocked = config.blockedPaths.map(p => `  🚫 ${p}`).join("\n");

        return {
          content: [{
            type: "text" as const,
            text: `## 📂 Workspace Configuration\n\n**Allowed Workspaces:**\n${allowed}\n\n**Pending Approvals:**\n${pending}\n\n**Blocked Paths:**\n${blocked}`,
          }],
        };
      }

      case "propose": {
        if (!workspacePath) {
          return { content: [{ type: "text" as const, text: "**Error:** `path` is required" }], isError: true };
        }
        const realPath = path.resolve(workspacePath);

        for (const blocked of config.blockedPaths) {
          if (realPath === blocked || realPath.startsWith(blocked + "/")) {
            return { content: [{ type: "text" as const, text: `**Error:** System path "${blocked}" is blocked` }], isError: true };
          }
        }

        if (config.allowedWorkspaces.includes(realPath)) {
          return { content: [{ type: "text" as const, text: `**Info:** "${realPath}" is already allowed` }] };
        }

        if (config.pendingApprovals.some(p => p.path === realPath)) {
          return { content: [{ type: "text" as const, text: `**Info:** "${realPath}" is already pending` }] };
        }

        config.pendingApprovals.push({ path: realPath, proposedAt: new Date().toISOString(), reason });
        await saveConfig(config);

        return {
          content: [{
            type: "text" as const,
            text: `## ⏳ Workspace Proposal\n\n**Path:** ${realPath}\n**Reason:** ${reason || "(none)"}\n\nUse \`manage_config(action: "workspaces.approve", path: "${realPath}")\` to approve.`,
          }],
        };
      }

      case "approve": {
        if (!workspacePath) {
          return { content: [{ type: "text" as const, text: "**Error:** `path` is required" }], isError: true };
        }
        const realPath = path.resolve(workspacePath);
        const pendingIndex = config.pendingApprovals.findIndex(p => p.path === realPath);

        if (pendingIndex !== -1) {
          config.pendingApprovals.splice(pendingIndex, 1);
        }

        if (!config.allowedWorkspaces.includes(realPath)) {
          config.allowedWorkspaces.push(realPath);
          await saveConfig(config);
          return { content: [{ type: "text" as const, text: `✅ **Workspace approved:** ${realPath}` }] };
        }
        return { content: [{ type: "text" as const, text: `**Info:** "${realPath}" is already allowed` }] };
      }

      case "reject": {
        if (!workspacePath) {
          return { content: [{ type: "text" as const, text: "**Error:** `path` is required" }], isError: true };
        }
        const realPath = path.resolve(workspacePath);
        const pendingIndex = config.pendingApprovals.findIndex(p => p.path === realPath);

        if (pendingIndex === -1) {
          return { content: [{ type: "text" as const, text: `**Info:** No pending proposal for "${realPath}"` }] };
        }

        config.pendingApprovals.splice(pendingIndex, 1);
        await saveConfig(config);
        return { content: [{ type: "text" as const, text: `❌ **Proposal rejected:** ${realPath}` }] };
      }

      case "remove": {
        if (!workspacePath) {
          return { content: [{ type: "text" as const, text: "**Error:** `path` is required" }], isError: true };
        }
        const realPath = path.resolve(workspacePath);
        const index = config.allowedWorkspaces.indexOf(realPath);

        if (index === -1) {
          return { content: [{ type: "text" as const, text: `**Info:** "${realPath}" is not in allowlist` }] };
        }

        config.allowedWorkspaces.splice(index, 1);
        await saveConfig(config);
        return { content: [{ type: "text" as const, text: `🗑️ **Workspace removed:** ${realPath}` }] };
      }
    }
  }

  // Handle GitHub actions
  if (section === "github") {
    switch (subaction) {
      case "show": {
        const hasToken = !!config.github?.token;
        const defaultAccess = config.github?.defaultAccess || "none";

        return {
          content: [{
            type: "text" as const,
            text: `## 🐙 GitHub Configuration\n\n` +
              `| Setting | Value |\n` +
              `|---------|-------|\n` +
              `| **Token** | ${hasToken ? "✅ Configured (hidden)" : "❌ Not set (will use gh CLI)"} |\n` +
              `| **Default Access** | ${defaultAccess} |\n\n` +
              `**Access Levels:**\n` +
              `- \`none\`: No GitHub access\n` +
              `- \`read\`: Read repos, PRs, issues\n` +
              `- \`comment\`: Read + post comments\n` +
              `- \`write\`: Create PRs, issues, push\n` +
              `- \`manage\`: Write + milestones, projects\n` +
              `- \`admin\`: Full access`,
          }],
        };
      }

      case "set_token": {
        if (!token) {
          return { content: [{ type: "text" as const, text: "**Error:** `token` is required" }], isError: true };
        }

        config.github = config.github || {};
        config.github.token = token;
        await saveConfig(config);

        return { content: [{ type: "text" as const, text: `✅ **GitHub token saved**\n\nAgents will use this token instead of gh CLI credentials.` }] };
      }

      case "remove_token": {
        if (config.github?.token) {
          delete config.github.token;
          await saveConfig(config);
          return { content: [{ type: "text" as const, text: `🗑️ **GitHub token removed**\n\nAgents will use gh CLI credentials if available.` }] };
        }
        return { content: [{ type: "text" as const, text: `**Info:** No token was configured` }] };
      }

      case "set_default": {
        if (!default_access) {
          return { content: [{ type: "text" as const, text: "**Error:** `default_access` is required" }], isError: true };
        }

        config.github = config.github || {};
        config.github.defaultAccess = default_access;
        await saveConfig(config);

        return { content: [{ type: "text" as const, text: `✅ **Default GitHub access set to:** ${default_access}` }] };
      }
    }
  }

  // Handle settings actions
  if (section === "settings" && subaction === "show") {
    const hasGhToken = !!config.github?.token;
    const ghDefault = config.github?.defaultAccess || "none";

    return {
      content: [{
        type: "text" as const,
        text: `## ⚙️ Docker Agent Configuration\n\n` +
          `**📂 Workspaces:**\n` +
          `- Allowed: ${config.allowedWorkspaces.length}\n` +
          `- Pending: ${config.pendingApprovals.length}\n` +
          `- Blocked: ${config.blockedPaths.length}\n\n` +
          `**🐙 GitHub:**\n` +
          `- Token: ${hasGhToken ? "configured" : "not set"}\n` +
          `- Default access: ${ghDefault}\n\n` +
          `**Config file:** ~/.config/pinocchio/config.json`,
      }],
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: `**Error:** Unknown action "${action}"\n\nValid actions:\n` +
        `- workspaces.list, workspaces.propose, workspaces.approve, workspaces.reject, workspaces.remove\n` +
        `- github.show, github.set_token, github.remove_token, github.set_default\n` +
        `- settings.show`,
    }],
    isError: true,
  };
}

// RELIABILITY FIX #16: Track if shutdown is in progress to prevent multiple shutdown attempts
let isShuttingDown = false;

// RELIABILITY FIX #16: Graceful shutdown handler
// Stops all running agent containers and saves final state before exiting
// RELIABILITY FIX #16.1: Save state BEFORE attempting to stop containers to prevent race condition
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.error(`[pinocchio] Shutdown already in progress, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  console.error(`[pinocchio] Received ${signal}, shutting down gracefully...`);

  // RELIABILITY FIX #16.1: Update metadata for all running agents FIRST
  // This ensures state is captured before any timeout can fire
  const containersToStop: Array<{ agentId: string; container: Docker.Container }> = [];
  for (const [agentId, container] of runningAgents) {
    containersToStop.push({ agentId, container });

    // Update metadata to mark as failed due to shutdown
    const metadata = agentMetadata.get(agentId);
    if (metadata && metadata.status === "running") {
      metadata.status = "failed";
      metadata.endedAt = new Date();
      metadata.output = (metadata.output || "") + "\n[pinocchio] Agent stopped due to MCP server shutdown";
    }
  }

  // RELIABILITY FIX #16.1: Save state IMMEDIATELY before stopping containers
  // This guarantees state is persisted before any container stop timeout can interfere
  console.error("[pinocchio] Saving agent state before stopping containers...");
  await saveAgentState();

  // Now stop all running agent containers (best effort, with timeout)
  if (containersToStop.length > 0) {
    console.error(`[pinocchio] Stopping ${containersToStop.length} container(s)...`);
    const stopPromises = containersToStop.map(async ({ agentId, container }) => {
      try {
        await container.stop({ t: 10 }); // 10 second timeout for graceful stop
        console.error(`[pinocchio] Stopped container: ${agentId}`);
      } catch (error) {
        // Container might already be stopped
        console.error(`[pinocchio] Could not stop container ${agentId}: ${error}`);
      }
    });

    // Wait for all containers to stop (with overall timeout)
    await Promise.race([
      Promise.all(stopPromises),
      new Promise(resolve => setTimeout(resolve, 15000)) // 15 second overall timeout
    ]);
  }

  console.error("[pinocchio] Shutdown complete");
  process.exit(0);
}

// RELIABILITY FIX #16: Register signal handlers for graceful shutdown
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start the server
async function main() {
  // RELIABILITY FIX #4: Load persisted agent state on startup
  await loadAgentState();

  // SECURITY FIX #8.1: Clean up any stale token files from previous sessions.
  // This handles cases where the MCP server was killed (SIGKILL) or crashed
  // without proper cleanup, leaving token files in /tmp/pinocchio-tokens/.
  await cleanupStaleTokenFiles();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pinocchio] Server started");
}

main().catch((error) => {
  console.error("[pinocchio] Fatal error:", error);
  process.exit(1);
});
