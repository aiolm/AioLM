import type { Locale } from '../../shared/i18n/i18n';

const en = {
  title: 'Execution environment', profile: 'Profile', runtime: 'Runtime', gpu: 'Selected GPU',
  system: 'CPU / system RAM', settings: 'Key settings', gpuLayers: 'GPU layers', threads: 'CPU threads',
  batch: 'Batch / microbatch', cache: 'KV cache (K / V)', flash: 'Flash Attention',
  automatic: 'Automatic', cpuOnly: 'CPU only', unknown: 'Unavailable', loading: 'Reading device specifications…',
  automaticGpu: 'Runtime selects the GPU at launch', missingGpu: 'Device specifications unavailable',
  main: 'Main', draft: 'Draft', allLayers: 'All', hardware: 'Hardware',
};
type Copy = { [K in keyof typeof en]: string };
const ko: Copy = {
  title: '실행 환경', profile: '프로필', runtime: '런타임', gpu: '선택 GPU',
  system: 'CPU / 시스템 RAM', settings: '주요 설정', gpuLayers: 'GPU 레이어', threads: 'CPU 스레드',
  batch: '배치 / 마이크로배치', cache: 'KV 캐시 (K / V)', flash: 'Flash Attention',
  automatic: '자동', cpuOnly: 'CPU 전용', unknown: '확인 불가', loading: '장치 사양 확인 중…',
  automaticGpu: '실행 시 런타임이 GPU 선택', missingGpu: '장치 사양 확인 불가',
  main: '주 GPU', draft: '초안', allLayers: '전체', hardware: '하드웨어',
};
const ja: Copy = {
  title: '実行環境', profile: 'プロファイル', runtime: 'ランタイム', gpu: '選択GPU',
  system: 'CPU / システムRAM', settings: '主な設定', gpuLayers: 'GPUレイヤー', threads: 'CPUスレッド',
  batch: 'バッチ / マイクロバッチ', cache: 'KVキャッシュ (K / V)', flash: 'Flash Attention',
  automatic: '自動', cpuOnly: 'CPUのみ', unknown: '確認不可', loading: 'デバイス仕様を確認中…',
  automaticGpu: '起動時にランタイムがGPUを選択', missingGpu: 'デバイス仕様を確認できません',
  main: 'メイン', draft: 'ドラフト', allLayers: 'すべて', hardware: 'ハードウェア',
};
const zh: Copy = {
  title: '运行环境', profile: '配置方案', runtime: '运行时', gpu: '所选GPU',
  system: 'CPU / 系统RAM', settings: '主要设置', gpuLayers: 'GPU层数', threads: 'CPU线程',
  batch: '批次 / 微批次', cache: 'KV缓存 (K / V)', flash: 'Flash Attention',
  automatic: '自动', cpuOnly: '仅CPU', unknown: '无法确认', loading: '正在读取设备规格…',
  automaticGpu: '启动时由运行时选择GPU', missingGpu: '无法确认设备规格',
  main: '主GPU', draft: '草稿', allLayers: '全部', hardware: '硬件',
};
export const benchmarkEnvironmentCopy: Record<Locale, Copy> = { en, ko, ja, zh };
