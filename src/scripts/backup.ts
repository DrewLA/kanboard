/**
 * backup — snapshot the team (Upstash) board to a local folder.
 *
 * Reads every table under the configured prefix straight from Upstash and writes
 * one JSON file per table into `.backup/<timestamp>/`, plus a manifest. Reads are
 * format-agnostic: whether a table is still a legacy string blob or the new
 * per-row hash, the output is the same logical StateTable JSON, so this is safe
 * to run before OR after the hash migration.
 *
 * Run as the board admin before any risky operation (e.g. the hash migration):
 *   npm run backup
 *
 * To restore a table, the JSON files here are plain StateTables. Restoring is a
 * deliberate, manual step (write them back with the appropriate storage layout);
 * this script only reads.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Redis } from "@upstash/redis";

import { loadAppConfig } from "../config";
import { parseDbString } from "../repository";
import { normalizeTable, tableFromHashFields, tableNames } from "../state-package";

async function run(): Promise<void> {
  const config = loadAppConfig();

  if (!config.dbString) {
    console.error("No TASKBOARD_DB_STRING configured. This backup only applies to Upstash (team) boards.");
    process.exit(1);
  }

  const parsed = parseDbString(config.dbString);
  const redis = new Redis({ url: parsed.url, token: parsed.token, automaticDeserialization: false });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(process.cwd(), ".backup", timestamp);
  await mkdir(outDir, { recursive: true });

  console.log(`Backing up Upstash prefix "${parsed.prefix}" -> ${outDir}\n`);

  const manifest: { prefix: string; createdAt: string; tables: Record<string, number> } = {
    prefix: parsed.prefix,
    createdAt: new Date().toISOString(),
    tables: {}
  };

  for (const tableName of tableNames) {
    const rowsKey = `${parsed.prefix}:table:${tableName}`;
    const type = await redis.type(rowsKey);

    let table;
    if (type === "hash") {
      const [fields, metaRaw] = await Promise.all([
        redis.hgetall<Record<string, string>>(rowsKey),
        redis.get<string | null>(`${parsed.prefix}:meta:${tableName}`)
      ]);
      table = tableFromHashFields(fields, metaRaw ?? undefined);
    } else if (type === "string") {
      const raw = await redis.get<string | null>(rowsKey);
      table = normalizeTable(raw ? JSON.parse(raw) : {});
    } else {
      table = normalizeTable({});
    }

    const rowCount = Object.keys(table.rows).length;
    manifest.tables[tableName] = rowCount;
    await writeFile(path.join(outDir, `${tableName}.json`), JSON.stringify(table, null, 2), "utf8");
    console.log(`  ✓ ${tableName}: ${rowCount} rows`);
  }

  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nBackup complete: ${outDir}`);
}

run().catch((error) => {
  console.error("\nBackup failed:", error);
  process.exit(1);
});
