import path from "node:path";

import { assertRedisConfig, getAppConfig } from "../config";
import { LocalFileTaskboardRepository, UpstashRedisTaskboardRepository } from "../repository";

async function run() {
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down") {
    console.error("Usage: tsx src/scripts/migrate.ts [up|down]");
    console.error("up:   Local -> Upstash Redis");
    console.error("down: Upstash Redis -> Local");
    process.exit(1);
  }

  const config = getAppConfig();
  const redisConfig = assertRedisConfig(config);

  const localRepo = new LocalFileTaskboardRepository(config.localFile);
  const upstashRepo = new UpstashRedisTaskboardRepository(
    redisConfig.redisUrl,
    redisConfig.redisToken,
    config.redisKey
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (direction === "up") {
    console.log("Migrating UP: Local -> Upstash Redis");

    console.log("Creating backup of current Upstash Redis data...");
    const upstashData = await upstashRepo.load();
    const backupKey = `${config.redisKey}:backup:${timestamp}`;
    const backupRepo = new UpstashRedisTaskboardRepository(
      redisConfig.redisUrl,
      redisConfig.redisToken,
      backupKey
    );
    await backupRepo.save(upstashData, 0);
    console.log(`Backup created at key [${backupKey}]`);

    console.log("Reading data from Local file...");
    const localData = await localRepo.load();

    console.log("Overwriting Upstash Redis data...");
    await upstashRepo.save(localData, upstashData.revision);

    console.log("Migration UP completed successfully.");
  } else if (direction === "down") {
    console.log("Migrating DOWN: Upstash Redis -> Local");

    console.log("Creating backup of current Local data...");
    const localData = await localRepo.load();
    const backupFile = path.resolve(
      path.dirname(config.localFile),
      path.basename(config.localFile, ".json") + `.backup-${timestamp}.json`
    );
    const backupRepo = new LocalFileTaskboardRepository(backupFile);
    await backupRepo.save(localData, 0);
    console.log(`Backup created at file [${backupFile}]`);

    console.log("Reading data from Upstash Redis...");
    const upstashData = await upstashRepo.load();

    console.log("Overwriting Local file data...");
    await localRepo.save(upstashData, localData.revision);

    console.log("Migration DOWN completed successfully.");
  }
}

run().catch((error) => {
  console.error("\nMigration failed:", error);
  process.exit(1);
});