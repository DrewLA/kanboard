import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Redis } from "@upstash/redis";

import { AppConfig, assertRedisConfig } from "./config";
import { createEmptyTaskboardDocument, normalizeTaskboardDocument, TaskboardDocument } from "./model";

const LOCAL_LOCK_RETRIES = 20;
const LOCAL_LOCK_DELAY_MS = 10;

export class RepositoryConflictError extends Error {
  readonly currentRevision: number;
  readonly expectedRevision: number;
  readonly operation: string;

  constructor(currentRevision: number, expectedRevision: number, operation = "save the kanboard document") {
    super(
      `Document revision mismatch while trying to ${operation}. ` +
      `Expected revision ${expectedRevision}, but storage currently has revision ${currentRevision}.`
    );
    this.name = "RepositoryConflictError";
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
    this.operation = operation;
  }
}

export class RepositoryDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryDataError";
  }
}

export interface LoadTaskboardOptions {
  onCreate?: (document: TaskboardDocument) => void | Promise<void>;
}

export interface SaveTaskboardOptions {
  operation?: string;
}

export interface TaskboardRepository {
  load(options?: LoadTaskboardOptions): Promise<TaskboardDocument>;
  save(document: TaskboardDocument, expectedRevision: number, options?: SaveTaskboardOptions): Promise<TaskboardDocument>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseRevision(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}

function describeRedisResponse(result: unknown): string {
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

function parseCompareAndSetResult(result: unknown): { ok: boolean; currentRevision: number } {
  let payload = result;

  if (typeof result === "string") {
    try {
      payload = JSON.parse(result) as unknown;
    } catch {
      throw new Error(`Unexpected Upstash Redis compare-and-set response: ${describeRedisResponse(result)}.`);
    }
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`Unexpected Upstash Redis compare-and-set response: ${describeRedisResponse(result)}.`);
  }

  const record = payload as { ok?: unknown; currentRevision?: unknown };

  if (typeof record.ok !== "boolean") {
    throw new Error(`Unexpected Upstash Redis compare-and-set response: ${describeRedisResponse(result)}.`);
  }

  return {
    ok: record.ok,
    currentRevision: parseRevision(record.currentRevision)
  };
}

function parseStoredDocumentJson(value: string, source: string, recovery: string): TaskboardDocument {
  try {
    return normalizeTaskboardDocument(JSON.parse(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    throw new RepositoryDataError(
      `${source} exists but does not contain valid kanboard JSON. ` +
      "The server will not overwrite it automatically. " +
      `${recovery} JSON parse error: ${detail}.`
    );
  }
}

export class UpstashRedisTaskboardRepository implements TaskboardRepository {
  private readonly redis: Redis;
  private readonly compareAndSetScript = `
local current = redis.call("GET", KEYS[1])
local expectedRevision = tonumber(ARGV[1])
local nextValue = ARGV[2]

if not current then
  if expectedRevision ~= 0 then
    return cjson.encode({ ok = false, currentRevision = 0 })
  end

  redis.call("SET", KEYS[1], nextValue)
  return cjson.encode({ ok = true, currentRevision = 0 })
end

local currentDocument = cjson.decode(current)
local currentRevision = tonumber(currentDocument.revision) or 0

if currentRevision ~= expectedRevision then
  return cjson.encode({ ok = false, currentRevision = currentRevision })
end

redis.call("SET", KEYS[1], nextValue)
return cjson.encode({ ok = true, currentRevision = currentRevision })
`;

  constructor(
    private readonly redisUrl: string,
    private readonly redisToken: string,
    private readonly redisKey: string
  ) {
    this.redis = new Redis({
      url: redisUrl,
      token: redisToken,
      automaticDeserialization: false
    });
  }

  async load(options: LoadTaskboardOptions = {}): Promise<TaskboardDocument> {
    const value = await this.redis.get<string | null>(this.redisKey);

    if (value === null || value === undefined) {
      const initial = createEmptyTaskboardDocument();
      await options.onCreate?.(initial);
      await this.save(initial, 0, { operation: "create the initial Upstash kanboard" });
      return initial;
    }

    if (typeof value !== "string") {
      return normalizeTaskboardDocument(value);
    }

    return parseStoredDocumentJson(
      value,
      `Upstash Redis key "${this.redisKey}"`,
      "Back it up, fix the stored value, delete the key, or set TASKBOARD_REDIS_KEY to a fresh key."
    );
  }

  async save(document: TaskboardDocument, expectedRevision: number, options: SaveTaskboardOptions = {}): Promise<TaskboardDocument> {
    const result = await this.redis.eval<string[], unknown>(this.compareAndSetScript, [this.redisKey], [String(expectedRevision), JSON.stringify(document)]);
    const payload = parseCompareAndSetResult(result);

    if (!payload.ok) {
      throw new RepositoryConflictError(payload.currentRevision, expectedRevision, options.operation);
    }

    return document;
  }
}

export class LocalFileTaskboardRepository implements TaskboardRepository {
  constructor(private readonly filePath: string) {}

  private async withFileLock<T>(callback: () => Promise<T>): Promise<T> {
    const directory = path.dirname(this.filePath);
    const lockPath = `${this.filePath}.lock`;

    await mkdir(directory, { recursive: true });

    for (let attempt = 0; attempt < LOCAL_LOCK_RETRIES; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");

        try {
          return await callback();
        } finally {
          await handle.close();
          await rm(lockPath, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === LOCAL_LOCK_RETRIES - 1) {
          throw error;
        }

        await delay(LOCAL_LOCK_DELAY_MS);
      }
    }

    throw new Error("Failed to acquire local taskboard lock.");
  }

  private async readCurrentDocument(): Promise<TaskboardDocument> {
    try {
      const value = await readFile(this.filePath, "utf8");
      return normalizeTaskboardDocument(JSON.parse(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      return createEmptyTaskboardDocument();
    }
  }

  async load(options: LoadTaskboardOptions = {}): Promise<TaskboardDocument> {
    try {
      const value = await readFile(this.filePath, "utf8");
      return parseStoredDocumentJson(
        value,
        `Local kanboard file ${this.filePath}`,
        "Back it up, fix the file, remove it, or set TASKBOARD_LOCAL_FILE to a fresh path."
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const initial = createEmptyTaskboardDocument();
      await options.onCreate?.(initial);
      await this.save(initial, 0, { operation: "create the initial local kanboard" });
      return initial;
    }
  }

  async save(document: TaskboardDocument, expectedRevision: number, options: SaveTaskboardOptions = {}): Promise<TaskboardDocument> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;

    await this.withFileLock(async () => {
      const current = await this.readCurrentDocument();

      if (current.revision !== expectedRevision) {
        throw new RepositoryConflictError(current.revision, expectedRevision, options.operation);
      }

      await mkdir(directory, { recursive: true });
      await writeFile(tempPath, JSON.stringify(document, null, 2), "utf8");
      await rename(tempPath, this.filePath);
    });

    return document;
  }
}

export function createTaskboardRepository(config: AppConfig): TaskboardRepository {
  if (config.storage === "local") {
    return new LocalFileTaskboardRepository(config.localFile);
  }

  const redisConfig = assertRedisConfig(config);
  return new UpstashRedisTaskboardRepository(redisConfig.redisUrl, redisConfig.redisToken, config.redisKey);
}
