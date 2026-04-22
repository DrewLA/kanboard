import path from "node:path";

import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { getAppConfig } from "./config";
import {
  boardBriefPatchSchema,
  createNodeCommentInputSchema,
  createEpicInputSchema,
  createFeatureInputSchema,
  createTaskInputSchema,
  createUserStoryInputSchema,
  createWorkLinkInputSchema,
  findNodesInputSchema,
  resolveNodeInputSchema,
  updateNodeCommentInputSchema,
  updateEpicInputSchema,
  updateFeatureInputSchema,
  updateTaskInputSchema,
  updateUserStoryInputSchema,
  updateWorkLinkInputSchema
} from "./model";
import { buildMcpServer } from "./mcp-core";
import { createTaskboardRepository } from "./repository";
import {
  NotFoundError,
  createNodeComment,
  createEpic,
  createFeature,
  createTask,
  createUserStory,
  createWorkLink,
  deleteNodeComment,
  deleteEpic,
  deleteFeature,
  deleteTask,
  deleteUserStory,
  deleteWorkLink,
  findNodes,
  getBoardBrief,
  getEpic,
  getFeature,
  getNodeComment,
  getTask,
  getTaskboard,
  getUserStory,
  getWorkLink,
  listEpics,
  listFeatures,
  listTasks,
  listUserStories,
  listWorkLinks,
  resolveNode,
  updateBoardBrief,
  updateEpic,
  updateFeature,
  updateNodeComment,
  updateTask,
  updateUserStory,
  updateWorkLink
} from "./taskboard-service";

function parseBody<T>(schema: { parse: (value: unknown) => T }, body: unknown): T {
  return schema.parse(body);
}

async function buildServer(): Promise<FastifyInstance> {
  const config = getAppConfig();
  const repository = createTaskboardRepository(config);

  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ message: "Invalid request payload.", issues: error.flatten() });
      return;
    }

    if (error instanceof NotFoundError) {
      reply.status(error.statusCode).send({ message: error.message });
      return;
    }

    app.log.error(error);
    reply.status(500).send({
      message: error instanceof Error ? error.message : "Unexpected server error."
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    mode: "local-only",
    storage: config.storage,
    localFile: config.storage === "local" ? config.localFile : undefined,
    redisKey: config.redisKey,
    host: config.host,
    port: config.port
  }));

  app.get("/api/taskboard", async () => getTaskboard(repository));
  app.get("/api/nodes/resolve", async (request) => resolveNode(repository, parseBody(resolveNodeInputSchema, request.query)));
  app.get("/api/nodes/search", async (request) => findNodes(repository, parseBody(findNodesInputSchema, request.query)));

  app.get("/api/board-brief", async () => getBoardBrief(repository));
  app.put("/api/board-brief", async (request) => updateBoardBrief(repository, parseBody(boardBriefPatchSchema, request.body)));
  app.get("/api/metadata", async () => getBoardBrief(repository));
  app.put("/api/metadata", async (request) => updateBoardBrief(repository, parseBody(boardBriefPatchSchema, request.body)));

  app.post("/api/comments", async (request) => createNodeComment(repository, parseBody(createNodeCommentInputSchema, request.body)));
  app.get("/api/comments/:commentId", async (request) => getNodeComment(repository, (request.params as { commentId: string }).commentId));
  app.patch("/api/comments/:commentId", async (request) =>
    updateNodeComment(repository, (request.params as { commentId: string }).commentId, parseBody(updateNodeCommentInputSchema, request.body))
  );
  app.delete("/api/comments/:commentId", async (request) => deleteNodeComment(repository, (request.params as { commentId: string }).commentId));

  app.get("/api/epics", async () => listEpics(repository));
  app.post("/api/epics", async (request) => createEpic(repository, parseBody(createEpicInputSchema, request.body)));
  app.get("/api/epics/:epicId", async (request) => getEpic(repository, (request.params as { epicId: string }).epicId));
  app.patch("/api/epics/:epicId", async (request) =>
    updateEpic(repository, (request.params as { epicId: string }).epicId, parseBody(updateEpicInputSchema, request.body))
  );
  app.delete("/api/epics/:epicId", async (request) => deleteEpic(repository, (request.params as { epicId: string }).epicId));

  app.get("/api/features", async (request) =>
    listFeatures(repository, (request.query as { epicId?: string; epicAlias?: string }).epicId, (request.query as { epicId?: string; epicAlias?: string }).epicAlias)
  );
  app.post("/api/features", async (request) => createFeature(repository, parseBody(createFeatureInputSchema, request.body)));
  app.get("/api/features/:featureId", async (request) =>
    getFeature(repository, (request.params as { featureId: string }).featureId)
  );
  app.patch("/api/features/:featureId", async (request) =>
    updateFeature(repository, (request.params as { featureId: string }).featureId, parseBody(updateFeatureInputSchema, request.body))
  );
  app.delete("/api/features/:featureId", async (request) => deleteFeature(repository, (request.params as { featureId: string }).featureId));

  app.get("/api/stories", async (request) =>
    listUserStories(
      repository,
      (request.query as { featureId?: string; featureAlias?: string }).featureId,
      (request.query as { featureId?: string; featureAlias?: string }).featureAlias
    )
  );
  app.post("/api/stories", async (request) => createUserStory(repository, parseBody(createUserStoryInputSchema, request.body)));
  app.get("/api/stories/:storyId", async (request) =>
    getUserStory(repository, (request.params as { storyId: string }).storyId)
  );
  app.patch("/api/stories/:storyId", async (request) =>
    updateUserStory(repository, (request.params as { storyId: string }).storyId, parseBody(updateUserStoryInputSchema, request.body))
  );
  app.delete("/api/stories/:storyId", async (request) => deleteUserStory(repository, (request.params as { storyId: string }).storyId));

  app.get("/api/tasks", async (request) =>
    listTasks(repository, (request.query as { storyId?: string; storyAlias?: string }).storyId, (request.query as { storyId?: string; storyAlias?: string }).storyAlias)
  );
  app.post("/api/tasks", async (request) => createTask(repository, parseBody(createTaskInputSchema, request.body)));
  app.get("/api/tasks/:taskId", async (request) => getTask(repository, (request.params as { taskId: string }).taskId));
  app.patch("/api/tasks/:taskId", async (request) =>
    updateTask(repository, (request.params as { taskId: string }).taskId, parseBody(updateTaskInputSchema, request.body))
  );
  app.delete("/api/tasks/:taskId", async (request) => deleteTask(repository, (request.params as { taskId: string }).taskId));

  app.get("/api/links", async () => listWorkLinks(repository));
  app.post("/api/links", async (request) => createWorkLink(repository, parseBody(createWorkLinkInputSchema, request.body)));
  app.get("/api/links/:linkId", async (request) =>
    getWorkLink(repository, (request.params as { linkId: string }).linkId)
  );
  app.patch("/api/links/:linkId", async (request) =>
    updateWorkLink(repository, (request.params as { linkId: string }).linkId, parseBody(updateWorkLinkInputSchema, request.body))
  );
  app.delete("/api/links/:linkId", async (request) => deleteWorkLink(repository, (request.params as { linkId: string }).linkId));

  app.get("/mcp", async (_request, reply) => {
    reply.status(405).send({ message: "Use POST /mcp for stateless MCP requests." });
  });

  app.delete("/mcp", async (_request, reply) => {
    reply.status(405).send({ message: "Stateless MCP does not use DELETE sessions." });
  });

  app.post("/mcp", async (request, reply) => {
    const server = buildMcpServer(repository);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    reply.hijack();

    const cleanup = async (): Promise<void> => {
      await transport.close();
      await server.close();
    };

    reply.raw.on("close", () => {
      void cleanup();
    });

    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), "public"),
    prefix: "/"
  });

  app.get("/", async (_request, reply) => reply.sendFile("index.html"));

  return app;
}

async function start(): Promise<void> {
  const config = getAppConfig();
  const app = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "Shutting down HTTP server.");

    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error(error, "Failed to close HTTP server cleanly.");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await app.listen({ host: config.host, port: config.port });
}

void start();