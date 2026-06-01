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

  if (config.mode === "team" && !config.evmPrivateKey) {
    throw new Error(
      "The stdio MCP server cannot share the browser identity unlock. " +
      `Use the HTTP MCP endpoint at http://${config.host}:${config.port}/mcp from the running app, ` +
      "or set TASKBOARD_EVM_PRIVATE_KEY for a separate non-interactive MCP process."
    );
  }

  const repository = createTaskboardRepository(config);
  await repository.load({
    onCreate: () => {
      console.error(formatCreatingKanboardMessage(config));
    }
  });
  const server = buildMcpServer(repository, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void start().catch((error) => {
  console.error(formatStartupError("kanboard MCP server", error, startupConfig));
  process.exit(1);
});
