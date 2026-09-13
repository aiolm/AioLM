const en = {
  model: 'Choose the model to run. Selecting another model loads its saved settings into this editor.',
  path: 'Enter the path to a local model file, then select it to load its settings. For a split model, choose its first part.',
  runtime: 'Choose the engine build used to load this model. The system runtime uses an executable discovered on this system. Available options and GPU support depend on the build.',
  projector: 'Choose the vision projector that matches this model to process images. Leave it empty when a separate projector is not needed.',
  draftModel: 'Choose a compatible smaller model to propose tokens for speculative decoding. The main model verifies those tokens; the speed benefit depends on the models and hardware.',
  loraPath: 'Choose a LoRA adapter file compatible with the selected base model.',
  loraEnabled: 'Load this adapter on the next model run. Turning it off keeps the file and scale saved without loading it.',
  loraScale: 'Controls the strength of this adapter. 1 uses its original scale; 0 gives it no effect.',
  gpuDevices: 'Select devices to use for model offloading. With none selected, the runtime chooses devices automatically. GPU layers controls how much of the model is offloaded.',
  gpuMain: 'Select the GPU used in single-GPU mode, or for intermediate results and the KV cache in row mode. Automatic uses the runtime default.',
  gpuDraft: 'Select a device for draft-model offloading. A device name entered under auxiliary models takes priority; otherwise Automatic uses the runtime default. Also configure the draft model and speculative mode.',
  gpuSplitMode: 'Automatic uses the runtime default. single uses one GPU; layer distributes layers; row splits weights by rows; tensor distributes weights and the KV cache and requires runtime support.',
  gpuTensorSplit: 'Enter one non-negative weight per GPU in selection order, separated by commas, with at least one above 0. For example, 3, 1 assigns a 3:1 ratio. Leave empty for automatic allocation.',
};
type Help = { [K in keyof typeof en]: string };

const ko: Help = {
  model: '실행할 모델을 선택합니다. 다른 모델을 선택하면 해당 모델에 저장된 설정을 편집기에 불러옵니다.',
  path: '로컬 모델 파일 경로를 입력한 뒤 선택하면 설정을 불러옵니다. 분할 모델은 첫 번째 파일을 선택하세요.',
  runtime: '모델을 로드할 엔진 빌드를 선택합니다. 시스템 런타임은 시스템에서 찾은 실행 파일을 사용합니다. 사용 가능한 옵션과 GPU 지원은 빌드에 따라 달라집니다.',
  projector: '이미지를 처리하려면 모델과 호환되는 비전 프로젝터를 선택하세요. 별도 프로젝터가 필요하지 않으면 비워 둡니다.',
  draftModel: '추측 디코딩에서 토큰을 먼저 제안할 호환 소형 모델을 선택합니다. 주 모델이 제안을 검증하며, 속도 개선 정도는 모델과 하드웨어에 따라 달라집니다.',
  loraPath: '선택한 기본 모델과 호환되는 LoRA 어댑터 파일을 지정합니다.',
  loraEnabled: '다음 모델 실행 시 이 어댑터를 로드합니다. 끄면 파일과 배율 설정을 유지하면서 로드에서 제외합니다.',
  loraScale: '어댑터의 적용 강도를 조절합니다. 1은 원래 강도이며, 0은 효과를 적용하지 않습니다.',
  gpuDevices: '모델 연산을 맡길 GPU를 선택합니다. 선택하지 않으면 런타임이 장치를 자동으로 정합니다. GPU 레이어 설정으로 GPU에 배치할 양을 조절합니다.',
  gpuMain: '단일 GPU 모드에서 사용할 GPU 또는 row 모드에서 중간 결과와 KV 캐시를 맡을 GPU입니다. 자동은 런타임 기본값을 사용합니다.',
  gpuDraft: '드래프트 모델을 배치할 장치를 선택합니다. 보조 모델 탭에 입력한 장치 이름이 우선하며, 별도 입력이 없을 때 자동은 런타임 기본값을 사용합니다. 드래프트 모델과 추측 모드도 설정하세요.',
  gpuSplitMode: '자동은 런타임 기본값입니다. single은 GPU 하나, layer는 레이어 분산, row는 가중치를 행 단위로 분산합니다. tensor는 가중치와 KV 캐시를 분산하며 런타임 지원이 필요합니다.',
  gpuTensorSplit: 'GPU를 선택한 순서대로 0 이상의 비중을 쉼표로 구분해 입력하고, 하나 이상은 0보다 크게 지정하세요. 예를 들어 3, 1은 3:1로 배분합니다. 비워 두면 자동 배분합니다.',
};

const ja: Help = {
  model: '実行するモデルを選択します。別のモデルを選ぶと、そのモデルに保存された設定をエディターに読み込みます。',
  path: 'ローカルモデルのファイルパスを入力し、選択して設定を読み込みます。分割モデルは最初のファイルを選んでください。',
  runtime: 'モデルを読み込むエンジンのビルドを選択します。システムランタイムはシステム内で見つかった実行ファイルを使います。利用可能なオプションと GPU 対応はビルドにより異なります。',
  projector: '画像を処理するには、モデルに対応したビジョンプロジェクターを選択してください。別のプロジェクターが不要なら空欄にします。',
  draftModel: '投機的デコードでトークンを提案する、互換性のある小型モデルを選択します。主モデルが提案を検証し、速度への効果はモデルとハードウェアにより異なります。',
  loraPath: '選択したベースモデルに対応する LoRA アダプターのファイルを指定します。',
  loraEnabled: '次回のモデル実行時にこのアダプターを読み込みます。オフにするとファイルと倍率を保持したまま読み込みから除外します。',
  loraScale: 'アダプターの適用強度を調整します。1 は元の強度、0 は効果なしです。',
  gpuDevices: 'モデルのオフロードに使う GPU を選択します。未選択ならランタイムが自動選択します。GPU レイヤー数でオフロードする量を調整します。',
  gpuMain: '単一 GPU モードで使う GPU、または row モードで中間結果と KV キャッシュを処理する GPU を選択します。自動はランタイムの既定値を使います。',
  gpuDraft: 'ドラフトモデルを配置するデバイスを選択します。補助モデルの項目に入力したデバイス名が優先され、入力がなければ自動はランタイムの既定値を使います。ドラフトモデルと投機モードも設定してください。',
  gpuSplitMode: '自動はランタイムの既定値です。single は GPU 1 台、layer はレイヤー分散、row は重みを行ごとに分散します。tensor は重みと KV キャッシュを分散し、ランタイムの対応が必要です。',
  gpuTensorSplit: 'GPU の選択順に 0 以上の比重をカンマ区切りで入力し、少なくとも 1 つを 0 より大きくしてください。例: 3, 1 は 3:1 に配分します。空欄は自動配分です。',
};

const zh: Help = {
  model: '选择要运行的模型。选择其他模型后，会将该模型保存的设置载入编辑器。',
  path: '输入本地模型文件的路径，然后选择该文件以载入设置。分片模型请选择第一个文件。',
  runtime: '选择用于加载模型的引擎构建版本。系统运行时使用在此系统中找到的可执行文件。可用选项和 GPU 支持取决于构建版本。',
  projector: '处理图像时请选择与模型匹配的视觉投影器。如果不需要独立投影器，请留空。',
  draftModel: '选择兼容的小型模型，为推测解码预先提出 token。主模型会验证这些 token；加速效果取决于模型和硬件。',
  loraPath: '指定与所选基础模型兼容的 LoRA 适配器文件。',
  loraEnabled: '在下次运行模型时加载此适配器。关闭后保留文件和缩放设置，但不加载适配器。',
  loraScale: '控制适配器的作用强度。1 为原始强度，0 表示不产生效果。',
  gpuDevices: '选择用于模型卸载的 GPU。不选择时由运行时自动决定。GPU 层数设置控制卸载到 GPU 的数量。',
  gpuMain: '选择单 GPU 模式使用的 GPU，或 row 模式中处理中间结果和 KV 缓存的 GPU。自动使用运行时默认值。',
  gpuDraft: '选择放置草稿模型的设备。辅助模型中输入的设备名称优先；未输入时，自动使用运行时默认值。还需配置草稿模型和推测模式。',
  gpuSplitMode: '自动使用运行时默认值。single 使用一个 GPU；layer 分配模型层；row 按行拆分权重；tensor 分配权重和 KV 缓存，需要运行时支持。',
  gpuTensorSplit: '按 GPU 选择顺序输入以逗号分隔的非负权重，至少一个大于 0。例如 3, 1 按 3:1 分配。留空则自动分配。',
};

export const modelSettingsHelp = { en, ko, ja, zh };
