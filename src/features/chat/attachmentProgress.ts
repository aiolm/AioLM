export type AttachmentStatus = "queued" | "reading" | "indexing" | "ready" | "failed" | "removed";

export interface AttachmentProgress {
  name: string;
  kind: "document" | "image";
  status: AttachmentStatus;
  error?: string;
}

export function normalizeAttachmentProgress(value: Partial<AttachmentProgress>): AttachmentProgress {
  return {
    name: value.name?.trim() || "attachment",
    kind: value.kind === "image" ? "image" : "document",
    status: value.status ?? "queued",
    error: value.error,
  };
}
