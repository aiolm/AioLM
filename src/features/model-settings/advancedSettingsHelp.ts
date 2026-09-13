import type { Locale, UnifiedKey } from '../../shared/i18n/i18n';
import type { ServerOption } from '../../shared/config/serverOptions';
import { serverAliasesForRequest } from '../../shared/config/tuningDefaults';
import { TUNING_FIELD_CATALOG, tuningFieldTooltip } from '../tuning/tuningFields';
import { serverOptionDescription } from '../../shared/i18n/serverOptionDescriptions';

const en = {
  args: 'Additional arguments passed to the runtime when the model is loaded. Enter one argument per line, with a flag and its value on separate lines. Spaces within a line are preserved; shell commands and quoting are not evaluated. App-managed options such as model and GPU selection must be changed in their dedicated controls.',
  chat: 'Extra options merged into each generation request after saving. Enter a JSON object, such as {"min_p": 0.05}; arrays and nested objects are allowed. Explicit temperature, Top-p, Top-k and reasoning controls take precedence when they are set. The app manages model, messages and stream, so those keys cannot be entered here.',
  options: 'These controls edit the additional server arguments above. Changes take effect when the model is next loaded. Available flags and values depend on the selected runtime.',
  search: 'Filter options by their flag, description or group.',
  missing: 'Passed to the runtime when the model is loaded. This runtime option has no description in its help output; check the runtime documentation for its effect and supported values.',
  toggle: 'Checked adds this flag to the server arguments. Unchecked omits it and leaves the runtime to choose its default.',
  single: 'Enter one value. Leave empty to omit this option and use the runtime default.',
  multiple: 'Enter all values shown in the signature, separated by spaces. Leave empty to omit this option and use the runtime default.',
  choices: 'Listed values',
  noResults: 'No matching options.',
};

export const advancedSettingsHelp: Record<Locale, typeof en> = {
  en,
  ko: {
    args: '모델을 로드할 때 런타임에 전달하는 추가 인수입니다. 한 줄에 인수 하나씩 입력하고, 플래그와 값은 서로 다른 줄에 적으세요. 줄 안의 공백은 유지되며 셸 명령이나 따옴표 문법은 해석하지 않습니다. 모델·GPU 선택 등 앱이 관리하는 옵션은 전용 입력란에서 변경하세요.',
    chat: '저장 후 각 생성 요청에 추가할 옵션입니다. {"min_p": 0.05}처럼 JSON 객체로 입력하며 배열과 중첩 객체도 사용할 수 있습니다. Temperature·Top-p·Top-k·추론 전용 설정에 명시한 값이 있으면 그 값이 우선합니다. model·messages·stream은 앱이 관리하므로 여기에 입력할 수 없습니다.',
    options: '아래 입력란은 위의 추가 서버 인수를 편집합니다. 변경한 값은 다음 모델 로드부터 적용됩니다. 사용할 수 있는 플래그와 값은 선택한 런타임에 따라 다릅니다.',
    search: '플래그·설명·분류로 옵션을 검색합니다.',
    missing: '모델을 로드할 때 런타임에 전달하는 옵션입니다. 런타임 도움말에 설명이 없으므로, 기능과 지원 값은 해당 런타임의 문서에서 확인하세요.',
    toggle: '선택하면 서버 인수에 이 플래그를 추가합니다. 해제하면 플래그를 생략하고 런타임 기본 동작을 따릅니다.',
    single: '값 하나를 입력하세요. 비워 두면 이 옵션을 생략하고 런타임 기본값을 사용합니다.',
    multiple: '표시된 형식에 맞춰 모든 값을 공백으로 구분해 입력하세요. 비워 두면 이 옵션을 생략하고 런타임 기본값을 사용합니다.',
    choices: '명시된 값',
    noResults: '일치하는 옵션이 없습니다.',
  },
  ja: {
    args: 'モデルの読み込み時にランタイムへ渡す追加引数です。1 行に 1 つの引数を入力し、フラグと値は別の行に記入します。行内の空白は保持され、シェルコマンドや引用符の構文は解釈されません。モデルや GPU の選択など、アプリが管理するオプションは専用の入力欄で変更してください。',
    chat: '保存後の各生成リクエストに追加するオプションです。{"min_p": 0.05} のような JSON オブジェクトを入力します。配列と入れ子のオブジェクトも使用できます。Temperature、Top-p、Top-k、推論の専用設定に明示した値があれば、その値が優先されます。model、messages、stream はアプリが管理するため、ここでは指定できません。',
    options: '以下の入力欄は上記の追加サーバー引数を編集します。変更は次回のモデル読み込み時に適用されます。利用可能なフラグと値は選択したランタイムによって異なります。',
    search: 'フラグ、説明、分類でオプションを検索します。',
    missing: 'モデルの読み込み時にランタイムへ渡すオプションです。ランタイムのヘルプに説明がないため、機能と対応する値はランタイムのドキュメントで確認してください。',
    toggle: '選択すると、このフラグをサーバー引数に追加します。解除するとフラグを省略し、ランタイムの既定の動作に従います。',
    single: '値を 1 つ入力してください。空欄にするとオプションを省略し、ランタイムの既定値を使用します。',
    multiple: '表示された形式に従って、すべての値を空白で区切って入力してください。空欄にするとオプションを省略し、ランタイムの既定値を使用します。',
    choices: '記載されている値',
    noResults: '該当するオプションがありません。',
  },
  zh: {
    args: '加载模型时传递给运行时的附加参数。每行输入一个参数，标志与值分别放在不同的行。行内空格会被保留，不会解析 shell 命令或引号语法。模型和 GPU 选择等由应用管理的选项必须通过专用控件修改。',
    chat: '保存后添加到每次生成请求的选项。请输入 JSON 对象，例如 {"min_p": 0.05}；也支持数组和嵌套对象。Temperature、Top-p、Top-k 和推理专用设置中明确指定的值优先。model、messages、stream 由应用管理，不能在此输入。',
    options: '以下控件编辑上方的附加服务器参数。更改在下次加载模型时生效。可用标志与值取决于所选运行时。',
    search: '按标志、说明或分类搜索选项。',
    missing: '加载模型时传递给运行时的选项。运行时帮助未提供说明；请查阅运行时文档以了解其作用和支持的值。',
    toggle: '选中后将此标志添加到服务器参数。取消选中会省略该标志，使用运行时的默认行为。',
    single: '输入一个值。留空将省略此选项，使用运行时默认值。',
    multiple: '按显示的格式输入所有值，以空格分隔。留空将省略此选项，使用运行时默认值。',
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
