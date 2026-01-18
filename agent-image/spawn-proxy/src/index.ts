#!/usr/bin/env node

/**
 * Pinocchio Spawn Proxy - MCP Server for Nested Agent Spawning
 *
 * This lightweight MCP server runs inside agent containers and provides
 * a `spawn_agent` tool that Claude CLI can call to spawn child agents.
 *
 * Environment variables:
 * - PINOCCHIO_API_URL: URL of the Pinocchio HTTP API (e.g., http://host:3001)
 * - PINOCCHIO_SESSION_TOKEN: Authentication token for the parent agent session
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Environment configuration
const PINOCCHIO_API_URL = process.env.PINOCCHIO_API_URL;
const PINOCCHIO_SESSION_TOKEN = process.env.PINOCCHIO_SESSION_TOKEN;

// Validate required environment variables
if (!PINOCCHIO_API_URL) {
  console.error("[spawn-proxy] Error: PINOCCHIO_API_URL environment variable is required");
  process.exit(1);
}

if (!PINOCCHIO_SESSION_TOKEN) {
  console.error("[spawn-proxy] Error: PINOCCHIO_SESSION_TOKEN environment variable is required");
  process.exit(1);
}

// Tool definitions
const TOOLS = [
  {
    name: "spawn_agent",
    description: `Spawn a child Claude agent to perform a subtask autonomously.

The child agent runs in an isolated Docker container with access to the workspace.
Use this to delegate complex subtasks that benefit from focused, independent execution.

IMPORTANT: Child agents run synchronously - this tool blocks until the child completes.
Consider the timeout setting for long-running tasks.

Examples of good subtasks to delegate:
- "Run the test suite and fix any failing tests"
- "Refactor the authentication module to use JWT"
- "Add comprehensive error handling to the API endpoints"
- "Write unit tests for the payment processing module"`,
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "The task for the child agent to perform. Be specific and clear about expected outcomes.",
        },
        workspace_path: {
          type: "string",
          description: "Optional: Override the workspace directory for the child agent. Defaults to parent's workspace.",
        },
        writable_paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional: Specific paths within the workspace that the child can write to. Defaults to read-only access.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional: Timeout in milliseconds. Defaults to 5 minutes (300000ms). Max 1 hour.",
        },
      },
      required: ["task"],
    },
  },
];

// Spawn request interface matching the API
interface SpawnRequest {
  task: string;
  workspace_path?: string;
  writable_paths?: string[];
  timeout_ms?: number;
}

// Spawn response interface matching the API
interface SpawnResponse {
  agent_id: string;
  status: "completed" | "failed" | "timeout";
  exit_code: number;
  output: string;
  duration_ms: number;
  files_modified?: string[];
  error?: string;
  quota_info?: {
    tree_agents_remaining: number;
    depth_remaining: number;
  };
}

// Error response interface
interface SpawnErrorResponse {
  error: string;
  current_depth?: number;
  max_depth?: number;
  current_count?: number;
  max_agents?: number;
}

/**
 * Spawn a child agent by calling the Pinocchio HTTP API
 */
async function spawnChildAgent(args: SpawnRequest): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const url = `${PINOCCHIO_API_URL}/api/v1/spawn`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PINOCCHIO_SESSION_TOKEN}`,
      },
      body: JSON.stringify({
        task: args.task,
        workspace_path: args.workspace_path,
        writable_paths: args.writable_paths,
        timeout_ms: args.timeout_ms,
      }),
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({
        error: response.statusText,
      }))) as SpawnErrorResponse;

      // Format quota errors specially
      if (errorBody.max_depth !== undefined || errorBody.max_agents !== undefined) {
        let errorMessage = `Spawn quota exceeded: ${errorBody.error}`;
        if (errorBody.current_depth !== undefined && errorBody.max_depth !== undefined) {
          errorMessage += `\n  Current depth: ${errorBody.current_depth}, Max depth: ${errorBody.max_depth}`;
        }
        if (errorBody.current_count !== undefined && errorBody.max_agents !== undefined) {
          errorMessage += `\n  Current agents in tree: ${errorBody.current_count}, Max agents: ${errorBody.max_agents}`;
        }
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Failed to spawn child agent: ${errorBody.error || response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    const result = (await response.json()) as SpawnResponse;

    // Format successful response
    let output = `Child agent ${result.agent_id} ${result.status}\n`;
    output += `Duration: ${(result.duration_ms / 1000).toFixed(1)}s\n`;
    output += `Exit code: ${result.exit_code}\n`;

    if (result.quota_info) {
      output += `\nQuota remaining:\n`;
      output += `  Spawn depth: ${result.quota_info.depth_remaining} levels\n`;
      output += `  Tree agents: ${result.quota_info.tree_agents_remaining} agents\n`;
    }

    if (result.files_modified && result.files_modified.length > 0) {
      output += `\nFiles modified:\n`;
      for (const file of result.files_modified) {
        output += `  - ${file}\n`;
      }
    }

    output += `\n--- Agent Output ---\n${result.output}`;

    if (result.error) {
      output += `\n--- Error ---\n${result.error}`;
    }

    return {
      content: [{ type: "text", text: output }],
      isError: result.status === "failed",
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      content: [
        {
          type: "text",
          text: `Failed to communicate with Pinocchio API: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

// Create and configure the MCP server
const server = new Server(
  {
    name: "pinocchio-spawn-proxy",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Register tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "spawn_agent") {
    return await spawnChildAgent(args as unknown as SpawnRequest);
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[spawn-proxy] MCP server started, waiting for connections...");
}

main().catch((error) => {
  console.error("[spawn-proxy] Fatal error:", error);
  process.exit(1);
});
