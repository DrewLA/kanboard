import type { FastifyReply } from "fastify";

import type { AppConfig } from "./config";
import type { TaskAttachment } from "./model";
import { getAttachmentObject } from "./r2";
import { NotFoundError } from "./application-errors";

function formatContentDisposition(value: string, disposition: "inline" | "attachment"): string {
  const sanitized = value.replace(/[\r\n"]/g, "-") || "download";
  return `${disposition}; filename="${sanitized}"`;
}

export async function sendAttachmentContent(
  config: AppConfig,
  reply: FastifyReply,
  attachment: TaskAttachment,
  attachmentId: string,
  sourceLabel: string,
  download?: string
): Promise<FastifyReply> {
  try {
    const object = await getAttachmentObject(config, attachment.key);
    if (!object.Body) {
      throw new NotFoundError(`Attachment ${attachmentId} has no content in R2.`);
    }

    reply.header("Content-Type", object.ContentType || attachment.contentType || "application/octet-stream");

    if (typeof object.ContentLength === "number") reply.header("Content-Length", object.ContentLength);
    if (object.ETag) reply.header("ETag", object.ETag);
    if (object.LastModified) reply.header("Last-Modified", object.LastModified.toUTCString());

    const disposition = download === "1" || attachment.kind === "file" ? "attachment" : "inline";
    reply.header("Content-Disposition", formatContentDisposition(attachment.name, disposition));
    return reply.send(object.Body as never);
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "NoSuchKey") {
      throw new NotFoundError(`Attachment ${attachmentId} content was not found in R2 for ${sourceLabel}.`);
    }
    throw error;
  }
}
