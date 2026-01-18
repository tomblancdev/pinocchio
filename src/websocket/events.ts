/**
 * Event Bus for Pinocchio WebSocket Server
 * Issue #27: Real-time agent event streaming
 */

import { EventEmitter } from 'events';
import {
  AgentEvent,
  AgentStartedEvent,
  AgentLogEvent,
  AgentProgressEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentTerminatedEvent,
} from './types.js';

/**
 * Hierarchy info for event emission (Issue #62)
 */
export interface HierarchyInfo {
  parentAgentId?: string;
  treeId: string;
  depth: number;
}
import { RingBuffer } from './buffer.js';

// ============================================================================
// Event Bus
// ============================================================================

type AgentEventHandler = (event: AgentEvent) => void;

export class EventBus extends EventEmitter {
  private static instance: EventBus | null = null;
  private agentBuffers: Map<string, RingBuffer<AgentEvent>> = new Map();
  private bufferCapacity: number;

  private constructor(bufferCapacity = 1000) {
    super();
    this.bufferCapacity = bufferCapacity;
    this.setMaxListeners(100); // Allow many WebSocket connections
  }

  static getInstance(bufferCapacity = 1000): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus(bufferCapacity);
    } else if (bufferCapacity !== EventBus.instance.bufferCapacity) {
      console.warn('[EventBus] Capacity change ignored - singleton already initialized');
    }
    return EventBus.instance;
  }

  static resetInstance(): void {
    if (EventBus.instance) {
      EventBus.instance.removeAllListeners();
      EventBus.instance.agentBuffers.clear();
      EventBus.instance = null;
    }
  }

  // -------------------------------------------------------------------------
  // Emit Methods
  // -------------------------------------------------------------------------

  emitEvent(event: AgentEvent): void {
    // Store in agent-specific buffer
    let buffer = this.agentBuffers.get(event.agentId);
    if (!buffer) {
      buffer = new RingBuffer<AgentEvent>(this.bufferCapacity);
      this.agentBuffers.set(event.agentId, buffer);
    }
    buffer.push(event);

    // Emit to listeners
    this.emit('event', event);
    this.emit(`agent:${event.agentId}`, event);
  }

  emitStarted(
    agentId: string,
    task: string,
    workspace: string,
    writablePaths: string[],
    hierarchy: HierarchyInfo
  ): void {
    const event: AgentStartedEvent = {
      type: 'agent.started',
      agentId,
      timestamp: new Date().toISOString(),
      parentAgentId: hierarchy.parentAgentId,
      treeId: hierarchy.treeId,
      depth: hierarchy.depth,
      data: { task, workspace, writablePaths },
    };
    this.emitEvent(event);
  }

  emitLog(
    agentId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    hierarchy: HierarchyInfo,
    metadata?: Record<string, unknown>
  ): void {
    const event: AgentLogEvent = {
      type: 'agent.log',
      agentId,
      timestamp: new Date().toISOString(),
      parentAgentId: hierarchy.parentAgentId,
      treeId: hierarchy.treeId,
      depth: hierarchy.depth,
      data: { level, message, metadata },
    };
    this.emitEvent(event);
  }

  emitProgress(
    agentId: string,
    progress: number,
    hierarchy: HierarchyInfo,
    message?: string,
    filesModified?: string[]
  ): void {
    const event: AgentProgressEvent = {
      type: 'agent.progress',
      agentId,
      timestamp: new Date().toISOString(),
      parentAgentId: hierarchy.parentAgentId,
      treeId: hierarchy.treeId,
      depth: hierarchy.depth,
      data: { progress, message, filesModified },
    };
    this.emitEvent(event);
  }

  emitCompleted(
    agentId: string,
    exitCode: number,
    output: string,
    durationMs: number,
    hierarchy: HierarchyInfo,
    filesModified?: string[]
  ): void {
    const event: AgentCompletedEvent = {
      type: 'agent.completed',
      agentId,
      timestamp: new Date().toISOString(),
      parentAgentId: hierarchy.parentAgentId,
      treeId: hierarchy.treeId,
      depth: hierarchy.depth,
      data: { exitCode, output, durationMs, filesModified },
    };
    this.emitEvent(event);
  }

  emitFailed(
    agentId: string,
    error: string,
    exitCode: number,
    hierarchy: HierarchyInfo,
    output?: string
  ): void {
    const event: AgentFailedEvent = {
      type: 'agent.failed',
      agentId,
      timestamp: new Date().toISOString(),
      parentAgentId: hierarchy.parentAgentId,
      treeId: hierarchy.treeId,
      depth: hierarchy.depth,
      data: { error, exitCode, output },
    };
    this.emitEvent(event);
  }

  emitTerminated(
    agentId: string,
    reason: 'cascade' | 'manual' | 'timeout' | 'orphan_cleanup',
    hierarchy: HierarchyInfo,
    terminatedBy?: string
  ): void {
    const event: AgentTerminatedEvent = {
      type: 'agent.terminated',
      agentId,
      timestamp: new Date().toISOString(),
      parentAgentId: hierarchy.parentAgentId,
      treeId: hierarchy.treeId,
      depth: hierarchy.depth,
      data: { reason, terminatedBy },
    };
    this.emitEvent(event);
  }

  // -------------------------------------------------------------------------
  // Subscription Methods
  // -------------------------------------------------------------------------

  onAny(handler: AgentEventHandler): void {
    this.on('event', handler);
  }

  offAny(handler: AgentEventHandler): void {
    this.off('event', handler);
  }

  onAgent(agentId: string, handler: AgentEventHandler): void {
    this.on(`agent:${agentId}`, handler);
  }

  offAgent(agentId: string, handler: AgentEventHandler): void {
    this.off(`agent:${agentId}`, handler);
  }

  // -------------------------------------------------------------------------
  // Buffer Methods
  // -------------------------------------------------------------------------

  getBufferedEvents(agentId: string): AgentEvent[] {
    const buffer = this.agentBuffers.get(agentId);
    return buffer ? buffer.toArray() : [];
  }

  clearAgentBuffer(agentId: string): void {
    this.agentBuffers.delete(agentId);
  }

  clearAllBuffers(): void {
    this.agentBuffers.clear();
  }
}

// Global singleton export
export const eventBus = EventBus.getInstance();
