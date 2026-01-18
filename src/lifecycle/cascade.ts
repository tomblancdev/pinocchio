/**
 * Cascade Termination (Issue #58)
 *
 * Implements cascade termination so when a parent agent terminates,
 * all its children are also terminated.
 */

import Docker from "dockerode";
import {
  getAgentMetadata,
  getSpawnTree,
  AgentMetadata,
  SpawnTree,
  cleanupTokenFile,
} from "../index.js";
import {
  invalidateTokensForAgent,
  invalidateTokensForTree,
  invalidateSessionToken,
} from "../session/index.js";

// Docker client for container operations
const docker = new Docker();

/**
 * Result of a cascade termination operation
 */
export interface CascadeTerminationResult {
  /** IDs of agents successfully terminated */
  terminated: string[];
  /** IDs of agents that failed to terminate with error messages */
  failed: Array<{ agentId: string; error: string }>;
  /** Total number of agents processed */
  totalProcessed: number;
}

/**
 * Recursively terminate an agent and all its descendants (depth-first).
 *
 * Children are terminated first to ensure proper cleanup order.
 * Session tokens are invalidated for each agent.
 *
 * @param agentId - The ID of the agent to terminate
 * @param signal - The signal to send (default: 'SIGTERM')
 * @param updateMetadata - Callback to update agent metadata after termination
 * @param runningAgents - Map of running agent containers
 * @returns Result containing terminated and failed agent IDs
 */
export async function terminateWithChildren(
  agentId: string,
  signal: string = "SIGTERM",
  updateMetadata: (agentId: string, status: "failed", output: string) => Promise<void>,
  runningAgents: Map<string, Docker.Container>
): Promise<CascadeTerminationResult> {
  const result: CascadeTerminationResult = {
    terminated: [],
    failed: [],
    totalProcessed: 0,
  };

  const metadata = getAgentMetadata(agentId);
  if (!metadata) {
    console.error(`[pinocchio] Cascade termination: Agent ${agentId} not found`);
    return result;
  }

  // Terminate children first (depth-first traversal)
  for (const childId of metadata.childAgentIds) {
    const childResult = await terminateWithChildren(childId, signal, updateMetadata, runningAgents);
    result.terminated.push(...childResult.terminated);
    result.failed.push(...childResult.failed);
    result.totalProcessed += childResult.totalProcessed;
  }

  // Now terminate this agent
  result.totalProcessed++;

  try {
    // Only terminate if the agent is still running
    if (metadata.status === "running") {
      // Invalidate session tokens for this agent
      if (metadata.sessionToken) {
        invalidateSessionToken(metadata.sessionToken);
      }
      invalidateTokensForAgent(agentId);

      // Clean up token file for this agent (SECURITY FIX #8)
      if (metadata.tokenFilePath) {
        await cleanupTokenFile(metadata.tokenFilePath);
      }

      // Stop the container
      const container = runningAgents.get(agentId);
      if (container) {
        try {
          // Use kill() for SIGKILL, stop() for SIGTERM (default graceful shutdown)
          if (signal === "SIGKILL") {
            await container.kill({ signal });
          } else {
            await container.stop();
          }
          await container.remove({ force: true });
        } catch (containerError) {
          // Container might already be stopped/removed
          console.error(`[pinocchio] Cascade termination: Container operation for ${agentId}: ${containerError}`);
        }
        runningAgents.delete(agentId);
      } else {
        // Try to get container directly by ID (might not be in runningAgents map)
        try {
          const directContainer = docker.getContainer(agentId);
          // Use kill() for SIGKILL, stop() for SIGTERM (default graceful shutdown)
          if (signal === "SIGKILL") {
            await directContainer.kill({ signal });
          } else {
            await directContainer.stop();
          }
          await directContainer.remove({ force: true });
        } catch (directError) {
          // Container might not exist or already be stopped
          console.error(`[pinocchio] Cascade termination: Direct container lookup for ${agentId}: ${directError}`);
        }
      }

      // Update metadata
      await updateMetadata(agentId, "failed", "[pinocchio] Agent terminated via cascade termination");
      result.terminated.push(agentId);
      console.error(`[pinocchio] Cascade termination: Terminated agent ${agentId}`);
    } else if (metadata.status === "completed" || metadata.status === "failed") {
      // Skip already terminated agents - don't count them as "terminated" by this operation
      console.error(`[pinocchio] Cascade termination: Agent ${agentId} already terminated (status: ${metadata.status}), skipping`);
    } else {
      // Agent in unknown status, log but don't add to terminated list
      console.error(`[pinocchio] Cascade termination: Agent ${agentId} in unexpected status: ${metadata.status}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.failed.push({ agentId, error: errorMessage });
    console.error(`[pinocchio] Cascade termination: Failed to terminate ${agentId}: ${errorMessage}`);
  }

  return result;
}

/**
 * Terminate an entire spawn tree by its tree ID.
 *
 * Finds the root agent of the tree and terminates it along with all descendants.
 * Also invalidates all session tokens for the tree.
 *
 * @param treeId - The ID of the spawn tree to terminate
 * @param updateMetadata - Callback to update agent metadata after termination
 * @param runningAgents - Map of running agent containers
 * @returns Result containing terminated and failed agent IDs
 */
export async function terminateTree(
  treeId: string,
  updateMetadata: (agentId: string, status: "failed", output: string) => Promise<void>,
  runningAgents: Map<string, Docker.Container>
): Promise<CascadeTerminationResult> {
  const result: CascadeTerminationResult = {
    terminated: [],
    failed: [],
    totalProcessed: 0,
  };

  const tree = getSpawnTree(treeId);
  if (!tree) {
    console.error(`[pinocchio] Cascade termination: Spawn tree ${treeId} not found`);
    return result;
  }

  if (tree.status === "terminated") {
    console.error(`[pinocchio] Cascade termination: Spawn tree ${treeId} already terminated`);
    return result;
  }

  // Invalidate all tokens for this tree upfront
  invalidateTokensForTree(treeId);

  // Terminate starting from the root agent (this will cascade to all children)
  const cascadeResult = await terminateWithChildren(
    tree.rootAgentId,
    "SIGTERM",
    updateMetadata,
    runningAgents
  );

  result.terminated = cascadeResult.terminated;
  result.failed = cascadeResult.failed;
  result.totalProcessed = cascadeResult.totalProcessed;

  console.error(`[pinocchio] Cascade termination: Tree ${treeId} terminated. ` +
    `Terminated: ${result.terminated.length}, Failed: ${result.failed.length}`);

  return result;
}
