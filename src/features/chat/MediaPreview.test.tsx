import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMedia } from '../../shared/api/commands';
import MediaPreview from './MediaPreview';

vi.mock('../../shared/api/commands', () => ({ resolveMedia: vi.fn() }));

describe('owned media preview independently of inference encoding', () => {
  beforeEach(() => vi.clearAllMocks());
  it('previews an MLX video using owned data without claiming frame preprocessing', async () => {
    vi.mocked(resolveMedia).mockResolvedValue({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AA==' } });
    const { container } = render(<MediaPreview locale="ko" provider="mlx-vlm" attachment={{ name: 'clip.mp4', kind: 'video', ref: `${'a'.repeat(64)}.mp4`, dataUrl: '' }} />);
    expect(resolveMedia).not.toHaveBeenCalled();
    expect(screen.queryByText(/샘플 프레임/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('data:video/mp4;base64,AA=='));
    expect(resolveMedia).toHaveBeenCalledWith(`${'a'.repeat(64)}.mp4`, 'vllm');
  });
  it('keeps original audio playable beside the saved transcript identity', async () => {
    vi.mocked(resolveMedia).mockResolvedValue({ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } });
    const { container } = render(<MediaPreview locale="ko" provider="mlx-vlm" attachment={{ name: 'speech.wav', kind: 'audio', ref: `${'b'.repeat(64)}.wav`, dataUrl: '',
      preparation: { kind: 'transcription', text: 'saved speech', model: 'whisper', sessionId: 'speech-session' } }} />);
    expect(screen.getByText('전사문 · whisper · speech-session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(container.querySelector('audio')?.getAttribute('src')).toBe('data:audio/wav;base64,AA=='));
    expect(screen.getByText('전사문 · whisper · speech-session')).toBeInTheDocument();
  });

  it('recovers an image preview on retry and clears prior errors', async () => {
    vi.mocked(resolveMedia)
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } });
    render(<MediaPreview locale="en" attachment={{ name: 'photo.png', kind: 'image', ref: `${'c'.repeat(64)}.png`, dataUrl: '' }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('temporary read failure');
    fireEvent.click(screen.getByRole('button', { name: /photo\.png/ }));
    expect(await screen.findByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'data:image/png;base64,AA==');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows loading state while resolving media and opens/closes an image lightbox dialog', async () => {
    let finishVideo!: (value: { type: 'video_url'; video_url: { url: string } }) => void;
    vi.mocked(resolveMedia).mockImplementationOnce(() => new Promise(resolve => { finishVideo = resolve; }));
    render(<MediaPreview locale="en" attachment={{ name: 'clip.mp4', kind: 'video', ref: `${'d'.repeat(64)}.mp4`, dataUrl: '' }} />);
    const loadButton = screen.getByRole('button', { name: /clip\.mp4/ });
    fireEvent.click(loadButton);
    expect(loadButton).toBeDisabled();
    expect(loadButton).toHaveAttribute('aria-busy', 'true');
    expect(loadButton).toHaveTextContent('Loading…');
    finishVideo({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AA==' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Loading/ })).not.toBeInTheDocument());

    render(<MediaPreview locale="en" attachment={{ name: 'shot.png', dataUrl: 'data:image/png;base64,AA==' }} />);
    const previewButton = screen.getByRole('button', { name: 'Preview image: shot.png' });
    fireEvent.click(previewButton);
    const dialog = screen.getByRole('dialog', { name: 'shot.png' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog', { name: 'shot.png' })).not.toBeInTheDocument();
  });
});
