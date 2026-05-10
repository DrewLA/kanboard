import { AppConfig } from "./config";
import { RepositoryConflictError, TeamBoardEmptyError } from "./repository";

export function getStorageLogContext(config: AppConfig): Record<string, string> {
  return {
    mode: config.mode,
    stateDir: config.stateDir,
    dbConfigured: String(Boolean(config.dbString))
  };
}

export function formatCreatingKanboardMessage(config: AppConfig): string {
  if (config.mode === "team") {
    return "No existing team kanboard package found in the configured DB; creating a new kanboard.";
  }

  return `No existing kanboard state package found at ${config.stateDir}; creating a new kanboard.`;
}

export function formatTeamBoardEmptyBanner(): string {
  return [
    "",
    "╔════════════════════════════════════════╗",
    "║   Kanboard — First-Time Team Setup     ║",
    "╚════════════════════════════════════════╝",
    "",
    "The team board database is empty.",
    "The first team member must run onboarding to initialize it:",
    "",
    "  npm run identity:onboard",
    "",
    "Then restart the server.",
    "",
  ].join("\n");
}

export function isTeamBoardEmptyError(error: unknown): error is TeamBoardEmptyError {
  return error instanceof TeamBoardEmptyError;
}

export function formatStartupError(serverName: string, error: unknown, config?: AppConfig): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!(error instanceof RepositoryConflictError)) {
    return `Failed to start ${serverName}: ${message}`;
  }

  const storage = config?.mode ?? "unknown";
  const location = config?.mode === "team"
    ? "configured team DB tables"
    : config?.stateDir ?? "configured state package";
  const resetAction = config?.mode === "team"
    ? "create a new team DB prefix/connection string after backing up the old tables"
    : "move or remove TASKBOARD_STATE_DIR after backing it up";

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
    "Common causes are another kanboard process using the same storage location, a reused DB prefix, or a manual restore/edit of the stored JSON.",
    "",
    "To recover, stop duplicate processes and restart. If you wanted a brand-new board, " + resetAction + "."
  ].join("\n");
}
