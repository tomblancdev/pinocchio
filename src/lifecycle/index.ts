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
