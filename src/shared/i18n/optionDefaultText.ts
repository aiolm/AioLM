import type { Locale } from './i18n';

const phrases: readonly [RegExp, string, string, string][] = [
  [/model training context size/gi, '모델 학습 컨텍스트 크기', 'モデル学習時のコンテキスト長', '模型训练上下文长度'],
  [/(?:loaded|read) from model/gi, '모델에서 읽음', 'モデルから読み込む', '从模型读取'],
  [/template taken from model's metadata/gi, '모델 메타데이터의 템플릿', 'モデルのメタデータ内のテンプレート', '模型元数据中的模板'],
  [/detect from template/gi, '템플릿에서 감지', 'テンプレートから検出', '从模板检测'],
  [/enabled if number of slots is auto/gi, '슬롯 수가 자동이면 사용', 'スロット数が自動の場合に有効', '槽位数为自动时启用'],
  [/value from HF_TOKEN environment variable/gi, 'HF_TOKEN 환경 변수 값', 'HF_TOKEN 環境変数の値', 'HF_TOKEN 环境变量的值'],
  [/use random seed for -1/gi, '-1이면 무작위 시드', '-1 はランダムシード', '-1 使用随机种子'],
  [/use host environment/gi, '호스트 환경 사용', 'ホスト環境を使用', '使用主机环境'],
  [/search in PATH/gi, 'PATH에서 검색', 'PATH 内で検索', '在 PATH 中搜索'],
  [/full interpolation/gi, '전체 보간', '完全補間', '完全插值'],
  [/requires cache-ram/gi, 'cache-ram 필요', 'cache-ram が必要', '需要 cache-ram'],
  [/prefill enabled/gi, '프리필 사용', 'プリフィル有効', '启用预填充'],
  [/no minimum/gi, '최솟값 없음', '最小値なし', '无最小值'],
  [/no limit|unlimited|infinity/gi, '제한 없음', '制限なし', '无限制'],
  [/no tools/gi, '도구 없음', 'ツールなし', '无工具'],
  [/behavior unchanged/gi, '기존 동작 유지', '既存の動作を維持', '保持原有行为'],
  [/disabled|disable/gi, '사용 안 함', '無効', '禁用'],
  [/enabled/gi, '사용', '有効', '启用'],
  [/unused|unset/gi, '지정 안 함', '未指定', '未设置'],
];
const index = { ko: 1, ja: 2, zh: 3 } as const;

/** Localize explanatory default clauses while preserving literal option values and flags. */
export function optionDefaultText(value: string, locale: Locale): string {
  if (locale === 'en' || /^(["'`]).*\1$/.test(value)) return value;
  const position = index[locale];
  let text = value.replace(/same as (--[\w-]+)/gi, (_, flag: string) => ({ ko: `${flag}와 동일`, ja: `${flag} と同じ`, zh: `与 ${flag} 相同` })[locale]);
  text = text.replace(/follows (--[\w-]+)/gi, (_, flag: string) => ({ ko: `${flag} 설정을 따름`, ja: `${flag} の設定に従う`, zh: `遵循 ${flag} 设置` })[locale]);
  for (const phrase of phrases) text = text.replace(phrase[0], phrase[position]);
  text = text.replace(/\b(?:all|auto|none)\b/g, (token, offset: number) => {
    if (!/[=()]\s*$/.test(text.slice(0, offset))) return token;
    return ({ all: ['전체', 'すべて', '全部'], auto: ['자동', '自動', '自动'], none: ['없음', 'なし', '无'] } as const)[token as 'all' | 'auto' | 'none'][position - 1];
  });
  return text;
}
