import type { Locale } from './i18n';

export const adapterSetupCopy = {
  ko: { title: '연결 설정 파일이 있나요?', hint: '엔진 제공자가 만든 AioLM용 설정을 가져오세요. 앱은 외부 엔진이나 특정 업체의 어댑터를 기본 제공하지 않습니다.',
    fileHint: '압축을 푼 어댑터 폴더에서 *.setup.json을 선택하세요. 일반 엔진 설정 JSON·모델 파일은 사용할 수 없습니다. 설정 파일이 없다면 아래에서 직접 등록하세요.', import: 'AioLM 연결 설정 가져오기 (.json)', select: '어댑터 설정', choose: '찾아보기', prepare: '설치 정보 확인하고 계속', cancel: '취소', required: '필수',
    review: '이 설정은 선택한 프로그램을 실행해 연결 정보를 확인합니다. 실행 파일과 인자를 검토하세요.', command: '설정 확인 명령', empty: '선택한 어댑터의 설치 위치를 입력하세요.' },
  en: { title: 'Have a connection setup file?', hint: 'Import an AioLM setup from the engine provider. No external engine or vendor-specific adapter is bundled.',
    fileHint: 'Unpack the adapter folder and select its *.setup.json file. Ordinary engine configuration JSON and model files are not setup recipes. Without a setup file, register manually below.', import: 'Import AioLM connection setup (.json)', select: 'Adapter setup', choose: 'Browse', prepare: 'Check installation and continue', cancel: 'Cancel', required: 'Required',
    review: 'This setup runs the selected program to check connection details. Review the executable and arguments.', command: 'Setup command', empty: 'Enter the installation locations for this adapter.' },
  ja: { title: '接続設定ファイルはありますか？', hint: 'エンジン提供者のAioLM用設定を読み込みます。外部エンジンや特定の提供者のアダプターは同梱しません。',
    fileHint: 'アダプターのフォルダーを展開し、*.setup.jsonを選択します。通常のエンジン設定JSONやモデルは使えません。設定がなければ下で手動登録してください。', import: 'AioLM接続設定を読み込む (.json)', select: 'アダプター設定', choose: '参照', prepare: 'インストールを確認して続行', cancel: 'キャンセル', required: '必須',
    review: '選択したプログラムを実行して接続情報を確認します。実行ファイルと引数を確認してください。', command: '設定確認コマンド', empty: 'このアダプターのインストール先を入力してください。' },
  zh: { title: '有连接设置文件吗？', hint: '导入引擎提供方的AioLM设置。应用不捆绑外部引擎或特定提供方的适配器。',
    fileHint: '解压适配器文件夹并选择其中的*.setup.json。普通引擎配置JSON和模型文件不是连接设置。没有设置文件时，请在下方手动注册。', import: '导入AioLM连接设置 (.json)', select: '适配器设置', choose: '浏览', prepare: '检查安装并继续', cancel: '取消', required: '必填',
    review: '此设置会运行所选程序以检查连接信息。请检查可执行文件和参数。', command: '设置检查命令', empty: '输入此适配器的安装位置。' },
} satisfies Record<Locale, Record<string, string>>;
