import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths';

const en = {
  next: 'Save the profile and reload to use these execution options.', request: 'Save the profile to use these settings for the next request.',
  prompt: 'Default system prompt', promptHint: 'Used by new conversations. Existing conversations keep their own prompt.',
  savedFailure: 'Settings were saved, but the following operation failed. You can retry without creating the profile again: ',
};
type Copy = typeof en;
export const profileStatusCopy: Record<'en' | 'ko' | 'ja' | 'zh', Copy> = {
  en,
  ko: { next: '프로필을 저장하고 다시 실행하면 실행 옵션이 반영됩니다.', request: '프로필을 저장하면 다음 요청부터 사용합니다.', prompt: '기본 시스템 프롬프트', promptHint: '새 대화에서 사용합니다. 기존 대화의 프롬프트는 유지됩니다.', savedFailure: '설정은 저장했지만 후속 작업에 실패했습니다. 프로필을 다시 만들지 않고 재시도할 수 있습니다: ' },
  ja: { next: 'プロファイルを保存して再起動すると実行設定が反映されます。', request: 'プロファイルを保存すると次のリクエストから使用します。', prompt: '既定のシステムプロンプト', promptHint: '新しい会話に使用します。既存の会話のプロンプトは保持されます。', savedFailure: '設定は保存されましたが、後続の操作に失敗しました。プロファイルを再作成せずに再試行できます: ' },
  zh: { next: '保存预设并重新运行后，执行选项才会生效。', request: '保存预设后用于下次请求。', prompt: '默认系统提示词', promptHint: '用于新对话。现有对话保留自己的提示词。', savedFailure: '设置已保存，但后续操作失败。无需重新创建预设即可重试：' },
};

const tensorHint: Record<'en' | 'ko' | 'ja' | 'zh', string> = {
  en: ' This model does not support the Tensor split mode (experimental).\nChange GPU split mode to Automatic, layer, or row and try again.',
  ko: ' 이 모델은 Tensor 분할 모드(실험적)를 지원하지 않습니다.\nGPU 설정의 분할 모드를 자동, layer 또는 row로 변경한 뒤 다시 실행해 주세요.',
  ja: ' このモデルはTensor分割モード（実験的）に対応していません。\nGPU分割モードを自動・layer・rowに変更して再試行してください。',
  zh: ' 该模型不支持 Tensor 切分模式（实验性）。\n请将 GPU 切分模式改为自动、layer 或 row 后重试。',
};

const launchFailed: Record<'en' | 'ko' | 'ja' | 'zh', string> = {
  en: 'The server exited before it was ready (code {code}).',
  ko: '서버가 준비되기 전에 종료됐습니다 (코드 {code}).',
  ja: 'サーバーは準備が整う前に終了しました（コード {code}）。',
  zh: '服务器在就绪前已退出（代码 {code}）。',
};

/** True when a launch log reports an unsupported Tensor split mode. */
export function isTensorSplitFailure(message: string): boolean {
  return /split[_-]?mode[_-]?tensor|tensor.*split|LLAMA_SPLIT_MODE_TENSOR/i.test(message);
}

/** Quoted model paths are shortened to their shard-grouped file name. */
function shortenQuotedPaths(line: string): string {
  return line.replace(/'([^'\n]{1,400})'/g, (_, path) => `'${modelDisplayName(path)}'`);
}

/** The single most representative error line of a server log, without timestamps or levels. */
function firstErrorLine(cleaned: string): string | null {
  const shorten = (line: string) => {
    const text = shortenQuotedPaths(line.trim());
    return text.length > 220 ? `${text.slice(0, 220)}…` : text;
  };
  let fallback: string | null = null;
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(?:\d+(?:\.\d+)*\s+)?([A-Za-z])\s+(.*)$/);
    if (match && (match[1] === 'E' || /^error\b/i.test(match[2]))) return shorten(match[2]);
    // Argument-parser errors print before logging starts, with no timestamp.
    if (fallback === null && /^(error|failed)\b/i.test(line)) fallback = shorten(line);
  }
  return fallback;
}

export interface LaunchFailureView { summary: string; detail: string | null }

/**
 * Split a launch error into a readable summary and an optional full log.
 * The save-succeeded preamble adds no diagnostic value, so it is dropped.
 * Unknown messages pass through untouched (no detail), so every other
 * editor error renders exactly as before.
 */
export function describeLaunchFailure(text: string, locale: 'en' | 'ko' | 'ja' | 'zh'): LaunchFailureView {
  let body = text;
  for (const copy of Object.values(profileStatusCopy)) {
    if (body.startsWith(copy.savedFailure)) { body = body.slice(copy.savedFailure.length); break; }
  }
  const cleaned = normalizeDisplayText(body).trim();
  const exit = cleaned.match(/server exited before ready \((\w+)\)/);
  if (!exit) return { summary: text, detail: null };
  if (isTensorSplitFailure(cleaned)) {
    return { summary: tensorHint[locale].trim(), detail: cleaned };
  }
  const representative = firstErrorLine(cleaned);
  const summary = representative ?? launchFailed[locale].replace('{code}', exit[1]);
  return { summary, detail: cleaned };
}
