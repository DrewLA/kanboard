import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { assertStorageConfig, getAppConfig } from "./config";
import { buildMcpServer } from "./mcp-core";
import { createTaskboardRepository } from "./repository";

async function start(): Promise<void> {
  const config = getAppConfig();
  assertStorageConfig(config);
  const repository = createTaskboardRepository(config);
  const server = buildMcpServer(repository);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start MCP server: ${message}`);
  process.exit(1);
});