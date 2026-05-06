import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AppConfig, assertStorageConfig, getAppConfig } from "./config";
import { buildMcpServer } from "./mcp-core";
import { createTaskboardRepository } from "./repository";
import { formatCreatingKanboardMessage, formatStartupError } from "./startup-errors";

let startupConfig: AppConfig | undefined;

async function start(): Promise<void> {
  const config = getAppConfig();
  startupConfig = config;
  assertStorageConfig(config);
  const repository = createTaskboardRepository(config);
  await repository.load({
    onCreate: () => {
      console.error(formatCreatingKanboardMessage(config));
    }
  });
  const server = buildMcpServer(repository);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void start().catch((error) => {
  console.error(formatStartupError("kanboard MCP server", error, startupConfig));
  process.exit(1);
});
