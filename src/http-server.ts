import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { AgentRegistry, createAgentRegistryFilePath } from "./agent-registry";
import { AgentEventHub, BoardEventHub } from "./board-events";
import { AppConfig, assertStorageConfig, loadAppConfig } from "./config";
import { registerBoardRoutes } from "./http-board-routes";
import {
  API_IDENTITY_UNLOCK_REQUIRED_RESPONSE,
  buildAllowedHosts,
  buildIdentityUnlockCookie,
  createUnlockRateLimiter,
  firstHeaderValue,
  hasIdentityUnlockSession,
  isPreUnlockApiRequest,
  unlockIdentityInputSchema
} from "./http-security";
import { buildMcpServer } from "./mcp-core";
import { getMcpSessionId, getMcpToolNames, hasMutatingMcpTool, isMcpInitializeBody, mcpError } from "./mcp-http";
import { NotFoundError } from "./application-errors";
import { acquireHttpServerLock } from "./process-lock";
import { RepositoryAccessError, RepositoryConflictError, createTaskboardRepository } from "./repository";
import { R2ConfigError } from "./r2";
import { formatCreatingKanboardMessage, formatStartupError, formatTeamBoardEmptyBanner, isTeamBoardEmptyError, getStorageLogContext } from "./startup-errors";

function parseBody<T>(schema: { parse: (value: unknown) => T }, body: unknown): T {
  return schema.parse(body);
}

type McpSessionRuntime = {
  server: ReturnType<typeof buildMcpServer>;
  transport: StreamableHTTPServerTransport;
};

const SHUTDOWN_FORCE_EXIT_MS = 5_000;

let startupConfig: AppConfig | undefined;

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  assertStorageConfig(config);
  const app = Fastify({ logger: true, forceCloseConnections: true });
  const repository = createTaskboardRepository(config);
  const agentRegistry = new AgentRegistry(createAgentRegistryFilePath(config.identityFile));
  const boardEvents = new BoardEventHub();
  const agentEvents = new AgentEventHub();
  const mcpSessions = new Map<string, McpSessionRuntime>();
  const allowedHosts = buildAllowedHosts(config);
  const allowUnlock = createUnlockRateLimiter();
  const identityUnlockSessions = new Set<string>();
  const apiMutationRevisions = new WeakMap<object, number>();

  await agentRegistry.load();

  await repository.load({
    onCreate: () => {
      app.log.info(getStorageLogContext(config), formatCreatingKanboardMessage(config));
    }
  });

  async function getCurrentBoardRevision(): Promise<number> {
    return repository.getRevision?.() ?? (await repository.load()).revision;
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

  function isBoardMutationRequest(method: string, url: string): boolean {
    if (!url.startsWith("/api/") || !["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return false;
    }

    return !(
      url === "/api/identity/unlock" ||
      url.startsWith("/api/notifications/") ||
      url.endsWith("/upload-url") ||
      (method === "DELETE" && url.startsWith("/api/recycle-bin"))
    );
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

  app.addHook("preHandler", async (request) => {
    if (isBoardMutationRequest(request.method, request.url)) {
      apiMutationRevisions.set(request, await getCurrentBoardRevision());
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const previousRevision = apiMutationRevisions.get(request);
    if (previousRevision === undefined || reply.statusCode >= 400) return;

    try {
      await emitBoardChangedIfRevisionAdvanced(previousRevision, "api");
    } catch (error) {
      app.log.warn({ error, url: request.url }, "Failed to publish board change event.");
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

    if (error instanceof R2ConfigError) {
      reply.status(error.statusCode).send({ message: error.message });
      return;
    }

    app.log.error(error);
    reply.status(500).send({ message: "Unexpected server error." });
  });

  let liveConnectionsClosePromise: Promise<void> | undefined;
  const closeLiveConnections = (): Promise<void> => {
    liveConnectionsClosePromise ??= (async () => {
      boardEvents.closeAll();
      agentEvents.closeAll();

      const runtimes = [...mcpSessions.entries()];
      mcpSessions.clear();

      const results = await Promise.allSettled(runtimes.map(async ([sessionId, { server, transport }]) => {
        transport.onclose = undefined;

        try {
          await transport.close();
        } catch (error) {
          app.log.warn({ error, sessionId }, "Failed to close MCP transport during shutdown.");
        }

        try {
          await server.close();
        } catch (error) {
          app.log.warn({ error, sessionId }, "Failed to close MCP server during shutdown.");
        }

        await agentRegistry.markDisconnected(sessionId);
      }));

      for (const result of results) {
        if (result.status === "rejected") {
          app.log.warn({ error: result.reason }, "Failed to disconnect an MCP session during shutdown.");
        }
      }

      await agentRegistry.flush();
    })();

    return liveConnectionsClosePromise;
  };

  app.addHook("preClose", async () => {
    await closeLiveConnections();
  });

  app.addHook("onClose", async () => {
    await closeLiveConnections();
  });

  app.get("/api/health", async () => ({
    ok: true,
    mode: config.mode,
    stateDir: config.stateDir,
    dbConfigured: Boolean(config.dbString),
    host: config.host,
    port: config.port,
    pid: process.pid,
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

  registerBoardRoutes(app, config, repository);

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

    const server = buildMcpServer(repository, config);
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
  const config = loadAppConfig();
  startupConfig = config;
  const serverLock = await acquireHttpServerLock(config);
  let app: FastifyInstance;

  try {
    app = await buildServer(config);
  } catch (error) {
    await serverLock.release();
    throw error;
  }

  app.addHook("onClose", async () => {
    await serverLock.release();
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) {
      app.log.warn({ signal }, "Shutdown already in progress.");
      return shutdownPromise;
    }

    app.log.info({ signal }, "Shutting down HTTP server.");
    shutdownPromise = (async () => {
      const forceExitTimer = setTimeout(() => {
        app.log.error(
          { signal, timeoutMs: SHUTDOWN_FORCE_EXIT_MS },
          "HTTP server shutdown timed out; forcing process exit."
        );
        process.exit(1);
      }, SHUTDOWN_FORCE_EXIT_MS);
      forceExitTimer.unref();

      try {
        await app.close();
        await serverLock.release();
        clearTimeout(forceExitTimer);
        process.exit(0);
      } catch (error) {
        await serverLock.release();
        clearTimeout(forceExitTimer);
        app.log.error(error, "Failed to close HTTP server cleanly.");
        process.exit(1);
      }
    })();

    return shutdownPromise;
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await serverLock.release();
    throw error;
  }
}

if (require.main === module) {
  void start().catch((error) => {
    if (isTeamBoardEmptyError(error)) {
      process.stdout.write(formatTeamBoardEmptyBanner());
      process.exit(0);
    }
    console.error(formatStartupError("kanboard HTTP server", error, startupConfig));
    process.exit(1);
  });
}
