// Pure attachment helpers for the composer and chat history (order 17e).

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

// At most 6 attachments per message, each at most 8 MiB decoded.
export function canAttach(count: number, bytes: number): boolean {
  return count < MAX_ATTACHMENTS && bytes >= 0 && bytes <= MAX_ATTACHMENT_BYTES;
}

export function guessMime(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function stripZeros(value: string): string {
  if (value.includes(".")) return value.replace(/0+$/, "").replace(/\.$/, "");
  return value;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${stripZeros(kb.toFixed(1))} KB`;
  return `${stripZeros((kb / 1024).toFixed(1))} MB`;
}

export interface AttachmentInfo {
  label: string;
  image: boolean;
  sizeBytes: number;
}

// History `file` part (order 17e): { type: "file", mime, metadata: { sizeBytes } }.
export function describeAttachment(part: unknown): AttachmentInfo {
  const data = (part ?? {}) as Record<string, any>;
  const mime =
    typeof data.mime === "string" && data.mime ? data.mime : "application/octet-stream";
  const metadata = (data.metadata ?? {}) as Record<string, any>;
  return {
    label: mime,
    image: mime.startsWith("image/"),
    sizeBytes: typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : 0,
  };
}
