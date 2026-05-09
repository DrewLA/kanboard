import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { Wallet } from "ethers";

const scrypt = promisify(scryptCallback);

export interface EncryptedIdentityFile {
  version: 1;
  address: string;
  createdAt: string;
  kdf: {
    name: "scrypt";
    salt: string;
    keyLength: 32;
  };
  cipher: {
    name: "aes-256-gcm";
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

export interface IdentityOnboardResult {
  address: string;
  privateKey: string;
  mnemonic: string;
  identityFile: EncryptedIdentityFile;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function requireTty(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Interactive password prompt requires a TTY.");
  }
}

export async function promptHidden(label: string): Promise<string> {
  requireTty();

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    let value = "";

    stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
    };

    const onData = (chunk: Buffer): void => {
      const input = chunk.toString("utf8");

      if (input === "\u0003") {
        cleanup();
        reject(new Error("Password prompt cancelled."));
        return;
      }

      if (input === "\r" || input === "\n") {
        cleanup();
        resolve(value);
        return;
      }

      if (input === "\u007f") {
        value = value.slice(0, -1);
        return;
      }

      value += input;
    };

    stdin.on("data", onData);
  });
}

export async function promptLine(label: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr
  });

  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return await scrypt(password, salt, 32) as Buffer;
}

export async function encryptPrivateKey(privateKey: string, password: string, address: string): Promise<EncryptedIdentityFile> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    address,
    createdAt: new Date().toISOString(),
    kdf: {
      name: "scrypt",
      salt: salt.toString("base64"),
      keyLength: 32
    },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    }
  };
}

export async function decryptPrivateKey(identityFile: EncryptedIdentityFile, password: string): Promise<string> {
  if (identityFile.version !== 1 || identityFile.kdf.name !== "scrypt" || identityFile.cipher.name !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted identity file format.");
  }

  const key = await deriveKey(password, Buffer.from(identityFile.kdf.salt, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(identityFile.cipher.iv, "base64"));
  decipher.setAuthTag(Buffer.from(identityFile.cipher.tag, "base64"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(identityFile.cipher.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt identity file. The password may be wrong or the file may be corrupted.");
  }
}

export async function readIdentityFile(filePath: string): Promise<EncryptedIdentityFile> {
  return JSON.parse(await readFile(filePath, "utf8")) as EncryptedIdentityFile;
}

export async function writeIdentityFile(filePath: string, identityFile: EncryptedIdentityFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(identityFile, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function createEncryptedIdentity(password: string): Promise<IdentityOnboardResult> {
  const wallet = Wallet.createRandom();
  const mnemonic = wallet.mnemonic?.phrase;

  if (!mnemonic) {
    throw new Error("Failed to generate wallet mnemonic.");
  }

  const identityFile = await encryptPrivateKey(wallet.privateKey, password, wallet.address);

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic,
    identityFile
  };
}
