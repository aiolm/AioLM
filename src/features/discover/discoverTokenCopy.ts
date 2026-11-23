import type { Locale } from '../../shared/i18n/i18nCatalog';

interface DiscoverTokenCopy {
  filterFiles: string;
  filterFilesPlaceholder: string;
  clearFilter: string;
  noMatchingFiles: string;
  tokenTitle: string;
  tokenConfigured: string;
  tokenNotConfigured: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHint: string;
  tokenSave: string;
  tokenClear: string;
  tokenSaved: string;
  tokenCleared: string;
  gatedTitle: string;
  gatedBody: string;
  gatedConfigure: string;
}

export const discoverTokenCopy: Record<Locale, DiscoverTokenCopy> = {
  en: {
    filterFiles: 'Filter repository files',
    filterFilesPlaceholder: 'Filter files or quantization (e.g. Q4_K_M)',
    clearFilter: 'Clear filter',
    noMatchingFiles: 'No repository files match the filter.',
    tokenTitle: 'Hugging Face access token',
    tokenConfigured: 'Token saved',
    tokenNotConfigured: 'Not set',
    tokenLabel: 'Access token',
    tokenPlaceholder: 'hf_…',
    tokenHint: 'Stored locally in a private file for gated repositories only, and sent only to huggingface.co over HTTPS.',
    tokenSave: 'Save token',
    tokenClear: 'Clear token',
    tokenSaved: 'Hugging Face access token saved.',
    tokenCleared: 'Hugging Face access token removed.',
    gatedTitle: 'Gated repository',
    gatedBody: 'This repository requires accepting its license on Hugging Face and configuring an access token before files can be inspected or downloaded.',
    gatedConfigure: 'Configure token',
  },
  ko: {
    filterFiles: '저장소 파일 필터',
    filterFilesPlaceholder: '파일명 또는 양자화 필터 (예: Q4_K_M)',
    clearFilter: '필터 지우기',
    noMatchingFiles: '필터와 일치하는 저장소 파일이 없습니다.',
    tokenTitle: 'Hugging Face 액세스 토큰',
    tokenConfigured: '토큰 저장됨',
    tokenNotConfigured: '미설정',
    tokenLabel: '액세스 토큰',
    tokenPlaceholder: 'hf_…',
    tokenHint: '게이트 저장소 접근을 위해 이 기기의 개인 파일에만 저장하며 HTTPS를 통해 huggingface.co로만 전송합니다.',
    tokenSave: '토큰 저장',
    tokenClear: '토큰 삭제',
    tokenSaved: 'Hugging Face 액세스 토큰을 저장했습니다.',
    tokenCleared: 'Hugging Face 액세스 토큰을 삭제했습니다.',
    gatedTitle: '접근 승인 필요(Gated) 저장소',
    gatedBody: '이 저장소는 Hugging Face에서 약관에 동의하고 액세스 토큰을 설정해야 파일 목록 조회나 다운로드를 진행할 수 있습니다.',
    gatedConfigure: '토큰 설정',
  },
  ja: {
    filterFiles: 'リポジトリファイルを絞り込む',
    filterFilesPlaceholder: 'ファイル名・量子化で絞り込み (例: Q4_K_M)',
    clearFilter: '絞り込みを解除',
    noMatchingFiles: '条件に一致するリポジトリファイルがありません。',
    tokenTitle: 'Hugging Face アクセストークン',
    tokenConfigured: '保存済み',
    tokenNotConfigured: '未設定',
    tokenLabel: 'アクセストークン',
    tokenPlaceholder: 'hf_…',
    tokenHint: '制限付きリポジトリ用にこの端末のプライベートファイルへ保存し、HTTPS 経由で huggingface.co のみに送信します。',
    tokenSave: 'トークンを保存',
    tokenClear: 'トークンを削除',
    tokenSaved: 'Hugging Face アクセストークンを保存しました。',
    tokenCleared: 'Hugging Face アクセストークンを削除しました。',
    gatedTitle: '承認制（Gated）リポジトリ',
    gatedBody: 'このリポジトリは Hugging Face で利用規約に同意し、アクセストークンを設定しないとファイル確認やダウンロードができません。',
    gatedConfigure: 'トークンを設定',
  },
  zh: {
    filterFiles: '筛选仓库文件',
    filterFilesPlaceholder: '按文件名或量化筛选（例如 Q4_K_M）',
    clearFilter: '清除筛选',
    noMatchingFiles: '没有符合筛选条件的仓库文件。',
    tokenTitle: 'Hugging Face 访问令牌',
    tokenConfigured: '已保存令牌',
    tokenNotConfigured: '未配置',
    tokenLabel: '访问令牌',
    tokenPlaceholder: 'hf_…',
    tokenHint: '仅保存在本机私有文件中用于受限仓库访问，且仅通过 HTTPS 发送至 huggingface.co。',
    tokenSave: '保存令牌',
    tokenClear: '清除令牌',
    tokenSaved: 'Hugging Face 访问令牌已保存。',
    tokenCleared: 'Hugging Face 访问令牌已清除。',
    gatedTitle: '受限访问（Gated）仓库',
    gatedBody: '此仓库需要先在 Hugging Face 同意条款并配置访问令牌，然后才能查看文件列表或下载。',
    gatedConfigure: '配置令牌',
  },
};
