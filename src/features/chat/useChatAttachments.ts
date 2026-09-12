import { useState } from "react";
import * as api from "../../shared/api/index";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";

interface UseChatAttachmentsOptions {
  visionReady: boolean;
  /** Mirrors the panel's shared error banner: pass a message to show it, `null` to clear it. */
  setError: (message: string | null) => void;
}

export function useChatAttachments({ visionReady, setError }: UseChatAttachmentsOptions) {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState<"idle" | "reading" | "ready" | "failed">("idle");

  const addAttachment = async () => {
    if (attachmentStatus === "reading") return;
    setAttachmentStatus("reading");
    try {
      const path = await api.pickAttachment();
      if (!path) { setAttachmentStatus(attachmentStatus); return; }
      const name = path.split(/[\\/]/).pop() ?? "file";
      if (/\.(png|jpe?g|webp)$/i.test(path)) {
        if (!visionReady) {
          throw new Error("Select an mmproj vision sidecar in Models or Tuning before attaching an image.");
        }
        if (attachments.length >= 4) throw new Error("You can attach up to 4 images per message.");
        const dataUrl = await api.readImageData(path);
        setAttachments((current) => current.length >= 4 ? current : [...current, { name, dataUrl }]);
      } else {
        if (documents.some((document) => document.path === path)) {
          setAttachmentStatus("ready");
          setError(null);
          return;
        }
        if (documents.length >= 4) throw new Error("You can attach up to 4 documents per message.");
        const text = await api.readDocumentText(path);
        setDocuments((current) => current.some((document) => document.path === path) || current.length >= 4
          ? current
          : [...current, { name, path, text }]);
      }
      setAttachmentStatus("ready");
      setError(null);
    } catch (caught) {
      setAttachmentStatus("failed");
      setError(`File attachment failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const removeAttachment = (dataUrl: string) => {
    setAttachments((current) => current.filter((item) => item.dataUrl !== dataUrl));
  };

  const removeDocument = (path: string) => {
    setDocuments((current) => current.filter((item) => item.path !== path));
  };

  /** Clears the composer's pending attachments — used after sending and when switching threads. */
  const clearComposerAttachments = () => {
    setAttachments([]);
    setDocuments([]);
    setAttachmentStatus("idle");
  };

  return {
    attachments, documents, attachmentStatus, setAttachments, setDocuments,
    addAttachment, removeAttachment, removeDocument, clearComposerAttachments,
  };
}
