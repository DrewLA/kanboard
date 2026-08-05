import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { AppConfig } from "./config";

type LockRecord = {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
};

export type ProcessLock = {
  path: string;
  release(): Promise<void>;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function readLockRecord(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const raw = await readFile(lockPath, { encoding: "utf8" });
    const parsed = JSON.parse(raw) as Partial<LockRecord>;

    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      Number.isInteger(parsed.port)
    ) {
      return {
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : ""
      };
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }

  return undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

export async function acquireHttpServerLock(config: AppConfig): Promise<ProcessLock> {
  await mkdir(config.stateDir, { recursive: true });
  const lockPath = path.join(config.stateDir, "http-server.lock");
  const record: LockRecord = {
    pid: process.pid,
    host: config.host,
    port: config.port,
    startedAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        path: lockPath,
        release: async () => {
          if (released) return;
          released = true;

          const current = await readLockRecord(lockPath);
          if (current?.pid === process.pid) {
            await rm(lockPath, { force: true });
          }
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      const existing = await readLockRecord(lockPath);
      if (existing && processExists(existing.pid)) {
        throw new Error(
          `Another kanboard HTTP server is already running for ${existing.host}:${existing.port} ` +
          `(pid ${existing.pid}, lock ${lockPath}). Stop that process before starting another one.`
        );
      }

      await rm(lockPath, { force: true });
    }
  }

  throw new Error(`Could not acquire kanboard HTTP server lock at ${lockPath}.`);
}
