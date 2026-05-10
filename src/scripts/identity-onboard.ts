import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Redis } from "@upstash/redis";
import { getAddress } from "ethers";

import { getAppConfig } from "../config";
import { nowIso } from "../model";
import { StateTable, UserRecord } from "../state-package";
import { createEncryptedIdentity, fileExists, promptHidden, promptLine, writeIdentityFile } from "../identity-store";

const AVATAR_COLORS = [
  "#2563eb", "#7c3aed", "#db2777", "#dc2626",
  "#d97706", "#16a34a", "#0891b2", "#9333ea",
  "#e11d48", "#0284c7"
];

function randomAvatarColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function parseDbString(dbString: string): { url: string; token: string; prefix: string } {
  const [scheme, ...parts] = dbString.split(";");

  if (scheme !== "upstash") {
    throw new Error(`Unsupported DB scheme "${scheme}". Only upstash is supported.`);
  }

  const values = Object.fromEntries(parts.map((part) => {
    const [key, ...rawValue] = part.split("=");
    return [key, decodeURIComponent(rawValue.join("="))];
  }));

  if (!values.url || !values.token) {
    throw new Error("TASKBOARD_DB_STRING must include url and token.");
  }

  return { url: values.url, token: values.token, prefix: values.prefix || "taskboard:main" };
}

async function pingRedis(dbString: string): Promise<Redis> {
  const parsed = parseDbString(dbString);
  const redis = new Redis({ url: parsed.url, token: parsed.token, automaticDeserialization: false });
  await redis.ping();
  return redis;
}

async function upsertUserInDb(redis: Redis, dbString: string, user: UserRecord): Promise<void> {
  const parsed = parseDbString(dbString);
  const tableKey = (name: string) => `${parsed.prefix}:table:${name}`;
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
}

async function readExistingAddress(userFile: string): Promise<string | null> {
  try {
    const raw = await readFile(userFile, { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    return typeof parsed?.address === "string" ? parsed.address : null;
  } catch {
    return null;
  }
}

async function promptConfirm(question: string): Promise<boolean> {
  const answer = await promptLine(question);
  return answer.trim().toLowerCase() === "y";
}

async function checkUsersTableExists(redis: Redis, dbString: string): Promise<boolean> {
  const parsed = parseDbString(dbString);
  const tableKey = (name: string) => `${parsed.prefix}:table:${name}`;
  const raw = await redis.get<string | null>(tableKey("users"));
  return raw !== null;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const config = getAppConfig();
  const identityPath = config.identityFile;

  // ── Intro ─────────────────────────────────────────────────────────────────
  console.error("");
  console.error("╔════════════════════════════════════════╗");
  console.error("║     Kanboard — Identity Onboarding     ║");
  console.error("╚════════════════════════════════════════╝");
  console.error("");
  console.error("This sets up your local identity for the board.");
  if (config.mode === "team") {
    console.error("Mode: team  (shared DB)");
    console.error("Your identity will be written locally and registered in the team database.");
  } else {
    console.error(`Mode: ${config.mode}  (local only)`);
    console.error("Your identity will be stored locally.");
  }
  console.error("");

  // ── Check for existing identity ──────────────────────────────────────────
  if ((await fileExists(identityPath)) && !force) {
    const existingAddress = await readExistingAddress(config.userFile);

    console.error("");
    console.error("An identity file already exists at:");
    console.error(`  ${identityPath}`);

    if (existingAddress) {
      console.error("");
      console.error(`Maybe your address is: ${existingAddress}`);
      console.error("(Cannot be certain — identity.json may have been edited manually.)");
    }

    console.error("");

    const confirmed = await promptConfirm("Overwrite existing identity? This cannot be undone. [y/N] ");

    if (!confirmed) {
      console.error("Aborted.");
      process.exit(0);
    }

    console.error("");
  }

  // ── Verify DB connection (if configured) ─────────────────────────────────
  let redis: Redis | null = null;
  let isFirstTeamSetup = false;

  if (config.dbString) {
    console.error("Checking database connection...");

    try {
      redis = await pingRedis(config.dbString);
      console.error("  ✓ Connected.");

      isFirstTeamSetup = !(await checkUsersTableExists(redis, config.dbString));
      if (isFirstTeamSetup) {
        console.error("  ℹ  No users table found — this looks like a first-time setup.");
        console.error("     The users table will be created when your profile is written.");
      } else {
        console.error("  ✓ Users table found.");
      }
      console.error("");
    } catch (err) {
      console.error(`  ✗ Could not reach the database: ${err instanceof Error ? err.message : String(err)}`);
      console.error("  Check your TASKBOARD_DB_STRING value and ensure the service is reachable.");
      console.error("");
      const proceed = await promptConfirm("Continue without writing to the database? [y/N] ");

      if (!proceed) {
        console.error("Aborted.");
        process.exit(1);
      }

      console.error("");
    }
  }

  // ── Profile questions ─────────────────────────────────────────────────────
  console.error("── Step 1 of 3: Your profile ────────────────────────────────────");
  console.error("");

  let displayName = "";

  while (!displayName.trim()) {
    displayName = await promptLine("Display name: ");

    if (!displayName.trim()) {
      console.error("  Name cannot be empty.");
    }
  }

  const roleInput = await promptLine("Role (e.g. engineer, designer, pm) [member]: ");
  const role = roleInput.trim() || "member";

  const emailInput = await promptLine("Email (optional, press Enter to skip): ");
  const email = emailInput.trim() || undefined;

  // ── Key generation ────────────────────────────────────────────────────────
  console.error("");
  console.error("── Step 2 of 3: Identity key ────────────────────────────────────");
  console.error("");
  console.error("A new EVM identity will be generated for this machine.");
  console.error("The seed phrase is shown once — write it down before continuing.");
  console.error("");

  const password = await promptHidden("Set identity password: ");
  const confirmation = await promptHidden("Retype identity password: ");

  if (password.length < 9) {
    throw new Error("Identity password must be at least 9 characters.");
  }

  if (password !== confirmation) {
    throw new Error("Identity passwords did not match.");
  }

  const identity = await createEncryptedIdentity(password);

  console.error("");
  console.error("Seed phrase (write this down now — it will NOT be saved to disk):");
  console.error("");
  console.error(`  ${identity.mnemonic}`);
  console.error("");

  // ── Write identity file ───────────────────────────────────────────────────
  console.error("── Step 3 of 3: Saving identity ─────────────────────────────────");
  console.error("");
  await writeIdentityFile(identityPath, identity.identityFile);
  console.error(`  ✓ Identity file written to ${path.relative(process.cwd(), identityPath)}`);

  const timestamp = nowIso();
  const userRecord: UserRecord = {
    id: getAddress(identity.address),
    name: displayName.trim(),
    role,
    ...(email ? { email } : {}),
    avatarIcon: "user",
    avatarColor: randomAvatarColor(),
    createdAt: timestamp,
    updatedAt: timestamp
  };

  // ── Write user.json ───────────────────────────────────────────────────────
  await mkdir(path.dirname(config.userFile), { recursive: true });
  await writeFile(config.userFile, JSON.stringify({
    address: userRecord.id,
    userRecord
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  console.error(`  ✓ Profile written to ${path.relative(process.cwd(), config.userFile)}`);

  // ── Write to DB ───────────────────────────────────────────────────────────
  if (redis && config.dbString) {
    if (isFirstTeamSetup) {
      console.error("  Creating users table in database...");
    } else {
      console.error("  Registering user in database...");
    }
    try {
      await upsertUserInDb(redis, config.dbString, userRecord);
      console.error(`  ✓ User record written to database.`);
    } catch (err) {
      console.error(`  ✗ Failed to write user to database: ${err instanceof Error ? err.message : String(err)}`);
      console.error("  Your local identity was saved. Re-run onboarding or use team:add-user to register manually.");
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const boardUrl = `http://${config.host}:${config.port}`;
  console.error("");
  console.error("╔════════════════════════════════════════╗");
  console.error("║           Setup complete! ✓            ║");
  console.error("╚════════════════════════════════════════╝");
  console.error("");
  console.error(`  Address : ${userRecord.id}`);
  console.error(`  Name    : ${userRecord.name}`);
  console.error(`  Role    : ${userRecord.role}`);
  console.error("");
  console.error("  Start the board server:");
  console.error("");
  console.error("    make dev");
  console.error("");
  console.error(`  Then open: ${boardUrl}`);
  console.error("");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
