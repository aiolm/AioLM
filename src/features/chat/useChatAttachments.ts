import { useState } from "react";
import * as api from "../../shared/api/index";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";

interface UseChatAttachmentsOptions {
  modalities?: api.Modalities;
  visionReady: boolean;
  /** Mirrors the panel's shared error banner: pass a message to show it, `null` to clear it. */
  setError: (message: string | null) => void;
  /**
   * Explicit preprocessing availability (wired by the chat owner, default off
   * so unsupported inputs stay refused):
   * - audio: a running local transcription session is explicitly selected;
   *   its transcript is inserted as labeled text without changing runtimes.
   * - video: the answering model is image-capable; at most four sampled
   *   frames travel as image parts with a no-audio-track label.
   */
  audioPreprocessAvailable?: boolean;
  videoPreprocessAvailable?: boolean;
}

export function useChatAttachments({ visionReady, modalities, setError, audioPreprocessAvailable = false, videoPreprocessAvailable = false }: UseChatAttachmentsOptions) {
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
      if (/\.(png|jpe?g|webp|wav|mp3|flac|mp4|webm)$/i.test(path)) {
        const kind = /\.(wav|mp3|flac)$/i.test(path) ? 'audio' : /\.(mp4|webm)$/i.test(path) ? 'video' : 'image';
        const usable = kind === 'audio'
          ? (modalities?.audio === true || audioPreprocessAvailable)
          : kind === 'video'
            ? (modalities?.video === true || videoPreprocessAvailable)
            : (modalities?.image ?? visionReady);
        if (!usable) {
          throw new Error(kind === 'audio' && !audioPreprocessAvailable
            ? 'The running model does not support audio input. Select a local transcription session to insert its transcript as labeled text.'
            : kind === 'video' && !videoPreprocessAvailable
              ? 'The running model does not support video input. Use an image-capable model to send sampled frames.'
              : `The running model does not support ${kind} input.`);
        }
        if (attachments.length >= 4) throw new Error("You can attach up to 4 media files per message.");
        const attachment = await api.importMedia(path);
        setAttachments((current) => current.length >= 4 ? current : [...current, { ...attachment, name }]);
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
    setAttachments((current) => current.filter((item) => (item.ref ?? item.dataUrl) !== dataUrl));
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
