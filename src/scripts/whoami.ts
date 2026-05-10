import { readFile } from "node:fs/promises";

import { getAppConfig } from "../config";
import { fileExists } from "../identity-store";

async function main(): Promise<void> {
  const config = getAppConfig();

  if (!(await fileExists(config.userFile))) {
    console.error(`No user file found at ${config.userFile}`);
    console.error("Run 'make identity-onboard' to create an identity.");
    process.exit(1);
  }

  const raw = await readFile(config.userFile, { encoding: "utf8" });
  const parsed = JSON.parse(raw);

  const address: string | undefined = parsed?.address;
  const name: string | undefined = parsed?.userRecord?.name;

  if (!address) {
    console.error(`user.json exists at ${config.userFile} but contains no address.`);
    process.exit(1);
  }

  if (name) console.error(`Name:    ${name}`);
  console.error(`Address: ${address}`);
  console.log(address);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
