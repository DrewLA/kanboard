import { Redis } from "@upstash/redis";
import { getAddress } from "ethers";

import { getAppConfig } from "../config";
import { createEmptyTaskboardDocument, nowIso } from "../model";
import { StateTable, UserRecord, statePackageFromDocument, tableNames } from "../state-package";

function usage(): never {
  console.error("Usage:");
  console.error("  npm run team:init -- <address> <name> <role>");
  console.error("  npm run team:add-user -- <address> <name> <role>");
  process.exit(1);
}

function parseDbString(dbString: string): { url: string; token: string; prefix: string } {
  const [scheme, ...parts] = dbString.split(";");

  if (scheme !== "upstash") {
    throw new Error("Only upstash TASKBOARD_DB_STRING values are supported by the current internal team tools.");
  }

  const values = Object.fromEntries(parts.map((part) => {
    const [key, ...rawValue] = part.split("=");
    return [key, decodeURIComponent(rawValue.join("="))];
  }));

  if (!values.url || !values.token) {
    throw new Error("TASKBOARD_DB_STRING must include url and token.");
  }

  return {
    url: values.url,
    token: values.token,
    prefix: values.prefix || "kanboard:main"
  };
}

function buildUser(address: string, name: string, role: string): UserRecord {
  const timestamp = nowIso();

  return {
    id: getAddress(address),
    name,
    role,
    avatarIcon: "user",
    avatarColor: "#2563eb",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function main(): Promise<void> {
  const [_node, script, address, name = "Team Member", role = "member"] = process.argv;
  const command = script.endsWith("team-admin.ts") ? process.env.TASKBOARD_ADMIN_COMMAND : undefined;
  const inferredCommand = command ?? (process.env.npm_lifecycle_event === "team:init" ? "init" : "add-user");

  if (!address || process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
  }

  const config = getAppConfig();

  if (!config.dbString) {
    throw new Error("Set TASKBOARD_DB_STRING before running team admin tools.");
  }

  const parsed = parseDbString(config.dbString);
  const redis = new Redis({
    url: parsed.url,
    token: parsed.token,
    automaticDeserialization: false
  });
  const tableKey = (tableName: string) => `${parsed.prefix}:table:${tableName}`;
  const user = buildUser(address, name, role);

  if (inferredCommand === "init") {
    const statePackage = statePackageFromDocument(createEmptyTaskboardDocument());
    statePackage.tables.users.rows[user.id] = {
      version: 1,
      value: user
    };
    statePackage.tables.users.version = 1;
    statePackage.tables.users.updatedAt = nowIso();

    for (const tableName of tableNames) {
      await redis.set(tableKey(tableName), JSON.stringify(statePackage.tables[tableName]));
    }

    console.log(`Initialized team board and registered ${user.id}.`);
    return;
  }

  const raw = await redis.get<string | null>(tableKey("users"));
  const usersTable: StateTable<UserRecord> = raw
    ? JSON.parse(raw) as StateTable<UserRecord>
    : { schemaVersion: 1, version: 0, updatedAt: nowIso(), rows: {} };
  usersTable.rows[user.id] = {
    version: (usersTable.rows[user.id]?.version ?? 0) + 1,
    value: user
  };
  usersTable.version += 1;
  usersTable.updatedAt = nowIso();
  await redis.set(tableKey("users"), JSON.stringify(usersTable));
  console.log(`Registered ${user.id}.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
