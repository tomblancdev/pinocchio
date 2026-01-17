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

export interface SubscribeMessage {
  type: 'subscribe';
  agentId: string; // '*' for all agents
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

export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type === 'ping') return true;
  if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
    return typeof msg.agentId === 'string' && msg.agentId.length > 0;
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
