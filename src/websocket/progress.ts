/**
 * Progress Tracker for Claude Agent Output Analysis
 * Parses unstructured log output and estimates task progress
 */

// ============================================================================
// Pattern Definitions
// ============================================================================

/** Tool call patterns that indicate progress */
const TOOL_PATTERNS = {
  // Read operations (small progress increments)
  read: [
    /\bRead\s+tool/i,
    /\breadFile\b/i,
    /\bReading\s+file/i,
    /\bcat\s+[^\s]+/,
    /\bless\s+[^\s]+/,
  ],
  // Search operations (small progress increments)
  search: [
    /\bGrep\s+tool/i,
    /\bGlob\s+tool/i,
    /\bSearching\b/i,
    /\bgrep\s+-/,
    /\bfind\s+\./,
    /\brg\s+/,
  ],
  // Write operations (larger progress increments)
  write: [
    /\bWrite\s+tool/i,
    /\bwriteFile\b/i,
    /\bWriting\s+(to\s+)?file/i,
    /\bCreating\s+file/i,
    /\bWrote\s+file/i,
    /\bFile\s+written/i,
  ],
  // Edit operations (larger progress increments)
  edit: [
    /\bEdit\s+tool/i,
    /\bEditing\s+file/i,
    /\bModifying\s+file/i,
    /\bUpdating\s+file/i,
    /\bEdited\s+file/i,
    /\bFile\s+updated/i,
  ],
  // Bash/command execution
  bash: [
    /\bBash\s+tool/i,
    /\bRunning\s+command/i,
    /\bExecuting\s+command/i,
    /\$\s*[a-zA-Z]/,
  ],
};

/** File path patterns for detecting modified files */
const FILE_PATH_PATTERNS = [
  // Unix-style absolute paths
  /(?:^|\s)(\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:\s|$|:|,)/g,
  // Relative paths with extension
  /(?:^|\s)(\.?\.?\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:\s|$|:|,)/g,
  // src/ style paths
  /(?:^|\s)(src\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:\s|$|:|,)/g,
  // Common patterns in tool output
  /(?:file|path|wrote|created|modified|edited|updated|saved):\s*([^\s,]+\.[a-zA-Z0-9]+)/gi,
];

/** Test execution patterns (near completion) */
const TEST_PATTERNS = [
  /\bRunning\s+tests?\b/i,
  /\bnpm\s+test\b/i,
  /\byarn\s+test\b/i,
  /\bpnpm\s+test\b/i,
  /\bpytest\b/i,
  /\bjest\b/i,
  /\bmocha\b/i,
  /\bvitest\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\s+test\b/i,
];

/** Build patterns (near completion) */
const BUILD_PATTERNS = [
  /\bBuilding\b/i,
  /\bnpm\s+run\s+build\b/i,
  /\byarn\s+build\b/i,
  /\bpnpm\s+build\b/i,
  /\btsc\b/,
  /\bcargo\s+build\b/i,
  /\bgo\s+build\b/i,
  /\bmake\b/,
];

/** Completion indicator patterns */
const COMPLETION_PATTERNS = [
  /\bcompleted?\b/i,
  /\bfinished\b/i,
  /\bdone\b/i,
  /\bsuccess(ful(ly)?)?\b/i,
  /\ball\s+(tests?\s+)?pass(ed|ing)?\b/i,
  /\btask\s+completed?\b/i,
  /\bimplementation\s+complete\b/i,
];

/** Todo list patterns */
const TODO_PATTERNS = {
  todoItem: /\[\s*[xX✓✔]\s*\]/,
  pendingItem: /\[\s*\]/,
  inProgress: /\b(in[_\s]?progress|working\s+on|currently)\b/i,
  completed: /\b(completed|done|finished|✓|✔)\b/i,
};

/** Error patterns (may indicate issues) */
const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bexception\b/i,
  /\bcrash(ed)?\b/i,
];

// ============================================================================
// ProgressTracker Class
// ============================================================================

export interface ProgressState {
  progress: number;
  filesModified: string[];
  linesProcessed: number;
  toolCalls: {
    read: number;
    search: number;
    write: number;
    edit: number;
    bash: number;
  };
  testsDetected: boolean;
  buildDetected: boolean;
  completionDetected: boolean;
  errorCount: number;
  todoItems: {
    completed: number;
    pending: number;
  };
}

export class ProgressTracker {
  private state: ProgressState;
  private seenFiles: Set<string>;

  constructor() {
    this.state = this.createInitialState();
    this.seenFiles = new Set();
  }

  private createInitialState(): ProgressState {
    return {
      progress: 0,
      filesModified: [],
      linesProcessed: 0,
      toolCalls: {
        read: 0,
        search: 0,
        write: 0,
        edit: 0,
        bash: 0,
      },
      testsDetected: false,
      buildDetected: false,
      completionDetected: false,
      errorCount: 0,
      todoItems: {
        completed: 0,
        pending: 0,
      },
    };
  }

  /**
   * Process a single log line and update progress estimation
   */
  processLogLine(line: string): void {
    this.state.linesProcessed++;

    // Detect tool calls
    this.detectToolCalls(line);

    // Detect file paths (potential modifications)
    this.detectFilePaths(line);

    // Detect todo items
    this.detectTodoItems(line);

    // Detect test execution
    if (!this.state.testsDetected) {
      this.state.testsDetected = TEST_PATTERNS.some((pattern) =>
        pattern.test(line)
      );
    }

    // Detect build execution
    if (!this.state.buildDetected) {
      this.state.buildDetected = BUILD_PATTERNS.some((pattern) =>
        pattern.test(line)
      );
    }

    // Detect completion indicators
    if (!this.state.completionDetected) {
      this.state.completionDetected = COMPLETION_PATTERNS.some((pattern) =>
        pattern.test(line)
      );
    }

    // Detect errors
    if (ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
      this.state.errorCount++;
    }

    // Recalculate progress after processing
    this.calculateProgress();
  }

  /**
   * Process multiple log lines at once
   */
  processLogLines(lines: string[]): void {
    for (const line of lines) {
      this.processLogLine(line);
    }
  }

  /**
   * Get the current estimated progress (0-100)
   */
  getProgress(): number {
    return this.state.progress;
  }

  /**
   * Get list of detected modified files
   */
  getFilesModified(): string[] {
    return [...this.state.filesModified];
  }

  /**
   * Get full progress state for debugging/detailed info
   */
  getState(): ProgressState {
    return { ...this.state, filesModified: [...this.state.filesModified] };
  }

  /**
   * Reset the tracker to initial state
   */
  reset(): void {
    this.state = this.createInitialState();
    this.seenFiles.clear();
  }

  // -------------------------------------------------------------------------
  // Private Detection Methods
  // -------------------------------------------------------------------------

  private detectToolCalls(line: string): void {
    // Check read patterns
    if (TOOL_PATTERNS.read.some((pattern) => pattern.test(line))) {
      this.state.toolCalls.read++;
    }

    // Check search patterns
    if (TOOL_PATTERNS.search.some((pattern) => pattern.test(line))) {
      this.state.toolCalls.search++;
    }

    // Check write patterns
    if (TOOL_PATTERNS.write.some((pattern) => pattern.test(line))) {
      this.state.toolCalls.write++;
    }

    // Check edit patterns
    if (TOOL_PATTERNS.edit.some((pattern) => pattern.test(line))) {
      this.state.toolCalls.edit++;
    }

    // Check bash patterns
    if (TOOL_PATTERNS.bash.some((pattern) => pattern.test(line))) {
      this.state.toolCalls.bash++;
    }
  }

  private detectFilePaths(line: string): void {
    // Only track files for write/edit operations
    const isWriteOrEdit =
      TOOL_PATTERNS.write.some((pattern) => pattern.test(line)) ||
      TOOL_PATTERNS.edit.some((pattern) => pattern.test(line));

    if (!isWriteOrEdit) {
      return;
    }

    for (const pattern of FILE_PATH_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const filePath = match[1];
        if (filePath && this.isValidFilePath(filePath)) {
          if (!this.seenFiles.has(filePath)) {
            this.seenFiles.add(filePath);
            this.state.filesModified.push(filePath);
          }
        }
      }
    }
  }

  private isValidFilePath(path: string): boolean {
    // Filter out common false positives
    const invalidPatterns = [
      /^https?:\/\//i, // URLs
      /^[a-z]+:\/\//i, // Other protocols
      /\s/, // Paths with spaces (usually not file paths in this context)
      /^\.{3,}/, // Multiple dots
    ];

    if (invalidPatterns.some((pattern) => pattern.test(path))) {
      return false;
    }

    // Must have a valid file extension
    const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(path);
    if (!hasExtension) {
      return false;
    }

    // Reasonable length
    if (path.length < 3 || path.length > 500) {
      return false;
    }

    return true;
  }

  private detectTodoItems(line: string): void {
    if (TODO_PATTERNS.todoItem.test(line)) {
      this.state.todoItems.completed++;
    }
    if (TODO_PATTERNS.pendingItem.test(line)) {
      this.state.todoItems.pending++;
    }
  }

  // -------------------------------------------------------------------------
  // Progress Calculation
  // -------------------------------------------------------------------------

  private calculateProgress(): void {
    let progress = 0;

    // Base progress from tool calls
    const { toolCalls } = this.state;

    // Read operations: 5% per call, max 20%
    progress += Math.min(toolCalls.read * 5, 20);

    // Search operations: 3% per call, max 15%
    progress += Math.min(toolCalls.search * 3, 15);

    // Write operations: 12% per call, max 25%
    progress += Math.min(toolCalls.write * 12, 25);

    // Edit operations: 10% per call, max 25%
    progress += Math.min(toolCalls.edit * 10, 25);

    // Bash commands: 5% per call, max 15%
    progress += Math.min(toolCalls.bash * 5, 15);

    // Test execution bumps progress to at least 80%
    if (this.state.testsDetected) {
      progress = Math.max(progress, 80);
    }

    // Build execution suggests near completion: at least 75%
    if (this.state.buildDetected) {
      progress = Math.max(progress, 75);
    }

    // Todo item progress (if we have any)
    const totalTodos =
      this.state.todoItems.completed + this.state.todoItems.pending;
    if (totalTodos > 0) {
      const todoProgress =
        (this.state.todoItems.completed / totalTodos) * 100;
      // Blend with calculated progress
      progress = Math.max(progress, todoProgress * 0.8);
    }

    // Completion detected: jump to 100%
    if (this.state.completionDetected) {
      progress = 100;
    }

    // Clamp to 0-100 range
    this.state.progress = Math.min(Math.max(Math.round(progress), 0), 100);
  }
}
