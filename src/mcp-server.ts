import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getAppConfig } from "./config";
import { buildMcpServer } from "./mcp-core";
import { createTaskboardRepository } from "./repository";

async function start(): Promise<void> {
  const config = getAppConfig();
  const repository = createTaskboardRepository(config);
  const server = buildMcpServer(repository);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void start();