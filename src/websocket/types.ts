/**
 * WebSocket Types for Pinocchio MCP Server
 * Issue #27: Real-time agent event streaming
 */

// ============================================================================
// Configuration
// ============================================================================

export interface WebSocketConfig {
  enabled: boolean;
  port: number;
  unixSocket?: string;
  bindAddress: string;
  auth: 'none' | 'api-key';
  apiKey?: string;
  subscriptionPolicy: 'open' | 'owner-only' | 'token-based';
  bufferSize: number;
  tls?: {
    cert: string;  // Path to certificate file
    key: string;   // Path to key file
  };
}

export const DEFAULT_WEBSOCKET_CONFIG: WebSocketConfig = {
  enabled: true,
  port: 3001,
  bindAddress: '127.0.0.1',
  auth: 'none',
  subscriptionPolicy: 'open',
  bufferSize: 1000,
};

// ============================================================================
// Agent Event Types
// ============================================================================

export type AgentEventType =
  | 'agent.started'
  | 'agent.log'
  | 'agent.progress'
  | 'agent.completed'
  | 'agent.failed';

export interface BaseAgentEvent {
  type: AgentEventType;
  agentId: string;
  timestamp: string;
}

export interface AgentStartedEvent extends BaseAgentEvent {
  type: 'agent.started';
  data: {
    task: string;
    workspace: string;
  };
}

export interface AgentLogEvent extends BaseAgentEvent {
  type: 'agent.log';
  data: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    metadata?: Record<string, unknown>;
  };
}

export interface AgentProgressEvent extends BaseAgentEvent {
  type: 'agent.progress';
  data: {
    progress: number; // 0-100
    message?: string;
    filesModified?: string[];
  };
}

export interface AgentCompletedEvent extends BaseAgentEvent {
  type: 'agent.completed';
  data: {
    exitCode: number;
    duration: number;
    filesModified: string[];
  };
}

export interface AgentFailedEvent extends BaseAgentEvent {
  type: 'agent.failed';
  data: {
    exitCode?: number;
    error: string;
    duration?: number;
  };
}

export type AgentEvent =
  | AgentStartedEvent
  | AgentLogEvent
  | AgentProgressEvent
  | AgentCompletedEvent
  | AgentFailedEvent;

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SubscribeMessage {
  type: 'subscribe';
  agentId: string; // '*' for all agents
  logLevels?: LogLevel[]; // Optional filter, defaults to all levels
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  agentId: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

// ============================================================================
// Server -> Client Messages
// ============================================================================

export interface SubscribedMessage {
  type: 'subscribed';
  agentId: string;
}

export interface UnsubscribedMessage {
  type: 'unsubscribed';
  agentId: string;
}

export interface ErrorMessage {
  type: 'error';
  code: number;
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export interface EventMessage {
  type: 'event';
  event: AgentEvent;
}

export type ServerMessage =
  | SubscribedMessage
  | UnsubscribedMessage
  | ErrorMessage
  | PongMessage
  | EventMessage;

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  INVALID_MESSAGE: 4001,
  AGENT_NOT_FOUND: 4002,
  UNAUTHORIZED: 4003,
  RATE_LIMITED: 4004,
  SUBSCRIPTION_DENIED: 4005,
  INTERNAL_ERROR: 4006,
  CONNECTION_TIMEOUT: 4007,
} as const;

// ============================================================================
// Type Guards
// ============================================================================

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function isValidLogLevels(levels: unknown): levels is LogLevel[] {
  if (!Array.isArray(levels)) return false;
  return levels.every(
    (level) => typeof level === 'string' && VALID_LOG_LEVELS.has(level)
  );
}

export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type === 'ping') return true;
  if (msg.type === 'unsubscribe') {
    return typeof msg.agentId === 'string' && msg.agentId.length > 0;
  }
  if (msg.type === 'subscribe') {
    if (typeof msg.agentId !== 'string' || msg.agentId.length === 0) {
      return false;
    }
    // logLevels is optional, but if provided must be valid
    if (msg.logLevels !== undefined && !isValidLogLevels(msg.logLevels)) {
      return false;
    }
    return true;
  }
  return false;
}

export function isAgentEvent(data: unknown): data is AgentEvent {
  if (typeof data !== 'object' || data === null) return false;
  const event = data as Record<string, unknown>;
  return (
    typeof event.type === 'string' &&
    event.type.startsWith('agent.') &&
    typeof event.agentId === 'string' &&
    typeof event.timestamp === 'string'
  );
}

// ============================================================================
// Issue #50: HTTP Spawn Endpoint Types
// ============================================================================

/**
 * Request body for POST /api/v1/spawn
 */
export interface SpawnRequest {
  task: string;
  workspace_path?: string;
  writable_paths?: string[];
  timeout_ms?: number;
}

/**
 * Successful response from POST /api/v1/spawn
 */
export interface SpawnResponse {
  agent_id: string;
  status: 'completed' | 'failed' | 'timeout';
  exit_code: number;
  output: string;
  duration_ms: number;
  files_modified?: string[];
  error?: string;
}

/**
 * Error response from POST /api/v1/spawn
 */
export interface SpawnErrorResponse {
  error: string;
}

/**
 * Session token with permissions (simplified view for HTTP handler)
 */
export interface SessionTokenInfo {
  agentId: string;
  treeId: string;
  parentAgentId?: string;
  depth: number;
  maxDepth: number;
  expiresAt: number;
  permissions: {
    canSpawn: boolean;
    inheritGitHubToken: boolean;
  };
}

/**
 * Result of session token validation
 */
export interface TokenValidationResult {
  valid: boolean;
  token?: SessionTokenInfo;
  error?: string;
}

/**
 * Internal spawn arguments passed to the spawn handler
 */
export interface SpawnHandlerArgs {
  task: string;
  workspace_path: string;
  writable_paths?: string[];
  timeout_ms?: number;
  parent_agent_id: string;
  // Child spawns are always blocking (background: false)
}

/**
 * Result from the spawn handler
 */
export interface SpawnHandlerResult {
  success: boolean;
  agent_id?: string;
  status?: 'completed' | 'failed' | 'timeout';
  exit_code?: number;
  output?: string;
  duration_ms?: number;
  files_modified?: string[];
  error?: string;
}

/**
 * Handler function type for spawning agents
 */
export type SpawnHandler = (args: SpawnHandlerArgs) => Promise<SpawnHandlerResult>;

/**
 * Handler function type for validating session tokens
 */
export type TokenValidator = (token: string) => TokenValidationResult;

/**
 * Type guard for SpawnRequest
 */
export function isSpawnRequest(data: unknown): data is SpawnRequest {
  if (typeof data !== 'object' || data === null) return false;
  const req = data as Record<string, unknown>;

  // task is required and must be a non-empty string
  if (typeof req.task !== 'string' || req.task.trim().length === 0) {
    return false;
  }

  // workspace_path is optional, but if provided must be a string
  if (req.workspace_path !== undefined && typeof req.workspace_path !== 'string') {
    return false;
  }

  // writable_paths is optional, but if provided must be an array of strings
  if (req.writable_paths !== undefined) {
    if (!Array.isArray(req.writable_paths)) return false;
    if (!req.writable_paths.every(p => typeof p === 'string')) return false;
  }

  // timeout_ms is optional, but if provided must be a positive number
  if (req.timeout_ms !== undefined) {
    if (typeof req.timeout_ms !== 'number' || req.timeout_ms <= 0) return false;
  }

  return true;
}
