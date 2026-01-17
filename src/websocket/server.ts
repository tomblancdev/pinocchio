/**
 * WebSocket Server for Pinocchio MCP Server
 * Issue #27: Real-time agent event streaming
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, Server } from 'http';
import { createServer as createHttpsServer } from 'https';
import { createConnection } from 'net';
import { unlinkSync, existsSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import {
  WebSocketConfig,
  AgentEvent,
  ClientMessage,
  ServerMessage,
  ErrorCodes,
  isClientMessage,
} from './types.js';
import { RingBuffer } from './buffer.js';
import { EventBus } from './events.js';

// ============================================================================
// Client State
// ============================================================================

interface ClientState {
  subscriptions: Set<string>; // agentIds or '*' for all
  authenticated: boolean;
  buffer: RingBuffer<AgentEvent>;
  lastPing: number;
}

// ============================================================================
// WebSocket Server
// ============================================================================

export class PinocchioWebSocket {
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private clients: Map<WebSocket, ClientState> = new Map();
  private eventBus: EventBus;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 60000; // 60 seconds

  constructor(private config: WebSocketConfig) {
    this.eventBus = EventBus.getInstance(config.bufferSize);
  }

  /**
   * Start the WebSocket server.
   */
  start(): void {
    // Create HTTP server
    this.httpServer = createServer();

    // Create WebSocket server
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 1024 * 1024, // 1MB max message size
      verifyClient: (info, callback) => {
        const authorized = this.authenticate(info.req);
        callback(authorized, authorized ? undefined : 401, 'Unauthorized');
      },
    });

    // Handle connections
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start listening on TCP port
    this.httpServer.listen(this.config.port, this.config.bindAddress, () => {
      console.error(
        `[pinocchio-ws] WebSocket server listening on ${this.config.bindAddress}:${this.config.port}`
      );
    });

    // Optionally listen on Unix socket
    if (this.config.unixSocket) {
      // Remove existing socket file
      if (existsSync(this.config.unixSocket)) {
        unlinkSync(this.config.unixSocket);
      }

      const unixServer = createServer();
      const unixWss = new WebSocketServer({ server: unixServer });
      unixWss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });
      unixServer.listen(this.config.unixSocket, () => {
        console.error(
          `[pinocchio-ws] WebSocket server listening on ${this.config.unixSocket}`
        );
      });
    }

    // Subscribe to all agent events
    this.eventBus.onAny((event) => {
      this.broadcast(event);
    });

    // Start heartbeat check
    this.startHeartbeat();
  }

  /**
   * Authenticate an incoming connection.
   */
  private authenticate(req: IncomingMessage): boolean {
    if (this.config.auth === 'none') {
      return true;
    }

    if (this.config.auth === 'api-key') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
      }

      const token = authHeader.slice(7);
      const expectedToken = this.config.apiKey || '';

      // Timing-safe comparison to prevent timing attacks
      if (token.length !== expectedToken.length) {
        return false;
      }

      try {
        return timingSafeEqual(
          Buffer.from(token),
          Buffer.from(expectedToken)
        );
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Handle a new WebSocket connection.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const state: ClientState = {
      subscriptions: new Set(),
      authenticated: true, // Already authenticated via verifyClient
      buffer: new RingBuffer<AgentEvent>(this.config.bufferSize),
      lastPing: Date.now(),
    };

    this.clients.set(ws, state);

    console.error(
      `[pinocchio-ws] Client connected from ${req.socket.remoteAddress}`
    );

    ws.on('message', (data) => {
      this.handleMessage(ws, state, data.toString());
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      console.error('[pinocchio-ws] Client disconnected');
    });

    ws.on('error', (error) => {
      console.error('[pinocchio-ws] Client error:', error.message);
      this.clients.delete(ws);
    });

    ws.on('pong', () => {
      state.lastPing = Date.now();
    });
  }

  /**
   * Handle an incoming message from a client.
   */
  private handleMessage(
    ws: WebSocket,
    state: ClientState,
    data: string
  ): void {
    let message: unknown;

    try {
      message = JSON.parse(data);
    } catch {
      this.sendError(ws, ErrorCodes.INVALID_MESSAGE, 'Invalid JSON');
      return;
    }

    if (!isClientMessage(message)) {
      this.sendError(ws, ErrorCodes.INVALID_MESSAGE, 'Invalid message format');
      return;
    }

    switch (message.type) {
      case 'subscribe':
        this.handleSubscribe(ws, state, message.agentId);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(ws, state, message.agentId);
        break;

      case 'ping':
        this.send(ws, { type: 'pong' });
        state.lastPing = Date.now();
        break;
    }
  }

  /**
   * Handle a subscribe request.
   */
  private handleSubscribe(
    ws: WebSocket,
    state: ClientState,
    agentId: string
  ): void {
    // Check subscription policy
    if (this.config.subscriptionPolicy === 'owner-only' && agentId !== '*') {
      // In owner-only mode, we'd need to track which connection spawned which agent
      // For now, allow all subscriptions (implementation detail for later)
    }

    state.subscriptions.add(agentId);
    this.send(ws, { type: 'subscribed', agentId });

    // Send buffered events for this agent
    if (agentId !== '*') {
      const bufferedEvents = this.eventBus.getBufferedEvents(agentId);
      for (const event of bufferedEvents) {
        this.send(ws, { type: 'event', event });
      }
    }
  }

  /**
   * Handle an unsubscribe request.
   */
  private handleUnsubscribe(
    ws: WebSocket,
    state: ClientState,
    agentId: string
  ): void {
    state.subscriptions.delete(agentId);
    this.send(ws, { type: 'unsubscribed', agentId });
  }

  /**
   * Broadcast an event to all subscribed clients.
   */
  broadcast(event: AgentEvent): void {
    for (const [ws, state] of this.clients) {
      // Check if client is subscribed to this agent or '*'
      if (
        state.subscriptions.has(event.agentId) ||
        state.subscriptions.has('*')
      ) {
        if (ws.readyState === WebSocket.OPEN) {
          this.send(ws, { type: 'event', event });
        } else {
          // Buffer event for slow/disconnected clients
          state.buffer.push(event);
        }
      }
    }
  }

  /**
   * Send a message to a client.
   */
  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send an error message to a client.
   */
  private sendError(ws: WebSocket, code: number, message: string): void {
    this.send(ws, { type: 'error', code, message });
  }

  /**
   * Start the heartbeat check interval.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const [ws, state] of this.clients) {
        if (now - state.lastPing > this.CONNECTION_TIMEOUT) {
          // Connection timed out
          console.error('[pinocchio-ws] Client timed out, disconnecting');
          ws.terminate();
          this.clients.delete(ws);
        } else {
          // Send ping
          ws.ping();
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Gracefully close the WebSocket server.
   */
  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all client connections
    for (const [ws] of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    console.error('[pinocchio-ws] WebSocket server closed');
  }

  /**
   * Get the number of connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get the event bus instance.
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }
}
