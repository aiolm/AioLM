import type { Locale } from './i18n';

export const adapterSetupCopy = {
  ko: { title: '연결 설정 파일이 있나요?', hint: '엔진·어댑터 제공자가 준비한 AioLM용 설정을 가져오세요. 실행 파일을 선택해도 이 설정 파일은 자동 생성되지 않습니다.',
    fileHint: '압축을 푼 어댑터 폴더에서 연결 설정 JSON(예: *.setup.json)을 선택하세요. 일반 엔진 설정 JSON·모델 파일은 사용할 수 없습니다. 설정 파일이 없다면 아래에서 직접 등록하세요.', import: 'AioLM 연결 설정 가져오기 (.json)', choose: '찾아보기', prepare: '설치 정보 확인하고 계속', cancel: '취소', required: '필수',
    review: '이 설정은 선택한 프로그램을 실행해 연결 정보를 확인합니다. 실행 파일과 인자를 검토하세요.', command: '설정 확인 명령', empty: '선택한 어댑터의 설치 위치를 입력하세요.' },
  en: { title: 'Have a connection setup file?', hint: 'Import an AioLM setup prepared by the engine or adapter provider. Choosing an executable does not generate this file.',
    fileHint: 'Unpack the adapter folder and select its connection setup JSON (for example *.setup.json). Ordinary engine configuration JSON and model files are not setup recipes. Without a setup file, register manually below.', import: 'Import AioLM connection setup (.json)', choose: 'Browse', prepare: 'Check installation and continue', cancel: 'Cancel', required: 'Required',
    review: 'This setup runs the selected program to check connection details. Review the executable and arguments.', command: 'Setup command', empty: 'Enter the installation locations for this adapter.' },
  ja: { title: '接続設定ファイルはありますか？', hint: 'エンジンやアダプターの提供者が用意したAioLM用設定を読み込みます。実行ファイルを選んでも、この設定ファイルは自動生成されません。',
    fileHint: 'アダプターのフォルダーを展開し、接続設定JSON（例：*.setup.json）を選択します。通常のエンジン設定JSONやモデルは使えません。設定がなければ下で手動登録してください。', import: 'AioLM接続設定を読み込む (.json)', choose: '参照', prepare: 'インストールを確認して続行', cancel: 'キャンセル', required: '必須',
    review: '選択したプログラムを実行して接続情報を確認します。実行ファイルと引数を確認してください。', command: '設定確認コマンド', empty: 'このアダプターのインストール先を入力してください。' },
  zh: { title: '有连接设置文件吗？', hint: '导入引擎或适配器提供方准备的AioLM设置。选择可执行文件不会自动生成此设置文件。',
    fileHint: '解压适配器文件夹并选择连接设置JSON（例如*.setup.json）。普通引擎配置JSON和模型文件不是连接设置。没有设置文件时，请在下方手动注册。', import: '导入AioLM连接设置 (.json)', choose: '浏览', prepare: '检查安装并继续', cancel: '取消', required: '必填',
    review: '此设置会运行所选程序以检查连接信息。请检查可执行文件和参数。', command: '设置检查命令', empty: '输入此适配器的安装位置。' },
} satisfies Record<Locale, Record<string, string>>;
