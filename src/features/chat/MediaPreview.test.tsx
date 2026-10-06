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
});
