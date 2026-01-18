/**
 * Session Token Module - Barrel Export
 *
 * Issue #51: Session token validation middleware for nested agent authentication.
 */

export {
  // Types
  type NestedSpawnConfig,
  type SpawnTreeStatus,
  type AgentStatus,
  type SessionToken,
  type PersistedSessionToken,
  type TokenValidationResult,
  type SessionManagerDependencies,

  // Initialization
  initSessionManager,

  // Token generation and storage
  generateSessionToken,
  storeSessionToken,
  getSessionToken,

  // Token validation
  validateSessionToken,

  // Token invalidation
  invalidateSessionToken,
  invalidateTokensForAgent,
  invalidateTokensForTree,

  // Token refresh (heartbeat)
  refreshToken,

  // Cleanup and persistence
  cleanupExpiredTokens,
  saveTokenState,
  loadTokenState,
  startTokenCleanup,
  stopTokenCleanup,

  // Utility functions
  getTokensForTree,
  getActiveTokenCount,
} from "./manager.js";
