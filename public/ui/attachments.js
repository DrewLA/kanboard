const mockupMimeTypes = new Set(["text/html", "image/svg+xml", "image/png"]);
const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

export function attachmentKindLabel(kind) {
  if (kind === "image") return "Image";
  if (kind === "mockup") return "Mockup";
  return "File";
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

export function workItemCollection(sourceType) {
  if (sourceType === "epic") return "epics";
  if (sourceType === "feature") return "features";
  return "tasks";
}

export function buildAttachmentContentUrl(sourceType, sourceId, attachmentId, download = false) {
  const query = download ? "?download=1" : "";
  return `/api/${workItemCollection(sourceType)}/${encodeURIComponent(sourceId)}/attachments/${encodeURIComponent(attachmentId)}/content${query}`;
}

export function buildTaskAttachmentContentUrl(taskId, attachmentId, download = false) {
  return buildAttachmentContentUrl("task", taskId, attachmentId, download);
}

export function isVisualAttachment(attachment) {
  return attachment?.kind === "image" || attachment?.kind === "mockup";
}

function fileExtension(fileName) {
  const match = String(fileName || "").toLowerCase().match(/\.[a-z0-9]+$/i);
  return match ? match[0] : "";
}

export function validateUploadSelection(kind, file) {
  if (!file) return "Select a file first.";

  const extension = fileExtension(file.name);
  const mimeType = (file.type || "").toLowerCase();

  if (kind === "mockup" && (!['.html', '.svg', '.png'].includes(extension) || !mockupMimeTypes.has(mimeType))) {
    return "Mockups must be an HTML, SVG, or PNG file.";
  }

  if (kind === "image" && (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'].includes(extension) || !imageMimeTypes.has(mimeType))) {
    return "Images must be JPG, PNG, GIF, WebP, or AVIF.";
  }

  return "";
}

export async function uploadFileToPresignedUrl(uploadUrl, file, contentType, onProgress) {
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", contentType);

      xhr.upload.addEventListener("progress", (event) => {
        onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size || 0);
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        reject(new Error(`Upload to R2 failed with status ${xhr.status}. Check the bucket CORS rule for ${window.location.origin}.`));
      });

      xhr.addEventListener("error", () => reject(new TypeError("Network request failed")));
      xhr.addEventListener("abort", () => reject(new Error("Upload to R2 was aborted.")));
      xhr.send(file);
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Upload to R2 failed. Configure the R2 bucket CORS rule to allow ${window.location.origin} with PUT, GET, and HEAD using the Content-Type header.`);
    }
    throw error;
  }
}
