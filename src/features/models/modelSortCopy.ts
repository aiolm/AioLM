import type { Locale } from '../../shared/i18n/i18nCatalog';

export type ModelSortOrder = 'default' | 'loaded' | 'name' | 'size-desc' | 'size-asc';

interface ModelSortCopy {
  label: string;
  default: string;
  loaded: string;
  name: string;
  sizeDesc: string;
  sizeAsc: string;
  clearSearch: string;
}

export const modelSortCopy: Record<Locale, ModelSortCopy> = {
  en: {
    label: 'Sort models',
    default: 'Order: Default',
    loaded: 'Order: Loaded first',
    name: 'Order: Name',
    sizeDesc: 'Order: Largest first',
    sizeAsc: 'Order: Smallest first',
    clearSearch: 'Clear search',
  },
  ko: {
    label: '모델 정렬',
    default: '정렬: 기본순',
    loaded: '정렬: 실행 중 우선',
    name: '정렬: 이름순',
    sizeDesc: '정렬: 큰 크기순',
    sizeAsc: '정렬: 작은 크기순',
    clearSearch: '검색어 지우기',
  },
  ja: {
    label: 'モデルの並び替え',
    default: '並び替え: 既定順',
    loaded: '並び替え: 実行中を先頭',
    name: '並び替え: 名前順',
    sizeDesc: '並び替え: 大きい順',
    sizeAsc: '並び替え: 小さい順',
    clearSearch: '検索をクリア',
  },
  zh: {
    label: '模型排序',
    default: '排序: 默认',
    loaded: '排序: 运行中优先',
    name: '排序: 名称',
    sizeDesc: '排序: 从大到小',
    sizeAsc: '排序: 从小到大',
    clearSearch: '清除搜索',
  },
};
