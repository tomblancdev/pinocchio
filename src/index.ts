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
import { EventBus, eventBus } from './websocket/events.js';
import { PinocchioWebSocket } from './websocket/server.js';
import { WebSocketConfig, SpawnHandlerArgs, SpawnHandlerResult, TokenValidationResult as WsTokenValidationResult } from './websocket/types.js';
import { ProgressTracker } from './websocket/progress.js';
import {
  initSessionManager,
  generateSessionToken as generateToken,
  storeSessionToken,
  getSessionToken,
  validateSessionToken,
  invalidateSessionToken,
  invalidateTokensForAgent,
  invalidateTokensForTree,
  saveTokenState as saveSessionTokenState,
  loadTokenState as loadSessionTokenState,
  startTokenCleanup,
  stopTokenCleanup,
  SessionToken,
  TokenValidationResult,
} from './session/index.js';
import {
  terminateWithChildren,
  terminateTree,
  CascadeTerminationResult,
} from './lifecycle/index.js';

// PR #32 FIX: Docker stream demultiplexer
// Docker multiplexed streams have an 8-byte header per message:
// - Byte 0: stream type (1=stdout, 2=stderr)
// - Bytes 1-3: reserved (zeros)
// - Bytes 4-7: message size (big-endian uint32)
// This class handles buffering incomplete chunks and iterating through multiple messages.
interface DockerLogMessage {
  streamType: 1 | 2; // 1=stdout, 2=stderr
  content: string;
}

class DockerStreamDemultiplexer {
  private buffer: Buffer = Buffer.alloc(0);
  private static readonly HEADER_SIZE = 8;

  // Process incoming chunk and return complete messages
  processChunk(chunk: Buffer): DockerLogMessage[] {
    // Append new chunk to buffer
    this.buffer = Buffer.concat([this.buffer, chunk]);

    const messages: DockerLogMessage[] = [];

    // Process all complete messages in the buffer
    while (this.buffer.length >= DockerStreamDemultiplexer.HEADER_SIZE) {
      const streamType = this.buffer[0];

      // Validate stream type (1=stdout, 2=stderr)
      // If not a valid multiplexed stream, treat the entire buffer as raw content
      if (streamType !== 1 && streamType !== 2) {
        // Not a multiplexed stream - emit raw content and clear buffer
        const content = this.buffer.toString('utf-8').trim();
        if (content) {
          messages.push({ streamType: 1, content });
        }
        this.buffer = Buffer.alloc(0);
        break;
      }

      // Read message size from bytes 4-7 (big-endian uint32)
      const messageSize = this.buffer.readUInt32BE(4);

      // Validate message size (sanity check: max 10MB per message)
      const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;
      if (messageSize > MAX_MESSAGE_SIZE) {
        // Invalid size - likely corrupted stream, treat as raw and clear
        console.error(`[pinocchio] Docker stream: invalid message size ${messageSize}, treating as raw`);
        const content = this.buffer.toString('utf-8').trim();
        if (content) {
          messages.push({ streamType: 1, content });
        }
        this.buffer = Buffer.alloc(0);
        break;
      }

      const totalMessageLength = DockerStreamDemultiplexer.HEADER_SIZE + messageSize;

      // Check if we have the complete message
      if (this.buffer.length < totalMessageLength) {
        // Incomplete message, wait for more data
        break;
      }

      // Extract the message content
      const content = this.buffer.slice(
        DockerStreamDemultiplexer.HEADER_SIZE,
        totalMessageLength
      ).toString('utf-8');

      if (content.trim()) {
        messages.push({
          streamType: streamType as 1 | 2,
          content: content.trim(),
        });
      }

      // Remove processed message from buffer
      this.buffer = this.buffer.slice(totalMessageLength);
    }

    return messages;
  }

  // Clear the buffer (for cleanup)
  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

// Helper function to determine log level from content and stream type
function determineLogLevel(
  content: string,
  streamType: 1 | 2
): 'debug' | 'info' | 'warn' | 'error' {
  const lowerContent = content.toLowerCase();

  // Check content for keywords
  if (lowerContent.includes('error') || lowerContent.includes('fail') || lowerContent.includes('exception')) {
    return 'error';
  }
  if (lowerContent.includes('warn')) {
    return 'warn';
  }
  if (lowerContent.includes('debug') || lowerContent.includes('verbose')) {
    return 'debug';
  }

  // Use stream type as hint: stderr defaults to warn
  if (streamType === 2) {
    return 'warn';
  }

  return 'info';
}

// Helper function to process Docker log messages and emit to event bus
function emitLogMessages(
  agentId: string,
  messages: DockerLogMessage[],
  eventBus: EventBus,
  hierarchy: { parentAgentId?: string; treeId: string; depth: number }
): void {
  for (const msg of messages) {
    // Split by newlines in case multiple lines come in one message
    const lines = msg.content.split('\n').filter(line => line.trim());
    for (const line of lines) {
      const level = determineLogLevel(line, msg.streamType);
      eventBus.emitLog(agentId, level, line, hierarchy);
    }
  }
}

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

// AUDIT FIX #9: Audit log file path and settings
const AUDIT_LOG_FILE = path.join(os.homedir(), ".config", "pinocchio", "audit.jsonl");
const MAX_AUDIT_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_AUDIT_FILES = 5;

// RELIABILITY FIX #4: Persistent agent state file path
// Agent metadata is now persisted to disk so it survives MCP server restarts
const AGENTS_STATE_FILE = path.join(os.homedir(), ".config", "pinocchio", "agents.json");

// Issue #46: Persistent spawn tree state file path
const TREES_STATE_FILE = path.join(os.homedir(), ".config", "pinocchio", "trees.json");

// Issue #90: Tree-level writable paths directory
// Each spawn tree gets its own writable directory for isolation
const WRITABLE_BASE_DIR = path.join(os.homedir(), ".config", "pinocchio", "writable");

// Issue #90: Helper functions for tree-level writable paths

function getTreeWritableDir(treeId: string): string {
  return path.join(WRITABLE_BASE_DIR, treeId);
}

async function createTreeWritableDirs(treeId: string, relativePaths: string[]): Promise<void> {
  const treeDir = getTreeWritableDir(treeId);
  await fs.mkdir(treeDir, { recursive: true, mode: 0o777 });
  // Explicit chmod to override umask which may have masked the mode
  await fs.chmod(treeDir, 0o777);

  for (const relPath of relativePaths) {
    // Defense-in-depth: reject paths with parent traversal
    if (relPath.includes('..') || path.isAbsolute(relPath)) {
      console.error(`[pinocchio] Skipping invalid writable path: ${relPath}`);
      continue;
    }
    const fullPath = path.join(treeDir, relPath);
    await fs.mkdir(fullPath, { recursive: true, mode: 0o777 });
    // Explicit chmod to override umask which may have masked the mode
    await fs.chmod(fullPath, 0o777);
  }
}

export async function cleanupTreeWritableDir(treeId: string): Promise<void> {
  const treeDir = getTreeWritableDir(treeId);
  try {
    await fs.rm(treeDir, { recursive: true, force: true });
    console.error(`[pinocchio] Cleaned up writable directory for tree: ${treeId}`);
  } catch (error) {
    console.error(`[pinocchio] Failed to cleanup writable dir for tree ${treeId}:`, error);
  }
}

// Issue #47: Nested spawning configuration
// Controls limits and behavior for agent-spawned agents
export interface NestedSpawnConfig {
  maxNestingDepth: number;       // Max depth of spawning (default: 2 = parent + child)
  maxAgentsPerTree: number;      // Max total agents in a spawn tree (default: 10)
  enableRecursiveSpawn: boolean; // Allow nested spawning at all (default: true)
}

// Issue #47: Default values for nested spawn configuration
const DEFAULT_NESTED_SPAWN_CONFIG: NestedSpawnConfig = {
  maxNestingDepth: 2,
  maxAgentsPerTree: 10,
  enableRecursiveSpawn: true,
};

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
  // WebSocket configuration
  websocket?: WebSocketConfig;
  // Issue #47: Nested spawning configuration
  nestedSpawn?: NestedSpawnConfig;
}

// Default config
const DEFAULT_CONFIG: AgentConfig = {
  allowedWorkspaces: [],
  blockedPaths: ["/etc", "/var", "/root", "/boot", "/sys", "/proc", "/dev"],
  pendingApprovals: [],
  websocket: {
    enabled: true,
    port: 3001,
    bindAddress: '0.0.0.0',  // Allow external connections (for container port mapping)
    auth: 'none',
    subscriptionPolicy: 'open',
    bufferSize: 1000,
  },
  // Issue #47: Nested spawn defaults
  nestedSpawn: DEFAULT_NESTED_SPAWN_CONFIG,
};

// AUDIT FIX #9: Audit event structure
interface AuditEvent {
  timestamp: string;
  event: string;
  agentId?: string;
  data: Record<string, unknown>;
}

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

// Issue #47: Upper bounds for nested spawn configuration
const MAX_NESTING_DEPTH_LIMIT = 10;
const MAX_AGENTS_PER_TREE_LIMIT = 100;

// Issue #47: Validate nested spawn configuration values
// Returns error messages for any invalid values, empty array if all valid
function validateNestedSpawnConfig(config: NestedSpawnConfig): string[] {
  const errors: string[] = [];

  if (!Number.isInteger(config.maxNestingDepth)) {
    errors.push(`maxNestingDepth must be an integer, got ${config.maxNestingDepth}`);
  } else if (config.maxNestingDepth < 1) {
    errors.push(`maxNestingDepth must be >= 1, got ${config.maxNestingDepth}`);
  } else if (config.maxNestingDepth > MAX_NESTING_DEPTH_LIMIT) {
    errors.push(`maxNestingDepth must be <= ${MAX_NESTING_DEPTH_LIMIT}, got ${config.maxNestingDepth}`);
  }

  if (!Number.isInteger(config.maxAgentsPerTree)) {
    errors.push(`maxAgentsPerTree must be an integer, got ${config.maxAgentsPerTree}`);
  } else if (config.maxAgentsPerTree < 1) {
    errors.push(`maxAgentsPerTree must be >= 1, got ${config.maxAgentsPerTree}`);
  } else if (config.maxAgentsPerTree > MAX_AGENTS_PER_TREE_LIMIT) {
    errors.push(`maxAgentsPerTree must be <= ${MAX_AGENTS_PER_TREE_LIMIT}, got ${config.maxAgentsPerTree}`);
  }

  if (typeof config.enableRecursiveSpawn !== 'boolean') {
    errors.push(`enableRecursiveSpawn must be a boolean`);
  }

  return errors;
}

// Issue #47: Helper to validate a numeric env var as a positive integer within bounds
function parseEnvVarAsPositiveInt(
  value: string,
  envVarName: string,
  minValue: number,
  maxValue: number
): number | null {
  const parsed = Number(value);

  // Check if it's a valid number
  if (isNaN(parsed)) {
    console.warn(`[pinocchio] Warning: ${envVarName}="${value}" is not a valid number, ignoring`);
    return null;
  }

  // Check if it's an integer
  if (!Number.isInteger(parsed)) {
    console.warn(`[pinocchio] Warning: ${envVarName}=${parsed} must be an integer, ignoring`);
    return null;
  }

  // Check minimum bound
  if (parsed < minValue) {
    console.warn(`[pinocchio] Warning: ${envVarName}=${parsed} must be >= ${minValue}, ignoring`);
    return null;
  }

  // Check maximum bound
  if (parsed > maxValue) {
    console.warn(`[pinocchio] Warning: ${envVarName}=${parsed} must be <= ${maxValue}, ignoring`);
    return null;
  }

  return parsed;
}

// Issue #47: Get nested spawn config with environment variable overrides
// Priority: environment variables > config file > defaults
function getNestedSpawnConfig(config: AgentConfig): NestedSpawnConfig {
  // Start with defaults, overlay config file values, then env overrides
  const baseConfig: NestedSpawnConfig = {
    ...DEFAULT_NESTED_SPAWN_CONFIG,
    ...(config.nestedSpawn || {}),
  };

  // Environment variable overrides
  const envDepth = process.env.MAX_NESTING_DEPTH;
  const envAgents = process.env.MAX_AGENTS_PER_TREE;
  const envRecursive = process.env.ENABLE_RECURSIVE_SPAWN;

  if (envDepth !== undefined) {
    const parsed = parseEnvVarAsPositiveInt(
      envDepth,
      "MAX_NESTING_DEPTH",
      1,
      MAX_NESTING_DEPTH_LIMIT
    );
    if (parsed !== null) {
      baseConfig.maxNestingDepth = parsed;
    }
  }

  if (envAgents !== undefined) {
    const parsed = parseEnvVarAsPositiveInt(
      envAgents,
      "MAX_AGENTS_PER_TREE",
      1,
      MAX_AGENTS_PER_TREE_LIMIT
    );
    if (parsed !== null) {
      baseConfig.maxAgentsPerTree = parsed;
    }
  }

  if (envRecursive !== undefined) {
    // Accept 'true', '1', 'yes' as true, anything else as false
    baseConfig.enableRecursiveSpawn = ['true', '1', 'yes'].includes(envRecursive.toLowerCase());
  }

  // Validate the final config and log any issues
  const validationErrors = validateNestedSpawnConfig(baseConfig);
  if (validationErrors.length > 0) {
    console.warn(`[pinocchio] Warning: Invalid nested spawn config: ${validationErrors.join("; ")}`);
    // Return defaults if validation fails
    return { ...DEFAULT_NESTED_SPAWN_CONFIG };
  }

  return baseConfig;
}

// AUDIT FIX #9: In-memory lock to prevent race condition during rotation
// Multiple concurrent auditLog calls could trigger rotation simultaneously
let rotationInProgress = false;

// AUDIT FIX #9: Rotate audit log file if it exceeds MAX_AUDIT_SIZE
// Keeps up to MAX_AUDIT_FILES rotated files (audit.jsonl.1, audit.jsonl.2, etc.)
async function rotateAuditLogIfNeeded(): Promise<void> {
  if (rotationInProgress) return;
  rotationInProgress = true;
  try {
    const stats = await fs.stat(AUDIT_LOG_FILE);
    if (stats.size < MAX_AUDIT_SIZE) {
      return; // No rotation needed
    }

    // Delete the oldest file if it exists (to make room for rotation)
    const oldestPath = `${AUDIT_LOG_FILE}.${MAX_AUDIT_FILES}`;
    try {
      await fs.unlink(oldestPath);
    } catch {
      // Oldest file doesn't exist, that's fine
    }

    // Rotate existing numbered files: .4 -> .5, .3 -> .4, .2 -> .3, .1 -> .2
    for (let i = MAX_AUDIT_FILES - 1; i >= 1; i--) {
      const oldPath = `${AUDIT_LOG_FILE}.${i}`;
      const newPath = `${AUDIT_LOG_FILE}.${i + 1}`;

      try {
        await fs.access(oldPath);
        await fs.rename(oldPath, newPath);
      } catch {
        // Source file doesn't exist, skip
      }
    }

    // Move current file to .1
    try {
      await fs.rename(AUDIT_LOG_FILE, `${AUDIT_LOG_FILE}.1`);
    } catch {
      // Current file doesn't exist or couldn't be moved
    }

    console.error("[pinocchio] Rotated audit log file");
  } catch (error) {
    // File doesn't exist yet, or other error - no rotation needed
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[pinocchio] Warning: Could not check audit log for rotation: ${error}`);
    }
  } finally {
    rotationInProgress = false;
  }
}

// AUDIT FIX #9: Append an audit event to the log file
// Events are stored as JSONL (one JSON object per line)
export async function auditLog(event: string, data: Record<string, unknown>, agentId?: string): Promise<void> {
  try {
    // Ensure config directory exists
    const dir = path.dirname(AUDIT_LOG_FILE);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Check if rotation is needed before appending
    await rotateAuditLogIfNeeded();

    // Create the audit event
    const auditEvent: AuditEvent = {
      timestamp: new Date().toISOString(),
      event,
      ...(agentId && { agentId }),
      data,
    };

    // Append to audit log file
    const line = JSON.stringify(auditEvent) + "\n";
    await fs.appendFile(AUDIT_LOG_FILE, line, { mode: 0o600 });
    // Ensure permissions even on existing files (mode option only applies on create)
    await fs.chmod(AUDIT_LOG_FILE, 0o600).catch(() => {});
  } catch (error) {
    // Audit logging should never break the main flow
    console.error(`[pinocchio] Warning: Could not write audit log: ${error}`);
  }
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

  // Issue #45: Hierarchy tracking for nested agent spawning
  // These fields are optional for backwards compatibility with existing state files
  parentAgentId?: string;
  childAgentIds?: string[];
  nestingDepth?: number;
  treeId?: string;

  // Issue #48: Session token for nested agent authentication
  sessionToken?: string;
}

// Issue #46: Serializable spawn tree for persistence
interface PersistedSpawnTree {
  treeId: string;
  rootAgentId: string;
  totalAgents: number;
  maxDepthReached: number;
  createdAt: string;  // ISO date string
  status: "active" | "terminated";
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
      // Issue #45: Handle backwards compatibility for hierarchy fields
      // Old state files won't have these fields, so provide sensible defaults
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
        // Issue #45: Default hierarchy values for backwards compatibility
        parentAgentId: item.parentAgentId,
        childAgentIds: item.childAgentIds ?? [],
        nestingDepth: item.nestingDepth ?? 0,
        treeId: item.treeId ?? `tree-legacy-${item.id}`,
        // Issue #48: Session token (will be validated/re-signed after agent state loads)
        sessionToken: item.sessionToken,
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
        // Issue #45: Persist hierarchy tracking fields
        parentAgentId: metadata.parentAgentId,
        childAgentIds: metadata.childAgentIds,
        nestingDepth: metadata.nestingDepth,
        treeId: metadata.treeId,
        // Issue #48: Persist session token
        sessionToken: metadata.sessionToken,
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

// Issue #46: Load spawn tree state from disk on startup
async function loadTreeState(): Promise<void> {
  try {
    const data = await fs.readFile(TREES_STATE_FILE, "utf-8");
    let persisted: PersistedSpawnTree[];

    try {
      persisted = JSON.parse(data);
    } catch (parseError) {
      // JSON parse failed - back up corrupted file for debugging
      const backupFile = `${TREES_STATE_FILE}.corrupted.${Date.now()}`;
      console.error(`[pinocchio] Trees state file corrupted, backing up to: ${backupFile}`);
      try {
        await fs.copyFile(TREES_STATE_FILE, backupFile);
        await fs.chmod(backupFile, 0o600);
      } catch (backupError) {
        console.error(`[pinocchio] Warning: Could not create backup: ${backupError}`);
      }
      console.error(`[pinocchio] Starting with fresh tree state due to parse error: ${parseError}`);
      return;
    }

    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    for (const item of persisted) {
      const createdAt = new Date(item.createdAt);

      // Clean up old trees (older than 24 hours)
      if (now.getTime() - createdAt.getTime() > maxAge) {
        console.error(`[pinocchio] Cleaning up old tree metadata: ${item.treeId}`);
        continue;
      }

      // Restore tree with Date objects
      const tree: SpawnTree = {
        treeId: item.treeId,
        rootAgentId: item.rootAgentId,
        totalAgents: item.totalAgents,
        maxDepthReached: item.maxDepthReached,
        createdAt,
        status: item.status,
      };

      spawnTrees.set(item.treeId, tree);
    }

    console.error(`[pinocchio] Loaded ${spawnTrees.size} spawn tree(s) from state file`);
  } catch (error) {
    // File doesn't exist or is invalid - start fresh
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[pinocchio] Warning: Could not load tree state: ${error}`);
    }
  }
}

// Issue #46: Save spawn tree state to disk
// Called when tree state changes (create, update, terminate)
async function saveTreeState(): Promise<void> {
  try {
    const dir = path.dirname(TREES_STATE_FILE);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Convert Map to array with dates as ISO strings
    const persisted: PersistedSpawnTree[] = [];
    for (const [, tree] of spawnTrees) {
      persisted.push({
        treeId: tree.treeId,
        rootAgentId: tree.rootAgentId,
        totalAgents: tree.totalAgents,
        maxDepthReached: tree.maxDepthReached,
        createdAt: tree.createdAt.toISOString(),
        status: tree.status,
      });
    }

    // Use atomic write pattern (temp file + rename) to prevent corruption
    const tempFile = `${TREES_STATE_FILE}.tmp.${process.pid}`;
    await fs.writeFile(tempFile, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    await fs.chmod(tempFile, 0o600);
    await fs.rename(tempFile, TREES_STATE_FILE);
  } catch (error) {
    console.error(`[pinocchio] Warning: Could not save tree state: ${error}`);
  }
}

// Docker client
const docker = new Docker();

// Agent metadata for tracking
export interface AgentMetadata {
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

  // Issue #45: Hierarchy tracking for nested agent spawning
  parentAgentId?: string;        // ID of parent agent (undefined for root)
  childAgentIds: string[];       // IDs of spawned children
  nestingDepth: number;          // 0 for root, increments per level
  treeId: string;                // Unique ID for the entire spawn tree

  // Issue #48: Session token for nested agent authentication
  sessionToken?: string;         // The token string (stored separately in sessionTokens map)
}

// Issue #64: Child agent summary for get_agent_status response
export interface ChildAgentSummary {
  agentId: string;
  status: string;
  task: string;  // truncated to 80 chars
}

// Track running agents and their metadata
const runningAgents = new Map<string, Docker.Container>();
const agentMetadata = new Map<string, AgentMetadata>();

// Issue #46: SpawnTree tracks an entire hierarchy of spawned agents as a single unit
export interface SpawnTree {
  treeId: string;                        // Unique tree identifier (matches AgentMetadata.treeId)
  rootAgentId: string;                   // ID of the root agent that started this tree
  totalAgents: number;                   // Count of all agents in this tree (root + children)
  maxDepthReached: number;               // Highest nesting depth used in this tree
  createdAt: Date;                       // When the tree was created
  status: "active" | "terminated";       // Tree lifecycle status
}

// Issue #46: Track all spawn trees
const spawnTrees = new Map<string, SpawnTree>();

// Issue #46: Create a new spawn tree when a root agent is spawned
function createSpawnTree(rootAgentId: string, treeId: string): SpawnTree {
  const tree: SpawnTree = {
    treeId,
    rootAgentId,
    totalAgents: 1,        // Root agent counts as first agent
    maxDepthReached: 0,    // Root is at depth 0
    createdAt: new Date(),
    status: "active",
  };
  spawnTrees.set(treeId, tree);
  console.error(`[pinocchio] Created spawn tree: ${treeId} for root agent: ${rootAgentId}`);
  return tree;
}

// Issue #46: Get a spawn tree by ID
export function getSpawnTree(treeId: string): SpawnTree | undefined {
  return spawnTrees.get(treeId);
}

// Issue #51: Get agent metadata by ID (for session module)
export function getAgentMetadata(agentId: string): AgentMetadata | undefined {
  return agentMetadata.get(agentId);
}

// Issue #61: Get all agent metadata (for orphan detection)
export function getAllAgentMetadata(): Map<string, AgentMetadata> {
  return agentMetadata;
}

// Issue #46: Update tree agent count (delta can be positive or negative)
async function updateTreeAgentCount(treeId: string, delta: number): Promise<void> {
  const tree = spawnTrees.get(treeId);
  if (tree) {
    tree.totalAgents = Math.max(0, tree.totalAgents + delta);
    console.error(`[pinocchio] Tree ${treeId} agent count updated to: ${tree.totalAgents}`);
    await saveTreeState(); // Auto-persist changes
  }
}

// Issue #46: Update the maximum depth reached in a tree
async function updateTreeMaxDepth(treeId: string, depth: number): Promise<void> {
  const tree = spawnTrees.get(treeId);
  if (tree && depth > tree.maxDepthReached) {
    tree.maxDepthReached = depth;
    console.error(`[pinocchio] Tree ${treeId} max depth updated to: ${tree.maxDepthReached}`);
    await saveTreeState(); // Auto-persist changes
  }
}

// Issue #46: Mark a tree as terminated (all agents finished)
function terminateSpawnTree(treeId: string): void {
  const tree = spawnTrees.get(treeId);
  if (tree && tree.status === "active") {
    tree.status = "terminated";
    // Issue #48: Invalidate all session tokens for this tree
    // Tokens are no longer valid once a tree is terminated
    invalidateTokensForTree(treeId);
    // PR #86: Clean up tree buffer to prevent memory leak
    eventBus.clearTreeBuffer(treeId);
    console.error(`[pinocchio] Spawn tree terminated: ${treeId}`);
  }
}

// Issue #46: Get all agents belonging to a specific tree
function getAgentsByTree(treeId: string): AgentMetadata[] {
  const agents: AgentMetadata[] = [];
  for (const [, metadata] of agentMetadata) {
    if (metadata.treeId === treeId) {
      agents.push(metadata);
    }
  }
  return agents;
}

// Issue #46: Check if a tree should be terminated (all agents completed/failed)
function checkAndTerminateTree(treeId: string): void {
  const tree = spawnTrees.get(treeId);
  if (!tree || tree.status === "terminated") {
    return;
  }

  const agents = getAgentsByTree(treeId);
  const allDone = agents.every(a => a.status === "completed" || a.status === "failed");

  // Note: [].every() returns true for empty arrays, so orphaned trees
  // (trees with no agents due to cleanup timing) will also be terminated
  if (allDone) {
    terminateSpawnTree(treeId);
  }
}

// WebSocket server instance (initialized in main if enabled)
let wsServer: PinocchioWebSocket | null = null;

// Issue #50: Wrapper for validateSessionToken for WebSocket server
// Converts internal TokenValidationResult to the WebSocket module's format
function validateSessionTokenForHttp(tokenString: string): WsTokenValidationResult {
  const result = validateSessionToken(tokenString);
  if (!result.valid || !result.token) {
    return { valid: false, error: result.error };
  }
  // Map internal token to the websocket module's format (without signature)
  return {
    valid: true,
    token: {
      agentId: result.token.agentId,
      treeId: result.token.treeId,
      parentAgentId: result.token.parentAgentId,
      depth: result.token.depth,
      maxDepth: result.token.maxDepth,
      expiresAt: result.token.expiresAt,
      permissions: result.token.permissions,
    },
  };
}

// Issue #50: Spawn handler wrapper for WebSocket server
// Calls spawnDockerAgent and returns structured result for HTTP response
async function handleSpawnFromHttp(args: SpawnHandlerArgs): Promise<SpawnHandlerResult> {
  const startTime = Date.now();

  try {
    // Call spawnDockerAgent with run_in_background: false (blocking)
    const result = await spawnDockerAgent({
      task: args.task,
      workspace_path: args.workspace_path,
      writable_paths: args.writable_paths,
      timeout_ms: args.timeout_ms,
      parent_agent_id: args.parent_agent_id,
      run_in_background: false, // Always blocking for child spawns
    });

    // Parse the MCP response format
    if (result.isError) {
      // Extract error message from the structured response
      const errorText = result.content?.[0]?.text || 'Unknown error';
      // Try to extract a clean error message from the markdown
      const errorMatch = errorText.match(/\*\*Error:\*\*\s*(.+)/);
      return {
        success: false,
        error: errorMatch ? errorMatch[1] : errorText.slice(0, 500),
      };
    }

    // Extract data from successful response
    const responseText = result.content?.[0]?.text || '';

    // Parse exit code from the table format
    const exitCodeMatch = responseText.match(/\*\*Exit Code\*\*\s*\|\s*(\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;

    // Parse duration from the table format
    const durationMatch = responseText.match(/\*\*Duration\*\*\s*\|\s*([^\n|]+)/);
    let durationMs = Date.now() - startTime;
    if (durationMatch) {
      // Parse duration like "45.2s" or "1m 23s"
      const durationStr = durationMatch[1].trim();
      const seconds = parseFloat(durationStr.replace(/[ms]/g, '')) || 0;
      if (durationStr.includes('m')) {
        const parts = durationStr.match(/(\d+)m\s*(\d+\.?\d*)s/);
        if (parts) {
          durationMs = (parseInt(parts[1], 10) * 60 + parseFloat(parts[2])) * 1000;
        }
      } else {
        durationMs = seconds * 1000;
      }
    }

    // Parse agent ID from the header
    const agentIdMatch = responseText.match(/Agent\s+(claude-agent-\w+|[\w-]+)\s+(?:Completed|Failed)/);
    const agentId = agentIdMatch ? agentIdMatch[1] : 'unknown';

    // Parse files modified section
    const filesModified: string[] = [];
    const filesSection = responseText.match(/\*\*Files Modified:\*\*\n((?:- [^\n]+\n?)+)/);
    if (filesSection) {
      const fileLines = filesSection[1].split('\n');
      for (const line of fileLines) {
        const fileMatch = line.match(/^- (.+)$/);
        if (fileMatch) {
          filesModified.push(fileMatch[1].trim());
        }
      }
    }

    // Extract output from the details section
    let output = '';
    const outputMatch = responseText.match(/<details><summary>Full Output<\/summary>\n\n```\n([\s\S]*?)```\n<\/details>/);
    if (outputMatch) {
      output = outputMatch[1];
    }

    // Determine status based on exit code
    const status = exitCode === 0 ? 'completed' : 'failed';

    return {
      success: true,
      agent_id: agentId,
      status,
      exit_code: exitCode,
      output,
      duration_ms: durationMs,
      files_modified: filesModified.length > 0 ? filesModified : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pinocchio] handleSpawnFromHttp error: ${message}`);
    return {
      success: false,
      error: message,
    };
  }
}

// Issue #53: Tree info getter for WebSocket quota enforcement
function getTreeInfoForHttp(treeId: string): { treeId: string; totalAgents: number; status: 'active' | 'terminated' } | undefined {
  const tree = getSpawnTree(treeId);
  if (!tree) return undefined;
  return {
    treeId: tree.treeId,
    totalAgents: tree.totalAgents,
    status: tree.status,
  };
}

// Issue #53: Running agent counter for WebSocket quota enforcement
function getRunningAgentCountForHttp(): number {
  return runningAgents.size;
}

// Issue #53: Quota config getter for WebSocket quota enforcement
function getQuotaConfigForHttp(): { maxAgentsPerTree: number; maxConcurrentAgents: number } {
  // Load fresh config to get nested spawn settings
  // Note: We use synchronous defaults here since this is called frequently
  // and loadConfig() is async. The defaults match RATE_LIMIT and DEFAULT_NESTED_SPAWN_CONFIG
  return {
    maxAgentsPerTree: Number(process.env.MAX_AGENTS_PER_TREE) || DEFAULT_NESTED_SPAWN_CONFIG.maxAgentsPerTree,
    maxConcurrentAgents: Number(process.env.MAX_CONCURRENT_AGENTS) || 5,
  };
}

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
export async function cleanupTokenFile(tokenFilePath: string): Promise<void> {
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
  // SECURITY FIX #1.1: Reject if workspace path doesn't exist or is a broken symlink
  let realPath: string;
  try {
    realPath = await fs.realpath(workspacePath);
  } catch (error) {
    // SECURITY FIX #1.1: Reject non-existent paths and broken symlinks instead of falling back
    // A broken symlink or non-existent path could be a TOCTOU attack vector
    return {
      allowed: false,
      reason: `Workspace path does not exist or is a broken symlink: ${workspacePath}`
    };
  }

  const config = await loadConfig();

  // Block system paths
  for (const blocked of config.blockedPaths) {
    if (realPath === blocked || realPath.startsWith(blocked + "/")) {
      return { allowed: false, reason: `System path "${blocked}" is not allowed` };
    }
  }

  // Check allowlist - also resolve symlinks in allowlist entries for consistent comparison
  // SECURITY FIX #1.1: Skip allowlist entries that don't exist (broken symlinks)
  const isInAllowlist = await (async () => {
    for (const allowed of config.allowedWorkspaces) {
      let normalizedAllowed: string;
      try {
        normalizedAllowed = await fs.realpath(allowed);
      } catch {
        // SECURITY FIX #1.1: Skip this allowlist entry if it's a broken symlink or doesn't exist
        // Don't fall back to path.resolve() as it could enable attacks
        continue;
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
        // Phase 1 of network security improvements (Issue #25):
        // Network is now enabled by default because agents require access to Anthropic's API to function.
        // Future phases will implement more granular controls (e.g., "anthropic-only" mode).
        allow_network: {
          type: "boolean",
          description: "Allow the agent to access the network. Default: true (required for Anthropic API access). Set to false only for offline testing scenarios where the agent won't actually function.",
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
        // Issue #49: Internal parameter for nested spawning
        // This is used by the HTTP endpoint when agents spawn children, not for direct Claude Code use
        parent_agent_id: {
          type: "string",
          description: "Internal: Parent agent ID for nested spawning. Used by HTTP endpoint when agents spawn children.",
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
    description: `Get the status and output of a running or completed agent. Includes hierarchy info (treeId, depth, childAgentIds). Set include_children: true for detailed child agent summaries.

Returns:
- Current status (running/completed/failed)
- Task progress and logs
- Files modified (if completed)
- Duration and resource usage
- Agent hierarchy info (parent, tree, depth, children)

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
        include_children: {
          type: "boolean",
          description: "Include detailed status summaries of child agents (default: false)",
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
    description: `Manage Pinocchio configuration (workspaces, GitHub, settings, nested spawning, audit).

**Sections:**
- workspaces: Manage allowed workspace paths
- github: Configure GitHub access and credentials
- settings: View/modify general settings
- nestedspawn: Configure nested agent spawning limits
- audit: View audit logs

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
- settings.show: Display all settings

**Nested Spawn Actions:**
- nestedspawn.show: Display nested spawning configuration
- nestedspawn.set: Update nested spawn settings (use max_depth, max_agents, enable_recursive params)

**Audit Actions:**
- audit.recent: View the last 50 audit log entries`,
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
        // Issue #47: Parameters for nested spawn configuration
        max_depth: {
          type: "number",
          description: "Max nesting depth for spawned agents (for nestedspawn.set)",
        },
        max_agents: {
          type: "number",
          description: "Max agents per spawn tree (for nestedspawn.set)",
        },
        enable_recursive: {
          type: "boolean",
          description: "Enable recursive spawning (for nestedspawn.set)",
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
        // Issue #49: Internal parameter for nested spawning
        parent_agent_id?: string;
      });

    case "list_docker_agents":
      return await listDockerAgents();

    case "get_agent_status":
      return await getAgentStatus(args as { agent_id: string; tail_lines?: number; include_children?: boolean });

    case "stop_docker_agent":
      return await stopDockerAgent(args as { agent_id: string });

    case "manage_config":
      return await manageConfig(args as {
        action: string;
        path?: string;
        reason?: string;
        token?: string;
        default_access?: "none" | "read" | "comment" | "write" | "manage" | "admin";
        // Issue #47: Nested spawn config params
        max_depth?: number;
        max_agents?: number;
        enable_recursive?: boolean;
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
// SECURITY FIX #3: This function mitigates TOCTOU (Time-of-Check-Time-of-Use) race conditions:
// 1. Glob resolution uses `follow: false` to avoid following symlinks during pattern matching
// 2. All matched paths are resolved to their canonical form via fs.realpath() before validation
// 3. The resolved real paths (not symlinks) are returned and used for mount configuration
// This ensures that symlink-based attacks cannot bypass path validation between resolution and use.
async function resolveWritablePaths(
  workspacePath: string,
  explicitPaths: string[] = [],
  patterns: string[] = []
): Promise<{ paths: string[]; errors: string[] }> {
  const resolvedPaths = new Set<string>();
  const errors: string[] = [];

  // Add explicit paths (relative to workspace)
  // SECURITY FIX #3.1: Use fs.realpath() to resolve symlinks and reject on failure
  // This prevents TOCTOU attacks where symlinks could escape the workspace
  const realWorkspace = await fs.realpath(workspacePath).catch(() => {
    throw new Error(`Workspace path does not exist or is not accessible: ${workspacePath}`);
  });

  for (const p of explicitPaths) {
    // Check for path traversal in explicit paths
    if (p.includes("..")) {
      errors.push(`Path "${p}" contains parent directory traversal (..)`);
      continue;
    }
    const fullPath = path.join(workspacePath, p);

    // SECURITY FIX #3.1: Resolve symlinks in explicit paths using fs.realpath()
    // If the path exists, resolve it to catch symlink escapes
    // If it doesn't exist yet (agent might create it), use path.resolve() but verify parent exists
    let realFullPath: string;
    try {
      await fs.access(fullPath);
      // Path exists - resolve symlinks to get canonical path
      try {
        realFullPath = await fs.realpath(fullPath);
      } catch (realpathError) {
        // Path exists but realpath failed (broken symlink) - reject it
        errors.push(`Path "${p}" is a broken symlink and cannot be resolved`);
        continue;
      }
    } catch {
      // Path doesn't exist yet - that's OK, agent might create it
      // Use path.resolve() for validation, but verify parent directory is within workspace
      realFullPath = path.resolve(fullPath);
    }

    // Ensure resolved path is still within workspace
    if (!realFullPath.startsWith(realWorkspace + "/") && realFullPath !== realWorkspace) {
      errors.push(`Path "${p}" resolves outside workspace`);
      continue;
    }
    resolvedPaths.add(realFullPath);
  }

  // SECURITY FIX #7: Validate glob patterns before resolving
  for (const pattern of patterns) {
    const validation = validateGlobPattern(pattern);
    if (!validation.valid) {
      errors.push(validation.reason!);
      continue;
    }

    // SECURITY FIX #3: Don't follow symlinks during glob to prevent symlink-based attacks
    const matches = await glob(pattern, {
      cwd: workspacePath,
      absolute: true,
      nodir: false,
      follow: false,  // SECURITY FIX #3: Don't follow symlinks
    });
    for (const match of matches) {
      // SECURITY FIX #3: Use fs.realpath() to resolve symlinks and get canonical paths.
      // This prevents TOCTOU attacks where an attacker could create a symlink after
      // glob resolution but before the path is used. By resolving to the real path,
      // we ensure the security check validates the actual target, not the symlink.
      let realMatch: string;
      try {
        realMatch = await fs.realpath(match);
      } catch {
        // SECURITY FIX #3.2: Reject broken symlinks instead of falling back to path.resolve()
        // A broken symlink could be a security risk - it might be pointing to a path
        // that will be created later, potentially outside the workspace
        errors.push(`Path "${match}" is a broken symlink and cannot be resolved`);
        continue;
      }
      // realWorkspace is already resolved at the start of this function
      if (realMatch.startsWith(realWorkspace + "/") || realMatch === realWorkspace) {
        resolvedPaths.add(realMatch);  // SECURITY FIX #3: Store the resolved real path
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
  // Issue #49: Internal parameter for nested spawning
  parent_agent_id?: string;
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
    // AUDIT FIX #9: Log concurrent rate limit event
    await auditLog("rate_limit.concurrent", {
      requested_agent_id: agentId,
      current_running: runningAgents.size,
      pending_reservations: pendingReservations.size,
      max_concurrent: RATE_LIMIT.maxConcurrentAgents,
    });

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

    // AUDIT FIX #9: Log spawn rate limit event
    await auditLog("rate_limit.spawn", {
      requested_agent_id: agentId,
      recent_spawn_count: recentSpawnCount,
      max_spawns_per_minute: RATE_LIMIT.maxSpawnsPerMinute,
      wait_seconds: waitSeconds,
    });

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
    allow_network = true,  // Phase 1 (Issue #25): Default to true - agents need Anthropic API access
    writable_paths = [],
    writable_patterns = [],
    run_in_background = false,
  } = args;

  // Load config for GitHub settings
  const config = await loadConfig();
  const github_access = args.github_access || config.github?.defaultAccess || "none";

  // Issue #49: Load nested spawn configuration early for hierarchy validation
  const nestedSpawnConfig = getNestedSpawnConfig(config);

  // Issue #49: Handle nested spawning - validate parent agent and spawn constraints
  let parentMetadata: AgentMetadata | undefined;
  let parentTreeId: string | undefined;
  let nestingDepth = 0;

  if (args.parent_agent_id) {
    // Validate that recursive spawning is enabled
    if (!nestedSpawnConfig.enableRecursiveSpawn) {
      pendingReservations.delete(agentId);
      return {
        content: [{
          type: "text" as const,
          text: `## Nested Spawning Disabled\n\n**Error:** Recursive agent spawning is disabled in configuration.`,
        }],
        isError: true,
      };
    }

    // Validate parent agent exists
    parentMetadata = agentMetadata.get(args.parent_agent_id);
    if (!parentMetadata) {
      pendingReservations.delete(agentId);
      await auditLog("spawn.parent_not_found", {
        requested_agent_id: agentId,
        parent_agent_id: args.parent_agent_id,
      });
      return {
        content: [{
          type: "text" as const,
          text: `## Parent Agent Not Found\n\n**Error:** Parent agent '${args.parent_agent_id}' does not exist.`,
        }],
        isError: true,
      };
    }

    // Validate parent agent is still running
    if (parentMetadata.status !== 'running') {
      pendingReservations.delete(agentId);
      await auditLog("spawn.parent_not_running", {
        requested_agent_id: agentId,
        parent_agent_id: args.parent_agent_id,
        parent_status: parentMetadata.status,
      });
      return {
        content: [{
          type: "text" as const,
          text: `## Parent Agent Not Running\n\n**Error:** Parent agent '${args.parent_agent_id}' is no longer running (status: ${parentMetadata.status}).`,
        }],
        isError: true,
      };
    }

    // Calculate nesting depth for child
    nestingDepth = parentMetadata.nestingDepth + 1;
    parentTreeId = parentMetadata.treeId;

    // Validate depth limit
    if (nestingDepth > nestedSpawnConfig.maxNestingDepth) {
      pendingReservations.delete(agentId);
      await auditLog("spawn.depth_limit_exceeded", {
        requested_agent_id: agentId,
        parent_agent_id: args.parent_agent_id,
        requested_depth: nestingDepth,
        max_depth: nestedSpawnConfig.maxNestingDepth,
      });
      return {
        content: [{
          type: "text" as const,
          text: `## Maximum Nesting Depth Exceeded\n\n**Error:** Cannot spawn child agent at depth ${nestingDepth}. Maximum depth is ${nestedSpawnConfig.maxNestingDepth}.`,
        }],
        isError: true,
      };
    }

    // Validate tree agent limit
    const tree = getSpawnTree(parentTreeId);
    if (tree && tree.totalAgents >= nestedSpawnConfig.maxAgentsPerTree) {
      pendingReservations.delete(agentId);
      await auditLog("spawn.tree_limit_exceeded", {
        requested_agent_id: agentId,
        parent_agent_id: args.parent_agent_id,
        tree_id: parentTreeId,
        current_agents: tree.totalAgents,
        max_agents: nestedSpawnConfig.maxAgentsPerTree,
      });
      return {
        content: [{
          type: "text" as const,
          text: `## Maximum Agents Per Tree Exceeded\n\n**Error:** Cannot spawn child agent. The spawn tree already has ${tree.totalAgents} agents, maximum is ${nestedSpawnConfig.maxAgentsPerTree}.`,
        }],
        isError: true,
      };
    }

    console.error(`[pinocchio] Nested spawn: parent=${args.parent_agent_id}, tree=${parentTreeId}, depth=${nestingDepth}`);
  }

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

  // PR #32 FIX: Variables declared at function scope for proper cleanup in catch block
  let foregroundLogStream: NodeJS.ReadableStream | null = null;
  let foregroundDemuxer: DockerStreamDemultiplexer | null = null;

  // Issue #90 FIX: Variables declared at function scope for proper cleanup in catch block
  let treeId: string | null = null;
  let treeWritableDirsCreated = false;

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

    // Issue #90: Inject writable path guidance into task
    let taskWithGuidance = sanitizedTask;
    if (hasWritablePaths) {
      const relativePaths = resolvedWritablePaths.map(p => path.relative(workspace_path, p));
      taskWithGuidance += `\n\n[WRITABLE PATHS: Read from /workspace, write to /writable. Writable paths: ${relativePaths.map(p => '/writable/' + p).join(', ')}. Note: For git operations, work in /writable as /workspace is read-only.]`;
    }

    console.error(`[pinocchio] Starting agent: ${agentId}`);
    console.error(`[pinocchio] Workspace: ${workspace_path}`);
    console.error(`[pinocchio] Access mode: ${accessMode}`);
    console.error(`[pinocchio] Writable paths: ${resolvedWritablePaths.length > 0 ? resolvedWritablePaths.join(", ") : "(none)"}`);
    console.error(`[pinocchio] Timeout: ${timeout_ms}ms`);
    console.error(`[pinocchio] Docker access: ${allow_docker}`);
    console.error(`[pinocchio] Network access: ${allow_network}`);
    console.error(`[pinocchio] GitHub access: ${github_access}`);
    console.error(`[pinocchio] Task: ${sanitizedTask.slice(0, 100)}...`);

    // AUDIT FIX #9: Log agent spawn request
    await auditLog("agent.spawn", {
      task: sanitizedTask.slice(0, 500), // Truncate for audit log
      workspace: workspace_path,
      writable_paths_count: resolvedWritablePaths.length,
      timeout_ms,
      allow_docker,
      allow_network,
      github_access,
      run_in_background,
    }, agentId);

    // Build environment variables
    const envVars = [
      `AGENT_TASK=${taskWithGuidance}`,
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

    // Issue #46: Generate treeId for this root agent's spawn tree
    // Issue #49: For child agents, inherit the parent's treeId instead of generating a new one
    // NOTE: Moved before container creation so token can be injected into env vars
    treeId = parentTreeId ?? `tree-${crypto.randomUUID()}`;

    // Issue #48: Generate session token for this agent
    // Root agents get tokens that allow them to spawn children (if config permits)
    // Issue #49: Child agents also get tokens, with inherited hierarchy info
    // NOTE: Moved before container creation so token can be injected into env vars (Issue #57)
    const agentSessionToken = generateToken(
      agentId,
      treeId,
      args.parent_agent_id,  // parentAgentId (undefined for root agents)
      nestingDepth,          // 0 for root, parent.depth + 1 for children
      nestedSpawnConfig,
      timeout_ms,
      github_access !== "none"  // Inherit GitHub token permission if GitHub access is granted
    );
    storeSessionToken(agentSessionToken);

    // Issue #57: Inject spawn proxy environment variables if agent can spawn children
    if (nestedSpawnConfig.enableRecursiveSpawn &&
        nestingDepth < nestedSpawnConfig.maxNestingDepth) {
      // Inject spawn proxy configuration
      envVars.push(`PINOCCHIO_API_URL=http://mcp-server:3001`);
      envVars.push(`PINOCCHIO_SESSION_TOKEN=${agentSessionToken.token}`);
      // Pass host workspace path so child agents can be spawned with correct path
      envVars.push(`PINOCCHIO_HOST_WORKSPACE=${workspace_path}`);
      console.error(`[pinocchio] Injected spawn proxy env vars for agent: ${agentId}`);
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

    // Issue #90: Mount writable paths to /writable/{rel-path} with tree isolation
    if (resolvedWritablePaths.length > 0) {
      const relativePaths = resolvedWritablePaths.map(p => path.relative(workspace_path, p));
      await createTreeWritableDirs(treeId, relativePaths);
      treeWritableDirsCreated = true;

      for (const writablePath of resolvedWritablePaths) {
        const relativePath = path.relative(workspace_path, writablePath);
        const hostWritableDir = path.join(getTreeWritableDir(treeId), relativePath);
        const containerPath = path.posix.join("/writable", relativePath);
        binds.push(`${hostWritableDir}:${containerPath}:rw`);
      }

      envVars.push(`PINOCCHIO_WRITABLE_ROOT=/writable`);
      envVars.push(`PINOCCHIO_WRITABLE_PATHS=${relativePaths.join(':')}`);
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
    // Issue #45: Initialize hierarchy tracking fields for root agents
    // Note: treeId and agentSessionToken are now generated before container creation (Issue #57)
    const metadata: AgentMetadata = {
      id: agentId,
      task: sanitizedTask,
      workspacePath: workspace_path,
      writablePaths: resolvedWritablePaths,
      startedAt: new Date(),
      status: "running",
      tokenFilePath: tokenFilePath || undefined,
      // Issue #45/49: Hierarchy tracking - root agents have no parent, depth 0
      // Child agents inherit parent's treeId and set proper depth
      parentAgentId: args.parent_agent_id,
      childAgentIds: [],
      nestingDepth,
      treeId,
      // Issue #48: Store session token reference
      sessionToken: agentSessionToken.token,
    };
    agentMetadata.set(agentId, metadata);

    // Issue #49: For child agents, update parent's childAgentIds and tree agent count
    if (parentMetadata) {
      parentMetadata.childAgentIds.push(agentId);
      console.error(`[pinocchio] Added child ${agentId} to parent ${args.parent_agent_id}'s childAgentIds`);

      // Issue #46: Update tree agent count and max depth
      await updateTreeAgentCount(treeId, 1);
      await updateTreeMaxDepth(treeId, nestingDepth);

      // Audit log the nested spawn relationship
      await auditLog("spawn.nested", {
        child_agent_id: agentId,
        tree_id: treeId,
        nesting_depth: nestingDepth,
      }, args.parent_agent_id);
    } else {
      // Issue #46: Create a SpawnTree to track this root agent's hierarchy
      createSpawnTree(agentId, treeId);
    }

    // RELIABILITY FIX #4: Persist state when agent starts
    await saveAgentState();

    // Issue #46: Persist tree state when tree is created or updated
    await saveTreeState();

    // Issue #48: Persist token state when token is created
    await saveSessionTokenState();

    // Start the container
    await container.start();

    // AUDIT FIX #9: Log agent start event with container ID
    const containerInfo = await container.inspect();
    await auditLog("agent.start", {
      container_id: containerInfo.Id,
      image: CONFIG.imageName,
    }, agentId);

    // Emit agent.started event via WebSocket
    if (wsServer) {
      EventBus.getInstance().emitStarted(
        agentId,
        sanitizedTask.slice(0, 500),
        workspace_path,
        resolvedWritablePaths,
        { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth }
      );
    }

    // SECURITY FIX #5.1: Record spawn timestamp ONLY after successful container start.
    // This ensures failed attempts don't count against the rate limit.
    recordSpawnTimestamp(Date.now());

    // SECURITY FIX #5.1: Release the reservation now that the agent is tracked in runningAgents.
    pendingReservations.delete(agentId);

    // If background mode, return immediately
    if (run_in_background) {
      // Start background monitoring
      monitorAgent(agentId, container, timeout_ms);

      // Issue #49: Build response with optional hierarchy info for nested agents
      let responseText = `## 🚀 Agent Started (Background)\n\n` +
        `| Property | Value |\n` +
        `|----------|-------|\n` +
        `| **Agent ID** | \`${agentId}\` |\n` +
        `| **Workspace** | ${workspace_path} |\n` +
        `| **Access Mode** | ${accessMode} |\n` +
        `| **Timeout** | ${formatDuration(timeout_ms)} |\n`;

      // Add hierarchy info for nested agents
      if (args.parent_agent_id) {
        responseText += `| **Parent Agent** | \`${args.parent_agent_id}\` |\n` +
          `| **Nesting Depth** | ${nestingDepth} |\n` +
          `| **Tree ID** | \`${treeId}\` |\n`;
      }

      responseText += `\nUse \`get_agent_status(agent_id: "${agentId}")\` to check progress.`;

      return {
        content: [{
          type: "text" as const,
          text: responseText,
        }],
      };
    }

    // Foreground mode: stream logs in real-time while waiting for completion
    const eventBus = wsServer ? EventBus.getInstance() : null;

    // Progress tracking for foreground mode
    const foregroundProgressTracker = new ProgressTracker();
    let foregroundLastEmittedProgress = 0;

    // Start streaming logs in real-time (if WebSocket server is active)
    if (eventBus) {
      try {
        foregroundLogStream = await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          timestamps: true,
        }) as NodeJS.ReadableStream;

        // PR #32 FIX: Use proper demultiplexer for Docker stream parsing
        foregroundDemuxer = new DockerStreamDemultiplexer();

        foregroundLogStream.on('data', (chunk: Buffer) => {
          if (foregroundDemuxer && eventBus) {
            const messages = foregroundDemuxer.processChunk(chunk);
            const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
            emitLogMessages(agentId, messages, eventBus, hierarchy);

            // Process each log line for progress tracking
            for (const msg of messages) {
              const lines = msg.content.split('\n').filter(line => line.trim());
              for (const line of lines) {
                foregroundProgressTracker.processLogLine(line);
              }
            }

            // Emit progress event if progress changed by at least 5%
            const currentProgress = foregroundProgressTracker.getProgress();
            if (currentProgress - foregroundLastEmittedProgress >= 5) {
              eventBus.emitProgress(
                agentId,
                currentProgress,
                hierarchy,
                undefined,
                foregroundProgressTracker.getFilesModified()
              );
              foregroundLastEmittedProgress = currentProgress;
            }
          }
        });

        foregroundLogStream.on('error', (err) => {
          console.error(`[pinocchio] Foreground log stream error for ${agentId}:`, err.message);
        });
      } catch (logError) {
        console.error(`[pinocchio] Could not start foreground log streaming for ${agentId}:`, logError);
      }
    }

    // Wait for completion
    const result = await waitForContainer(container, timeout_ms);
    const endTime = new Date();
    const duration = endTime.getTime() - metadata.startedAt.getTime();

    // Clean up log stream and demultiplexer
    if (foregroundLogStream) {
      foregroundLogStream.removeAllListeners();
    }
    if (foregroundDemuxer) {
      foregroundDemuxer.clear();
    }

    // Get full logs for the final output
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

    // AUDIT FIX #9: Log agent completion or failure
    if (result.StatusCode === 0) {
      await auditLog("agent.complete", {
        exit_code: result.StatusCode,
        duration_ms: duration,
        files_modified: parsed.filesModified.length,
      }, agentId);

      // Emit final 100% progress event before completion
      const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
      if (wsServer) {
        EventBus.getInstance().emitProgress(agentId, 100, hierarchy, undefined, parsed.filesModified);
      }

      // Emit agent.completed event via WebSocket
      if (wsServer) {
        EventBus.getInstance().emitCompleted(agentId, result.StatusCode, output, duration, hierarchy, parsed.filesModified);
      }
    } else {
      await auditLog("agent.fail", {
        exit_code: result.StatusCode,
        duration_ms: duration,
        error: "Non-zero exit code",
      }, agentId);

      // Emit agent.failed event via WebSocket
      const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
      if (wsServer) {
        EventBus.getInstance().emitFailed(agentId, 'Non-zero exit code', result.StatusCode, hierarchy, output);
      }
    }

    // Issue #48: Invalidate session token for this agent
    if (metadata.sessionToken) {
      invalidateSessionToken(metadata.sessionToken);
    }
    invalidateTokensForAgent(agentId);

    // RELIABILITY FIX #4: Persist state when agent completes
    await saveAgentState();

    // Issue #46: Check if the tree should be terminated and persist tree state
    checkAndTerminateTree(metadata.treeId);
    await saveTreeState();

    // Issue #48: Persist token state after invalidation
    await saveSessionTokenState();

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

    // PR #32 FIX: Clean up foreground log stream and demultiplexer on error
    // This prevents memory leaks if waitForContainer() throws
    if (foregroundLogStream) {
      foregroundLogStream.removeAllListeners();
    }
    if (foregroundDemuxer) {
      foregroundDemuxer.clear();
    }

    // Clean up on error
    runningAgents.delete(agentId);
    const metadata = agentMetadata.get(agentId);
    if (metadata) {
      // Issue #48: Invalidate session token for this agent
      if (metadata.sessionToken) {
        invalidateSessionToken(metadata.sessionToken);
      }
      invalidateTokensForAgent(agentId);

      metadata.status = "failed";
      metadata.endedAt = new Date();
      // RELIABILITY FIX #4: Persist state when agent fails
      await saveAgentState();

      // Issue #46: Check if the tree should be terminated and persist tree state
      checkAndTerminateTree(metadata.treeId);
      await saveTreeState();

      // Issue #48: Persist token state after invalidation
      await saveSessionTokenState();
    }

    // SECURITY FIX #8: Clean up token file on error
    // Use the local variable since metadata may not have been set yet
    if (tokenFilePath) {
      await cleanupTokenFile(tokenFilePath);
    }

    // Clean up tree writable dirs if spawn fails
    if (treeWritableDirsCreated && treeId) {
      await cleanupTreeWritableDir(treeId).catch(() => {});
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    // AUDIT FIX #9: Log agent failure with error message
    await auditLog("agent.fail", {
      error: errorMessage,
      phase: "startup",
    }, agentId);

    // Emit agent.failed event via WebSocket
    if (wsServer && metadata) {
      const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
      EventBus.getInstance().emitFailed(agentId, errorMessage, -1, hierarchy);
    }

    return {
      content: [{
        type: "text" as const,
        text: `## ❌ Agent ${agentId} Failed\n\n**Error:** ${errorMessage}`,
      }],
      isError: true,
    };
  }
}

// Monitor a background agent with real-time log streaming
async function monitorAgent(agentId: string, container: Docker.Container, timeout: number) {
  const metadata = agentMetadata.get(agentId);
  if (!metadata) return;

  // Get the event bus for emitting log events (only if WebSocket server is active)
  const eventBus = wsServer ? EventBus.getInstance() : null;

  // Progress tracking: track last emitted progress to throttle events (emit only on >=5% change)
  const progressTracker = new ProgressTracker();
  let lastEmittedProgress = 0;

  // Stream logs in real-time
  // PR #32 FIX: Use proper demultiplexer for Docker stream parsing
  let logStream: NodeJS.ReadableStream | null = null;
  let demuxer: DockerStreamDemultiplexer | null = null;
  try {
    logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
    }) as NodeJS.ReadableStream;

    // PR #32 FIX: Use proper demultiplexer for Docker stream parsing
    demuxer = new DockerStreamDemultiplexer();

    logStream.on('data', (chunk: Buffer) => {
      if (demuxer && eventBus) {
        const messages = demuxer.processChunk(chunk);
        const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
        emitLogMessages(agentId, messages, eventBus, hierarchy);

        // Process each log line for progress tracking
        for (const msg of messages) {
          const lines = msg.content.split('\n').filter(line => line.trim());
          for (const line of lines) {
            progressTracker.processLogLine(line);
          }
        }

        // Emit progress event if progress changed by at least 5%
        const currentProgress = progressTracker.getProgress();
        if (currentProgress - lastEmittedProgress >= 5) {
          eventBus.emitProgress(
            agentId,
            currentProgress,
            hierarchy,
            undefined,
            progressTracker.getFilesModified()
          );
          lastEmittedProgress = currentProgress;
        }
      }
    });

    logStream.on('error', (err) => {
      console.error(`[pinocchio] Log stream error for ${agentId}:`, err.message);
    });
  } catch (logError) {
    // Log streaming failed but we can still monitor the container
    console.error(`[pinocchio] Could not start log streaming for ${agentId}:`, logError);
  }

  try {
    const result = await waitForContainer(container, timeout);

    // Clean up log stream and demultiplexer (stream ends naturally when container stops, but be explicit)
    if (logStream) {
      logStream.removeAllListeners();
    }
    if (demuxer) {
      demuxer.clear();
    }

    metadata.status = result.StatusCode === 0 ? "completed" : "failed";
    metadata.exitCode = result.StatusCode;
    metadata.endedAt = new Date();

    // Get and store output
    const logs = await container.logs({ stdout: true, stderr: true, follow: false });
    metadata.output = logs.toString("utf-8");

    // AUDIT FIX #9: Log background agent completion or failure
    const duration_ms = metadata.endedAt.getTime() - metadata.startedAt.getTime();
    const parsed = parseAgentOutput(metadata.output);
    if (result.StatusCode === 0) {
      await auditLog("agent.complete", {
        exit_code: result.StatusCode,
        duration_ms,
        files_modified: parsed.filesModified.length,
        background: true,
      }, agentId);

      // Emit final 100% progress event before completion
      const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
      if (wsServer) {
        EventBus.getInstance().emitProgress(agentId, 100, hierarchy, undefined, parsed.filesModified);
      }

      // Emit agent.completed event via WebSocket for background agents
      if (wsServer) {
        EventBus.getInstance().emitCompleted(agentId, result.StatusCode, metadata.output, duration_ms, hierarchy, parsed.filesModified);
      }
    } else {
      await auditLog("agent.fail", {
        exit_code: result.StatusCode,
        duration_ms,
        error: "Non-zero exit code",
        background: true,
      }, agentId);

      // Emit agent.failed event via WebSocket for background agents
      const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
      if (wsServer) {
        EventBus.getInstance().emitFailed(agentId, 'Non-zero exit code', result.StatusCode, hierarchy, metadata.output);
      }
    }

    // Issue #48: Invalidate session token for this agent
    if (metadata.sessionToken) {
      invalidateSessionToken(metadata.sessionToken);
    }
    invalidateTokensForAgent(agentId);

    // RELIABILITY FIX #4: Persist state when background agent completes
    await saveAgentState();

    // Issue #46: Check if the tree should be terminated and persist tree state
    checkAndTerminateTree(metadata.treeId);
    await saveTreeState();

    // Issue #48: Persist token state after invalidation
    await saveSessionTokenState();

    // SECURITY FIX #8: Clean up token file after container completes
    if (metadata.tokenFilePath) {
      await cleanupTokenFile(metadata.tokenFilePath);
    }

    // Clean up container
    try {
      await container.remove({ force: true });
    } catch (e) {
      // Ignore
    }
    runningAgents.delete(agentId);
  } catch (error) {
    // Clean up log stream and demultiplexer on error
    if (logStream) {
      logStream.removeAllListeners();
    }
    if (demuxer) {
      demuxer.clear();
    }

    metadata.status = "failed";
    metadata.endedAt = new Date();
    metadata.output = `Error: ${error instanceof Error ? error.message : String(error)}`;

    // AUDIT FIX #9: Log background agent failure
    const duration_ms = metadata.endedAt.getTime() - metadata.startedAt.getTime();
    const errorMessage = error instanceof Error ? error.message : String(error);
    await auditLog("agent.fail", {
      error: errorMessage,
      duration_ms,
      background: true,
    }, agentId);

    // Emit agent.failed event via WebSocket for background agent errors
    const hierarchy = { parentAgentId: metadata.parentAgentId, treeId: metadata.treeId, depth: metadata.nestingDepth };
    if (wsServer) {
      EventBus.getInstance().emitFailed(agentId, errorMessage, -1, hierarchy, metadata.output);
    }

    // Issue #48: Invalidate session token for this agent
    if (metadata.sessionToken) {
      invalidateSessionToken(metadata.sessionToken);
    }
    invalidateTokensForAgent(agentId);

    // RELIABILITY FIX #4: Persist state when background agent fails
    await saveAgentState();

    // Issue #46: Check if the tree should be terminated and persist tree state
    checkAndTerminateTree(metadata.treeId);
    await saveTreeState();

    // Issue #48: Persist token state after invalidation
    await saveSessionTokenState();

    // SECURITY FIX #8: Clean up token file even on error
    if (metadata.tokenFilePath) {
      await cleanupTokenFile(metadata.tokenFilePath);
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

// Issue #64: Helper function to get child agent summaries
function getChildAgentSummaries(childIds: string[]): ChildAgentSummary[] {
  return childIds.map(childId => {
    const childMeta = agentMetadata.get(childId);
    if (!childMeta) {
      return {
        agentId: childId,
        status: "unknown",
        task: "(metadata not found)",
      };
    }
    return {
      agentId: childId,
      status: childMeta.status,
      task: childMeta.task.slice(0, 80) + (childMeta.task.length > 80 ? "..." : ""),
    };
  });
}

// Get agent status and output
async function getAgentStatus(args: { agent_id: string; tail_lines?: number; include_children?: boolean }) {
  const { agent_id, tail_lines = 100, include_children = false } = args;

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

  // Issue #64: Build hierarchy info section for nested agents (always include these fields)
  const hierarchySection =
    `| **Tree ID** | \`${metadata.treeId}\` |\n` +
    `| **Nesting Depth** | ${metadata.nestingDepth} |\n` +
    (metadata.parentAgentId ? `| **Parent Agent** | \`${metadata.parentAgentId}\` |\n` : "") +
    `| **Child Count** | ${metadata.childAgentIds.length} |\n` +
    (metadata.childAgentIds.length > 0
      ? `| **Child Agent IDs** | ${metadata.childAgentIds.map(id => `\`${id}\``).join(", ")} |\n`
      : "");

  // Issue #64: Build child agent summaries section if requested
  let childSummariesSection = "";
  if (include_children && metadata.childAgentIds.length > 0) {
    const childSummaries = getChildAgentSummaries(metadata.childAgentIds);
    childSummariesSection = "\n**Child Agent Details:**\n" +
      "| Agent ID | Status | Task |\n" +
      "|----------|--------|------|\n" +
      childSummaries.map(child =>
        `| \`${child.agentId}\` | ${child.status} | ${child.task} |`
      ).join("\n") + "\n";
  }

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
        hierarchySection +
        `| **Task** | ${metadata.task.slice(0, 80)}${metadata.task.length > 80 ? "..." : ""} |\n` +
        filesSection +
        childSummariesSection +
        `\n**Output** (last ${tail_lines} lines):\n\`\`\`\n${displayOutput}\n\`\`\``,
    }],
  };
}

// Issue #58: Helper function to update agent metadata for cascade termination
async function updateAgentMetadataForTermination(
  agentId: string,
  status: "failed",
  output: string
): Promise<void> {
  const metadata = agentMetadata.get(agentId);
  if (metadata && metadata.status === "running") {
    metadata.status = status;
    metadata.endedAt = new Date();
    metadata.output = (metadata.output || "") + "\n" + output;
  }
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
    const metadata = agentMetadata.get(agent_id);

    // Issue #58: Check if this agent has children and use cascade termination
    if (metadata && metadata.childAgentIds.length > 0) {
      console.error(`[pinocchio] Agent ${agent_id} has ${metadata.childAgentIds.length} children, using cascade termination`);

      const cascadeResult = await terminateWithChildren(
        agent_id,
        "SIGTERM",
        updateAgentMetadataForTermination,
        runningAgents
      );

      // Persist state after cascade termination
      await saveAgentState();

      // Issue #46: Check if the tree should be terminated
      checkAndTerminateTree(metadata.treeId);
      await saveTreeState();

      // Issue #48: Persist token state after invalidation
      await saveSessionTokenState();

      // AUDIT FIX #9: Log agent stop event with cascade info
      const duration_ms = metadata.endedAt
        ? metadata.endedAt.getTime() - metadata.startedAt.getTime()
        : undefined;
      await auditLog("agent.stop", {
        stopped_by: "user",
        duration_ms,
        cascade: true,
        terminated_count: cascadeResult.terminated.length,
        failed_count: cascadeResult.failed.length,
      }, agent_id);

      // Build response with cascade information
      const failedInfo = cascadeResult.failed.length > 0
        ? `\n\n**Failed to terminate:**\n${cascadeResult.failed.map(f => `- ${f.agentId}: ${f.error}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `## 🔗 Cascade Termination Complete\n\n` +
              `**Root Agent:** ${agent_id}\n` +
              `**Agents Terminated:** ${cascadeResult.terminated.length}\n` +
              `**Terminated IDs:** ${cascadeResult.terminated.map(id => `\`${id}\``).join(", ")}` +
              failedInfo,
          },
        ],
      };
    }

    // No children - use original single-agent termination logic
    const container = docker.getContainer(agent_id);
    await container.stop();
    await container.remove({ force: true });
    runningAgents.delete(agent_id);

    // RELIABILITY FIX #4: Update and persist metadata when agent is manually stopped
    let duration_ms: number | undefined;
    if (metadata && metadata.status === "running") {
      metadata.status = "failed";
      metadata.endedAt = new Date();
      metadata.output = (metadata.output || "") + "\n[pinocchio] Agent manually stopped by user";
      duration_ms = metadata.endedAt.getTime() - metadata.startedAt.getTime();

      // Issue #48: Invalidate session token for this agent
      if (metadata.sessionToken) {
        invalidateSessionToken(metadata.sessionToken);
      }
      invalidateTokensForAgent(agent_id);

      await saveAgentState();

      // Issue #46: Check if the tree should be terminated and persist tree state
      checkAndTerminateTree(metadata.treeId);
      await saveTreeState();

      // Issue #48: Persist token state after invalidation
      await saveSessionTokenState();
    }

    // AUDIT FIX #9: Log agent stop event
    await auditLog("agent.stop", {
      stopped_by: "user",
      duration_ms,
    }, agent_id);

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
  // Issue #47: Nested spawn config params
  max_depth?: number;
  max_agents?: number;
  enable_recursive?: boolean;
}) {
  const { action, path: workspacePath, reason, token, default_access, max_depth, max_agents, enable_recursive } = args;
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

        // AUDIT FIX #9: Log workspace proposal
        await auditLog("workspace.propose", {
          path: realPath,
          reason: reason || null,
        });

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
        const wasPending = pendingIndex !== -1;

        if (wasPending) {
          config.pendingApprovals.splice(pendingIndex, 1);
        }

        if (!config.allowedWorkspaces.includes(realPath)) {
          config.allowedWorkspaces.push(realPath);
          await saveConfig(config);

          // AUDIT FIX #9: Log workspace approval
          await auditLog("workspace.approve", {
            path: realPath,
            was_pending: wasPending,
          });

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

        // AUDIT FIX #9: Log workspace rejection
        await auditLog("workspace.reject", {
          path: realPath,
        });

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

        // AUDIT FIX #9: Log workspace removal
        await auditLog("workspace.remove", {
          path: realPath,
        });

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

        // AUDIT FIX #9: Log that token was set (NOT the token value itself!)
        await auditLog("github.set_token", {
          token_length: token.length,
        });

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

        // AUDIT FIX #9: Log default access level change
        await auditLog("github.set_default", {
          default_access,
        });

        return { content: [{ type: "text" as const, text: `✅ **Default GitHub access set to:** ${default_access}` }] };
      }
    }
  }

  // Handle settings actions
  if (section === "settings" && subaction === "show") {
    const hasGhToken = !!config.github?.token;
    const ghDefault = config.github?.defaultAccess || "none";
    // Issue #47: Include nested spawn config in settings display
    const nestedSpawn = getNestedSpawnConfig(config);

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
          `**🔄 Nested Spawning:**\n` +
          `- Max depth: ${nestedSpawn.maxNestingDepth}\n` +
          `- Max agents per tree: ${nestedSpawn.maxAgentsPerTree}\n` +
          `- Recursive spawn: ${nestedSpawn.enableRecursiveSpawn ? "enabled" : "disabled"}\n\n` +
          `**Config file:** ~/.config/pinocchio/config.json`,
      }],
    };
  }

  // Issue #47: Handle nested spawn actions
  if (section === "nestedspawn") {
    switch (subaction) {
      case "show": {
        const nestedSpawn = getNestedSpawnConfig(config);
        const envOverrides: string[] = [];
        if (process.env.MAX_NESTING_DEPTH) envOverrides.push("MAX_NESTING_DEPTH");
        if (process.env.MAX_AGENTS_PER_TREE) envOverrides.push("MAX_AGENTS_PER_TREE");
        if (process.env.ENABLE_RECURSIVE_SPAWN) envOverrides.push("ENABLE_RECURSIVE_SPAWN");

        return {
          content: [{
            type: "text" as const,
            text: `## 🔄 Nested Spawn Configuration\n\n` +
              `| Setting | Value | Default |\n` +
              `|---------|-------|--------|\n` +
              `| **Max Nesting Depth** | ${nestedSpawn.maxNestingDepth} | ${DEFAULT_NESTED_SPAWN_CONFIG.maxNestingDepth} |\n` +
              `| **Max Agents Per Tree** | ${nestedSpawn.maxAgentsPerTree} | ${DEFAULT_NESTED_SPAWN_CONFIG.maxAgentsPerTree} |\n` +
              `| **Recursive Spawn** | ${nestedSpawn.enableRecursiveSpawn ? "enabled" : "disabled"} | ${DEFAULT_NESTED_SPAWN_CONFIG.enableRecursiveSpawn ? "enabled" : "disabled"} |\n\n` +
              (envOverrides.length > 0
                ? `**Active Environment Overrides:** ${envOverrides.join(", ")}\n\n`
                : "") +
              `**Description:**\n` +
              `- \`maxNestingDepth\`: Maximum depth of spawning (1 = only direct spawns)\n` +
              `- \`maxAgentsPerTree\`: Maximum total agents in a single spawn tree\n` +
              `- \`enableRecursiveSpawn\`: Whether agents can spawn other agents at all`,
          }],
        };
      }

      case "set": {
        // Validate that at least one parameter is provided
        if (max_depth === undefined && max_agents === undefined && enable_recursive === undefined) {
          return {
            content: [{
              type: "text" as const,
              text: `**Error:** At least one parameter is required: max_depth, max_agents, or enable_recursive`,
            }],
            isError: true,
          };
        }

        // Initialize nestedSpawn in config if not present
        config.nestedSpawn = config.nestedSpawn || { ...DEFAULT_NESTED_SPAWN_CONFIG };

        // Apply updates
        const updates: string[] = [];
        if (max_depth !== undefined) {
          if (max_depth < 1) {
            return {
              content: [{
                type: "text" as const,
                text: `**Error:** max_depth must be >= 1, got ${max_depth}`,
              }],
              isError: true,
            };
          }
          config.nestedSpawn.maxNestingDepth = max_depth;
          updates.push(`maxNestingDepth: ${max_depth}`);
        }

        if (max_agents !== undefined) {
          if (max_agents < 1) {
            return {
              content: [{
                type: "text" as const,
                text: `**Error:** max_agents must be >= 1, got ${max_agents}`,
              }],
              isError: true,
            };
          }
          config.nestedSpawn.maxAgentsPerTree = max_agents;
          updates.push(`maxAgentsPerTree: ${max_agents}`);
        }

        if (enable_recursive !== undefined) {
          config.nestedSpawn.enableRecursiveSpawn = enable_recursive;
          updates.push(`enableRecursiveSpawn: ${enable_recursive}`);
        }

        await saveConfig(config);

        // Audit log the change
        await auditLog("nestedspawn.set", {
          updates: updates,
          new_config: config.nestedSpawn,
        });

        return {
          content: [{
            type: "text" as const,
            text: `✅ **Nested spawn configuration updated**\n\nChanges:\n${updates.map(u => `- ${u}`).join("\n")}`,
          }],
        };
      }
    }
  }

  // AUDIT FIX #9: Handle audit actions
  if (section === "audit" && subaction === "recent") {
    try {
      const data = await fs.readFile(AUDIT_LOG_FILE, "utf-8");
      const lines = data.trim().split("\n");

      // Get last 50 entries
      const recentLines = lines.slice(-50);
      const events: AuditEvent[] = [];

      for (const line of recentLines) {
        if (line.trim()) {
          try {
            events.push(JSON.parse(line));
          } catch {
            // Skip malformed lines
          }
        }
      }

      if (events.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `## 📋 Audit Log\n\nNo audit events found.`,
          }],
        };
      }

      // Format events for display
      const formatted = events.map(e => {
        const agentPart = e.agentId ? ` [${e.agentId}]` : "";
        const dataPart = Object.keys(e.data).length > 0
          ? ` ${JSON.stringify(e.data)}`
          : "";
        return `${e.timestamp} ${e.event}${agentPart}${dataPart}`;
      }).join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `## 📋 Audit Log (last ${events.length} entries)\n\n\`\`\`\n${formatted}\n\`\`\`\n\n**Log file:** ~/.config/pinocchio/audit.jsonl`,
        }],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: [{
            type: "text" as const,
            text: `## 📋 Audit Log\n\nNo audit log file found. Events will be logged as operations occur.`,
          }],
        };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text" as const,
          text: `## 📋 Audit Log\n\n**Error reading audit log:** ${errorMessage}`,
        }],
        isError: true,
      };
    }
  }

  return {
    content: [{
      type: "text" as const,
      text: `**Error:** Unknown action "${action}"\n\nValid actions:\n` +
        `- workspaces.list, workspaces.propose, workspaces.approve, workspaces.reject, workspaces.remove\n` +
        `- github.show, github.set_token, github.remove_token, github.set_default\n` +
        `- settings.show\n` +
        `- nestedspawn.show, nestedspawn.set\n` +
        `- audit.recent`,
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

  // Issue #46: Check and terminate all affected trees, then persist tree state
  const affectedTreeIds = new Set<string>();
  for (const { agentId } of containersToStop) {
    const metadata = agentMetadata.get(agentId);
    if (metadata) {
      affectedTreeIds.add(metadata.treeId);
    }
  }
  for (const treeId of affectedTreeIds) {
    checkAndTerminateTree(treeId);
  }
  await saveTreeState();

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

  // Close WebSocket server if running
  if (wsServer) {
    console.error("[pinocchio] Closing WebSocket server...");
    await wsServer.close();
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

  // Issue #46: Load persisted spawn tree state on startup
  await loadTreeState();

  // Issue #51: Initialize session manager with dependencies from index.ts
  initSessionManager({
    getSpawnTree: (treeId) => getSpawnTree(treeId),
    getAgentMetadata: (agentId) => getAgentMetadata(agentId),
    auditLog,
  });

  // Issue #48: Load persisted session token state on startup
  // Note: Tokens are re-signed with new server secret for running agents
  await loadSessionTokenState();

  // Issue #48: Start periodic token cleanup
  startTokenCleanup();

  // SECURITY FIX #8.1: Clean up any stale token files from previous sessions.
  // This handles cases where the MCP server was killed (SIGKILL) or crashed
  // without proper cleanup, leaving token files in /tmp/pinocchio-tokens/.
  await cleanupStaleTokenFiles();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pinocchio] Server started");

  // Initialize WebSocket server if enabled
  const config = await loadConfig();
  if (config.websocket?.enabled) {
    wsServer = new PinocchioWebSocket(config.websocket);
    try {
      // Issue #50: Register handlers for HTTP spawn endpoint
      wsServer.setSpawnHandler(handleSpawnFromHttp);
      wsServer.setTokenValidator(validateSessionTokenForHttp);

      // Issue #53: Register quota enforcement handlers
      wsServer.setTreeInfoGetter(getTreeInfoForHttp);
      wsServer.setRunningAgentCounter(getRunningAgentCountForHttp);
      wsServer.setQuotaConfigGetter(getQuotaConfigForHttp);

      wsServer.start();
      console.error('[pinocchio] WebSocket server started on port', config.websocket.port);
    } catch (error) {
      console.error('[pinocchio] Failed to start WebSocket server:', error);
    }
  }
}

main().catch((error) => {
  console.error("[pinocchio] Fatal error:", error);
  process.exit(1);
});
