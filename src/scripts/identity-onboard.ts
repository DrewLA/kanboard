import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Redis } from "@upstash/redis";
import { getAddress } from "ethers";

import { getAppConfig } from "../config";
import { deriveAddress, signMutationEnvelope } from "../identity";
import { createEmptyTaskboardDocument, nowIso } from "../model";
import { StateTable, UserRecord, statePackageFromDocument, tableNames } from "../state-package";
import { createEncryptedIdentity, decryptPrivateKey, fileExists, promptHidden, promptLine, readIdentityFile, writeIdentityFile } from "../identity-store";

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

async function initializeTeamPackageInDb(redis: Redis, dbString: string): Promise<void> {
  const parsed = parseDbString(dbString);
  const tableKey = (name: string) => `${parsed.prefix}:table:${name}`;
  const statePackage = statePackageFromDocument(createEmptyTaskboardDocument());

  for (const tableName of tableNames) {
    await redis.set(tableKey(tableName), JSON.stringify(statePackage.tables[tableName]));
  }
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

async function readExistingProfile(userFile: string): Promise<UserRecord | null> {
  try {
    const raw = await readFile(userFile, { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    return parsed?.userRecord && typeof parsed.userRecord === "object" ? parsed.userRecord as UserRecord : null;
  } catch {
    return null;
  }
}

async function promptConfirm(question: string): Promise<boolean> {
  const answer = await promptLine(question);
  return answer.trim().toLowerCase() === "y";
}

async function promptConfirmDefaultYes(question: string): Promise<boolean> {
  const answer = await promptLine(question);
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

async function checkUsersTableExists(redis: Redis, dbString: string): Promise<boolean> {
  const parsed = parseDbString(dbString);
  const tableKey = (name: string) => `${parsed.prefix}:table:${name}`;
  const raw = await redis.get<string | null>(tableKey("users"));
  return raw !== null;
}

async function writeLocalUserFile(userFile: string, userRecord: UserRecord): Promise<void> {
  await mkdir(path.dirname(userFile), { recursive: true });
  await writeFile(userFile, JSON.stringify({
    address: userRecord.id,
    userRecord
  }, null, 2), { encoding: "utf8", mode: 0o600 });
}

async function promptProfile(existing: UserRecord | null, address: string): Promise<UserRecord> {
  let displayName = "";
  const defaultName = existing?.name?.trim() || "";

  while (!displayName.trim()) {
    const prompt = defaultName ? `Display name [${defaultName}]: ` : "Display name: ";
    displayName = (await promptLine(prompt)).trim() || defaultName;

    if (!displayName.trim()) {
      console.error("  Name cannot be empty.");
    }
  }

  const defaultRole = existing?.role?.trim() || "member";
  const roleInput = await promptLine(`Role (e.g. engineer, designer, pm) [${defaultRole}]: `);
  const role = roleInput.trim() || defaultRole;

  const defaultEmail = existing?.email?.trim() || "";
  const emailInput = await promptLine(defaultEmail ? `Email [${defaultEmail}]: ` : "Email (optional, press Enter to skip): ");
  const email = emailInput.trim() || defaultEmail || undefined;

  const timestamp = nowIso();
  return {
    id: getAddress(address),
    name: displayName,
    role,
    ...(email ? { email } : {}),
    avatarIcon: existing?.avatarIcon ?? "user",
    avatarColor: existing?.avatarColor ?? randomAvatarColor(),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

async function registerUserInTeamDb(options: {
  redis: Redis;
  dbString: string;
  userRecord: UserRecord;
  privateKey: string;
  isFirstTeamSetup: boolean;
}): Promise<void> {
  if (options.isFirstTeamSetup) {
    console.log("  Initializing team board tables in database...");
    await initializeTeamPackageInDb(options.redis, options.dbString);
    console.log("  ✓ Team board initialized.");
  }

  const parsed = parseDbString(options.dbString);
  const tableKey = (name: string) => `${parsed.prefix}:table:${name}`;
  const usersRaw = await options.redis.get<string | null>(tableKey("users"));
  const usersTable = usersRaw ? JSON.parse(usersRaw) as StateTable<UserRecord> : null;
  const currentUserVersion = usersTable?.rows?.[options.userRecord.id]?.version ?? 0;
  const metadataRaw = await options.redis.get<string | null>(tableKey("metadata"));
  const metadataTable = metadataRaw ? JSON.parse(metadataRaw) as StateTable<{ projectId?: string }> : null;
  const projectId = metadataTable?.rows?.project?.value?.projectId ?? "project";
  const signature = await signMutationEnvelope(options.privateKey, projectId, {
    nonce: randomUUID(),
    issuedAt: nowIso(),
    summary: `Register team user ${options.userRecord.id}`,
    readSet: [{ table: "users", id: options.userRecord.id, version: currentUserVersion }]
  });

  console.log(`  ✓ Registration signature created for ${signature.actor}.`);
  console.log("  Registering user in database...");
  await upsertUserInDb(options.redis, options.dbString, options.userRecord);
  console.log("  ✓ User record written to database.");
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const config = getAppConfig();
  const identityPath = config.identityFile;
  let registerExistingIdentity = false;

  // ── Intro ─────────────────────────────────────────────────────────────────
  console.log("");
  console.log("╔════════════════════════════════════════╗");
  console.log("║     Kanboard — Identity Onboarding     ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");
  console.log("This sets up your local identity for the board.");
  if (config.mode === "team") {
    console.log("Mode: team  (shared DB)");
    console.log("Your identity will be written locally and registered in the team database.");
  } else {
    console.log(`Mode: ${config.mode}  (local only)`);
    console.log("Your identity will be stored locally.");
  }
  console.log("");

  // ── Check for existing identity ──────────────────────────────────────────
  if ((await fileExists(identityPath)) && !force) {
    const existingIdentity = await readIdentityFile(identityPath);
    const existingAddress = existingIdentity.address || await readExistingAddress(config.userFile);

    console.log("");
    console.log("An identity file already exists at:");
    console.log(`  ${identityPath}`);

    if (existingAddress) {
      console.log("");
      console.log(`Address: ${existingAddress}`);
      console.log("(Read from identity.json.)");
    }

    console.log("");

    if (config.mode === "team" && config.dbString) {
      registerExistingIdentity = await promptConfirmDefaultYes("Register this existing identity in the current team database? [Y/n] ");

      if (!registerExistingIdentity) {
        const confirmed = await promptConfirm("Overwrite existing identity? This cannot be undone. [y/N] ");

        if (!confirmed) {
          console.log("Aborted.");
          process.exit(0);
        }
      }
    } else {
      const confirmed = await promptConfirm("Overwrite existing identity? This cannot be undone. [y/N] ");

      if (!confirmed) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    console.log("");
  }

  // ── Verify DB connection (if configured) ─────────────────────────────────
  let redis: Redis | null = null;
  let isFirstTeamSetup = false;

  if (config.dbString) {
    console.log("Checking database connection...");

    try {
      redis = await pingRedis(config.dbString);
      console.log("  ✓ Connected.");

      isFirstTeamSetup = !(await checkUsersTableExists(redis, config.dbString));
      if (isFirstTeamSetup) {
        console.log("  ℹ  No users table found — this looks like a first-time setup.");
        console.log("     The users table will be created when your profile is written.");
      } else {
        console.log("  ✓ Users table found.");
      }
      console.log("");
    } catch (err) {
      console.error(`  ✗ Could not reach the database: ${err instanceof Error ? err.message : String(err)}`);
      console.error("  Check your TASKBOARD_DB_STRING value and ensure the service is reachable.");
      console.log("");
      const proceed = await promptConfirm("Continue without writing to the database? [y/N] ");

      if (!proceed) {
        console.log("Aborted.");
        process.exit(1);
      }

      console.log("");
    }
  }

  if (registerExistingIdentity) {
    if (!redis || !config.dbString) {
      console.error("Cannot register existing identity because the configured team database is not reachable.");
      process.exit(1);
    }

    const identityFile = await readIdentityFile(identityPath);
    const address = getAddress(identityFile.address);
    const existingProfile = await readExistingProfile(config.userFile);

    console.log("── Step 1 of 3: Your profile ────────────────────────────────────");
    console.log("");
    const userRecord = await promptProfile(existingProfile, address);

    console.log("");
    console.log("── Step 2 of 3: Unlock identity ─────────────────────────────────");
    console.log("");
    const password = await promptHidden("Identity password: ");
    const privateKey = await decryptPrivateKey(identityFile, password);
    const decryptedAddress = getAddress(deriveAddress(privateKey));

    if (decryptedAddress !== address) {
      throw new Error(`Encrypted identity file address ${address} does not match decrypted private key address ${decryptedAddress}.`);
    }

    console.log("  ✓ Identity unlocked.");

    console.log("");
    console.log("── Step 3 of 3: Registering identity ────────────────────────────");
    console.log("");

    await writeLocalUserFile(config.userFile, userRecord);
    console.log(`  ✓ Profile written to ${path.relative(process.cwd(), config.userFile)}`);

    await registerUserInTeamDb({
      redis,
      dbString: config.dbString,
      userRecord,
      privateKey,
      isFirstTeamSetup
    });

    const boardUrl = `http://${config.host}:${config.port}`;
    console.log("");
    console.log("╔════════════════════════════════════════╗");
    console.log("║           Setup complete! ✓            ║");
    console.log("╚════════════════════════════════════════╝");
    console.log("");
    console.log(`  Address : ${userRecord.id}`);
    console.log(`  Name    : ${userRecord.name}`);
    console.log(`  Role    : ${userRecord.role}`);
    console.log("");
    console.log("  Your existing identity is now registered for this team board.");
    console.log(`  Open: ${boardUrl}`);
    console.log("");
    return;
  }

  // ── Profile questions ─────────────────────────────────────────────────────
  console.log("── Step 1 of 3: Your profile ────────────────────────────────────");
  console.log("");

  const profile = await promptProfile(null, "0x0000000000000000000000000000000000000000");

  // ── Key generation ────────────────────────────────────────────────────────
  console.log("");
  console.log("── Step 2 of 3: Identity key ────────────────────────────────────");
  console.log("");
  console.log("A new EVM identity will be generated for this machine.");
  console.log("The seed phrase is shown once — write it down before continuing.");
  console.log("");

  let password = "";
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = await promptHidden("Set identity password: ");
    const confirmation = await promptHidden("Retype identity password: ");

    if (candidate.length < 9) {
      console.error(`  ✗ Password must be at least 9 characters.${attempt < maxAttempts ? " Try again." : ""}`);
    } else if (candidate !== confirmation) {
      console.error(`  ✗ Passwords did not match.${attempt < maxAttempts ? " Try again." : ""}`);
    } else {
      password = candidate;
      break;
    }

    if (attempt === maxAttempts) {
      console.error("Too many failed attempts.");
      process.exit(1);
    }

    console.log("");
  }

  const identity = await createEncryptedIdentity(password);

  console.log("");
  console.log("Seed phrase (write this down now — it will NOT be saved to disk):");
  console.log("");
  console.log(`  ${identity.mnemonic}`);
  console.log("");

  // ── Write identity file ───────────────────────────────────────────────────
  console.log("── Step 3 of 3: Saving identity ─────────────────────────────────");
  console.log("");
  await writeIdentityFile(identityPath, identity.identityFile);
  console.log(`  ✓ Identity file written to ${path.relative(process.cwd(), identityPath)}`);

  const timestamp = nowIso();
  const userRecord: UserRecord = {
    id: getAddress(identity.address),
    name: profile.name,
    role: profile.role,
    ...(profile.email ? { email: profile.email } : {}),
    avatarIcon: profile.avatarIcon,
    avatarColor: profile.avatarColor,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  // ── Write user.json ───────────────────────────────────────────────────────
  await writeLocalUserFile(config.userFile, userRecord);
  console.log(`  ✓ Profile written to ${path.relative(process.cwd(), config.userFile)}`);

  // ── Write to DB ───────────────────────────────────────────────────────────
  if (redis && config.dbString) {
    try {
      await registerUserInTeamDb({
        redis,
        dbString: config.dbString,
        userRecord,
        privateKey: identity.privateKey,
        isFirstTeamSetup
      });
    } catch (err) {
      console.error(`  ✗ Failed to write to database: ${err instanceof Error ? err.message : String(err)}`);
      console.error("  Your local identity was saved, but team onboarding did not finish. Fix the DB issue and run onboarding again.");
      process.exit(1);
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const boardUrl = `http://${config.host}:${config.port}`;
  console.log("");
  console.log("╔════════════════════════════════════════╗");
  console.log("║           Setup complete! ✓            ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");
  console.log(`  Address : ${userRecord.id}`);
  console.log(`  Name    : ${userRecord.name}`);
  console.log(`  Role    : ${userRecord.role}`);
  console.log("");
  console.log("  Start the board server:");
  console.log("");
  console.log("    make dev");
  console.log("");
  console.log(`  Then open: ${boardUrl}`);
  console.log("");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
