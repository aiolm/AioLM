import { useEffect, useState } from 'react';
import { resolveMedia } from '../../shared/api/commands';
import type { ProviderId } from '../../shared/api/providers';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import type { ImageAttachment } from './chatTypes';
import type { Locale } from '../../shared/i18n/i18nCatalog';
import { mediaPreparationCopy } from './mediaPreparationCopy';

export default function MediaPreview({ attachment, small = false, provider = 'vllm', locale = 'en' }: { attachment: ImageAttachment; small?: boolean; provider?: ProviderId; locale?: Locale }) {
  const copy = mediaPreparationCopy[locale];
  const [url, setUrl] = useState(attachment.dataUrl); const [error, setError] = useState('');
  const kind = attachment.kind ?? 'image';
  useEffect(() => {
    let active = true;
    if (!attachment.ref || attachment.dataUrl || kind !== 'image') return;
    void resolveMedia(attachment.ref, provider).then(part => { if (active && part.type === 'image_url') setUrl(part.image_url.url); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [attachment.ref, attachment.dataUrl, kind, provider]);
  const read = async () => {
    if (!attachment.ref) return;
    try {
      // Preview needs a data URL even when MLX inference receives an owned
      // local video path. This resolves media only; it starts no engine.
      const part = await resolveMedia(attachment.ref, 'vllm');
      if (part.type === 'video_url') setUrl(part.video_url.url);
      if (part.type === 'input_audio') setUrl(part.input_audio.data.startsWith('data:') ? part.input_audio.data : `data:${attachment.mime ?? 'audio/wav'};base64,${part.input_audio.data}`);
    } catch (cause) { setError(String(cause)); }
  };
  const preparation = attachment.preparation;
  const pendingLabel = `${kind} · ${normalizeDisplayText(attachment.name)}`;
  return <span className="inline-flex max-w-full flex-col gap-1">
    {kind === 'image' && url ? <img src={url} alt={normalizeDisplayText(attachment.name)} loading="lazy" decoding="async" width={small ? 64 : 144} height={small ? 64 : 144} className={`${small ? 'h-16 w-16' : 'h-36 w-36'} rounded-lg border object-contain ui-border-color-border`} />
      : kind === 'audio' && url ? <audio controls src={url} aria-label={attachment.name} />
      : kind === 'video' && url ? <video controls src={url} aria-label={attachment.name} className="max-h-40 max-w-64" />
      : <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => void read()}>{pendingLabel}</button>}
    {preparation?.kind === 'transcription' && <small>{copy.transcript} · {preparation.model} · {preparation.sessionId}</small>}
    {preparation?.kind === 'video-frames' && <small>{preparation.frames.length} {copy.frames} · {copy.noAudio}</small>}
    {error && <small role="alert">{error}</small>}
  </span>;
}
