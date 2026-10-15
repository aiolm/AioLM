import type { Locale } from './i18n';

export const adapterSetupCopy = {
  ko: { title: '어댑터로 간편 연결', hint: '어댑터가 제공하는 연결 정보를 불러오거나 아래에서 실행 파일을 직접 선택하세요. 어떤 엔진이든 어댑터 설정을 추가할 수 있습니다.',
    provided: '제공 어댑터 보기', import: '어댑터 설정 가져오기', select: '어댑터 설정', choose: '찾아보기', prepare: '설치 정보 확인하고 계속', cancel: '취소', required: '필수',
    review: '이 설정은 선택한 프로그램을 실행해 연결 정보를 확인합니다. 실행 파일과 인자를 검토하세요.', command: '설정 확인 명령', empty: '선택한 어댑터의 설치 위치를 입력하세요.' },
  en: { title: 'Connect with an adapter', hint: 'Load adapter-provided connection details, or select an executable below. You can add setup recipes for other engines.',
    provided: 'Browse provided adapters', import: 'Import adapter setup', select: 'Adapter setup', choose: 'Browse', prepare: 'Check installation and continue', cancel: 'Cancel', required: 'Required',
    review: 'This setup runs the selected program to check connection details. Review the executable and arguments.', command: 'Setup command', empty: 'Enter the installation locations for this adapter.' },
  ja: { title: 'アダプターで簡単に接続', hint: 'アダプターの接続情報を読み込むか、下で実行ファイルを選択してください。他のエンジンの設定も追加できます。',
    provided: '付属アダプターを表示', import: 'アダプター設定を読み込む', select: 'アダプター設定', choose: '参照', prepare: 'インストールを確認して続行', cancel: 'キャンセル', required: '必須',
    review: '選択したプログラムを実行して接続情報を確認します。実行ファイルと引数を確認してください。', command: '設定確認コマンド', empty: 'このアダプターのインストール先を入力してください。' },
  zh: { title: '通过适配器连接', hint: '加载适配器提供的连接信息，或在下方选择可执行文件。可以添加其他引擎的适配器设置。',
    provided: '查看随附适配器', import: '导入适配器设置', select: '适配器设置', choose: '浏览', prepare: '检查安装并继续', cancel: '取消', required: '必填',
    review: '此设置会运行所选程序以检查连接信息。请检查可执行文件和参数。', command: '设置检查命令', empty: '输入此适配器的安装位置。' },
} satisfies Record<Locale, Record<string, string>>;
