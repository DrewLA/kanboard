import { AppConfig } from "./config";
import { RepositoryConflictError } from "./repository";

export function getStorageLogContext(config: AppConfig): Record<string, string> {
  if (config.storage === "local") {
    return {
      storage: config.storage,
      localFile: config.localFile
    };
  }

  return {
    storage: config.storage,
    redisKey: config.redisKey
  };
}

export function formatCreatingKanboardMessage(config: AppConfig): string {
  if (config.storage === "local") {
    return `No existing kanboard file found at ${config.localFile}; creating a new kanboard.`;
  }

  return `No existing kanboard found at Upstash Redis key "${config.redisKey}"; creating a new kanboard.`;
}

export function formatStartupError(serverName: string, error: unknown, config?: AppConfig): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!(error instanceof RepositoryConflictError)) {
    return `Failed to start ${serverName}: ${message}`;
  }

  const storage = config?.storage === "local" ? "local JSON file" : "Upstash Redis";
  const location = config?.storage === "local"
    ? config.localFile
    : config
      ? config.redisKey
      : "the configured Redis key";
  const resetAction = config?.storage === "local"
    ? "move or remove TASKBOARD_LOCAL_FILE after backing it up"
    : "choose a new TASKBOARD_REDIS_KEY, or delete the existing Redis key after backing it up";

  return [
    `Failed to start ${serverName}: ${message}`,
    "",
    "Kanboard storage revision conflict:",
    `- Storage: ${storage}`,
    `- Location: ${location}`,
    `- Operation: ${error.operation}`,
    `- Expected revision: ${error.expectedRevision}`,
    `- Stored revision: ${error.currentRevision}`,
    "",
    "This means the board changed between the read step and the write step, or the configured storage location already contains a different board revision.",
    "Common causes are another kanboard process using the same storage location, a reused TASKBOARD_REDIS_KEY, or a manual restore/edit of the stored JSON.",
    "",
    "To recover, stop duplicate processes and restart. If you wanted a brand-new board, " + resetAction + "."
  ].join("\n");
}
