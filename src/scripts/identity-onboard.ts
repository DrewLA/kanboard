import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAppConfig } from "../config";
import { createEncryptedIdentity, fileExists, promptHidden, writeIdentityFile } from "../identity-store";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const config = getAppConfig();
  const identityPath = config.identityFile;

  if ((await fileExists(identityPath)) && !force) {
    throw new Error(`Identity file already exists at ${identityPath}. Use --force to replace it.`);
  }

  console.error("");
  console.error("A new EVM identity will be generated for this local machine.");
  console.error("The seed phrase is shown once. Copy it down before continuing.");
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
  console.error("Seed phrase:");
  console.error(identity.mnemonic);
  console.error("");
  console.error("Copy the seed phrase now. It will not be written to disk.");

  await writeIdentityFile(identityPath, identity.identityFile);

  const timestamp = new Date().toISOString();
  const output = {
    identityPath: path.relative(process.cwd(), identityPath),
    userPath: path.relative(process.cwd(), config.userFile),
    address: identity.address,
    userRecord: {
      id: identity.address,
      name: config.privateUsername,
      role: "member",
      avatarIcon: "user",
      avatarColor: "#2563eb",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };

  await mkdir(path.dirname(config.userFile), { recursive: true });
  await writeFile(config.userFile, JSON.stringify({
    address: output.address,
    userRecord: output.userRecord
  }, null, 2), { encoding: "utf8", mode: 0o600 });

  console.log(JSON.stringify(output, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
