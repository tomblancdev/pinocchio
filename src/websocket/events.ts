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
} from './types.js';
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

  emitStarted(agentId: string, task: string, workspace: string): void {
    const event: AgentStartedEvent = {
      type: 'agent.started',
      agentId,
      timestamp: new Date().toISOString(),
      data: { task, workspace },
    };
    this.emitEvent(event);
  }

  emitLog(
    agentId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const event: AgentLogEvent = {
      type: 'agent.log',
      agentId,
      timestamp: new Date().toISOString(),
      data: { level, message, metadata },
    };
    this.emitEvent(event);
  }

  emitProgress(agentId: string, progress: number, message?: string): void {
    const event: AgentProgressEvent = {
      type: 'agent.progress',
      agentId,
      timestamp: new Date().toISOString(),
      data: { progress, message },
    };
    this.emitEvent(event);
  }

  emitCompleted(
    agentId: string,
    exitCode: number,
    duration: number,
    filesModified: string[]
  ): void {
    const event: AgentCompletedEvent = {
      type: 'agent.completed',
      agentId,
      timestamp: new Date().toISOString(),
      data: { exitCode, duration, filesModified },
    };
    this.emitEvent(event);
  }

  emitFailed(
    agentId: string,
    error: string,
    exitCode?: number,
    duration?: number
  ): void {
    const event: AgentFailedEvent = {
      type: 'agent.failed',
      agentId,
      timestamp: new Date().toISOString(),
      data: { error, exitCode, duration },
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
