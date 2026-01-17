/**
 * Ring Buffer for WebSocket Backpressure Handling
 * Issue #27: Real-time agent event streaming
 */

export class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private tail = 0;
  private size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  /**
   * Add an item to the buffer.
   * If the buffer is full, the oldest item is dropped silently.
   */
  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;

    if (this.size < this.capacity) {
      this.size++;
    } else {
      // Buffer was full, oldest item dropped
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /**
   * Remove and return the oldest item from the buffer.
   * Returns undefined if the buffer is empty.
   */
  shift(): T | undefined {
    if (this.size === 0) {
      return undefined;
    }

    const item = this.buffer[this.head];
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    return item;
  }

  /**
   * Return all items in the buffer as an array (oldest first).
   */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity]);
    }
    return result;
  }

  /**
   * Iterate over all items in the buffer.
   */
  forEach(callback: (item: T, index: number) => void): void {
    for (let i = 0; i < this.size; i++) {
      callback(this.buffer[(this.head + i) % this.capacity], i);
    }
  }

  /**
   * Find an item in the buffer.
   */
  find(predicate: (item: T) => boolean): T | undefined {
    for (let i = 0; i < this.size; i++) {
      const item = this.buffer[(this.head + i) % this.capacity];
      if (predicate(item)) {
        return item;
      }
    }
    return undefined;
  }

  /**
   * Filter items in the buffer.
   */
  filter(predicate: (item: T) => boolean): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const item = this.buffer[(this.head + i) % this.capacity];
      if (predicate(item)) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }

  /**
   * Get the current number of items in the buffer.
   */
  getSize(): number {
    return this.size;
  }

  /**
   * Get the maximum capacity of the buffer.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Check if the buffer is empty.
   */
  isEmpty(): boolean {
    return this.size === 0;
  }

  /**
   * Check if the buffer is full.
   */
  isFull(): boolean {
    return this.size === this.capacity;
  }
}

/**
 * Per-agent buffer manager for managing multiple ring buffers.
 */
export class AgentBufferManager<T> {
  private buffers: Map<string, RingBuffer<T>> = new Map();

  constructor(private bufferCapacity: number) {}

  /**
   * Get or create a buffer for an agent.
   */
  getBuffer(agentId: string): RingBuffer<T> {
    let buffer = this.buffers.get(agentId);
    if (!buffer) {
      buffer = new RingBuffer<T>(this.bufferCapacity);
      this.buffers.set(agentId, buffer);
    }
    return buffer;
  }

  /**
   * Push an item to an agent's buffer.
   */
  push(agentId: string, item: T): void {
    this.getBuffer(agentId).push(item);
  }

  /**
   * Get all items from an agent's buffer.
   */
  getItems(agentId: string): T[] {
    const buffer = this.buffers.get(agentId);
    return buffer ? buffer.toArray() : [];
  }

  /**
   * Clear an agent's buffer.
   */
  clearAgent(agentId: string): void {
    this.buffers.delete(agentId);
  }

  /**
   * Clear all buffers.
   */
  clearAll(): void {
    this.buffers.clear();
  }

  /**
   * Get all agent IDs with buffers.
   */
  getAgentIds(): string[] {
    return Array.from(this.buffers.keys());
  }
}
