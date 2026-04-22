import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Redis } from "@upstash/redis";

import { AppConfig, assertRedisConfig } from "./config";
import { createEmptyTaskboardDocument, normalizeTaskboardDocument, TaskboardDocument } from "./model";

const LOCAL_LOCK_RETRIES = 20;
const LOCAL_LOCK_DELAY_MS = 10;

export class RepositoryConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Document revision mismatch. Current revision is ${currentRevision}.`);
    this.name = "RepositoryConflictError";
    this.currentRevision = currentRevision;
  }
}

export interface TaskboardRepository {
  load(): Promise<TaskboardDocument>;
  save(document: TaskboardDocument, expectedRevision: number): Promise<TaskboardDocument>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
      token: redisToken
    });
  }

  async load(): Promise<TaskboardDocument> {
    const value = await this.redis.get<string>(this.redisKey);

    if (!value) {
      const initial = createEmptyTaskboardDocument();
      await this.save(initial, 0);
      return initial;
    }

    if (typeof value !== "string") {
      return normalizeTaskboardDocument(value);
    }

    return normalizeTaskboardDocument(JSON.parse(value));
  }

  async save(document: TaskboardDocument, expectedRevision: number): Promise<TaskboardDocument> {
    const result = await this.redis.eval<string[], string>(this.compareAndSetScript, [this.redisKey], [String(expectedRevision), JSON.stringify(document)]);
    const payload = typeof result === "string" ? JSON.parse(result) as { ok?: boolean; currentRevision?: number } : {};

    if (!payload.ok) {
      throw new RepositoryConflictError(typeof payload.currentRevision === "number" ? payload.currentRevision : 0);
    }

    return document;
  }
}

export class LocalFileTaskboardRepository implements TaskboardRepository {
  constructor(private readonly filePath: string) {}

  private async withFileLock<T>(callback: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;

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

  async load(): Promise<TaskboardDocument> {
    try {
      const value = await readFile(this.filePath, "utf8");
      return normalizeTaskboardDocument(JSON.parse(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const initial = createEmptyTaskboardDocument();
      await this.save(initial, 0);
      return initial;
    }
  }

  async save(document: TaskboardDocument, expectedRevision: number): Promise<TaskboardDocument> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;

    await this.withFileLock(async () => {
      const current = await this.readCurrentDocument();

      if (current.revision !== expectedRevision) {
        throw new RepositoryConflictError(current.revision);
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