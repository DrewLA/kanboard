/**
 * migrate-hash — one-time storage migration for team (Upstash) boards.
 *
 * Converts each table from the legacy single-string-blob layout
 *   (SET  <prefix>:table:<name>  '{"rows":{...all rows...}}')
 * to the per-row hash layout the current code reads/writes
 *   (HSET <prefix>:table:<name>  <rowId> '{"version":N,"value":{...}}')
 * plus a small sibling meta key
 *   (SET  <prefix>:meta:<name>   '{"schemaVersion":1,"version":N,"updatedAt":"..."}').
 *
 * The row *values* are untouched — only how the table is packed into Redis
 * changes. This removes the whole-table cjson.decode that was tripping Upstash's
 * Lua script execution-time limit on writes.
 *
 * Safe to run:
 *   - Idempotent: tables already stored as hashes are skipped.
 *   - Crash-safe: the new hash is built at a temp key and RENAMEd over the blob
 *     atomically, so the original blob stays intact until the swap succeeds.
 *
 * Run as the board admin, once, before restarting on the new build:
 *   npm run backup        # snapshot first (see backup.ts)
 *   npm run migrate:hash
 *   # then restart the server
 */
import { Redis } from "@upstash/redis";

import { getAppConfig } from "../config";
import { parseDbString } from "../repository";
import { encodeRowsToHashFields, encodeTableMeta, normalizeTable, tableNames } from "../state-package";

async function run(): Promise<void> {
  const config = getAppConfig();

  if (!config.dbString) {
    console.error("No TASKBOARD_DB_STRING configured. This migration only applies to Upstash (team) boards.");
    process.exit(1);
  }

  const parsed = parseDbString(config.dbString);
  const redis = new Redis({ url: parsed.url, token: parsed.token, automaticDeserialization: false });

  console.log(`Migrating tables under prefix "${parsed.prefix}" from string blobs to per-row hashes...\n`);

  let converted = 0;
  let skipped = 0;
  let emptied = 0;

  for (const tableName of tableNames) {
    const rowsKey = `${parsed.prefix}:table:${tableName}`;
    const metaKey = `${parsed.prefix}:meta:${tableName}`;
    const type = await redis.type(rowsKey);

    if (type === "hash") {
      console.log(`  = ${tableName}: already a hash — skipped`);
      skipped += 1;
      continue;
    }

    if (type === "none") {
      console.log(`  · ${tableName}: no data`);
      continue;
    }

    if (type !== "string") {
      throw new Error(`Unexpected Redis type "${type}" at ${rowsKey}; refusing to migrate.`);
    }

    const raw = await redis.get<string | null>(rowsKey);
    const table = normalizeTable(raw ? JSON.parse(raw) : {});
    const fields = encodeRowsToHashFields(table);
    const rowCount = Object.keys(fields).length;

    if (rowCount === 0) {
      // Empty legacy blob: drop the string key and write meta so the new code
      // sees an empty (hash) table rather than a string it would choke on.
      await redis.del(rowsKey);
      await redis.set(metaKey, encodeTableMeta(table));
      console.log(`  → ${tableName}: 0 rows — blob removed`);
      emptied += 1;
      continue;
    }

    // Write meta first, then atomically swap in the hash. If we crash between,
    // the rows key is still the original string blob, so a re-run re-migrates it
    // cleanly (rather than leaving a migrated hash with stale/missing meta).
    await redis.set(metaKey, encodeTableMeta(table));
    const tempKey = `${rowsKey}:__hashmigrate`;
    await redis.del(tempKey);
    await redis.hset(tempKey, fields);
    await redis.rename(tempKey, rowsKey); // atomic replace; blob intact until here
    console.log(`  → ${tableName}: ${rowCount} rows converted`);
    converted += 1;
  }

  console.log(`\nDone. ${converted} converted, ${emptied} emptied, ${skipped} already migrated.`);
  console.log("Restart the server on the new build to use hash storage.");
}

run().catch((error) => {
  console.error("\nMigration failed:", error);
  process.exit(1);
});
