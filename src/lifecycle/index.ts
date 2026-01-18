/**
 * Lifecycle module barrel export
 *
 * This module handles agent lifecycle operations including cascade termination.
 */

export {
  terminateWithChildren,
  terminateTree,
  CascadeTerminationResult,
} from "./cascade.js";

export {
  detectOrphanedAgents,
  cleanupOrphanedAgents,
  startOrphanDetection,
  stopOrphanDetection,
  getOrphanDetectionConfig,
  isOrphanDetectionRunning,
  OrphanedAgent,
  OrphanDetectionConfig,
} from "./orphan.js";
