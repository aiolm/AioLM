import type { Locale } from '../../shared/i18n/i18nCatalog';

interface Copy { label: string; audio: string; native: string; video: string; hint: string; transcript: string; frames: string; noAudio: string }
export const mediaPreparationCopy: Record<Locale, Copy> = {
  en: { transcript: 'Transcript', frames: 'sampled frames', noAudio: 'audio track omitted', label: "How to send audio and video", audio: "Session for converting audio to text", native: "Send original files directly", video: "Extract images from video and send them", hint: "Choose whether to convert media on this computer before sending. Audio is sent as text from the selected transcription session. Video requires installed ffmpeg and an image-capable answering model; extracted images do not include the audio track." },
  ko: { transcript: '전사문', frames: '샘플 프레임', noAudio: '음성 트랙 미포함', label: "음성·영상 전달 방식", audio: "음성을 텍스트로 바꿀 세션", native: "원본 파일 그대로 전달", video: "영상에서 이미지를 추출해 전달", hint: "보내기 전에 이 컴퓨터에서 파일을 변환할지 선택하세요. 음성은 선택한 세션에서 텍스트로 바꿉니다. 영상에서 이미지를 추출하려면 ffmpeg와 이미지 입력을 지원하는 답변 모델이 필요하며, 영상의 소리는 전달되지 않습니다." },
  ja: { transcript: '文字起こし', frames: '抽出フレーム', noAudio: '音声トラックなし', label: "音声・動画の送信方法", audio: "音声を文字に変換するセッション", native: "元のファイルをそのまま送信", video: "動画から画像を抽出して送信", hint: "送信前にこのコンピューターでファイルを変換するか選んでください。音声は選択したセッションで文字に変換します。動画からの画像抽出にはffmpegと画像入力対応の回答モデルが必要で、動画の音声は送信されません。" },
  zh: { transcript: '转录文本', frames: '采样帧', noAudio: '不含音轨', label: "音频与视频发送方式", audio: "用于将音频转为文字的会话", native: "直接发送原始文件", video: "从视频提取图像并发送", hint: "选择是否在此电脑上转换文件后再发送。音频由所选会话转为文字。提取视频图像需要已安装的ffmpeg及支持图像输入的回答模型，视频声音不会发送。" },
};
