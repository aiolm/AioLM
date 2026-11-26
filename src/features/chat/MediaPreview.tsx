import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../../shared/api/errors';
import { resolveMedia } from '../../shared/api/commands';
import type { ProviderId } from '../../shared/api/providers';
import { formatModelLabel, normalizeDisplayText } from '../../shared/lib/displayPaths';
import type { ImageAttachment } from './chatTypes';
import type { Locale } from '../../shared/i18n/i18nCatalog';
import { mediaPreparationCopy } from './mediaPreparationCopy';

export default function MediaPreview({ attachment, small = false, provider = 'vllm', locale = 'en' }: { attachment: ImageAttachment; small?: boolean; provider?: ProviderId; locale?: Locale }) {
  const copy = mediaPreparationCopy[locale];
  const [url, setUrl] = useState(attachment.dataUrl);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const mounted = useRef(true);
  const lightboxRef = useRef<HTMLDialogElement>(null);
  const thumbButtonRef = useRef<HTMLButtonElement>(null);
  const kind = attachment.kind ?? 'image';
  const displayName = normalizeDisplayText(attachment.name);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!attachment.ref || attachment.dataUrl || kind !== 'image') return;
    void resolveMedia(attachment.ref, provider).then(part => { if (active && part.type === 'image_url') setUrl(part.image_url.url); }).catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [attachment.ref, attachment.dataUrl, kind, provider]);
  useEffect(() => {
    const dialog = lightboxRef.current;
    const trigger = thumbButtonRef.current;
    if (!lightboxOpen || !dialog) return;
    if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
    const handleBackdropClick = (event: MouseEvent) => {
      if (event.target === dialog) setLightboxOpen(false);
    };
    dialog.addEventListener('click', handleBackdropClick);
    return () => {
      dialog.removeEventListener('click', handleBackdropClick);
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus();
    };
  }, [lightboxOpen]);
  const read = async () => {
    if (!attachment.ref || loading) return;
    setError('');
    setLoading(true);
    try {
      // Preview needs a data URL even when MLX inference receives an owned
      // local video path. This resolves media only; it starts no engine.
      const part = await resolveMedia(attachment.ref, 'vllm');
      if (!mounted.current) return;
      if (part.type === 'image_url') setUrl(part.image_url.url);
      if (part.type === 'video_url') setUrl(part.video_url.url);
      if (part.type === 'input_audio') setUrl(part.input_audio.data.startsWith('data:') ? part.input_audio.data : `data:${attachment.mime ?? 'audio/wav'};base64,${part.input_audio.data}`);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setLoading(false); }
  };
  const preparation = attachment.preparation;
  const pendingLabel = `${kind} · ${displayName}`;
  return <span className="inline-flex max-w-full flex-col gap-1">
    {kind === 'image' && url
      ? <button ref={thumbButtonRef} type="button" className="chat-media-thumb" onClick={() => setLightboxOpen(true)} aria-label={`${copy.previewImage}: ${displayName}`}>
          <img src={url} alt={displayName} loading="lazy" decoding="async" width={small ? 64 : 144} height={small ? 64 : 144} className={`${small ? 'h-16 w-16' : 'h-36 w-36'} rounded-lg border object-contain ui-border-color-border`} />
        </button>
      : kind === 'image' && attachment.ref && !error
        ? <div role="status" aria-label={pendingLabel} className={`${small ? 'h-16 w-16' : 'h-36 w-36'} flex items-center justify-center rounded-lg border ui-border-color-border ui-background-surface-muted`}><span className="sr-only">{pendingLabel}</span></div>
      : kind === 'audio' && url ? <audio controls src={url} aria-label={attachment.name} className="max-w-full" />
      : kind === 'video' && url ? <video controls src={url} aria-label={attachment.name} className="max-h-40 w-full max-w-64" />
      : <button type="button" disabled={loading} aria-busy={loading || undefined} className="app-button app-button--secondary app-button--sm" onClick={() => void read()}>{loading ? copy.loading : pendingLabel}</button>}
    {lightboxOpen && url && kind === 'image' && createPortal(
      <dialog
        ref={lightboxRef}
        className="app-dialog chat-media-lightbox"
        aria-label={displayName}
        onCancel={(event) => { event.preventDefault(); event.stopPropagation(); setLightboxOpen(false); }}
      >
        <div className="chat-media-lightbox-panel">
          <div className="chat-media-lightbox-header">
            <span className="min-w-0 truncate text-sm font-medium ui-color-ink">{displayName}</span>
            <button type="button" data-icon="close" className="app-button app-button--secondary app-button--sm shrink-0" onClick={() => setLightboxOpen(false)}>{copy.closePreview}</button>
          </div>
          <img src={url} alt={displayName} className="chat-media-lightbox-image" />
        </div>
      </dialog>,
      document.body,
    )}
    {preparation?.kind === 'transcription' && <small className="text-xs ui-color-muted">{copy.transcript} · {formatModelLabel(preparation.model)} · {preparation.sessionId}</small>}
    {preparation?.kind === 'video-frames' && <small className="text-xs ui-color-muted">{preparation.frames.length} {copy.frames} · {copy.noAudio}</small>}
    {error && <small className="text-xs ui-color-danger" role="alert">{error}</small>}
  </span>;
}
