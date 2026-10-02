import type { Locale } from '../../shared/i18n/i18n';

const en = {
  website: 'AioLM website', browse: 'Browse public benchmarks',
  browseHint: 'Explore the website’s filters, comparisons and result details in an AioLM window.',
  import: 'Create profile from run settings', importing: 'Creating profile…',
  importHint: 'Creates a saved profile. Check local model files, GPU devices and the installed runtime before applying it. Unrecorded settings use runtime defaults.',
  saved: 'Profile created:', failed: 'Could not create the profile.', openFailed: 'Could not open the website.',
  omitted: 'Some launch options could not be restored. Review the run’s arguments before applying this profile.',
};
const translations: Record<Locale, typeof en> = {
  en,
  ko: {
    website: 'AioLM 웹사이트', browse: '공개 벤치마크 조회',
    browseHint: 'AioLM 전용 창에서 웹사이트의 필터, 비교 및 기록 상세 화면을 이용합니다.',
    import: '실행 설정으로 프로필 생성', importing: '프로필 생성 중…',
    importHint: '저장된 프로필을 생성합니다. 적용하기 전에 로컬 모델 파일, GPU 장치와 설치된 런타임을 확인하세요. 기록되지 않은 설정은 런타임 기본값을 사용합니다.',
    saved: '프로필 생성 완료:', failed: '프로필을 생성하지 못했습니다.', openFailed: '웹사이트를 열지 못했습니다.',
    omitted: '일부 실행 옵션은 복원하지 못했습니다. 프로필 적용 전에 기록의 실행 인수를 확인하세요.',
  },
  ja: {
    website: 'AioLM ウェブサイト', browse: '公開ベンチマークを参照',
    browseHint: 'AioLM ウィンドウでウェブサイトのフィルター、比較、結果詳細を利用できます。',
    import: '実行設定からプロファイルを作成', importing: 'プロファイルを作成中…',
    importHint: '保存プロファイルを作成します。適用前にローカルモデル、GPU、インストール済みランタイムを確認してください。未記録の設定にはランタイムの既定値を使用します。',
    saved: 'プロファイルを作成しました:', failed: 'プロファイルを作成できませんでした。', openFailed: 'ウェブサイトを開けませんでした。',
    omitted: '一部の実行オプションを復元できませんでした。適用前に実行引数を確認してください。',
  },
  zh: {
    website: 'AioLM 网站', browse: '浏览公开基准测试',
    browseHint: '在 AioLM 窗口中使用网站的筛选、比较和结果详情。',
    import: '根据运行设置创建配置档', importing: '正在创建配置档…',
    importHint: '创建保存的配置档。应用前请检查本地模型文件、GPU 设备和已安装的运行时。未记录的设置使用运行时默认值。',
    saved: '已创建配置档：', failed: '无法创建配置档。', openFailed: '无法打开网站。',
    omitted: '部分运行选项无法恢复。应用前请检查记录的启动参数。',
  },
};
export const benchmarkExplorerCopy = (locale: Locale) => translations[locale];
