/**
 * WebSocket Server for Pinocchio MCP Server
 * Issue #27: Real-time agent event streaming
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { createServer as createHttpsServer } from 'https';
import { createConnection } from 'net';
import { unlinkSync, existsSync, promises as fs } from 'fs';
import { timingSafeEqual } from 'crypto';
import * as path from 'path';
import * as os from 'os';
import {
  WebSocketConfig,
  AgentEvent,
  AgentLogEvent,
  ClientMessage,
  ServerMessage,
  ErrorCodes,
  LogLevel,
  isClientMessage,
  SpawnRequest,
  SpawnResponse,
  SpawnErrorResponse,
  QuotaErrorResponse,
  QuotaInfo,
  SpawnHandler,
  TokenValidator,
  TreeInfoGetter,
  RunningAgentCounter,
  QuotaConfigGetter,
  isSpawnRequest,
} from './types.js';
import { RingBuffer } from './buffer.js';
import { EventBus } from './events.js';

// ============================================================================
// Client State
// ============================================================================

const ALL_LOG_LEVELS: Set<LogLevel> = new Set(['debug', 'info', 'warn', 'error']);

interface ClientState {
  subscriptions: Map<string, Set<LogLevel>>; // agentId -> Set of log levels (all levels if not specified)
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

  // Issue #50: Handler functions for spawn endpoint
  private spawnHandler: SpawnHandler | null = null;
  private tokenValidator: TokenValidator | null = null;

  // Issue #53: Quota enforcement handlers
  private treeInfoGetter: TreeInfoGetter | null = null;
  private runningAgentCounter: RunningAgentCounter | null = null;
  private quotaConfigGetter: QuotaConfigGetter | null = null;

  // PR #73: Rate limiting state (IP -> timestamps of recent requests)
  private rateLimitMap: Map<string, number[]> = new Map();

  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 60000; // 60 seconds
  private readonly MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB max request body
  private readonly RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
  private readonly RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per window

  constructor(private config: WebSocketConfig) {
    this.eventBus = EventBus.getInstance(config.bufferSize);
  }

  /**
   * Issue #50: Register the spawn handler function.
   * This should be called from index.ts to provide access to spawnDockerAgent.
   */
  setSpawnHandler(handler: SpawnHandler): void {
    this.spawnHandler = handler;
    console.error('[pinocchio-ws] Spawn handler registered');
  }

  /**
   * Issue #50: Register the token validator function.
   * This should be called from index.ts to provide access to validateSessionToken.
   */
  setTokenValidator(validator: TokenValidator): void {
    this.tokenValidator = validator;
    console.error('[pinocchio-ws] Token validator registered');
  }

  /**
   * Issue #53: Register the tree info getter for quota enforcement.
   */
  setTreeInfoGetter(getter: TreeInfoGetter): void {
    this.treeInfoGetter = getter;
    console.error('[pinocchio-ws] Tree info getter registered');
  }

  /**
   * Issue #53: Register the running agent counter for quota enforcement.
   */
  setRunningAgentCounter(counter: RunningAgentCounter): void {
    this.runningAgentCounter = counter;
    console.error('[pinocchio-ws] Running agent counter registered');
  }

  /**
   * Issue #53: Register the quota config getter for quota enforcement.
   */
  setQuotaConfigGetter(getter: QuotaConfigGetter): void {
    this.quotaConfigGetter = getter;
    console.error('[pinocchio-ws] Quota config getter registered');
  }

  /**
   * Start the WebSocket server.
   */
  start(): void {
    // Issue #50: Create HTTP server with request handler for HTTP endpoints
    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Create WebSocket server with noServer option for upgrade handling
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024, // 1MB max message size
    });

    // Issue #50: Handle HTTP upgrade requests for WebSocket
    this.httpServer.on('upgrade', (req, socket, head) => {
      // Authenticate WebSocket upgrade requests
      const authorized = this.authenticate(req);
      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
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
      console.error(
        `[pinocchio-ws] HTTP endpoints available: GET /health, POST /api/v1/spawn`
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
      subscriptions: new Map(),
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
        this.handleSubscribe(ws, state, message.agentId, message.logLevels);
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
    agentId: string,
    logLevels?: LogLevel[]
  ): void {
    // Check subscription policy
    if (this.config.subscriptionPolicy === 'owner-only' && agentId !== '*') {
      // In owner-only mode, we'd need to track which connection spawned which agent
      // For now, allow all subscriptions (implementation detail for later)
    }

    // Store subscription with log level filter (default to all levels)
    const levels = new Set(logLevels || ALL_LOG_LEVELS);
    state.subscriptions.set(agentId, levels);
    this.send(ws, { type: 'subscribed', agentId });

    // Send buffered events for this agent (filtered by log level)
    if (agentId !== '*') {
      const bufferedEvents = this.eventBus.getBufferedEvents(agentId);
      for (const event of bufferedEvents) {
        // Filter log events by level
        if (event.type === 'agent.log') {
          const logLevel = (event as AgentLogEvent).data.level;
          if (!levels.has(logLevel)) continue;
        }
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
      // Subscription precedence: specific agent subscription takes precedence over wildcard ('*').
      // If a client has both a subscription for a specific agentId AND a wildcard subscription
      // with different log levels, only the specific subscription's log levels are used.
      const levels = state.subscriptions.get(event.agentId) || state.subscriptions.get('*');
      if (!levels) continue;

      // For log events, check level filter
      if (event.type === 'agent.log') {
        const logLevel = (event as AgentLogEvent).data.level;
        if (!levels.has(logLevel)) continue;
      }

      // Send event
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, { type: 'event', event });
      } else {
        // Buffer event for slow/disconnected clients
        state.buffer.push(event);
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

  // ============================================================================
  // Issue #50: HTTP Request Handling
  // ============================================================================

  /**
   * Handle incoming HTTP requests.
   * Routes to appropriate handler based on method and path.
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';

    // GET /health - Health check endpoint
    if (req.method === 'GET' && url === '/health') {
      this.handleHealthRequest(res);
      return;
    }

    // POST /api/v1/spawn - Spawn child agent endpoint
    if (req.method === 'POST' && url === '/api/v1/spawn') {
      this.handleSpawnRequest(req, res);
      return;
    }

    // 404 for unknown routes
    this.sendJsonResponse(res, 404, { error: 'Not Found' });
  }

  /**
   * Handle GET /health endpoint.
   */
  private handleHealthRequest(res: ServerResponse): void {
    this.sendJsonResponse(res, 200, {
      status: 'ok',
      service: 'pinocchio-websocket',
      clients: this.clients.size,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle POST /api/v1/spawn endpoint.
   * Allows authenticated child agents to spawn more children.
   */
  private async handleSpawnRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const startTime = Date.now();

    // PR #73 Fix 1: Content-Type validation
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      this.sendJsonResponse(res, 415, {
        error: 'Unsupported Media Type: Content-Type must be application/json',
      } as SpawnErrorResponse);
      return;
    }

    // PR #73 Fix 4: Rate limiting per IP
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!this.checkRateLimit(clientIp)) {
      this.sendJsonResponse(res, 429, {
        error: 'Too Many Requests: rate limit exceeded (10 requests per minute)',
      } as SpawnErrorResponse);
      return;
    }

    // Check if handlers are registered
    if (!this.spawnHandler || !this.tokenValidator) {
      console.error('[pinocchio-ws] Spawn endpoint called but handlers not registered');
      this.sendJsonResponse(res, 503, {
        error: 'Spawn service not available',
      } as SpawnErrorResponse);
      return;
    }

    // Extract and validate Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      this.sendJsonResponse(res, 401, {
        error: 'Missing or invalid Authorization header',
      } as SpawnErrorResponse);
      return;
    }

    const token = authHeader.slice(7); // Remove 'Bearer ' prefix
    const validation = this.tokenValidator(token);

    if (!validation.valid || !validation.token) {
      console.error(`[pinocchio-ws] Token validation failed: ${validation.error}`);
      this.sendJsonResponse(res, 401, {
        error: validation.error || 'Invalid or expired session token',
      } as SpawnErrorResponse);
      return;
    }

    // Capture token in local constant for use in closures (TypeScript narrowing doesn't persist)
    const sessionToken = validation.token;

    // Check spawn permission
    if (!sessionToken.permissions.canSpawn) {
      console.error(
        `[pinocchio-ws] Spawn permission denied for agent ${sessionToken.agentId} (depth: ${sessionToken.depth}, maxDepth: ${sessionToken.maxDepth})`
      );
      this.sendJsonResponse(res, 403, {
        error: 'Spawn permission denied (depth limit reached)',
      } as SpawnErrorResponse);
      return;
    }

    // Issue #53: Depth limit enforcement
    // Note: This is a stricter check using current depth vs max depth
    // The canSpawn permission above uses depth < maxDepth, this uses depth >= maxDepth
    if (validation.token.depth >= validation.token.maxDepth) {
      console.error(
        `[pinocchio-ws] Depth limit exceeded for agent ${validation.token.agentId} (depth: ${validation.token.depth}, maxDepth: ${validation.token.maxDepth})`
      );
      this.sendJsonResponse(res, 403, {
        error: 'Maximum nesting depth exceeded',
        current_depth: validation.token.depth,
        max_depth: validation.token.maxDepth,
      } as QuotaErrorResponse);
      return;
    }

    // Issue #53: Tree agent quota enforcement
    if (this.treeInfoGetter && this.quotaConfigGetter) {
      const tree = this.treeInfoGetter(validation.token.treeId);
      const quotaConfig = this.quotaConfigGetter();

      if (tree && tree.totalAgents >= quotaConfig.maxAgentsPerTree) {
        console.error(
          `[pinocchio-ws] Tree agent quota exceeded for tree ${validation.token.treeId} (count: ${tree.totalAgents}, max: ${quotaConfig.maxAgentsPerTree})`
        );
        this.sendJsonResponse(res, 429, {
          error: 'Maximum agents per tree exceeded',
          current_count: tree.totalAgents,
          max_agents: quotaConfig.maxAgentsPerTree,
        } as QuotaErrorResponse);
        return;
      }
    }

    // Issue #53: Global concurrent agent limit enforcement
    if (this.runningAgentCounter && this.quotaConfigGetter) {
      const runningCount = this.runningAgentCounter();
      const quotaConfig = this.quotaConfigGetter();

      if (runningCount >= quotaConfig.maxConcurrentAgents) {
        console.error(
          `[pinocchio-ws] Global concurrent agent limit reached (running: ${runningCount}, max: ${quotaConfig.maxConcurrentAgents})`
        );
        this.sendJsonResponse(res, 429, {
          error: 'Global concurrent agent limit reached',
          current_count: runningCount,
          max_agents: quotaConfig.maxConcurrentAgents,
        } as QuotaErrorResponse);
        return;
      }
    }

    // Parse request body
    let body: SpawnRequest;
    try {
      body = await this.parseJsonBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body';
      this.sendJsonResponse(res, 400, { error: message } as SpawnErrorResponse);
      return;
    }

    // Validate request body
    if (!isSpawnRequest(body)) {
      this.sendJsonResponse(res, 400, {
        error: 'Invalid request body: task is required and must be a non-empty string',
      } as SpawnErrorResponse);
      return;
    }

    // PR #73 Fix 3: Validate workspace path against allowed workspaces
    const workspacePath = body.workspace_path || '/workspace';
    const workspaceValidation = await this.validateWorkspacePath(workspacePath);
    if (!workspaceValidation.allowed) {
      this.sendJsonResponse(res, 403, {
        error: `Forbidden: ${workspaceValidation.reason}`,
      } as SpawnErrorResponse);
      return;
    }

    // Calculate effective timeout (capped at parent's remaining time)
    const parentRemaining = sessionToken.expiresAt - Date.now();
    const requestedTimeout = body.timeout_ms || 3600000; // Default 1 hour
    const effectiveTimeout = Math.min(requestedTimeout, parentRemaining);

    // Don't allow spawn if parent is about to expire
    if (effectiveTimeout < 60000) {
      // Less than 1 minute
      this.sendJsonResponse(res, 400, {
        error: 'Insufficient time remaining for child agent (parent expires soon)',
      } as SpawnErrorResponse);
      return;
    }

    console.error(
      `[pinocchio-ws] Spawn request from agent ${sessionToken.agentId}: task="${body.task.slice(0, 50)}..."`
    );

    // Issue #52: Set socket timeout to match child timeout + 5s buffer
    const socketTimeout = effectiveTimeout + 5000;
    req.socket.setTimeout(socketTimeout);
    console.error(
      `[pinocchio-ws] Socket timeout set to ${socketTimeout}ms (child timeout: ${effectiveTimeout}ms + 5s buffer)`
    );

    // Issue #52: Track if parent disconnected
    let parentDisconnected = false;
    const disconnectHandler = () => {
      parentDisconnected = true;
      console.error(
        `[pinocchio-ws] Parent agent ${sessionToken.agentId} disconnected, child will continue to completion`
      );
    };
    req.on('close', disconnectHandler);

    // Call the spawn handler (blocking until child completes)
    try {
      const result = await this.spawnHandler({
        task: body.task,
        workspace_path: body.workspace_path || '/workspace',
        writable_paths: body.writable_paths,
        timeout_ms: effectiveTimeout,
        parent_agent_id: sessionToken.agentId,
      });

      // Clean up disconnect handler
      req.off('close', disconnectHandler);

      // Issue #52: If parent disconnected, just log and don't try to send response
      if (parentDisconnected) {
        console.error(
          `[pinocchio-ws] Child agent ${result.agent_id} completed with status ${result.status} but parent disconnected`
        );
        return;
      }

      if (result.success) {
        // Issue #53: Calculate quota info for response
        let quotaInfo: QuotaInfo | undefined;
        if (this.treeInfoGetter && this.quotaConfigGetter) {
          const tree = this.treeInfoGetter(validation.token.treeId);
          const quotaConfig = this.quotaConfigGetter();
          if (tree) {
            // After spawn, tree.totalAgents has been incremented
            // Calculate remaining based on new count
            quotaInfo = {
              tree_agents_remaining: Math.max(0, quotaConfig.maxAgentsPerTree - tree.totalAgents),
              depth_remaining: Math.max(0, validation.token.maxDepth - (validation.token.depth + 1)),
            };
          }
        }

        const response: SpawnResponse = {
          agent_id: result.agent_id!,
          status: result.status || 'completed',
          exit_code: result.exit_code ?? 0,
          output: result.output || '',
          duration_ms: result.duration_ms || Date.now() - startTime,
          files_modified: result.files_modified,
          error: result.status === 'failed' || result.status === 'timeout' ? result.error : undefined,
          quota_info: quotaInfo,
        };
        this.sendJsonResponse(res, 200, response);
      } else {
        this.sendJsonResponse(res, 500, {
          error: result.error || 'Spawn failed',
        } as SpawnErrorResponse);
      }
    } catch (error) {
      // Clean up disconnect handler
      req.off('close', disconnectHandler);

      // Don't try to send response if parent disconnected
      if (parentDisconnected) {
        console.error(
          `[pinocchio-ws] Spawn handler error but parent disconnected: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return;
      }

      const message = error instanceof Error ? error.message : 'Internal server error';
      console.error(`[pinocchio-ws] Spawn handler error: ${message}`);
      this.sendJsonResponse(res, 500, { error: message } as SpawnErrorResponse);
    }
  }

  /**
   * Parse JSON body from incoming request.
   * PR #73 Fix 2: Added requestEnded flag to prevent data accumulation after rejection
   */
  private parseJsonBody(req: IncomingMessage): Promise<SpawnRequest> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let requestEnded = false;

      const rejectRequest = (error: Error) => {
        if (requestEnded) return;
        requestEnded = true;
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.removeAllListeners('error');
        reject(error);
      };

      req.on('data', (chunk: Buffer) => {
        if (requestEnded) return;
        size += chunk.length;
        if (size > this.MAX_REQUEST_BODY_SIZE) {
          req.destroy();
          rejectRequest(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (requestEnded) return;
        requestEnded = true;
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (!body.trim()) {
            reject(new Error('Empty request body'));
            return;
          }
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });

      req.on('error', (error) => {
        rejectRequest(error);
      });
    });
  }

  /**
   * Send a JSON response.
   */
  private sendJsonResponse(
    res: ServerResponse,
    statusCode: number,
    data: unknown
  ): void {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  // ============================================================================
  // PR #73: Helper methods for security fixes
  // ============================================================================

  /**
   * PR #73 Fix 4: Check rate limit for an IP address.
   * Returns true if request is allowed, false if rate limited.
   */
  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - this.RATE_LIMIT_WINDOW_MS;

    // Get or initialize timestamps for this IP
    let timestamps = this.rateLimitMap.get(ip) || [];

    // Filter out timestamps outside the window
    timestamps = timestamps.filter((t) => t > windowStart);

    // Check if rate limit exceeded
    if (timestamps.length >= this.RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }

    // Record this request
    timestamps.push(now);
    this.rateLimitMap.set(ip, timestamps);

    return true;
  }

  /**
   * PR #73 Fix 3: Validate workspace path against allowed workspaces.
   * Loads config and checks if the path is in the allowlist.
   */
  private async validateWorkspacePath(
    workspacePath: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    const CONFIG_FILE = path.join(
      os.homedir(),
      '.config',
      'pinocchio',
      'config.json'
    );

    // Load config
    let config: { allowedWorkspaces?: string[]; blockedPaths?: string[] };
    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      config = JSON.parse(data);
    } catch {
      config = { allowedWorkspaces: [], blockedPaths: [] };
    }

    const allowedWorkspaces = config.allowedWorkspaces || [];
    const blockedPaths = config.blockedPaths || [
      '/etc',
      '/var',
      '/root',
      '/boot',
      '/sys',
      '/proc',
      '/dev',
    ];

    // Resolve workspace path to real path
    let realPath: string;
    try {
      realPath = await fs.realpath(workspacePath);
    } catch {
      return {
        allowed: false,
        reason: `Workspace path does not exist or is a broken symlink: ${workspacePath}`,
      };
    }

    // Check blocked paths
    for (const blocked of blockedPaths) {
      if (realPath === blocked || realPath.startsWith(blocked + '/')) {
        return { allowed: false, reason: `System path "${blocked}" is not allowed` };
      }
    }

    // Check allowlist
    for (const allowed of allowedWorkspaces) {
      let normalizedAllowed: string;
      try {
        normalizedAllowed = await fs.realpath(allowed);
      } catch {
        continue; // Skip broken symlinks in allowlist
      }
      if (
        realPath === normalizedAllowed ||
        realPath.startsWith(normalizedAllowed + '/')
      ) {
        return { allowed: true };
      }
    }

    const allowedList =
      allowedWorkspaces.length > 0
        ? allowedWorkspaces.join(', ')
        : '(none configured)';
    return {
      allowed: false,
      reason: `Path not in allowlist. Allowed: ${allowedList}. Use 'manage_config' tool to add workspace.`,
    };
  }
}
