import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  TASKBOARD_STORAGE: z.enum(["upstash", "local"]).default("upstash"),
  TASKBOARD_LOCAL_FILE: z.string().min(1).default(".taskboard/local-taskboard.json"),
  TASKBOARD_HOST: z.string().default("127.0.0.1"),
  TASKBOARD_PORT: z.coerce.number().int().positive().default(8787),
  TASKBOARD_REDIS_KEY: z.string().min(1).default("taskboard:main"),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional()
});

export type AppConfig = {
  storage: "upstash" | "local";
  localFile: string;
  host: string;
  port: number;
  redisKey: string;
  redisUrl?: string;
  redisToken?: string;
};

export function getAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    storage: parsed.TASKBOARD_STORAGE,
    localFile: path.resolve(parsed.TASKBOARD_LOCAL_FILE),
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
  if (config.storage === "upstash") {
    assertRedisConfig(config);
  }
}