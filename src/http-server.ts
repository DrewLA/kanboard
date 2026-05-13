import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import { AgentRegistry, createAgentRegistryFilePath } from "./agent-registry";
import { AgentEventHub, BoardEventHub } from "./board-events";
import { AppConfig, assertStorageConfig, getAppConfig } from "./config";
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
import { RepositoryAccessError, RepositoryConflictError, createTaskboardRepository } from "./repository";
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
  listNotifications,
  listTasks,
  listUserStories,
  listWorkLinks,
  readNodeNotifications,
  resolveNode,
  updateBoardBrief,
  updateEpic,
  updateFeature,
  updateNodeComment,
  updateTask,
  updateUserStory,
  updateWorkLink
} from "./taskboard-service";
import { formatCreatingKanboardMessage, formatStartupError, formatTeamBoardEmptyBanner, isTeamBoardEmptyError, getStorageLogContext } from "./startup-errors";

function parseBody<T>(schema: { parse: (value: unknown) => T }, body: unknown): T {
  return schema.parse(body);
}

const unlockIdentityInputSchema = z.object({
  password: z.string().min(1, "Password is required.")
});

const readNodeNotificationsInputSchema = z.object({
  nodeId: z.string().min(1)
});

type McpSessionRuntime = {
  server: ReturnType<typeof buildMcpServer>;
  transport: StreamableHTTPServerTransport;
};

const MUTATING_MCP_TOOLS = new Set([
  "update_board_brief",
  "update_metadata",
  "create_comment",
  "update_comment",
  "delete_comment",
  "create_epic",
  "update_epic",
  "delete_epic",
  "create_feature",
  "update_feature",
  "delete_feature",
  "create_user_story",
  "update_user_story",
  "delete_user_story",
  "create_task",
  "update_task",
  "delete_task",
  "create_link",
  "update_link",
  "delete_link"
]);

let startupConfig: AppConfig | undefined;

function buildAllowedHosts(config: AppConfig): Set<string> {
  const allowed = new Set<string>();
  const ports = new Set<string>([String(config.port)]);

  for (const port of ports) {
    allowed.add(`127.0.0.1:${port}`);
    allowed.add(`localhost:${port}`);
    allowed.add(`[::1]:${port}`);
  }

  if (config.host && config.host !== "127.0.0.1" && config.host !== "0.0.0.0") {
    for (const port of ports) {
      allowed.add(`${config.host}:${port}`);
    }
  }

  return allowed;
}

const UNLOCK_RATE_WINDOW_MS = 60_000;
const UNLOCK_RATE_MAX_ATTEMPTS = 5;
const IDENTITY_UNLOCK_COOKIE_NAME = "kb_identity_unlocked";
const API_IDENTITY_UNLOCK_REQUIRED_RESPONSE = {
  message: "HTTP API access requires an unlocked browser session.",
  code: "KB_IDENTITY_UNLOCK_SESSION_REQUIRED",
  recovery: "Unlock identity from the browser UI. Agents must use the MCP endpoint and must not call the HTTP API directly."
};

function createUnlockRateLimiter(): (ip: string) => boolean {
  const attempts = new Map<string, number[]>();

  return (ip: string): boolean => {
    const now = Date.now();
    const cutoff = now - UNLOCK_RATE_WINDOW_MS;
    const history = (attempts.get(ip) ?? []).filter((stamp) => stamp >= cutoff);

    if (history.length >= UNLOCK_RATE_MAX_ATTEMPTS) {
      attempts.set(ip, history);
      return false;
    }

    history.push(now);
    attempts.set(ip, history);
    return true;
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};

  return Object.fromEntries(cookieHeader.split(";").flatMap((part) => {
    const [name, ...rawValue] = part.trim().split("=");
    if (!name) return [];
    return [[name, decodeURIComponent(rawValue.join("="))]];
  }));
}

function buildIdentityUnlockCookie(token: string): string {
  return [
    `${IDENTITY_UNLOCK_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict"
  ].join("; ");
}

function hasIdentityUnlockSession(headers: IncomingHttpHeaders, sessions: Set<string>): boolean {
  const cookies = parseCookies(firstHeaderValue(headers.cookie));
  return Boolean(cookies[IDENTITY_UNLOCK_COOKIE_NAME] && sessions.has(cookies[IDENTITY_UNLOCK_COOKIE_NAME]));
}

function isPreUnlockApiRequest(method: string, url: string): boolean {
  return (
    (method === "GET" && url === "/api/health") ||
    (method === "POST" && url === "/api/identity/unlock")
  );
}

function getMcpSessionId(headers: IncomingHttpHeaders): string | undefined {
  return firstHeaderValue(headers["mcp-session-id"]);
}

function jsonRpcMessages(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

function isMcpInitializeBody(body: unknown): boolean {
  return jsonRpcMessages(body).some((message) => isInitializeRequest(message));
}

function getMcpToolNames(body: unknown): string[] {
  return jsonRpcMessages(body).flatMap((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return [];
    }

    const record = message as { method?: unknown; params?: unknown };
    if (record.method !== "tools/call" || typeof record.params !== "object" || record.params === null || Array.isArray(record.params)) {
      return [];
    }

    const toolName = (record.params as { name?: unknown }).name;
    return typeof toolName === "string" && toolName.trim() ? [toolName] : [];
  });
}

function hasMutatingMcpTool(body: unknown): boolean {
  return getMcpToolNames(body).some((toolName) => MUTATING_MCP_TOOLS.has(toolName));
}

function mcpError(code: number, message: string): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id: null
  };
}

async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  assertStorageConfig(config);
  const app = Fastify({ logger: true });
  const repository = createTaskboardRepository(config);
  const agentRegistry = new AgentRegistry(createAgentRegistryFilePath(config.identityFile));
  const boardEvents = new BoardEventHub();
  const agentEvents = new AgentEventHub();
  const mcpSessions = new Map<string, McpSessionRuntime>();
  const allowedHosts = buildAllowedHosts(config);
  const allowUnlock = createUnlockRateLimiter();
  const identityUnlockSessions = new Set<string>();

  await agentRegistry.load();

  await repository.load({
    onCreate: () => {
      app.log.info(getStorageLogContext(config), formatCreatingKanboardMessage(config));
    }
  });

  async function getCurrentBoardRevision(): Promise<number> {
    return (await repository.load()).revision;
  }

  async function getAgentsPayload() {
    const sessions = await agentRegistry.list();
    const visibleSessions = sessions.filter((s) => s.status !== "closed");
    return {
      sessions: visibleSessions,
      counts: {
        connected: visibleSessions.filter((s) => s.status === "connected").length,
        recent: visibleSessions.filter((s) => s.status === "recent").length
      }
    };
  }

  async function emitBoardChangedIfRevisionAdvanced(previousRevision: number, source: "mcp" | "api", tools?: string[]): Promise<void> {
    const nextRevision = await getCurrentBoardRevision();
    if (nextRevision <= previousRevision) return;

    boardEvents.emitBoardChanged({
      revision: nextRevision,
      source,
      tools,
      changedAt: new Date().toISOString()
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    const hostHeader = request.headers.host;

    if (!hostHeader || !allowedHosts.has(hostHeader.toLowerCase())) {
      reply.status(403).send({ message: "Forbidden." });
      return;
    }

    if (request.url.startsWith("/api/")) {
      if (config.mode === "team" && !isPreUnlockApiRequest(request.method, request.url) && !hasIdentityUnlockSession(request.headers, identityUnlockSessions)) {
        reply.status(401).send(API_IDENTITY_UNLOCK_REQUIRED_RESPONSE);
      }
      return;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ message: "Invalid request payload.", issues: error.flatten() });
      return;
    }

    if (error instanceof NotFoundError) {
      reply.status(error.statusCode).send({ message: error.message });
      return;
    }

    if (error instanceof RepositoryConflictError) {
      reply.status(409).send({
        message: "Kanboard storage revision conflict.",
        operation: error.operation,
        expectedRevision: error.expectedRevision,
        currentRevision: error.currentRevision,
        recovery: "Reload the board and retry. If this keeps happening, check for another kanboard process or client using the same storage location."
      });
      return;
    }

    if (error instanceof RepositoryAccessError) {
      const statusByCode: Record<string, number> = {
        KB_IDENTITY_LOCKED: 423,
        KB_IDENTITY_SETUP_REQUIRED: 400,
        KB_IDENTITY_NOT_REGISTERED: 403,
        KB_IDENTITY_FILE_MISMATCH: 409
      };

      reply.status(statusByCode[error.code] ?? 403).send({
        message: error.message,
        code: error.code,
        recovery: error.recovery
      });
      return;
    }

    app.log.error(error);
    reply.status(500).send({ message: "Unexpected server error." });
  });

  app.addHook("onClose", async () => {
    const runtimes = [...mcpSessions.entries()];
    mcpSessions.clear();
    boardEvents.closeAll();
    agentEvents.closeAll();

    await Promise.all(runtimes.map(async ([sessionId, { transport }]) => {
      await transport.close();
      await agentRegistry.markDisconnected(sessionId);
    }));
    await agentRegistry.flush();
  });

  app.get("/api/health", async () => ({
    ok: true,
    mode: config.mode,
    stateDir: config.stateDir,
    dbConfigured: Boolean(config.dbString),
    host: config.host,
    port: config.port,
    identity: await repository.getIdentityStatus?.()
  }));

  app.get("/api/agents", async () => {
    const sessions = await agentRegistry.list();
    const visibleSessions = sessions.filter((session) => session.status !== "closed");
    return {
      sessions: visibleSessions,
      counts: {
        connected: visibleSessions.filter((session) => session.status === "connected").length,
        recent: visibleSessions.filter((session) => session.status === "recent").length
      },
      storePath: createAgentRegistryFilePath(config.identityFile)
    };
  });

  app.get("/api/agents/events", async (request, reply) => {
    const payload = await getAgentsPayload();
    reply.hijack();
    agentEvents.open(request.raw, reply.raw, payload);
  });

  app.get("/api/board-events", async (request, reply) => {
    const revision = await getCurrentBoardRevision();
    reply.hijack();
    boardEvents.open(request.raw, reply.raw, revision);
  });

  app.post("/api/identity/unlock", async (request, reply) => {
    if (!allowUnlock(request.ip)) {
      reply.status(429).send({ message: "Too many unlock attempts. Try again shortly." });
      return reply;
    }

    const payload = parseBody(unlockIdentityInputSchema, request.body);
    const identity = await repository.unlockIdentity?.(payload.password);
    const currentUser = await repository.getCurrentUser?.();
    const identityUnlockToken = randomBytes(32).toString("base64url");
    identityUnlockSessions.add(identityUnlockToken);
    reply.header("Set-Cookie", buildIdentityUnlockCookie(identityUnlockToken));
    return { identity, currentUser };
  });

  app.get("/api/users", async () => repository.listUsers?.() ?? []);
  app.get("/api/users/me", async () => repository.getCurrentUser?.() ?? null);
  app.get("/api/taskboard", async () => getTaskboard(repository));
  app.get("/api/nodes/resolve", async (request) => resolveNode(repository, parseBody(resolveNodeInputSchema, request.query)));
  app.get("/api/nodes/search", async (request) => findNodes(repository, parseBody(findNodesInputSchema, request.query)));

  app.get("/api/board-brief", async () => getBoardBrief(repository));
  app.put("/api/board-brief", async (request) => updateBoardBrief(repository, parseBody(boardBriefPatchSchema, request.body)));
  app.get("/api/metadata", async () => getBoardBrief(repository));
  app.put("/api/metadata", async (request) => updateBoardBrief(repository, parseBody(boardBriefPatchSchema, request.body)));

  app.get("/api/notifications", async () => {
    const currentUser = await repository.getCurrentUser?.();
    if (!currentUser?.id) return [];
    return listNotifications(repository, currentUser.id);
  });

  app.post("/api/notifications/read-node", async (request) => {
    const { nodeId } = parseBody(readNodeNotificationsInputSchema, request.body);
    const currentUser = await repository.getCurrentUser?.();
    if (currentUser?.id) await readNodeNotifications(repository, currentUser.id, nodeId);
    return { ok: true };
  });

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

  app.get("/mcp", async (request, reply) => {
    const sessionId = getMcpSessionId(request.headers);
    if (!sessionId) {
      reply.status(400).send(mcpError(-32000, "Bad Request: Mcp-Session-Id header is required."));
      return;
    }

    const runtime = mcpSessions.get(sessionId);
    if (!runtime) {
      await agentRegistry.markDisconnected(sessionId);
      reply.status(404).send(mcpError(-32001, "Session not active. Reinitialize the MCP session."));
      return;
    }

    await agentRegistry.observeConnection(sessionId, {
      ip: request.ip,
      userAgent: firstHeaderValue(request.headers["user-agent"])
    });
    agentEvents.emit(await getAgentsPayload());

    reply.hijack();
    await runtime.transport.handleRequest(request.raw, reply.raw);
  });

  app.delete("/mcp", async (request, reply) => {
    const sessionId = getMcpSessionId(request.headers);
    if (!sessionId) {
      reply.status(400).send(mcpError(-32000, "Bad Request: Mcp-Session-Id header is required."));
      return;
    }

    const runtime = mcpSessions.get(sessionId);
    if (!runtime) {
      await agentRegistry.markDisconnected(sessionId);
      reply.status(404).send(mcpError(-32001, "Session not active. Reinitialize the MCP session."));
      return;
    }

    reply.hijack();
    await runtime.transport.handleRequest(request.raw, reply.raw);
    agentEvents.emit(await getAgentsPayload());
  });

  app.post("/mcp", async (request, reply) => {
    const sessionId = getMcpSessionId(request.headers);
    const context = {
      ip: request.ip,
      userAgent: firstHeaderValue(request.headers["user-agent"])
    };

    if (sessionId) {
      const runtime = mcpSessions.get(sessionId);
      if (!runtime) {
        await agentRegistry.markDisconnected(sessionId);
        reply.status(404).send(mcpError(-32001, "Session not active. Reinitialize the MCP session."));
        return;
      }

      await agentRegistry.observeRequest(sessionId, request.body, context);
      agentEvents.emit(await getAgentsPayload());
      const toolNames = getMcpToolNames(request.body);
      const previousRevision = hasMutatingMcpTool(request.body) ? await getCurrentBoardRevision() : null;
      reply.hijack();
      await runtime.transport.handleRequest(request.raw, reply.raw, request.body);
      if (previousRevision != null) {
        await emitBoardChangedIfRevisionAdvanced(previousRevision, "mcp", toolNames);
      }
      return;
    }

    if (!isMcpInitializeBody(request.body)) {
      reply.status(400).send(mcpError(-32000, "Bad Request: No valid session ID provided."));
      return;
    }

    const server = buildMcpServer(repository);
    let isClosing = false;
    let transport!: StreamableHTTPServerTransport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: async (initializedSessionId) => {
        mcpSessions.set(initializedSessionId, { server, transport });
        await agentRegistry.registerInitialized(initializedSessionId, request.body, context);
        agentEvents.emit(await getAgentsPayload());
      },
      onsessionclosed: async (closedSessionId) => {
        mcpSessions.delete(closedSessionId);
        await agentRegistry.markClosed(closedSessionId);
        agentEvents.emit(await getAgentsPayload());
      }
    });

    transport.onclose = () => {
      if (isClosing) return;
      isClosing = true;

      const closedSessionId = transport.sessionId;
      if (closedSessionId) {
        mcpSessions.delete(closedSessionId);
        void agentRegistry.markDisconnected(closedSessionId).then(async () => {
          agentEvents.emit(await getAgentsPayload());
        });
      }
      void server.close();
    };

    transport.onerror = (error) => {
      app.log.warn({ error }, "MCP transport error.");
    };

    await server.connect(transport);
    reply.hijack();
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
  startupConfig = config;
  const app = await buildServer(config);

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

void start().catch((error) => {
  if (isTeamBoardEmptyError(error)) {
    process.stdout.write(formatTeamBoardEmptyBanner());
    process.exit(0);
  }
  console.error(formatStartupError("kanboard HTTP server", error, startupConfig));
  process.exit(1);
});
