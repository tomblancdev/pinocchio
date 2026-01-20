/**
 * Test Utilities for Pinocchio Integration Tests
 *
 * Provides helper functions for creating test agents, spawn trees,
 * session tokens, and managing test state.
 */

import { v4 as uuidv4 } from 'uuid';
import { MockContainer, createMockRunningAgents } from './docker-mock.js';

// Types matching src/index.ts
export interface AgentMetadata {
  id: string;
  task: string;
  workspacePath: string;
  writablePaths: string[];
  startedAt: Date;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  endedAt?: Date;
  output?: string;
  tokenFilePath?: string;
  parentAgentId?: string;
  childAgentIds: string[];
  nestingDepth: number;
  treeId: string;
  sessionToken?: string;
}

export interface SpawnTree {
  treeId: string;
  rootAgentId: string;
  totalAgents: number;
  maxDepthReached: number;
  createdAt: Date;
  status: 'active' | 'terminated';
}

export interface NestedSpawnConfig {
  maxNestingDepth: number;
  maxAgentsPerTree: number;
  enableRecursiveSpawn: boolean;
}

/**
 * Default nested spawn configuration for tests
 */
export const DEFAULT_NESTED_SPAWN_CONFIG: NestedSpawnConfig = {
  maxNestingDepth: 3,
  maxAgentsPerTree: 10,
  enableRecursiveSpawn: true,
};

/**
 * Create a test agent metadata object
 */
export function createTestAgent(options: {
  id?: string;
  task?: string;
  workspacePath?: string;
  status?: 'running' | 'completed' | 'failed';
  parentAgentId?: string;
  childAgentIds?: string[];
  nestingDepth?: number;
  treeId?: string;
  sessionToken?: string;
}): AgentMetadata {
  const id = options.id || `agent-${uuidv4().slice(0, 8)}`;
  const treeId = options.treeId || `tree-${uuidv4().slice(0, 8)}`;

  return {
    id,
    task: options.task || 'Test task',
    workspacePath: options.workspacePath || '/test/workspace',
    writablePaths: [],
    startedAt: new Date(),
    status: options.status || 'running',
    parentAgentId: options.parentAgentId,
    childAgentIds: options.childAgentIds || [],
    nestingDepth: options.nestingDepth ?? 0,
    treeId,
    sessionToken: options.sessionToken,
  };
}

/**
 * Create a test spawn tree
 */
export function createTestSpawnTree(options: {
  treeId?: string;
  rootAgentId?: string;
  totalAgents?: number;
  maxDepthReached?: number;
  status?: 'active' | 'terminated';
}): SpawnTree {
  const treeId = options.treeId || `tree-${uuidv4().slice(0, 8)}`;
  const rootAgentId = options.rootAgentId || `agent-${uuidv4().slice(0, 8)}`;

  return {
    treeId,
    rootAgentId,
    totalAgents: options.totalAgents ?? 1,
    maxDepthReached: options.maxDepthReached ?? 0,
    createdAt: new Date(),
    status: options.status || 'active',
  };
}

/**
 * Create a hierarchy of test agents (parent-child relationships)
 */
export function createTestAgentHierarchy(options: {
  levels: number;
  childrenPerAgent?: number;
  treeId?: string;
}): { agents: Map<string, AgentMetadata>; tree: SpawnTree; rootAgentId: string } {
  const treeId = options.treeId || `tree-${uuidv4().slice(0, 8)}`;
  const childrenPerAgent = options.childrenPerAgent ?? 2;
  const agents = new Map<string, AgentMetadata>();

  // Create root agent
  const rootAgent = createTestAgent({
    treeId,
    nestingDepth: 0,
  });
  agents.set(rootAgent.id, rootAgent);

  // Create hierarchy
  let currentLevel = [rootAgent];
  for (let depth = 1; depth < options.levels; depth++) {
    const nextLevel: AgentMetadata[] = [];

    for (const parent of currentLevel) {
      for (let i = 0; i < childrenPerAgent; i++) {
        const child = createTestAgent({
          treeId,
          nestingDepth: depth,
          parentAgentId: parent.id,
        });
        agents.set(child.id, child);
        parent.childAgentIds.push(child.id);
        nextLevel.push(child);
      }
    }

    currentLevel = nextLevel;
  }

  const tree = createTestSpawnTree({
    treeId,
    rootAgentId: rootAgent.id,
    totalAgents: agents.size,
    maxDepthReached: options.levels - 1,
  });

  return { agents, tree, rootAgentId: rootAgent.id };
}

/**
 * Test state manager for managing agents and trees in tests
 */
export class TestStateManager {
  private agents = new Map<string, AgentMetadata>();
  private trees = new Map<string, SpawnTree>();
  private runningAgents = createMockRunningAgents();

  addAgent(agent: AgentMetadata): void {
    this.agents.set(agent.id, agent);
  }

  getAgent(agentId: string): AgentMetadata | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): Map<string, AgentMetadata> {
    return new Map(this.agents);
  }

  updateAgentStatus(agentId: string, status: 'completed' | 'failed', output?: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.endedAt = new Date();
      if (output) {
        agent.output = output;
      }
    }
  }

  addTree(tree: SpawnTree): void {
    this.trees.set(tree.treeId, tree);
  }

  getTree(treeId: string): SpawnTree | undefined {
    return this.trees.get(treeId);
  }

  terminateTree(treeId: string): void {
    const tree = this.trees.get(treeId);
    if (tree) {
      tree.status = 'terminated';
    }
  }

  addRunningAgent(agentId: string, container: MockContainer): void {
    this.runningAgents.set(agentId, container as any);
  }

  getRunningAgents(): Map<string, MockContainer> {
    return this.runningAgents as Map<string, MockContainer>;
  }

  clear(): void {
    this.agents.clear();
    this.trees.clear();
    this.runningAgents.clear();
  }
}

/**
 * Create mock updateMetadata callback for cascade termination tests
 */
export function createUpdateMetadataCallback(
  stateManager: TestStateManager
): (agentId: string, status: 'failed', output: string) => Promise<void> {
  return async (agentId: string, status: 'failed', output: string) => {
    stateManager.updateAgentStatus(agentId, status, output);
  };
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50
): Promise<void> {
  const startTime = Date.now();
  while (!condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Create a mock audit log function for testing
 */
export function createMockAuditLog(): {
  auditLog: (event: string, data: Record<string, unknown>, agentId?: string) => Promise<void>;
  getEvents: () => Array<{ event: string; data: Record<string, unknown>; agentId?: string }>;
  clear: () => void;
} {
  const events: Array<{ event: string; data: Record<string, unknown>; agentId?: string }> = [];

  return {
    auditLog: async (event: string, data: Record<string, unknown>, agentId?: string) => {
      events.push({ event, data, agentId });
    },
    getEvents: () => [...events],
    clear: () => {
      events.length = 0;
    },
  };
}
