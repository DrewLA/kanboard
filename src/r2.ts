import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { AppConfig, assertR2Config } from "./config";
import { TaskAttachmentKind } from "./model";
 
let activeClient: S3Client | undefined;
let loadedConfigSignature: string | undefined;

export class R2ConfigError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "R2ConfigError";
  }
}

function getR2Client(config: AppConfig): { client: S3Client; config: Required<Pick<AppConfig, "r2Endpoint" | "r2AccessKeyId" | "r2SecretAccessKey" | "r2Bucket">> } {
  let requiredConfig: Required<Pick<AppConfig, "r2Endpoint" | "r2AccessKeyId" | "r2SecretAccessKey" | "r2Bucket">>;

  try {
    requiredConfig = assertR2Config(config);
  } catch (error) {
    throw new R2ConfigError(error instanceof Error ? error.message : "R2 is not configured.");
  }

  const signature = [
    requiredConfig.r2Endpoint,
    requiredConfig.r2AccessKeyId,
    requiredConfig.r2SecretAccessKey,
    requiredConfig.r2Bucket
  ].join("|");

  if (!activeClient || loadedConfigSignature !== signature) {
    loadedConfigSignature = signature;
    activeClient = new S3Client({
      region: "auto",
      endpoint: requiredConfig.r2Endpoint,
      credentials: {
        accessKeyId: requiredConfig.r2AccessKeyId,
        secretAccessKey: requiredConfig.r2SecretAccessKey
      }
    });
  }

  return { client: activeClient!, config: requiredConfig };
}

function sanitizeKeySegment(value: string, fallback = "file"): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return cleaned || fallback;
}

function sanitizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizeKeySegment(segment))
    .join("/");
}

export function normalizeAttachmentToken(value: string): string {
  return sanitizeKeySegment(value, "attachment");
}

export function buildTaskAttachmentKey(
  taskId: string,
  attachmentId: string,
  kind: TaskAttachmentKind,
  fileName: string,
  relativePath?: string
): string {
  const normalizedTaskId = sanitizeKeySegment(taskId, "task");
  const normalizedAttachmentId = normalizeAttachmentToken(attachmentId);

  if (kind === "mockup") {
    const normalizedRelativePath = sanitizeRelativePath(relativePath || fileName);
    return `mockups/${normalizedTaskId}/${normalizedAttachmentId}/${normalizedRelativePath}`;
  }

  const normalizedFileName = sanitizeKeySegment(fileName, kind === "image" ? "image" : "file");
  const prefix = kind === "image" ? "images" : "files";
  return `${prefix}/${normalizedTaskId}/${normalizedAttachmentId}-${normalizedFileName}`;
}

export async function createTaskUploadUrl(config: AppConfig, key: string, contentType: string, expiresIn = 3600) {
  const { client, config: requiredConfig } = getR2Client(config);
  const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
    Bucket: requiredConfig.r2Bucket,
    Key: key,
    ContentType: contentType
  }), { expiresIn });

  return {
    key,
    uploadUrl
  };
}

export async function getTaskAttachmentObject(config: AppConfig, key: string) {
  const { client, config: requiredConfig } = getR2Client(config);
  return client.send(new GetObjectCommand({
    Bucket: requiredConfig.r2Bucket,
    Key: key
  }));
}