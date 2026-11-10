import type { Locale } from '../../shared/i18n/i18n';

export const rawArgumentsCopy = {
  ko: {
    title: '추가 실행 인수 직접 입력',
    hint: '도움말에 없는 옵션을 인수 단위로 추가하세요. 경로와 값은 공백이 있어도 한 칸에 입력합니다. 표시된 옵션은 위 설정이나 명령어 가져오기로 입력하세요. 중복 옵션과 앱이 관리하는 인수는 실행 전에 차단합니다.',
  },
  en: {
    title: 'Additional launch arguments',
    hint: 'Add undocumented options as individual arguments. Keep a path or value containing spaces in one field. Use the controls or command import for listed options. Duplicate options and app-managed arguments are blocked before launch.',
  },
  ja: {
    title: '追加の起動引数を直接入力',
    hint: 'ヘルプにないオプションを引数ごとに追加します。空白を含むパスや値も一つの欄に入力してください。表示されているオプションは設定欄かコマンド取り込みを使用します。重複やアプリ管理の引数は起動前に拒否されます。',
  },
  zh: {
    title: '直接输入其他启动参数',
    hint: '按参数添加帮助中未列出的选项。包含空格的路径或值放在同一输入框中。已列出的选项请使用设置控件或导入命令。重复选项和应用管理的参数会在启动前被阻止。',
  },
} satisfies Record<Locale, { title: string; hint: string }>;
