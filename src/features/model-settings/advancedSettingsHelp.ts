import type { Locale, UnifiedKey } from '../../shared/i18n/i18n';
import type { ServerOption } from '../../shared/config/serverOptions';
import { serverAliasesForRequest } from '../../shared/config/tuningDefaults';
import { TUNING_FIELD_CATALOG, tuningFieldTooltip } from '../tuning/tuningFields';
import { serverOptionDescription } from '../../shared/i18n/serverOptionDescriptions';

const en = {
  args: 'Additional arguments passed to the runtime when the model is loaded. Enter one option per line, with its value after a space, such as --load-mode none. Everything after the flag is one value, so a path may contain spaces; shell commands and quoting are not evaluated. App-managed options such as model and GPU selection must be changed in their dedicated controls.',
  chat: 'Extra options merged into each generation request after saving. Enter a JSON object, such as {"min_p": 0.05}; arrays and nested objects are allowed. Explicit temperature, Top-p, Top-k and reasoning controls take precedence when they are set. The app manages model, messages and stream, so those keys cannot be entered here.',
  options: 'These controls edit the additional server arguments above. Changes take effect when the model is next loaded. Available flags and values depend on the selected runtime.',
  search: 'Filter options by their flag, description or group.',
  missing: 'Passed to the runtime when the model is loaded. This runtime option has no description in its help output; check the runtime documentation for its effect and supported values.',
  toggle: 'Checked adds this flag to the server arguments. Unchecked omits it and leaves the runtime to choose its default.',
  single: 'Enter the value only, without the flag: the app writes the flag for you. Leave empty to omit this option and use the runtime default.',
  multiple: 'Enter the values only, without the flag, in the order shown in the signature and separated by spaces: the app writes the flag for you. Leave empty to omit this option and use the runtime default.',
  choices: 'Listed values',
  noResults: 'No matching options.',
};

export const advancedSettingsHelp: Record<Locale, typeof en> = {
  en,
  ko: {
    args: '모델을 로드할 때 런타임에 전달하는 추가 인수입니다. 한 줄에 옵션 하나씩, `--load-mode none`처럼 플래그 뒤에 공백을 두고 값을 적으세요. 플래그 뒤는 전부 값 하나로 취급하므로 공백이 든 경로도 그대로 쓸 수 있으며, 셸 명령이나 따옴표 문법은 해석하지 않습니다. 모델·GPU 선택 등 앱이 관리하는 옵션은 전용 입력란에서 변경하세요.',
    chat: '저장 후 각 생성 요청에 추가할 옵션입니다. {"min_p": 0.05}처럼 JSON 객체로 입력하며 배열과 중첩 객체도 사용할 수 있습니다. Temperature·Top-p·Top-k·추론 전용 설정에 명시한 값이 있으면 그 값이 우선합니다. model·messages·stream은 앱이 관리하므로 여기에 입력할 수 없습니다.',
    options: '아래 입력란은 위의 추가 서버 인수를 편집합니다. 변경한 값은 다음 모델 로드부터 적용됩니다. 사용할 수 있는 플래그와 값은 선택한 런타임에 따라 다릅니다.',
    search: '플래그·설명·분류로 옵션을 검색합니다.',
    missing: '모델을 로드할 때 런타임에 전달하는 옵션입니다. 런타임 도움말에 설명이 없으므로, 기능과 지원 값은 해당 런타임의 문서에서 확인하세요.',
    toggle: '선택하면 서버 인수에 이 플래그를 추가합니다. 해제하면 플래그를 생략하고 런타임 기본 동작을 따릅니다.',
    single: '플래그는 앱이 붙이므로 값만 입력하세요. 비워 두면 이 옵션을 생략하고 런타임 기본값을 사용합니다.',
    multiple: '플래그는 앱이 붙이므로 표시된 형식 순서대로 값만 공백으로 구분해 입력하세요. 비워 두면 이 옵션을 생략하고 런타임 기본값을 사용합니다.',
    choices: '명시된 값',
    noResults: '일치하는 옵션이 없습니다.',
  },
  ja: {
    args: 'モデルの読み込み時にランタイムへ渡す追加引数です。1 行に 1 つのオプションを、`--load-mode none` のようにフラグと値を空白で区切って記入します。フラグより後ろはすべて 1 つの値として扱うため、空白を含むパスもそのまま使えます。シェルコマンドや引用符の構文は解釈されません。モデルや GPU の選択など、アプリが管理するオプションは専用の入力欄で変更してください。',
    chat: '保存後の各生成リクエストに追加するオプションです。{"min_p": 0.05} のような JSON オブジェクトを入力します。配列と入れ子のオブジェクトも使用できます。Temperature、Top-p、Top-k、推論の専用設定に明示した値があれば、その値が優先されます。model、messages、stream はアプリが管理するため、ここでは指定できません。',
    options: '以下の入力欄は上記の追加サーバー引数を編集します。変更は次回のモデル読み込み時に適用されます。利用可能なフラグと値は選択したランタイムによって異なります。',
    search: 'フラグ、説明、分類でオプションを検索します。',
    missing: 'モデルの読み込み時にランタイムへ渡すオプションです。ランタイムのヘルプに説明がないため、機能と対応する値はランタイムのドキュメントで確認してください。',
    toggle: '選択すると、このフラグをサーバー引数に追加します。解除するとフラグを省略し、ランタイムの既定の動作に従います。',
    single: 'フラグはアプリが付けるため、値だけを入力してください。空欄にするとオプションを省略し、ランタイムの既定値を使用します。',
    multiple: 'フラグはアプリが付けるため、表示された形式の順に値だけを空白で区切って入力してください。空欄にするとオプションを省略し、ランタイムの既定値を使用します。',
    choices: '記載されている値',
    noResults: '該当するオプションがありません。',
  },
  zh: {
    args: '加载模型时传递给运行时的附加参数。每行输入一个选项，标志与值之间用空格分隔，例如 --load-mode none。标志之后的内容整体作为一个值，因此路径可以包含空格；不会解析 shell 命令或引号语法。模型和 GPU 选择等由应用管理的选项必须通过专用控件修改。',
    chat: '保存后添加到每次生成请求的选项。请输入 JSON 对象，例如 {"min_p": 0.05}；也支持数组和嵌套对象。Temperature、Top-p、Top-k 和推理专用设置中明确指定的值优先。model、messages、stream 由应用管理，不能在此输入。',
    options: '以下控件编辑上方的附加服务器参数。更改在下次加载模型时生效。可用标志与值取决于所选运行时。',
    search: '按标志、说明或分类搜索选项。',
    missing: '加载模型时传递给运行时的选项。运行时帮助未提供说明；请查阅运行时文档以了解其作用和支持的值。',
    toggle: '选中后将此标志添加到服务器参数。取消选中会省略该标志，使用运行时的默认行为。',
    single: '标志由应用自动写入，只需输入值。留空将省略此选项，使用运行时默认值。',
    multiple: '标志由应用自动写入，请按显示的格式顺序仅输入各个值，以空格分隔。留空将省略此选项，使用运行时默认值。',
    choices: '列出的值',
    noResults: '没有匹配的选项。',
  },
};

export function advancedOptionDescription(option: ServerOption, locale: Locale, t: (key: UnifiedKey) => string): string {
  const field = TUNING_FIELD_CATALOG.find(item => {
    const aliases = [...serverAliasesForRequest(item.key), ...(item.aliases ?? [])];
    return option.flags.some(flag => aliases.includes(flag));
  });
  return (field && tuningFieldTooltip(t, field).description.trim())
    || serverOptionDescription(option, locale);
}
