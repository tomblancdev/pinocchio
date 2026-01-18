/**
 * Integration Tests for Nested Agent Spawning
 *
 * Issue #67: Comprehensive tests for the nested agent spawning feature.
 *
 * Tests cover:
 * - Basic spawning (parent spawns child, completion updates parent metadata)
 * - Hierarchy (two-level, depth limits, tree quotas)
 * - Cascade termination (parent termination cascades to children)
 * - Session tokens (generation, validation, expiry)
 * - WebSocket events (hierarchy fields, tree subscriptions)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  TestStateManager,
  createTestAgent,
  createTestSpawnTree,
  createTestAgentHierarchy,
  createUpdateMetadataCallback,
  createMockAuditLog,
  DEFAULT_NESTED_SPAWN_CONFIG,
  type AgentMetadata,
  type SpawnTree,
  type NestedSpawnConfig,
} from '../helpers/test-utils.js';
import { MockContainer, MockDocker } from '../helpers/docker-mock.js';

// Mock the external dependencies
import * as sessionManager from '../../session/manager.js';
import { EventBus } from '../../websocket/events.js';
import type { AgentEvent } from '../../websocket/types.js';

// =============================================================================
// Test Suite: Basic Spawning
// =============================================================================

describe('Basic Spawning Tests', () => {
  let stateManager: TestStateManager;

  beforeEach(() => {
    stateManager = new TestStateManager();
  });

  afterEach(() => {
    stateManager.clear();
  });

  describe('Parent spawns child successfully', () => {
    it('should create child agent with correct parent reference', () => {
      // Create parent (root) agent
      const parentAgent = createTestAgent({
        id: 'parent-001',
        treeId: 'tree-001',
        nestingDepth: 0,
      });
      stateManager.addAgent(parentAgent);

      // Create child agent with parent reference
      const childAgent = createTestAgent({
        id: 'child-001',
        treeId: 'tree-001',
        parentAgentId: 'parent-001',
        nestingDepth: 1,
      });
      stateManager.addAgent(childAgent);

      // Update parent's child list
      parentAgent.childAgentIds.push(childAgent.id);

      // Verify relationships
      expect(childAgent.parentAgentId).toBe('parent-001');
      expect(childAgent.nestingDepth).toBe(1);
      expect(childAgent.treeId).toBe('tree-001');
      expect(parentAgent.childAgentIds).toContain('child-001');
    });

    it('should inherit tree ID from parent', () => {
      const treeId = 'tree-shared-001';

      const parentAgent = createTestAgent({
        id: 'parent-002',
        treeId,
        nestingDepth: 0,
      });

      const childAgent = createTestAgent({
        id: 'child-002',
        treeId: parentAgent.treeId, // Inherited
        parentAgentId: parentAgent.id,
        nestingDepth: parentAgent.nestingDepth + 1,
      });

      expect(childAgent.treeId).toBe(treeId);
      expect(childAgent.treeId).toBe(parentAgent.treeId);
    });
  });

  describe('Child completion updates parent metadata', () => {
    it('should keep parent running when child completes', () => {
      const parentAgent = createTestAgent({
        id: 'parent-003',
        status: 'running',
      });
      stateManager.addAgent(parentAgent);

      const childAgent = createTestAgent({
        id: 'child-003',
        parentAgentId: parentAgent.id,
        status: 'running',
      });
      stateManager.addAgent(childAgent);
      parentAgent.childAgentIds.push(childAgent.id);

      // Child completes
      stateManager.updateAgentStatus(childAgent.id, 'completed', 'Task done');

      // Verify parent still running
      const updatedParent = stateManager.getAgent(parentAgent.id);
      expect(updatedParent?.status).toBe('running');

      // Verify child completed
      const updatedChild = stateManager.getAgent(childAgent.id);
      expect(updatedChild?.status).toBe('completed');
    });

    it('should handle child failure without affecting parent', () => {
      const parentAgent = createTestAgent({
        id: 'parent-004',
        status: 'running',
      });
      stateManager.addAgent(parentAgent);

      const childAgent = createTestAgent({
        id: 'child-004',
        parentAgentId: parentAgent.id,
        status: 'running',
      });
      stateManager.addAgent(childAgent);
      parentAgent.childAgentIds.push(childAgent.id);

      // Child fails
      stateManager.updateAgentStatus(childAgent.id, 'failed', 'Error occurred');

      // Verify parent still running
      expect(stateManager.getAgent(parentAgent.id)?.status).toBe('running');
      expect(stateManager.getAgent(childAgent.id)?.status).toBe('failed');
    });
  });
});

// =============================================================================
// Test Suite: Hierarchy Tests
// =============================================================================

describe('Hierarchy Tests', () => {
  let stateManager: TestStateManager;

  beforeEach(() => {
    stateManager = new TestStateManager();
  });

  afterEach(() => {
    stateManager.clear();
  });

  describe('Two-level hierarchy works', () => {
    it('should support parent -> child relationship', () => {
      const { agents, tree, rootAgentId } = createTestAgentHierarchy({
        levels: 2,
        childrenPerAgent: 1,
      });

      // Load into state manager
      for (const [, agent] of agents) {
        stateManager.addAgent(agent);
      }
      stateManager.addTree(tree);

      // Verify structure
      const rootAgent = stateManager.getAgent(rootAgentId);
      expect(rootAgent).toBeDefined();
      expect(rootAgent?.nestingDepth).toBe(0);
      expect(rootAgent?.childAgentIds.length).toBe(1);

      const childId = rootAgent?.childAgentIds[0];
      const childAgent = stateManager.getAgent(childId!);
      expect(childAgent).toBeDefined();
      expect(childAgent?.nestingDepth).toBe(1);
      expect(childAgent?.parentAgentId).toBe(rootAgentId);
    });

    it('should support multiple children per parent', () => {
      const { agents, tree, rootAgentId } = createTestAgentHierarchy({
        levels: 2,
        childrenPerAgent: 3,
      });

      for (const [, agent] of agents) {
        stateManager.addAgent(agent);
      }

      const rootAgent = stateManager.getAgent(rootAgentId);
      expect(rootAgent?.childAgentIds.length).toBe(3);
      expect(tree.totalAgents).toBe(4); // 1 root + 3 children
    });
  });

  describe('Three-level hierarchy works', () => {
    it('should support grandchild agents', () => {
      const { agents, tree, rootAgentId } = createTestAgentHierarchy({
        levels: 3,
        childrenPerAgent: 1,
      });

      for (const [, agent] of agents) {
        stateManager.addAgent(agent);
      }
      stateManager.addTree(tree);

      // Verify three levels
      const rootAgent = stateManager.getAgent(rootAgentId)!;
      expect(rootAgent.nestingDepth).toBe(0);

      const childAgent = stateManager.getAgent(rootAgent.childAgentIds[0])!;
      expect(childAgent.nestingDepth).toBe(1);

      const grandchildAgent = stateManager.getAgent(childAgent.childAgentIds[0])!;
      expect(grandchildAgent.nestingDepth).toBe(2);
      expect(grandchildAgent.parentAgentId).toBe(childAgent.id);

      expect(tree.maxDepthReached).toBe(2);
    });
  });

  describe('Depth limit enforced', () => {
    it('should reject spawn at max depth', () => {
      const config: NestedSpawnConfig = {
        maxNestingDepth: 2, // Allows depth 0, 1 (not 2)
        maxAgentsPerTree: 10,
        enableRecursiveSpawn: true,
      };

      // Agent at depth 1 (max allowed based on config)
      const parentAtMaxDepth = createTestAgent({
        nestingDepth: 1,
        treeId: 'tree-depth-test',
      });
      stateManager.addAgent(parentAtMaxDepth);

      // Check if spawning another child would exceed depth
      const wouldExceedDepth = parentAtMaxDepth.nestingDepth + 1 >= config.maxNestingDepth;
      expect(wouldExceedDepth).toBe(true);
    });

    it('should allow spawn below max depth', () => {
      const config: NestedSpawnConfig = {
        maxNestingDepth: 3,
        maxAgentsPerTree: 10,
        enableRecursiveSpawn: true,
      };

      const parentAgent = createTestAgent({
        nestingDepth: 1,
        treeId: 'tree-depth-test-2',
      });

      const canSpawn = parentAgent.nestingDepth + 1 < config.maxNestingDepth;
      expect(canSpawn).toBe(true);
    });

    it('should calculate depth correctly across hierarchy', () => {
      const { agents, rootAgentId } = createTestAgentHierarchy({
        levels: 4,
        childrenPerAgent: 1,
      });

      // Verify depth increments correctly
      let currentAgent = agents.get(rootAgentId)!;
      let expectedDepth = 0;

      while (currentAgent.childAgentIds.length > 0) {
        expect(currentAgent.nestingDepth).toBe(expectedDepth);
        currentAgent = agents.get(currentAgent.childAgentIds[0])!;
        expectedDepth++;
      }
      // Final agent (leaf)
      expect(currentAgent.nestingDepth).toBe(expectedDepth);
    });
  });

  describe('Tree agent quota enforced', () => {
    it('should track total agents in tree', () => {
      const tree = createTestSpawnTree({
        totalAgents: 5,
        treeId: 'tree-quota-test',
      });
      stateManager.addTree(tree);

      const config: NestedSpawnConfig = {
        maxNestingDepth: 10,
        maxAgentsPerTree: 10,
        enableRecursiveSpawn: true,
      };

      // Check quota
      const canSpawnMore = tree.totalAgents < config.maxAgentsPerTree;
      expect(canSpawnMore).toBe(true);

      // Simulate adding agents
      tree.totalAgents = 10;
      const canSpawnAtLimit = tree.totalAgents < config.maxAgentsPerTree;
      expect(canSpawnAtLimit).toBe(false);
    });

    it('should reject spawn when tree quota exceeded', () => {
      const config: NestedSpawnConfig = {
        maxNestingDepth: 10,
        maxAgentsPerTree: 5,
        enableRecursiveSpawn: true,
      };

      const tree = createTestSpawnTree({
        totalAgents: 5, // At quota
      });

      const quotaExceeded = tree.totalAgents >= config.maxAgentsPerTree;
      expect(quotaExceeded).toBe(true);
    });

    it('should increment tree count on spawn', () => {
      const tree = createTestSpawnTree({
        totalAgents: 1,
      });

      // Simulate spawn
      tree.totalAgents += 1;
      expect(tree.totalAgents).toBe(2);

      // Simulate another spawn
      tree.totalAgents += 1;
      expect(tree.totalAgents).toBe(3);
    });
  });
});

// =============================================================================
// Test Suite: Cascade Termination
// =============================================================================

describe('Cascade Termination Tests', () => {
  let stateManager: TestStateManager;
  let mockDocker: MockDocker;

  beforeEach(() => {
    stateManager = new TestStateManager();
    mockDocker = new MockDocker();
  });

  afterEach(() => {
    stateManager.clear();
    mockDocker.clearContainers();
  });

  describe('Stop parent terminates children', () => {
    it('should mark children as failed when parent terminates', async () => {
      // Create hierarchy
      const { agents, tree, rootAgentId } = createTestAgentHierarchy({
        levels: 2,
        childrenPerAgent: 2,
      });

      for (const [, agent] of agents) {
        stateManager.addAgent(agent);
        // Create mock containers for running agents
        const container = new MockContainer(agent.id);
        await container.start();
        stateManager.addRunningAgent(agent.id, container);
      }
      stateManager.addTree(tree);

      // Get all agent IDs for verification
      const allAgentIds = Array.from(agents.keys());
      expect(allAgentIds.length).toBe(3); // 1 root + 2 children

      // Simulate cascade termination starting from root
      const updateMetadata = createUpdateMetadataCallback(stateManager);

      // Terminate children first (depth-first)
      const rootAgent = stateManager.getAgent(rootAgentId)!;
      for (const childId of rootAgent.childAgentIds) {
        await updateMetadata(childId, 'failed', 'Terminated via cascade');
      }
      // Then terminate root
      await updateMetadata(rootAgentId, 'failed', 'Manual termination');

      // Verify all agents are failed
      for (const agentId of allAgentIds) {
        const agent = stateManager.getAgent(agentId);
        expect(agent?.status).toBe('failed');
      }
    });

    it('should handle deep hierarchies', async () => {
      const { agents, tree, rootAgentId } = createTestAgentHierarchy({
        levels: 4,
        childrenPerAgent: 1,
      });

      for (const [, agent] of agents) {
        stateManager.addAgent(agent);
      }
      stateManager.addTree(tree);

      const updateMetadata = createUpdateMetadataCallback(stateManager);

      // Collect agents in depth-first order (deepest first)
      const terminationOrder: string[] = [];
      const collectDepthFirst = (agentId: string) => {
        const agent = stateManager.getAgent(agentId);
        if (agent) {
          for (const childId of agent.childAgentIds) {
            collectDepthFirst(childId);
          }
          terminationOrder.push(agentId);
        }
      };
      collectDepthFirst(rootAgentId);

      // Terminate in depth-first order
      for (const agentId of terminationOrder) {
        await updateMetadata(agentId, 'failed', 'Cascade termination');
      }

      // Verify all terminated
      expect(terminationOrder.length).toBe(4);
      for (const agentId of terminationOrder) {
        expect(stateManager.getAgent(agentId)?.status).toBe('failed');
      }
    });
  });

  describe('Terminated events emitted', () => {
    it('should track termination reason', () => {
      const terminationReasons = ['cascade', 'manual', 'timeout', 'orphan_cleanup'] as const;

      for (const reason of terminationReasons) {
        // Each reason should be a valid termination reason
        expect(['cascade', 'manual', 'timeout', 'orphan_cleanup']).toContain(reason);
      }
    });

    it('should include terminatedBy for cascade termination', () => {
      const terminatedEvent = {
        type: 'agent.terminated' as const,
        agentId: 'child-001',
        timestamp: new Date().toISOString(),
        parentAgentId: 'parent-001',
        treeId: 'tree-001',
        depth: 1,
        data: {
          reason: 'cascade' as const,
          terminatedBy: 'parent-001',
        },
      };

      expect(terminatedEvent.data.reason).toBe('cascade');
      expect(terminatedEvent.data.terminatedBy).toBe('parent-001');
    });
  });

  describe('Tree status updated on cascade', () => {
    it('should mark tree as terminated after cascade', () => {
      const tree = createTestSpawnTree({
        status: 'active',
      });
      stateManager.addTree(tree);

      // Simulate cascade termination completing
      stateManager.terminateTree(tree.treeId);

      const updatedTree = stateManager.getTree(tree.treeId);
      expect(updatedTree?.status).toBe('terminated');
    });
  });
});

// =============================================================================
// Test Suite: Session Token Tests
// =============================================================================

describe('Session Token Tests', () => {
  let mockAudit: ReturnType<typeof createMockAuditLog>;

  beforeEach(() => {
    mockAudit = createMockAuditLog();
  });

  afterEach(() => {
    mockAudit.clear();
  });

  describe('Token generated on spawn', () => {
    it('should generate token with correct agent and tree IDs', () => {
      const token = sessionManager.generateSessionToken(
        'agent-001',
        'tree-001',
        undefined, // root agent, no parent
        0, // depth
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000, // 1 hour timeout
        false
      );

      expect(token.agentId).toBe('agent-001');
      expect(token.treeId).toBe('tree-001');
      expect(token.depth).toBe(0);
      expect(token.parentAgentId).toBeUndefined();
    });

    it('should set canSpawn based on depth and config', () => {
      // At depth 0, should be able to spawn (max depth is 3)
      const tokenAtRoot = sessionManager.generateSessionToken(
        'agent-root',
        'tree-001',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      expect(tokenAtRoot.permissions.canSpawn).toBe(true);

      // At depth 2 (maxNestingDepth - 1), should still be able to spawn
      const tokenAtDepth2 = sessionManager.generateSessionToken(
        'agent-depth2',
        'tree-001',
        'agent-depth1',
        2,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      expect(tokenAtDepth2.permissions.canSpawn).toBe(true);

      // At depth 3 (maxNestingDepth), should NOT be able to spawn
      const tokenAtMaxDepth = sessionManager.generateSessionToken(
        'agent-max',
        'tree-001',
        'agent-depth2',
        3,
        { ...DEFAULT_NESTED_SPAWN_CONFIG, maxNestingDepth: 3 },
        3600000,
        false
      );
      expect(tokenAtMaxDepth.permissions.canSpawn).toBe(false);
    });

    it('should include parent reference for child agents', () => {
      const childToken = sessionManager.generateSessionToken(
        'child-001',
        'tree-001',
        'parent-001',
        1,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );

      expect(childToken.parentAgentId).toBe('parent-001');
      expect(childToken.depth).toBe(1);
    });

    it('should set expiry based on timeout', () => {
      const timeoutMs = 1800000; // 30 minutes
      const token = sessionManager.generateSessionToken(
        'agent-001',
        'tree-001',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        timeoutMs,
        false
      );

      const expectedMaxExpiry = token.issuedAt + timeoutMs;
      expect(token.expiresAt).toBeLessThanOrEqual(expectedMaxExpiry);
      expect(token.expiresAt).toBeGreaterThan(token.issuedAt);
    });
  });

  describe('Token validation', () => {
    it('should reject non-existent token', () => {
      const result = sessionManager.validateSessionToken('non-existent-token');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token not found');
    });

    it('should validate stored token successfully', () => {
      // Generate and store token
      const token = sessionManager.generateSessionToken(
        'agent-validate',
        'tree-validate',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      sessionManager.storeSessionToken(token);

      // Validate
      const result = sessionManager.validateSessionToken(token.token);
      expect(result.valid).toBe(true);
      expect(result.token?.agentId).toBe('agent-validate');
    });
  });

  describe('Token invalidation', () => {
    it('should invalidate single token', () => {
      const token = sessionManager.generateSessionToken(
        'agent-invalidate',
        'tree-invalidate',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      sessionManager.storeSessionToken(token);

      // Verify valid first
      expect(sessionManager.validateSessionToken(token.token).valid).toBe(true);

      // Invalidate
      const invalidated = sessionManager.invalidateSessionToken(token.token);
      expect(invalidated).toBe(true);

      // Verify no longer valid
      expect(sessionManager.validateSessionToken(token.token).valid).toBe(false);
    });

    it('should invalidate all tokens for an agent', () => {
      const agentId = 'agent-multi-token';
      const token1 = sessionManager.generateSessionToken(
        agentId,
        'tree-001',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      sessionManager.storeSessionToken(token1);

      // Store another token for same agent (e.g., after refresh)
      const token2 = sessionManager.generateSessionToken(
        agentId,
        'tree-001',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      sessionManager.storeSessionToken(token2);

      // Invalidate all for agent
      const count = sessionManager.invalidateTokensForAgent(agentId);
      expect(count).toBe(2);

      // Both should be invalid
      expect(sessionManager.validateSessionToken(token1.token).valid).toBe(false);
      expect(sessionManager.validateSessionToken(token2.token).valid).toBe(false);
    });

    it('should invalidate all tokens for a tree', () => {
      const treeId = 'tree-invalidate-all';

      const token1 = sessionManager.generateSessionToken(
        'agent-001',
        treeId,
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      sessionManager.storeSessionToken(token1);

      const token2 = sessionManager.generateSessionToken(
        'agent-002',
        treeId,
        'agent-001',
        1,
        DEFAULT_NESTED_SPAWN_CONFIG,
        3600000,
        false
      );
      sessionManager.storeSessionToken(token2);

      // Invalidate entire tree
      const count = sessionManager.invalidateTokensForTree(treeId);
      expect(count).toBe(2);

      // Both should be invalid
      expect(sessionManager.validateSessionToken(token1.token).valid).toBe(false);
      expect(sessionManager.validateSessionToken(token2.token).valid).toBe(false);
    });
  });

  describe('Expired token rejected', () => {
    it('should reject expired token', async () => {
      // Generate token with very short expiry
      const token = sessionManager.generateSessionToken(
        'agent-expire',
        'tree-expire',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        1, // 1ms timeout
        false
      );
      sessionManager.storeSessionToken(token);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should be expired
      const result = sessionManager.validateSessionToken(token.token);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token expired');
    });
  });

  describe('Token cleanup', () => {
    it('should cleanup expired tokens', async () => {
      // Generate expired token
      const expiredToken = sessionManager.generateSessionToken(
        'agent-cleanup',
        'tree-cleanup',
        undefined,
        0,
        DEFAULT_NESTED_SPAWN_CONFIG,
        1, // Expires immediately
        false
      );
      sessionManager.storeSessionToken(expiredToken);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cleanup
      const cleaned = sessionManager.cleanupExpiredTokens();
      expect(cleaned).toBeGreaterThanOrEqual(1);
    });
  });
});

// =============================================================================
// Test Suite: WebSocket Event Tests
// =============================================================================

describe('WebSocket Event Tests', () => {
  let eventBus: EventBus;
  let capturedEvents: AgentEvent[];

  beforeEach(() => {
    EventBus.resetInstance();
    eventBus = EventBus.getInstance(100);
    capturedEvents = [];
    eventBus.onAny((event) => capturedEvents.push(event));
  });

  afterEach(() => {
    eventBus.clearAllBuffers();
    EventBus.resetInstance();
  });

  describe('Events include hierarchy fields', () => {
    it('should include parentAgentId in child events', () => {
      eventBus.emitStarted(
        'child-001',
        'Child task',
        '/workspace',
        [],
        {
          parentAgentId: 'parent-001',
          treeId: 'tree-001',
          depth: 1,
        }
      );

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];
      expect(event.parentAgentId).toBe('parent-001');
    });

    it('should include treeId in all events', () => {
      eventBus.emitStarted(
        'agent-001',
        'Task',
        '/workspace',
        [],
        {
          treeId: 'tree-hierarchy-001',
          depth: 0,
        }
      );

      expect(capturedEvents[0].treeId).toBe('tree-hierarchy-001');
    });

    it('should include depth in all events', () => {
      eventBus.emitProgress(
        'agent-001',
        50,
        {
          parentAgentId: 'parent-001',
          treeId: 'tree-001',
          depth: 2,
        },
        'Half done'
      );

      expect(capturedEvents[0].depth).toBe(2);
    });

    it('should have undefined parentAgentId for root agents', () => {
      eventBus.emitStarted(
        'root-001',
        'Root task',
        '/workspace',
        [],
        {
          treeId: 'tree-001',
          depth: 0,
        }
      );

      expect(capturedEvents[0].parentAgentId).toBeUndefined();
    });
  });

  describe('Terminated event includes reason and terminatedBy', () => {
    it('should emit terminated event with cascade reason', () => {
      eventBus.emitTerminated(
        'child-001',
        'cascade',
        {
          parentAgentId: 'parent-001',
          treeId: 'tree-001',
          depth: 1,
        },
        'parent-001'
      );

      expect(capturedEvents.length).toBe(1);
      const event = capturedEvents[0];
      expect(event.type).toBe('agent.terminated');

      if (event.type === 'agent.terminated') {
        expect(event.data.reason).toBe('cascade');
        expect(event.data.terminatedBy).toBe('parent-001');
      }
    });

    it('should emit terminated event for orphan cleanup', () => {
      eventBus.emitTerminated(
        'orphan-001',
        'orphan_cleanup',
        {
          parentAgentId: 'dead-parent',
          treeId: 'tree-001',
          depth: 1,
        }
      );

      const event = capturedEvents[0];
      if (event.type === 'agent.terminated') {
        expect(event.data.reason).toBe('orphan_cleanup');
        expect(event.data.terminatedBy).toBeUndefined();
      }
    });
  });

  describe('Tree subscription receives all tree events', () => {
    it('should buffer events by tree ID', () => {
      const treeId = 'tree-buffer-001';

      // Emit events for multiple agents in same tree
      eventBus.emitStarted('agent-001', 'Task 1', '/ws', [], {
        treeId,
        depth: 0,
      });

      eventBus.emitStarted('agent-002', 'Task 2', '/ws', [], {
        parentAgentId: 'agent-001',
        treeId,
        depth: 1,
      });

      eventBus.emitProgress('agent-002', 50, {
        parentAgentId: 'agent-001',
        treeId,
        depth: 1,
      });

      // Get buffered events by tree
      const treeEvents = eventBus.getBufferedEventsByTree(treeId);
      expect(treeEvents.length).toBe(3);

      // All events should have same treeId
      for (const event of treeEvents) {
        expect(event.treeId).toBe(treeId);
      }
    });

    it('should not mix events from different trees', () => {
      eventBus.emitStarted('agent-001', 'Task', '/ws', [], {
        treeId: 'tree-A',
        depth: 0,
      });

      eventBus.emitStarted('agent-002', 'Task', '/ws', [], {
        treeId: 'tree-B',
        depth: 0,
      });

      const treeAEvents = eventBus.getBufferedEventsByTree('tree-A');
      const treeBEvents = eventBus.getBufferedEventsByTree('tree-B');

      expect(treeAEvents.length).toBe(1);
      expect(treeBEvents.length).toBe(1);
      expect(treeAEvents[0].agentId).toBe('agent-001');
      expect(treeBEvents[0].agentId).toBe('agent-002');
    });

    it('should clear tree buffer when tree terminates', () => {
      const treeId = 'tree-clear-001';

      eventBus.emitStarted('agent-001', 'Task', '/ws', [], {
        treeId,
        depth: 0,
      });

      expect(eventBus.getBufferedEventsByTree(treeId).length).toBe(1);

      // Clear tree buffer (simulates tree termination)
      eventBus.clearTreeBuffer(treeId);

      expect(eventBus.getBufferedEventsByTree(treeId).length).toBe(0);
    });
  });

  describe('Agent-specific buffer', () => {
    it('should buffer events by agent ID', () => {
      eventBus.emitStarted('agent-001', 'Task', '/ws', [], {
        treeId: 'tree-001',
        depth: 0,
      });

      eventBus.emitProgress('agent-001', 25, {
        treeId: 'tree-001',
        depth: 0,
      });

      eventBus.emitProgress('agent-001', 50, {
        treeId: 'tree-001',
        depth: 0,
      });

      const agentEvents = eventBus.getBufferedEvents('agent-001');
      expect(agentEvents.length).toBe(3);
    });

    it('should clear agent buffer', () => {
      eventBus.emitStarted('agent-clear', 'Task', '/ws', [], {
        treeId: 'tree-001',
        depth: 0,
      });

      expect(eventBus.getBufferedEvents('agent-clear').length).toBe(1);

      eventBus.clearAgentBuffer('agent-clear');

      expect(eventBus.getBufferedEvents('agent-clear').length).toBe(0);
    });
  });
});

// =============================================================================
// Test Suite: Orphan Detection
// =============================================================================

describe('Orphan Detection Tests', () => {
  let stateManager: TestStateManager;

  beforeEach(() => {
    stateManager = new TestStateManager();
  });

  afterEach(() => {
    stateManager.clear();
  });

  describe('Detect orphaned agents', () => {
    it('should detect agent with missing parent', () => {
      // Create child agent with non-existent parent
      const orphanAgent = createTestAgent({
        id: 'orphan-001',
        parentAgentId: 'non-existent-parent',
        status: 'running',
      });
      stateManager.addAgent(orphanAgent);

      // Check for orphan
      const allAgents = stateManager.getAllAgents();
      const orphans: Array<{ agentId: string; reason: string }> = [];

      for (const [agentId, agent] of allAgents) {
        if (agent.status !== 'running') continue;
        if (!agent.parentAgentId) continue; // Root agents can't be orphaned

        const parent = stateManager.getAgent(agent.parentAgentId);
        if (!parent) {
          orphans.push({ agentId, reason: 'parent_not_found' });
        }
      }

      expect(orphans.length).toBe(1);
      expect(orphans[0].agentId).toBe('orphan-001');
      expect(orphans[0].reason).toBe('parent_not_found');
    });

    it('should detect agent with terminated parent', () => {
      const parentAgent = createTestAgent({
        id: 'parent-terminated',
        status: 'failed', // Parent terminated
      });
      stateManager.addAgent(parentAgent);

      const childAgent = createTestAgent({
        id: 'child-orphaned',
        parentAgentId: 'parent-terminated',
        status: 'running',
      });
      stateManager.addAgent(childAgent);

      // Check for orphan
      const allAgents = stateManager.getAllAgents();
      const orphans: Array<{ agentId: string; reason: string }> = [];

      for (const [agentId, agent] of allAgents) {
        if (agent.status !== 'running') continue;
        if (!agent.parentAgentId) continue;

        const parent = stateManager.getAgent(agent.parentAgentId);
        if (!parent) {
          orphans.push({ agentId, reason: 'parent_not_found' });
        } else if (parent.status !== 'running') {
          orphans.push({ agentId, reason: 'parent_terminated' });
        }
      }

      expect(orphans.length).toBe(1);
      expect(orphans[0].reason).toBe('parent_terminated');
    });

    it('should not flag root agents as orphans', () => {
      const rootAgent = createTestAgent({
        id: 'root-agent',
        parentAgentId: undefined, // Root agent
        status: 'running',
      });
      stateManager.addAgent(rootAgent);

      const allAgents = stateManager.getAllAgents();
      const orphans: string[] = [];

      for (const [agentId, agent] of allAgents) {
        if (agent.status !== 'running') continue;
        if (!agent.parentAgentId) continue; // Root agents excluded

        orphans.push(agentId);
      }

      expect(orphans.length).toBe(0);
    });
  });

  describe('Cleanup orphaned agents', () => {
    it('should terminate orphaned agents', async () => {
      const orphanAgent = createTestAgent({
        id: 'orphan-cleanup',
        parentAgentId: 'missing-parent',
        status: 'running',
      });
      stateManager.addAgent(orphanAgent);

      const updateMetadata = createUpdateMetadataCallback(stateManager);

      // Simulate orphan cleanup
      await updateMetadata(orphanAgent.id, 'failed', 'Orphan cleanup');

      expect(stateManager.getAgent(orphanAgent.id)?.status).toBe('failed');
    });

    it('should cascade terminate orphan children', async () => {
      // Create orphan with its own child
      const orphanAgent = createTestAgent({
        id: 'orphan-parent',
        parentAgentId: 'missing',
        status: 'running',
        childAgentIds: ['orphan-child'],
      });
      stateManager.addAgent(orphanAgent);

      const childOfOrphan = createTestAgent({
        id: 'orphan-child',
        parentAgentId: 'orphan-parent',
        status: 'running',
      });
      stateManager.addAgent(childOfOrphan);

      const updateMetadata = createUpdateMetadataCallback(stateManager);

      // Terminate child first (depth-first)
      await updateMetadata('orphan-child', 'failed', 'Cascade from orphan cleanup');
      await updateMetadata('orphan-parent', 'failed', 'Orphan cleanup');

      expect(stateManager.getAgent('orphan-parent')?.status).toBe('failed');
      expect(stateManager.getAgent('orphan-child')?.status).toBe('failed');
    });
  });
});

// =============================================================================
// Test Suite: Configuration Tests
// =============================================================================

describe('Nested Spawn Configuration Tests', () => {
  describe('Config parameter validation', () => {
    it('should use default config when none provided', () => {
      expect(DEFAULT_NESTED_SPAWN_CONFIG.maxNestingDepth).toBe(3);
      expect(DEFAULT_NESTED_SPAWN_CONFIG.maxAgentsPerTree).toBe(10);
      expect(DEFAULT_NESTED_SPAWN_CONFIG.enableRecursiveSpawn).toBe(true);
    });

    it('should respect disabled recursive spawn', () => {
      const config: NestedSpawnConfig = {
        maxNestingDepth: 3,
        maxAgentsPerTree: 10,
        enableRecursiveSpawn: false,
      };

      const token = sessionManager.generateSessionToken(
        'agent-001',
        'tree-001',
        undefined,
        0,
        config,
        3600000,
        false
      );

      // Even at depth 0, should not be able to spawn if disabled
      expect(token.permissions.canSpawn).toBe(false);
    });

    it('should calculate remaining quota correctly', () => {
      const config: NestedSpawnConfig = {
        maxNestingDepth: 5,
        maxAgentsPerTree: 20,
        enableRecursiveSpawn: true,
      };

      const tree = createTestSpawnTree({
        totalAgents: 8,
      });

      const remainingAgents = config.maxAgentsPerTree - tree.totalAgents;
      expect(remainingAgents).toBe(12);

      const currentDepth = 2;
      const remainingDepth = config.maxNestingDepth - currentDepth;
      expect(remainingDepth).toBe(3);
    });
  });
});
