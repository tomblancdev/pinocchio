/**
 * Orphan Detection and Cleanup (Issue #61)
 *
 * Detects and cleans up child agents whose parents terminated unexpectedly.
 */

import {
  getAgentMetadata,
  getAllAgentMetadata,
  getSpawnTree,
} from "../index.js";
import { terminateWithChildren, CascadeTerminationResult } from "./cascade.js";
import Docker from "dockerode";

// Default check interval: 60 seconds
const DEFAULT_ORPHAN_CHECK_INTERVAL_MS = 60000;

export interface OrphanedAgent {
  agentId: string;
  parentAgentId: string;
  reason: "parent_not_found" | "parent_terminated" | "tree_terminated";
}

export interface OrphanDetectionConfig {
  checkIntervalMs: number;
  enabled: boolean;
}

let orphanCleanupInterval: NodeJS.Timeout | null = null;
let cleanupConfig: OrphanDetectionConfig = {
  checkIntervalMs: DEFAULT_ORPHAN_CHECK_INTERVAL_MS,
  enabled: true,
};

/**
 * Detect all orphaned agents (agents with dead/missing parents)
 */
export function detectOrphanedAgents(): OrphanedAgent[] {
  const orphans: OrphanedAgent[] = [];
  const allMetadata = getAllAgentMetadata();

  for (const [agentId, metadata] of allMetadata) {
    if (metadata.status !== "running") continue;
    if (!metadata.parentAgentId) continue; // Root agents can't be orphaned

    const parent = getAgentMetadata(metadata.parentAgentId);

    if (!parent) {
      orphans.push({
        agentId,
        parentAgentId: metadata.parentAgentId,
        reason: "parent_not_found",
      });
      continue;
    }

    if (parent.status !== "running") {
      orphans.push({
        agentId,
        parentAgentId: metadata.parentAgentId,
        reason: "parent_terminated",
      });
      continue;
    }

    // Check if the tree is terminated
    if (metadata.treeId) {
      const tree = getSpawnTree(metadata.treeId);
      if (tree && tree.status === "terminated") {
        orphans.push({
          agentId,
          parentAgentId: metadata.parentAgentId,
          reason: "tree_terminated",
        });
      }
    }
  }

  return orphans;
}

/**
 * Clean up all detected orphaned agents
 */
export async function cleanupOrphanedAgents(
  updateMetadata: (
    agentId: string,
    status: "failed",
    output: string
  ) => Promise<void>,
  runningAgents: Map<string, Docker.Container>
): Promise<{ cleaned: number; results: CascadeTerminationResult[] }> {
  const orphans = detectOrphanedAgents();
  const results: CascadeTerminationResult[] = [];

  for (const orphan of orphans) {
    console.error(
      `[pinocchio] Orphan detection: Cleaning up orphaned agent ${orphan.agentId} (reason: ${orphan.reason})`
    );

    // Pass orphan_cleanup as the reason for the initial orphan,
    // children will be terminated with 'cascade' reason
    const result = await terminateWithChildren(
      orphan.agentId,
      "SIGTERM",
      updateMetadata,
      runningAgents,
      undefined, // no initiatorAgentId for orphan cleanup
      'orphan_cleanup'
    );
    results.push(result);
  }

  return { cleaned: orphans.length, results };
}

/**
 * Start periodic orphan detection
 */
export function startOrphanDetection(
  updateMetadata: (
    agentId: string,
    status: "failed",
    output: string
  ) => Promise<void>,
  runningAgents: Map<string, Docker.Container>,
  config?: Partial<OrphanDetectionConfig>
): void {
  if (config) {
    cleanupConfig = { ...cleanupConfig, ...config };
  }

  if (!cleanupConfig.enabled) {
    console.error("[pinocchio] Orphan detection disabled by configuration");
    return;
  }

  if (orphanCleanupInterval) {
    console.error("[pinocchio] Orphan detection already running");
    return;
  }

  console.error(
    `[pinocchio] Starting orphan detection (interval: ${cleanupConfig.checkIntervalMs}ms)`
  );

  orphanCleanupInterval = setInterval(async () => {
    try {
      const { cleaned, results } = await cleanupOrphanedAgents(
        updateMetadata,
        runningAgents
      );
      if (cleaned > 0) {
        const totalTerminated = results.reduce(
          (sum, r) => sum + r.terminated.length,
          0
        );
        console.error(
          `[pinocchio] Orphan detection: Cleaned up ${cleaned} orphaned agents (${totalTerminated} total terminated)`
        );
      }
    } catch (error) {
      console.error("[pinocchio] Orphan detection error:", error);
    }
  }, cleanupConfig.checkIntervalMs);
}

/**
 * Stop periodic orphan detection
 */
export function stopOrphanDetection(): void {
  if (orphanCleanupInterval) {
    clearInterval(orphanCleanupInterval);
    orphanCleanupInterval = null;
    console.error("[pinocchio] Orphan detection stopped");
  }
}

/**
 * Get current orphan detection configuration
 */
export function getOrphanDetectionConfig(): OrphanDetectionConfig {
  return { ...cleanupConfig };
}

/**
 * Check if orphan detection is running
 */
export function isOrphanDetectionRunning(): boolean {
  return orphanCleanupInterval !== null;
}
