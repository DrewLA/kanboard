import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

type AgentStatus = "connected" | "recent" | "closed";

type ClientInfo = {
  name: string;
  version: string;
  title?: string;
};

type RequestContext = {
  ip?: string;
  userAgent?: string;
};

export type AgentSessionRecord = {
  sessionId: string;
  status: AgentStatus;
  clientInfo: ClientInfo;
  protocolVersion: string;
  capabilities?: unknown;
  createdAt: string;
  lastSeenAt: string;
  connectedAt?: string;
  disconnectedAt?: string;
  closedAt?: string;
  requestCount: number;
  toolCallCount: number;
  lastMethod?: string;
  lastToolName?: string;
  userAgent?: string;
  remoteAddress?: string;
  supersededBySessionId?: string;
};

type AgentSessionStore = {
  schemaVersion: 1;
  updatedAt: string;
  sessions: Record<string, AgentSessionRecord>;
};

const DEFAULT_CLIENT_INFO: ClientInfo = {
  name: "Unknown MCP client",
  version: "unknown"
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptyStore(): AgentSessionStore {
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    sessions: {}
  };
}

function jsonRpcMessages(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

function getMethod(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }

  const method = (message as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function getMethods(body: unknown): string[] {
  return jsonRpcMessages(body).map(getMethod).filter((method): method is string => Boolean(method));
}

function countToolCalls(body: unknown): number {
  return getMethods(body).filter((method) => method === "tools/call").length;
}

function getToolNames(body: unknown): string[] {
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

function findInitializeMessage(body: unknown): unknown | null {
  return jsonRpcMessages(body).find((message) => isInitializeRequest(message)) ?? null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeClientInfo(value: unknown): ClientInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_CLIENT_INFO;
  }

  const record = value as { name?: unknown; version?: unknown; title?: unknown };
  return {
    name: getString(record.name) ?? DEFAULT_CLIENT_INFO.name,
    version: getString(record.version) ?? DEFAULT_CLIENT_INFO.version,
    title: getString(record.title)
  };
}

function normalizeFingerprintPart(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function agentFingerprint(record: Pick<AgentSessionRecord, "clientInfo" | "userAgent" | "remoteAddress">): string {
  return [
    normalizeFingerprintPart(record.clientInfo.title),
    normalizeFingerprintPart(record.clientInfo.name),
    normalizeFingerprintPart(record.clientInfo.version),
    normalizeFingerprintPart(record.userAgent)
  ].join("\n");
}

function getInitializeParams(body: unknown): {
  clientInfo: ClientInfo;
  protocolVersion: string;
  capabilities?: unknown;
} {
  const initialize = findInitializeMessage(body);
  if (typeof initialize !== "object" || initialize === null || Array.isArray(initialize)) {
    return {
      clientInfo: DEFAULT_CLIENT_INFO,
      protocolVersion: "unknown"
    };
  }

  const params = (initialize as { params?: unknown }).params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {
      clientInfo: DEFAULT_CLIENT_INFO,
      protocolVersion: "unknown"
    };
  }

  const record = params as { clientInfo?: unknown; protocolVersion?: unknown; capabilities?: unknown };
  return {
    clientInfo: normalizeClientInfo(record.clientInfo),
    protocolVersion: getString(record.protocolVersion) ?? "unknown",
    capabilities: record.capabilities
  };
}

export function createAgentRegistryFilePath(identityFile: string): string {
  return path.join(path.dirname(identityFile), "mcp-sessions.json");
}

export class AgentRegistry {
  private store: AgentSessionStore = emptyStore();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private activeSessionIds = new Set<string>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AgentSessionStore;

      this.store = {
        schemaVersion: 1,
        updatedAt: getString(parsed.updatedAt) ?? nowIso(),
        sessions: typeof parsed.sessions === "object" && parsed.sessions !== null ? parsed.sessions : {}
      };

      for (const record of Object.values(this.store.sessions)) {
        if (!record.closedAt) {
          record.status = "recent";
          record.disconnectedAt = record.disconnectedAt ?? nowIso();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.store = emptyStore();
    }

    this.loaded = true;
    await this.persist();
  }

  async registerInitialized(sessionId: string, body: unknown, context: RequestContext): Promise<void> {
    await this.load();

    const initializedAt = nowIso();
    const init = getInitializeParams(body);
    const nextRecord: AgentSessionRecord = {
      sessionId,
      status: "connected",
      clientInfo: init.clientInfo,
      protocolVersion: init.protocolVersion,
      capabilities: init.capabilities,
      createdAt: initializedAt,
      lastSeenAt: initializedAt,
      connectedAt: initializedAt,
      requestCount: 1,
      toolCallCount: countToolCalls(body),
      lastMethod: getMethods(body).at(-1),
      lastToolName: getToolNames(body).at(-1),
      userAgent: context.userAgent,
      remoteAddress: context.ip
    };

    this.supersedeMatchingInactiveSessions(nextRecord, initializedAt);
    this.activeSessionIds.add(sessionId);
    this.store.sessions[sessionId] = nextRecord;
    await this.persist();
  }

  async observeRequest(sessionId: string, body: unknown, context: RequestContext): Promise<void> {
    await this.load();

    const seenAt = nowIso();
    const record = this.store.sessions[sessionId];
    if (!record) return;

    record.status = this.activeSessionIds.has(sessionId) ? "connected" : "recent";
    record.lastSeenAt = seenAt;
    record.requestCount += 1;
    record.toolCallCount += countToolCalls(body);
    record.lastMethod = getMethods(body).at(-1) ?? record.lastMethod;
    record.lastToolName = getToolNames(body).at(-1) ?? record.lastToolName;
    record.userAgent = context.userAgent ?? record.userAgent;
    record.remoteAddress = context.ip ?? record.remoteAddress;
    await this.persist();
  }

  async observeConnection(sessionId: string, context: RequestContext): Promise<void> {
    await this.load();

    const seenAt = nowIso();
    const record = this.store.sessions[sessionId];
    if (!record) return;

    record.status = "connected";
    record.lastSeenAt = seenAt;
    record.userAgent = context.userAgent ?? record.userAgent;
    record.remoteAddress = context.ip ?? record.remoteAddress;
    this.activeSessionIds.add(sessionId);
    await this.persist();
  }

  async markDisconnected(sessionId: string): Promise<void> {
    await this.load();

    const record = this.store.sessions[sessionId];
    if (!record || record.closedAt) return;

    record.status = "recent";
    record.disconnectedAt = nowIso();
    this.activeSessionIds.delete(sessionId);
    await this.persist();
  }

  async markClosed(sessionId: string): Promise<void> {
    await this.load();

    const record = this.store.sessions[sessionId];
    if (!record) return;

    const closedAt = nowIso();
    record.status = "closed";
    record.closedAt = closedAt;
    record.disconnectedAt = record.disconnectedAt ?? closedAt;
    this.activeSessionIds.delete(sessionId);
    await this.persist();
  }

  async list(): Promise<AgentSessionRecord[]> {
    await this.load();

    const records = Object.values(this.store.sessions)
      .map((record) => {
        const status: AgentStatus = record.closedAt
          ? "closed"
          : this.activeSessionIds.has(record.sessionId)
            ? "connected"
            : "recent";

        return {
          ...record,
          status
        };
      })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

    const connectedAgentKeys = new Set(
      records
        .filter((record) => record.status === "connected")
        .map((record) => agentFingerprint(record))
    );

    return records.filter((record) => {
      if (record.status !== "recent") return true;
      return !connectedAgentKeys.has(agentFingerprint(record));
    });
  }

  private supersedeMatchingInactiveSessions(nextRecord: AgentSessionRecord, timestamp: string): void {
    const nextFingerprint = agentFingerprint(nextRecord);

    for (const record of Object.values(this.store.sessions)) {
      if (
        record.sessionId === nextRecord.sessionId ||
        record.closedAt ||
        this.activeSessionIds.has(record.sessionId) ||
        agentFingerprint(record) !== nextFingerprint
      ) {
        continue;
      }

      record.status = "closed";
      record.closedAt = timestamp;
      record.disconnectedAt = record.disconnectedAt ?? timestamp;
      record.supersededBySessionId = nextRecord.sessionId;
    }
  }

  private async persist(): Promise<void> {
    this.store.updatedAt = nowIso();
    const payload = JSON.stringify(this.store, null, 2);
    const tmpPath = `${this.filePath}.tmp`;

    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, this.filePath);
    });

    await this.writeQueue;
  }
}
