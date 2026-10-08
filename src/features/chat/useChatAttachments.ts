import { useEffect, useRef, useState } from "react";
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

type AttachmentApplication = { generation: number } & (
  | { kind: 'document'; value: DocumentAttachment }
  | { kind: 'media'; value: ImageAttachment }
);

export function useChatAttachments({ visionReady, modalities, setError, audioPreprocessAvailable = false, videoPreprocessAvailable = false }: UseChatAttachmentsOptions) {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState<"idle" | "reading" | "ready" | "failed">("idle");
  const [application, setApplication] = useState<AttachmentApplication | null>(null);
  const generation = useRef(0);
  const pendingImport = useRef<number | null>(null);
  useEffect(() => () => { generation.current += 1; pendingImport.current = null; }, []);

  useEffect(() => {
    if (!application || generation.current !== application.generation) return;
    const accepted = application.kind === 'document'
      ? documents.some(document => document.path === application.value.path)
      : attachments.includes(application.value);
    // Project bindings may occupy a slot before the queued append commits.
    // Confirm the result after rendering without side effects inside its updater.
    setAttachmentStatus(accepted ? 'ready' : 'failed');
    setError(accepted ? null : `File attachment failed: You can attach up to 4 ${application.kind === 'document' ? 'documents' : 'media files'} per message.`);
    if (pendingImport.current === application.generation) pendingImport.current = null;
    setApplication(null);
  }, [application, documents, attachments, setError]);

  const addAttachment = async () => {
    if (pendingImport.current !== null) return;
    const ownGeneration = generation.current;
    pendingImport.current = ownGeneration;
    const current = () => generation.current === ownGeneration && pendingImport.current === ownGeneration;
    setAttachmentStatus("reading");
    let queued = false;
    try {
      const path = await api.pickAttachment();
      if (!current()) return;
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
        if (!current()) return;
        const value = { ...attachment, name };
        setAttachments((items) => generation.current !== ownGeneration || items.length >= 4 ? items : [...items, value]);
        setApplication({ generation: ownGeneration, kind: 'media', value });
        queued = true;
      } else {
        if (documents.some((document) => document.path === path)) {
          setAttachmentStatus("ready");
          setError(null);
          return;
        }
        if (documents.length >= 4) throw new Error("You can attach up to 4 documents per message.");
        const text = await api.readDocumentText(path);
        if (!current()) return;
        const value = { name, path, text };
        setDocuments((items) => generation.current !== ownGeneration || items.some((document) => document.path === path) || items.length >= 4
          ? items
          : [...items, value]);
        setApplication({ generation: ownGeneration, kind: 'document', value });
        queued = true;
      }
    } catch (caught) {
      if (!current()) return;
      setAttachmentStatus("failed");
      setError(`File attachment failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      if (!queued && pendingImport.current === ownGeneration) pendingImport.current = null;
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
    // A picker/import may finish after its conversation has been left behind.
    generation.current += 1;
    pendingImport.current = null;
    setAttachments([]);
    setDocuments([]);
    setApplication(null);
    setAttachmentStatus("idle");
  };

  return {
    attachments, documents, attachmentStatus, setAttachments, setDocuments,
    addAttachment, removeAttachment, removeDocument, clearComposerAttachments,
  };
}
