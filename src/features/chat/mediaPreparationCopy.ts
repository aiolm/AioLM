import type { Locale } from '../../shared/i18n/i18nCatalog';

interface Copy { label: string; audio: string; native: string; video: string; hint: string; transcript: string; frames: string; noAudio: string }
export const mediaPreparationCopy: Record<Locale, Copy> = {
  en: { transcript: 'Transcript', frames: 'sampled frames', noAudio: 'audio track omitted', label: 'Media preprocessing', audio: 'Audio transcription session', native: 'Use native input only', video: 'Send video as sampled image frames', hint: 'Opt in to local preprocessing. Audio becomes a labeled transcript from the selected speech session. Video needs installed ffmpeg and an image-capable answering model; sampled frames do not include its audio track.' },
  ko: { transcript: '전사문', frames: '샘플 프레임', noAudio: '음성 트랙 미포함', label: '미디어 전처리', audio: '음성 전사 세션', native: '기본 입력만 사용', video: '영상을 샘플링한 이미지 프레임으로 전송', hint: '로컬 전처리를 선택합니다. 음성은 선택한 전사 세션의 텍스트로 전달됩니다. 영상은 설치된 ffmpeg와 이미지 입력을 지원하는 답변 모델이 필요하며, 샘플링한 프레임에는 음성 트랙이 포함되지 않습니다.' },
  ja: { transcript: '文字起こし', frames: '抽出フレーム', noAudio: '音声トラックなし', label: 'メディアの前処理', audio: '音声文字起こしセッション', native: 'ネイティブ入力のみ使用', video: '動画をサンプリングした画像フレームで送信', hint: 'ローカル前処理を明示的に選択します。音声は選択したセッションの文字起こしになります。動画にはインストール済みの ffmpeg と画像入力対応の回答モデルが必要です。抽出フレームに音声は含まれません。' },
  zh: { transcript: '转录文本', frames: '采样帧', noAudio: '不含音轨', label: '媒体预处理', audio: '音频转录会话', native: '仅使用原生输入', video: '将视频作为采样图像帧发送', hint: '明确选择本地预处理。音频转换为所选语音会话的转录文本。视频需要已安装的 ffmpeg 和支持图像输入的回答模型；采样帧不包含音轨。' },
};
