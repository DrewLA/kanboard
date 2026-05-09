import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalNonEmptyString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional()
);

const envSchema = z.object({
  TASKBOARD_MODE: z.enum(["private", "private-backup", "team"]).optional(),
  TASKBOARD_STORAGE: z.enum(["upstash", "local"]).optional(),
  TASKBOARD_DB_STRING: optionalNonEmptyString,
  TASKBOARD_STATE_DIR: z.string().min(1).default(".kanboard/state"),
  TASKBOARD_IDENTITY_FILE: z.string().min(1).default(".kanboard/identity.json"),
  TASKBOARD_USER_FILE: z.string().min(1).default(".kanboard/user.json"),
  TASKBOARD_LOCAL_FILE: z.string().min(1).default(".taskboard/local-taskboard.json"),
  TASKBOARD_PRIVATE_USERNAME: z.string().min(1).default("Private User"),
  TASKBOARD_EVM_PRIVATE_KEY: optionalNonEmptyString,
  TASKBOARD_BACKUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  TASKBOARD_HOST: z.string().default("127.0.0.1"),
  TASKBOARD_PORT: z.coerce.number().int().positive().default(8787),
  TASKBOARD_REDIS_KEY: z.string().min(1).default("taskboard:main"),
  UPSTASH_REDIS_REST_URL: optionalNonEmptyString,
  UPSTASH_REDIS_REST_TOKEN: optionalNonEmptyString
});

export type AppConfig = {
  mode: "private" | "private-backup" | "team";
  storage: "upstash" | "local";
  stateDir: string;
  identityFile: string;
  userFile: string;
  localFile: string;
  privateUsername: string;
  evmPrivateKey?: string;
  backupIntervalMinutes: number;
  dbString?: string;
  host: string;
  port: number;
  redisKey: string;
  redisUrl?: string;
  redisToken?: string;
};

function resolveMode(parsed: z.infer<typeof envSchema>): AppConfig["mode"] {
  if (parsed.TASKBOARD_MODE) {
    return parsed.TASKBOARD_MODE;
  }

  if (parsed.TASKBOARD_STORAGE === "upstash") {
    return "team";
  }

  return "private";
}

function buildLegacyUpstashDbString(parsed: z.infer<typeof envSchema>): string | undefined {
  if (!parsed.UPSTASH_REDIS_REST_URL || !parsed.UPSTASH_REDIS_REST_TOKEN) {
    return undefined;
  }

  return [
    "upstash",
    `url=${encodeURIComponent(parsed.UPSTASH_REDIS_REST_URL)}`,
    `token=${encodeURIComponent(parsed.UPSTASH_REDIS_REST_TOKEN)}`,
    `prefix=${encodeURIComponent(parsed.TASKBOARD_REDIS_KEY)}`
  ].join(";");
}

export function getAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const mode = resolveMode(parsed);

  return {
    mode,
    storage: parsed.TASKBOARD_STORAGE ?? (mode === "private" ? "local" : "upstash"),
    stateDir: path.resolve(parsed.TASKBOARD_STATE_DIR),
    identityFile: path.resolve(parsed.TASKBOARD_IDENTITY_FILE),
    userFile: path.resolve(parsed.TASKBOARD_USER_FILE),
    localFile: path.resolve(parsed.TASKBOARD_LOCAL_FILE),
    privateUsername: parsed.TASKBOARD_PRIVATE_USERNAME,
    evmPrivateKey: parsed.TASKBOARD_EVM_PRIVATE_KEY,
    backupIntervalMinutes: parsed.TASKBOARD_BACKUP_INTERVAL_MINUTES,
    dbString: parsed.TASKBOARD_DB_STRING ?? buildLegacyUpstashDbString(parsed),
    host: parsed.TASKBOARD_HOST,
    port: parsed.TASKBOARD_PORT,
    redisKey: parsed.TASKBOARD_REDIS_KEY,
    redisUrl: parsed.UPSTASH_REDIS_REST_URL,
    redisToken: parsed.UPSTASH_REDIS_REST_TOKEN
  };
}

export function assertRedisConfig(config: AppConfig): Required<Pick<AppConfig, "redisUrl" | "redisToken">> {
  const missingKeys: string[] = [];

  if (!config.redisUrl) {
    missingKeys.push("UPSTASH_REDIS_REST_URL");
  }

  if (!config.redisToken) {
    missingKeys.push("UPSTASH_REDIS_REST_TOKEN");
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `TASKBOARD_STORAGE=upstash requires these environment variables: ${missingKeys.join(", ")}. ` +
      "Set them in .env, or switch to TASKBOARD_STORAGE=local for local file persistence."
    );
  }

  return {
    redisUrl: config.redisUrl!,
    redisToken: config.redisToken!
  };
}

export function assertStorageConfig(config: AppConfig): void {
  if (config.mode === "team" && !config.dbString) {
    throw new Error(
      "TASKBOARD_MODE=team requires TASKBOARD_DB_STRING. " +
      "Create a team board and provide its connection string, or switch to TASKBOARD_MODE=private."
    );
  }

  if (config.mode === "private-backup" && !config.dbString) {
    throw new Error(
      "TASKBOARD_MODE=private-backup requires TASKBOARD_DB_STRING for hourly backups. " +
      "Provide a backup connection string, or switch to TASKBOARD_MODE=private."
    );
  }

  if (config.storage === "upstash" && !config.dbString) {
    assertRedisConfig(config);
  }
}
