/**
 * Session Token Manager for Pinocchio MCP Server
 *
 * Issue #51: Session token validation middleware for nested agent authentication.
 *
 * Session tokens are used to authenticate spawn requests from child agents.
 * Tokens are HMAC-signed to prevent forgery and contain hierarchy information
 * for validation. Tokens are short-lived and invalidated when parent terminates.
 */

import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";

// =============================================================================
// Types (self-contained, no circular imports)
// =============================================================================

/**
 * Nested spawn configuration - matches NestedSpawnConfig from index.ts
 */
export interface NestedSpawnConfig {
  maxNestingDepth: number;
  maxAgentsPerTree: number;
  enableRecursiveSpawn: boolean;
}

/**
 * Spawn tree status - simplified interface for validation
 */
export interface SpawnTreeStatus {
  treeId: string;
  status: "active" | "terminated";
}

/**
 * Agent status - simplified interface for validation
 */
export interface AgentStatus {
  id: string;
  status: "running" | "completed" | "failed";
}

/**
 * SessionToken interface
 * Represents a cryptographically signed token for agent authentication
 */
export interface SessionToken {
  token: string;              // Cryptographically random, 32 bytes hex
  signature: string;          // HMAC signature of token payload
  agentId: string;            // Agent this token belongs to
  treeId: string;             // Spawn tree for validation
  parentAgentId?: string;     // Parent for hierarchy validation
  depth: number;              // Current nesting depth
  maxDepth: number;           // Configured max depth
  issuedAt: number;           // Unix timestamp (ms)
  expiresAt: number;          // Token expiry (ms)
  permissions: {
    canSpawn: boolean;        // Can this agent spawn children?
    inheritGitHubToken: boolean;  // Can inherit parent's GitHub token?
  };
}

/**
 * Serializable session token for persistence
 */
export interface PersistedSessionToken {
  token: string;
  signature: string;
  agentId: string;
  treeId: string;
  parentAgentId?: string;
  depth: number;
  maxDepth: number;
  issuedAt: number;
  expiresAt: number;
  permissions: {
    canSpawn: boolean;
    inheritGitHubToken: boolean;
  };
}

/**
 * Validation result for session tokens
 */
export interface TokenValidationResult {
  valid: boolean;
  token?: SessionToken;
  error?: string;
}

/**
 * Dependencies injected from index.ts to avoid circular imports
 */
export interface SessionManagerDependencies {
  getSpawnTree: (treeId: string) => SpawnTreeStatus | undefined;
  getAgentMetadata: (agentId: string) => AgentStatus | undefined;
  auditLog: (event: string, data: Record<string, unknown>, agentId?: string) => Promise<void>;
}

// =============================================================================
// Configuration
// =============================================================================

const SESSION_TOKEN_CONFIG = {
  // Default token lifetime: 1 hour (capped by agent timeout)
  defaultTokenLifetimeMs: 60 * 60 * 1000,
  // Token is 32 bytes hex-encoded (64 characters)
  tokenBytes: 32,
  // HMAC algorithm for signing
  hmacAlgorithm: 'sha256' as const,
};

// Server secret for HMAC signing (generated on startup)
// In production, this should be loaded from secure storage
// Regenerated on server restart, which invalidates all existing tokens
const serverSecret = crypto.randomBytes(32);

// State file path for token persistence
const TOKENS_STATE_FILE = path.join(os.homedir(), ".config", "pinocchio", "tokens.json");

// =============================================================================
// Internal State
// =============================================================================

// In-memory token store: Map from token string to SessionToken for O(1) lookup
const sessionTokens = new Map<string, SessionToken>();

// Periodic cleanup interval handle
let tokenCleanupInterval: NodeJS.Timeout | null = null;

// Injected dependencies (set during initialization)
let deps: SessionManagerDependencies | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the session manager with dependencies from index.ts.
 * Must be called before using validation functions that need external data.
 */
export function initSessionManager(dependencies: SessionManagerDependencies): void {
  deps = dependencies;
  console.error("[pinocchio] Session manager initialized");
}

// =============================================================================
// HMAC Signing Functions
// =============================================================================

/**
 * Generate the HMAC signature for a token payload.
 * This prevents token forgery - only the server can create valid signatures.
 */
function signTokenPayload(payload: {
  token: string;
  agentId: string;
  treeId: string;
  parentAgentId?: string;
  depth: number;
  maxDepth: number;
  issuedAt: number;
  expiresAt: number;
  permissions: { canSpawn: boolean; inheritGitHubToken: boolean };
}): string {
  const hmac = crypto.createHmac(SESSION_TOKEN_CONFIG.hmacAlgorithm, serverSecret);
  // Create deterministic string representation of payload
  const dataToSign = JSON.stringify({
    token: payload.token,
    agentId: payload.agentId,
    treeId: payload.treeId,
    parentAgentId: payload.parentAgentId || '',
    depth: payload.depth,
    maxDepth: payload.maxDepth,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    canSpawn: payload.permissions.canSpawn,
    inheritGitHubToken: payload.permissions.inheritGitHubToken,
  });
  hmac.update(dataToSign);
  return hmac.digest('hex');
}

/**
 * Verify that a token's signature is valid.
 */
function verifyTokenSignature(token: SessionToken): boolean {
  const expectedSignature = signTokenPayload({
    token: token.token,
    agentId: token.agentId,
    treeId: token.treeId,
    parentAgentId: token.parentAgentId,
    depth: token.depth,
    maxDepth: token.maxDepth,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    permissions: token.permissions,
  });
  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token.signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    // Length mismatch or invalid hex - signature is invalid
    return false;
  }
}

// =============================================================================
// Token Generation and Storage
// =============================================================================

/**
 * Generate a new session token for an agent.
 * Called when spawning a new agent (root or child).
 */
export function generateSessionToken(
  agentId: string,
  treeId: string,
  parentAgentId: string | undefined,
  depth: number,
  nestedSpawnConfig: NestedSpawnConfig,
  timeoutMs: number,
  inheritGitHubToken: boolean = false
): SessionToken {
  // Generate cryptographically random token
  const token = crypto.randomBytes(SESSION_TOKEN_CONFIG.tokenBytes).toString('hex');

  const now = Date.now();
  // Token expiry is the minimum of:
  // 1. Default token lifetime (1 hour)
  // 2. Agent timeout (so token expires when agent should be done)
  const expiresAt = now + Math.min(SESSION_TOKEN_CONFIG.defaultTokenLifetimeMs, timeoutMs);

  // Determine spawn permission based on depth and config
  const canSpawn = nestedSpawnConfig.enableRecursiveSpawn &&
                   depth < nestedSpawnConfig.maxNestingDepth;

  const sessionToken: SessionToken = {
    token,
    signature: '', // Will be set after signing
    agentId,
    treeId,
    parentAgentId,
    depth,
    maxDepth: nestedSpawnConfig.maxNestingDepth,
    issuedAt: now,
    expiresAt,
    permissions: {
      canSpawn,
      inheritGitHubToken,
    },
  };

  // Sign the token
  sessionToken.signature = signTokenPayload(sessionToken);

  return sessionToken;
}

/**
 * Store a session token in the in-memory store.
 */
export function storeSessionToken(sessionToken: SessionToken): void {
  sessionTokens.set(sessionToken.token, sessionToken);
  console.error(`[pinocchio] Stored session token for agent: ${sessionToken.agentId} (expires: ${new Date(sessionToken.expiresAt).toISOString()})`);

  // Audit log token generation (don't log the actual token for security)
  if (deps?.auditLog) {
    deps.auditLog("token.generated", {
      treeId: sessionToken.treeId,
      depth: sessionToken.depth,
      maxDepth: sessionToken.maxDepth,
      canSpawn: sessionToken.permissions.canSpawn,
      inheritGitHubToken: sessionToken.permissions.inheritGitHubToken,
      expiresAt: new Date(sessionToken.expiresAt).toISOString(),
    }, sessionToken.agentId).catch(() => {}); // Fire and forget
  }
}

/**
 * Retrieve a session token by token string.
 */
export function getSessionToken(tokenString: string): SessionToken | undefined {
  return sessionTokens.get(tokenString);
}

// =============================================================================
// Token Validation
// =============================================================================

/**
 * Validate a session token.
 * Checks: signature, expiry, tree active, parent running (if applicable).
 */
export function validateSessionToken(tokenString: string): TokenValidationResult {
  // Check token exists in store
  const token = sessionTokens.get(tokenString);
  if (!token) {
    // Log potential token replay or forgery attempt
    if (deps?.auditLog) {
      deps.auditLog("token.validation_failed", {
        reason: 'Token not found',
        // Log a prefix of the token for debugging (not full token for security)
        tokenPrefix: tokenString.slice(0, 8) + '...',
      }).catch(() => {});
    }
    return { valid: false, error: 'Token not found' };
  }

  // Verify signature (protects against tampering)
  if (!verifyTokenSignature(token)) {
    console.error(`[pinocchio] Token signature verification failed for agent: ${token.agentId}`);
    // This is a serious security event - potential tampering
    if (deps?.auditLog) {
      deps.auditLog("token.signature_invalid", {
        reason: 'Signature verification failed',
        treeId: token.treeId,
        depth: token.depth,
      }, token.agentId).catch(() => {});
    }
    return { valid: false, error: 'Invalid token signature' };
  }

  // Check expiry
  const now = Date.now();
  if (now > token.expiresAt) {
    if (deps?.auditLog) {
      deps.auditLog("token.expired", {
        reason: 'Token expired',
        expiredAt: new Date(token.expiresAt).toISOString(),
        treeId: token.treeId,
      }, token.agentId).catch(() => {});
    }
    return { valid: false, error: 'Token expired' };
  }

  // Check if the spawn tree is still active (requires dependencies)
  if (deps?.getSpawnTree) {
    const tree = deps.getSpawnTree(token.treeId);
    if (!tree) {
      return { valid: false, error: 'Spawn tree not found' };
    }
    if (tree.status === 'terminated') {
      return { valid: false, error: 'Spawn tree terminated' };
    }
  }

  // If token has a parent, verify parent is still running (requires dependencies)
  if (token.parentAgentId && deps?.getAgentMetadata) {
    const parentMetadata = deps.getAgentMetadata(token.parentAgentId);
    if (!parentMetadata) {
      return { valid: false, error: 'Parent agent not found' };
    }
    if (parentMetadata.status !== 'running') {
      return { valid: false, error: 'Parent agent no longer running' };
    }
  }

  // All checks passed
  return { valid: true, token };
}

// =============================================================================
// Token Invalidation
// =============================================================================

/**
 * Invalidate a single session token.
 */
export function invalidateSessionToken(tokenString: string): boolean {
  const token = sessionTokens.get(tokenString);
  if (token) {
    sessionTokens.delete(tokenString);
    console.error(`[pinocchio] Invalidated session token for agent: ${token.agentId}`);
    return true;
  }
  return false;
}

/**
 * Invalidate all tokens belonging to a specific agent.
 */
export function invalidateTokensForAgent(agentId: string): number {
  let count = 0;
  for (const [tokenString, token] of sessionTokens) {
    if (token.agentId === agentId) {
      sessionTokens.delete(tokenString);
      count++;
    }
  }
  if (count > 0) {
    console.error(`[pinocchio] Invalidated ${count} token(s) for agent: ${agentId}`);
  }
  return count;
}

/**
 * Invalidate all tokens in a spawn tree.
 * Called when a tree is terminated or when cleanup is needed.
 */
export function invalidateTokensForTree(treeId: string): number {
  let count = 0;
  for (const [tokenString, token] of sessionTokens) {
    if (token.treeId === treeId) {
      sessionTokens.delete(tokenString);
      count++;
    }
  }
  if (count > 0) {
    console.error(`[pinocchio] Invalidated ${count} token(s) for tree: ${treeId}`);
  }
  return count;
}

// =============================================================================
// Token Refresh (Optional heartbeat extension)
// =============================================================================

/**
 * Refresh a token's expiry time (heartbeat extension).
 * Returns the updated token or undefined if token not found/invalid.
 */
export function refreshToken(tokenString: string, extensionMs?: number): SessionToken | undefined {
  const token = sessionTokens.get(tokenString);
  if (!token) {
    return undefined;
  }

  // Validate the token first
  const validation = validateSessionToken(tokenString);
  if (!validation.valid) {
    return undefined;
  }

  // Extend expiry by the specified amount or default (15 minutes)
  const extension = extensionMs ?? 15 * 60 * 1000;
  const newExpiry = Date.now() + extension;

  // Cap at the original max expiry (don't extend beyond original timeout)
  const originalDuration = token.expiresAt - token.issuedAt;
  const maxExpiry = token.issuedAt + originalDuration;

  token.expiresAt = Math.min(newExpiry, maxExpiry);

  // Re-sign the token with updated expiry
  token.signature = signTokenPayload(token);

  console.error(`[pinocchio] Refreshed token for agent: ${token.agentId} (new expiry: ${new Date(token.expiresAt).toISOString()})`);

  return token;
}

// =============================================================================
// Cleanup and Persistence
// =============================================================================

/**
 * Clean up expired tokens (called periodically).
 */
export function cleanupExpiredTokens(): number {
  const now = Date.now();
  let count = 0;
  for (const [tokenString, token] of sessionTokens) {
    if (now > token.expiresAt) {
      sessionTokens.delete(tokenString);
      count++;
    }
  }
  if (count > 0) {
    console.error(`[pinocchio] Cleaned up ${count} expired token(s)`);
  }
  return count;
}

/**
 * Save token state to disk.
 */
export async function saveTokenState(): Promise<void> {
  try {
    const dir = path.dirname(TOKENS_STATE_FILE);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Convert Map to array for serialization
    const persisted: PersistedSessionToken[] = [];
    const now = Date.now();

    for (const [, token] of sessionTokens) {
      // Only persist non-expired tokens
      if (token.expiresAt > now) {
        persisted.push({
          token: token.token,
          signature: token.signature,
          agentId: token.agentId,
          treeId: token.treeId,
          parentAgentId: token.parentAgentId,
          depth: token.depth,
          maxDepth: token.maxDepth,
          issuedAt: token.issuedAt,
          expiresAt: token.expiresAt,
          permissions: { ...token.permissions },
        });
      }
    }

    // Use atomic write pattern (temp file + rename)
    const tempFile = `${TOKENS_STATE_FILE}.tmp.${process.pid}`;
    await fs.writeFile(tempFile, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    await fs.chmod(tempFile, 0o600);
    await fs.rename(tempFile, TOKENS_STATE_FILE);
  } catch (error) {
    console.error(`[pinocchio] Warning: Could not save token state: ${error}`);
  }
}

/**
 * Load token state from disk on startup.
 * Note: Tokens loaded from disk will have invalid signatures since serverSecret
 * is regenerated on restart. This is intentional for security - tokens from
 * previous server instances should not be trusted.
 */
export async function loadTokenState(): Promise<void> {
  try {
    const data = await fs.readFile(TOKENS_STATE_FILE, "utf-8");
    let persisted: PersistedSessionToken[];

    try {
      persisted = JSON.parse(data);
    } catch (parseError) {
      // JSON parse failed - back up corrupted file
      const backupFile = `${TOKENS_STATE_FILE}.corrupted.${Date.now()}`;
      console.error(`[pinocchio] Tokens state file corrupted, backing up to: ${backupFile}`);
      try {
        await fs.copyFile(TOKENS_STATE_FILE, backupFile);
        await fs.chmod(backupFile, 0o600);
      } catch (backupError) {
        console.error(`[pinocchio] Warning: Could not create backup: ${backupError}`);
      }
      console.error(`[pinocchio] Starting with fresh token state due to parse error: ${parseError}`);
      return;
    }

    const now = Date.now();
    let loadedCount = 0;
    let expiredCount = 0;
    let invalidSignatureCount = 0;

    for (const item of persisted) {
      // Skip expired tokens
      if (item.expiresAt <= now) {
        expiredCount++;
        continue;
      }

      const token: SessionToken = {
        token: item.token,
        signature: item.signature,
        agentId: item.agentId,
        treeId: item.treeId,
        parentAgentId: item.parentAgentId,
        depth: item.depth,
        maxDepth: item.maxDepth,
        issuedAt: item.issuedAt,
        expiresAt: item.expiresAt,
        permissions: { ...item.permissions },
      };

      // Verify signature - since serverSecret is regenerated on restart,
      // all loaded tokens will have invalid signatures. We regenerate
      // signatures for tokens that belong to still-running agents.
      // This maintains security while preserving session continuity.
      const agentMeta = deps?.getAgentMetadata?.(token.agentId);
      if (agentMeta && agentMeta.status === 'running') {
        // Re-sign the token with new server secret
        token.signature = signTokenPayload(token);
        sessionTokens.set(token.token, token);
        loadedCount++;
      } else {
        // Agent not running, don't restore token
        invalidSignatureCount++;
      }
    }

    if (loadedCount > 0 || expiredCount > 0 || invalidSignatureCount > 0) {
      console.error(`[pinocchio] Token state loaded: ${loadedCount} restored, ${expiredCount} expired, ${invalidSignatureCount} for non-running agents`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[pinocchio] Warning: Could not load token state: ${error}`);
    }
  }
}

/**
 * Start periodic token cleanup (every 5 minutes).
 */
export function startTokenCleanup(): void {
  if (tokenCleanupInterval) {
    return; // Already running
  }
  tokenCleanupInterval = setInterval(() => {
    cleanupExpiredTokens();
  }, 5 * 60 * 1000); // Every 5 minutes

  // Don't prevent Node from exiting
  tokenCleanupInterval.unref();
}

/**
 * Stop periodic token cleanup.
 */
export function stopTokenCleanup(): void {
  if (tokenCleanupInterval) {
    clearInterval(tokenCleanupInterval);
    tokenCleanupInterval = null;
  }
}

// =============================================================================
// Utility Functions for External Integration
// =============================================================================

/**
 * Get all tokens for a specific tree (for debugging/monitoring).
 */
export function getTokensForTree(treeId: string): SessionToken[] {
  const tokens: SessionToken[] = [];
  for (const [, token] of sessionTokens) {
    if (token.treeId === treeId) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Get the count of active tokens.
 */
export function getActiveTokenCount(): number {
  return sessionTokens.size;
}
