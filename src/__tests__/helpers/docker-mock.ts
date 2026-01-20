/**
 * Docker Mock for Testing
 *
 * Provides mock implementations of Dockerode Container and Docker classes
 * for testing spawn, cascade termination, and agent lifecycle without
 * actual Docker operations.
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';

// Container status type
export type ContainerStatus = 'created' | 'running' | 'exited' | 'paused' | 'dead';

// Mock container state
export interface MockContainerState {
  id: string;
  name: string;
  status: ContainerStatus;
  exitCode: number;
  logs: string[];
  startTime?: Date;
  endTime?: Date;
}

/**
 * Mock Docker Container
 */
export class MockContainer {
  private state: MockContainerState;
  private onStopCallback?: () => void;
  private onKillCallback?: () => void;

  constructor(id: string, name?: string) {
    this.state = {
      id,
      name: name || `container-${id}`,
      status: 'created',
      exitCode: 0,
      logs: [],
    };
  }

  get id(): string {
    return this.state.id;
  }

  async start(): Promise<void> {
    if (this.state.status === 'running') {
      throw new Error('Container already running');
    }
    this.state.status = 'running';
    this.state.startTime = new Date();
  }

  async stop(): Promise<void> {
    if (this.state.status !== 'running') {
      throw new Error('Container not running');
    }
    this.state.status = 'exited';
    this.state.endTime = new Date();
    this.onStopCallback?.();
  }

  async kill(options?: { signal?: string }): Promise<void> {
    if (this.state.status !== 'running') {
      // Allow kill on non-running container (mimics Docker behavior)
      return;
    }
    this.state.status = 'exited';
    this.state.endTime = new Date();
    this.state.exitCode = options?.signal === 'SIGKILL' ? 137 : 143;
    this.onKillCallback?.();
  }

  async remove(options?: { force?: boolean }): Promise<void> {
    if (this.state.status === 'running' && !options?.force) {
      throw new Error('Container is running, use force to remove');
    }
    this.state.status = 'dead';
  }

  async wait(): Promise<{ StatusCode: number }> {
    // Simulate waiting for container to finish
    return { StatusCode: this.state.exitCode };
  }

  async inspect(): Promise<{ State: { Status: string; ExitCode: number; Running: boolean } }> {
    return {
      State: {
        Status: this.state.status,
        ExitCode: this.state.exitCode,
        Running: this.state.status === 'running',
      },
    };
  }

  logs(options?: { follow?: boolean; stdout?: boolean; stderr?: boolean }): Promise<Readable> {
    const containerState = this.state;
    const stream = new Readable({
      read() {
        // Push all logs
        for (const log of containerState?.logs || []) {
          this.push(Buffer.from(log + '\n'));
        }
        this.push(null); // End of stream
      },
    });

    return Promise.resolve(stream);
  }

  // Test helper methods
  setExitCode(code: number): void {
    this.state.exitCode = code;
  }

  addLog(message: string): void {
    this.state.logs.push(message);
  }

  getState(): MockContainerState {
    return { ...this.state };
  }

  onStop(callback: () => void): void {
    this.onStopCallback = callback;
  }

  onKill(callback: () => void): void {
    this.onKillCallback = callback;
  }
}

/**
 * Mock Docker client
 */
export class MockDocker {
  private containers = new Map<string, MockContainer>();
  private nextId = 1;

  async createContainer(options: {
    name?: string;
    Image?: string;
    Cmd?: string[];
    Env?: string[];
    HostConfig?: Record<string, unknown>;
  }): Promise<MockContainer> {
    const id = `mock-container-${this.nextId++}`;
    const container = new MockContainer(id, options.name);
    this.containers.set(id, container);
    return container;
  }

  getContainer(id: string): MockContainer {
    const container = this.containers.get(id);
    if (!container) {
      // Return a container that will throw on operations (mimics Docker behavior)
      return new MockContainer(id);
    }
    return container;
  }

  async listContainers(options?: { all?: boolean }): Promise<Array<{ Id: string; Names: string[]; State: string }>> {
    const result: Array<{ Id: string; Names: string[]; State: string }> = [];
    for (const [id, container] of this.containers) {
      const state = container.getState();
      if (options?.all || state.status === 'running') {
        result.push({
          Id: id,
          Names: [`/${state.name}`],
          State: state.status,
        });
      }
    }
    return result;
  }

  // Test helper methods
  getContainerById(id: string): MockContainer | undefined {
    return this.containers.get(id);
  }

  addContainer(container: MockContainer): void {
    this.containers.set(container.id, container);
  }

  clearContainers(): void {
    this.containers.clear();
  }

  getContainerCount(): number {
    return this.containers.size;
  }
}

/**
 * Create a mock runningAgents map for testing
 */
export function createMockRunningAgents(): Map<string, MockContainer> {
  return new Map();
}

/**
 * Factory function to create a mock Docker instance
 */
export function createMockDocker(): MockDocker {
  return new MockDocker();
}
