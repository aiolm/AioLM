import type { Dispatch, SetStateAction } from 'react';
import type * as api from '../../shared/api/index';
import type { AppStore } from '../../shared/state/store';

export interface DiscoverProps {
  store: AppStore;
  active?: boolean;
  onSelectModel?: (path: string) => Promise<void>;
  onOpenModels?: () => void;
}

export type DownloadedChoice = { path: string; projector: boolean; repo: string; destination: string }
  & Pick<api.ModelArtifact, 'selected_file' | 'selected_weight_files'>;
export type DownloadNotice = { message: string; repo: string; destination: string };
export interface DiscoverFeedback {
  setError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<DownloadNotice | null>>;
  setDownloadedChoice: Dispatch<SetStateAction<DownloadedChoice | null>>;
}

export interface InstalledLookup {
  repoId: string;
  modelsDir: string;
  entries: Record<string, api.HfInstalledFile>;
  /** `pending` until the first answer for this identity has arrived. */
  state: "pending" | "ready" | "unavailable";
}

export type TransferCancel = () => Promise<void> | void;

export interface TransferOrigin {
  repo: string;
  file: string;
  inspectionGeneration: number;
  destination: string;
  provider: api.ProviderId;
  runtime: string;
  activeModel: string;
  mmproj: string;
  taskCancel: TransferCancel | null;
  superseded: boolean;
  cancelled: boolean;
  disposed: boolean;
}

export interface TransferContext {
  repo: string;
  destination: string;
  provider: api.ProviderId;
  runtime: string;
  activeModel: string;
  mmproj: string;
}

export function matches(lookup: InstalledLookup | null, repoId: string, modelsDir: string): boolean {
  return !!lookup && lookup.repoId === repoId && lookup.modelsDir === modelsDir;
}
