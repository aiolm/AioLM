import type { Locale } from './i18n';

export const runtimeCommandCopy = {
  en: { title: 'Entry token roles (optional)', enable: 'Declare fixed options and subcommands', hint: 'Map the serving entry tokens explicitly. Option values are never subcommands, even when their text matches. Literal interpreter and script tokens stay unchanged.', token: 'Argument', role: 'Role', literal: 'Literal entry token', option: 'Fixed option', command: 'Subcommand', count: 'Following value count', value: 'Value of argument' },
  ko: { title: '진입 인자 역할 (선택)', enable: '고정 옵션과 서브커맨드 명시', hint: '서버 진입 인자의 역할을 직접 연결하세요. 옵션 값은 같은 단어여도 서브커맨드가 아닙니다. 인터프리터와 스크립트의 리터럴 인자는 유지됩니다.', token: '인자', role: '역할', literal: '리터럴 진입 인자', option: '고정 옵션', command: '서브커맨드', count: '뒤따르는 값 개수', value: '값을 소유한 인자' },
  ja: { title: '起動引数の役割（任意）', enable: '固定オプションとサブコマンドを明示', hint: 'サーバーの起動引数を明示的に対応付けます。同じ単語でもオプションの値はサブコマンドではありません。インタープリターとスクリプトの引数は維持されます。', token: '引数', role: '役割', literal: '固定の起動引数', option: '固定オプション', command: 'サブコマンド', count: '後続する値の数', value: '値を所有する引数' },
  zh: { title: '入口参数角色（可选）', enable: '声明固定选项和子命令', hint: '明确指定服务入口参数的角色。即使文本相同，选项值也不是子命令。解释器和脚本的字面参数保持不变。', token: '参数', role: '角色', literal: '字面入口参数', option: '固定选项', command: '子命令', count: '后续值数量', value: '值所属的参数' },
} satisfies Record<Locale, Record<string, string>>;
