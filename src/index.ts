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

// Config file path
const CONFIG_FILE = path.join(os.homedir(), ".config", "pinocchio", "config.json");

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
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
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
}

// Track running agents and their metadata
const runningAgents = new Map<string, Docker.Container>();
const agentMetadata = new Map<string, AgentMetadata>();

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
  const realPath = path.resolve(workspacePath);
  const config = await loadConfig();

  // Block system paths
  for (const blocked of config.blockedPaths) {
    if (realPath === blocked || realPath.startsWith(blocked + "/")) {
      return { allowed: false, reason: `System path "${blocked}" is not allowed` };
    }
  }

  // Check allowlist
  const isInAllowlist = config.allowedWorkspaces.some(allowed => {
    const normalizedAllowed = path.resolve(allowed);
    return realPath === normalizedAllowed || realPath.startsWith(normalizedAllowed + "/");
  });

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
- Full network access for package installations
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

// Resolve glob patterns to actual file paths
async function resolveWritablePaths(
  workspacePath: string,
  explicitPaths: string[] = [],
  patterns: string[] = []
): Promise<string[]> {
  const resolvedPaths = new Set<string>();

  // Add explicit paths (relative to workspace)
  for (const p of explicitPaths) {
    const fullPath = path.join(workspacePath, p);
    try {
      await fs.access(fullPath);
      resolvedPaths.add(fullPath);
    } catch {
      // Path doesn't exist yet - that's OK, agent might create it
      resolvedPaths.add(fullPath);
    }
  }

  // Resolve glob patterns
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: workspacePath,
      absolute: true,
      nodir: false,
    });
    for (const match of matches) {
      resolvedPaths.add(match);
    }
  }

  return Array.from(resolvedPaths);
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
  writable_paths?: string[];
  writable_patterns?: string[];
  run_in_background?: boolean;
  github_access?: "none" | "read" | "comment" | "write" | "manage" | "admin";
}) {
  const {
    task,
    workspace_path,
    allow_docker = false,
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

  // Validate container name if provided
  const agentId = args.container_name || `claude-agent-${uuidv4().slice(0, 8)}`;
  if (args.container_name && !validateContainerName(args.container_name)) {
    return {
      content: [{
        type: "text" as const,
        text: `## Invalid container name\n\n**Error:** Container name must be alphanumeric with hyphens/underscores only, max 128 chars.`,
      }],
      isError: true,
    };
  }

  // Validate workspace path against allowlist
  const workspaceCheck = await isWorkspaceAllowed(workspace_path);
  if (!workspaceCheck.allowed) {
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
    return {
      content: [{
        type: "text" as const,
        text: `## Invalid task\n\n**Error:** Task cannot be empty.`,
      }],
      isError: true,
    };
  }

  try {
    // Verify workspace path exists
    const fs = await import("fs/promises");
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
    const resolvedWritablePaths = await resolveWritablePaths(
      workspace_path,
      writable_paths,
      writable_patterns
    );

    const hasWritablePaths = resolvedWritablePaths.length > 0;
    const accessMode = hasWritablePaths ? "read-only + specific writes" : "read-only";

    console.error(`[pinocchio] Starting agent: ${agentId}`);
    console.error(`[pinocchio] Workspace: ${workspace_path}`);
    console.error(`[pinocchio] Access mode: ${accessMode}`);
    console.error(`[pinocchio] Writable paths: ${resolvedWritablePaths.length > 0 ? resolvedWritablePaths.join(", ") : "(none)"}`);
    console.error(`[pinocchio] Timeout: ${timeout_ms}ms`);
    console.error(`[pinocchio] Docker access: ${allow_docker}`);
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
      // If token is configured, use it; otherwise gh CLI will use mounted config
      if (config.github?.token) {
        envVars.push(`GITHUB_TOKEN=${config.github.token}`);
        envVars.push(`GH_TOKEN=${config.github.token}`);
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
        NetworkMode: allow_docker ? "pinocchio_docker-proxy" : "bridge",
      },
      WorkingDir: "/workspace",
    });

    // Track the agent
    runningAgents.set(agentId, container);

    // Store metadata
    const metadata: AgentMetadata = {
      id: agentId,
      task: sanitizedTask,
      workspacePath: workspace_path,
      writablePaths: resolvedWritablePaths,
      startedAt: new Date(),
      status: "running",
    };
    agentMetadata.set(agentId, metadata);

    // Start the container
    await container.start();

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

    // Clean up container (keep metadata for status queries)
    try {
      await container.remove({ force: true });
    } catch (e) {
      // Ignore removal errors
    }
    runningAgents.delete(agentId);

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
    // Clean up on error
    runningAgents.delete(agentId);
    const metadata = agentMetadata.get(agentId);
    if (metadata) {
      metadata.status = "failed";
      metadata.endedAt = new Date();
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

// Get agent status and output
async function getAgentStatus(args: { agent_id: string; tail_lines?: number }) {
  const { agent_id, tail_lines = 100 } = args;

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

  try {
    const container = docker.getContainer(agent_id);
    await container.stop();
    await container.remove({ force: true });
    runningAgents.delete(agent_id);

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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pinocchio] Server started");
}

main().catch((error) => {
  console.error("[pinocchio] Fatal error:", error);
  process.exit(1);
});
