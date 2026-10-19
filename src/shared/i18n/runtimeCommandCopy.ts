import type { Locale } from './i18n';

export const runtimeCommandCopy = {
  en: { title: "Launch argument roles (optional)", enable: 'Declare fixed options and subcommands', hint: "Identify which launch arguments are fixed options, their values or subcommands. A value is not a subcommand even if its text matches. Interpreter and script arguments stay unchanged.", token: 'Argument', role: 'Role', literal: "Keep this argument unchanged", option: 'Fixed option', command: 'Subcommand', count: 'Following value count', value: "Value belongs to argument" },
  ko: { title: "실행 인자 역할 (선택)", enable: '고정 옵션과 서브커맨드 명시', hint: "실행 인자가 고정 옵션인지, 그 옵션의 값인지, 서브커맨드인지 지정하세요. 단어가 같아도 옵션 값은 서브커맨드로 처리하지 않습니다. 인터프리터와 스크립트 인자는 그대로 유지됩니다.", token: '인자', role: '역할', literal: "그대로 사용할 인자", option: '고정 옵션', command: '서브커맨드', count: '뒤따르는 값 개수', value: "이 값이 속한 인자" },
  ja: { title: '起動引数の役割（任意）', enable: '固定オプションとサブコマンドを明示', hint: "起動引数が固定オプション、その値、サブコマンドのどれかを指定してください。同じ単語でもオプションの値をサブコマンドとして扱いません。インタープリターとスクリプトの引数は維持されます。", token: '引数', role: '役割', literal: "そのまま使う引数", option: '固定オプション', command: 'サブコマンド', count: '後続する値の数', value: "この値が属する引数" },
  zh: { title: "启动参数用途（可选）", enable: '声明固定选项和子命令', hint: "指定启动参数是固定选项、选项值还是子命令。即使文本相同，也不会将选项值作为子命令。解释器和脚本参数保持不变。", token: '参数', role: '角色', literal: "保持不变的参数", option: '固定选项', command: '子命令', count: '后续值数量', value: "此值所属的参数" },
} satisfies Record<Locale, Record<string, string>>;
