import type { Dispatch, Ref, SetStateAction } from 'react';
import type { EntrypointDraft, EntrypointHelp, HelpReport, HelpRequest, RuntimeDescriptor } from '../../shared/api/runtimeHelp';
import type { ProviderId } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';
import type { entrypointCopy } from '../../shared/i18n/entrypointCopy';
import type { HelpTextChoice } from './HelpTextSettings';

export type EntrypointRegistrationCopy = (typeof entrypointCopy)['en'];
export interface EntrypointRegistrationProps {
  locked: boolean;
  onRegistered: (engine: ProviderId, registered: { runtime_id: string; display_name: string }) => void;
  onBusyChange?: (busy: boolean) => void;
  titleRef?: Ref<HTMLHeadingElement>;
  cfg?: AppConfig;
  onPublished?: () => void;
}
export type EntrypointRegistrationStep = 0 | 1 | 2 | 3;
export interface BindingState { mode: 'none' | 'flag' | 'positional'; flag: string; equals: boolean }
type Setter<T> = Dispatch<SetStateAction<T>>;
interface HelpDiscovery {
  entry: string;
  request: HelpRequest;
  result: [HelpReport, RuntimeDescriptor];
}

/** Values and actions consumed by the wizard shell and its presentational steps. */
export interface EntrypointRegistrationController {
  id: string;
  copy: EntrypointRegistrationCopy;
  locked: boolean;
  step: EntrypointRegistrationStep;
  steps: string[];
  disabled: boolean;
  busy: boolean;
  setBusy: Setter<boolean>;
  error: string;
  setError: Setter<string>;
  canContinue: boolean;
  previous: () => void;
  next: () => void;
  onPrepared: (prepared: EntrypointDraft) => void;
  engine: string; setEngine: Setter<string>;
  runtime: string; setRuntime: Setter<string>;
  displayName: string; setDisplayName: Setter<string>;
  program: string; setProgram: Setter<string>;
  prefix: string[]; setPrefix: Setter<string[]>;
  workingDir: string; setWorkingDir: Setter<string>;
  artifacts: string[]; setArtifacts: Setter<string[]>;
  env: Array<[string, string]>; setEnv: Setter<Array<[string, string]>>;
  protocol: 'openai_http' | 'bridge'; setProtocol: Setter<'openai_http' | 'bridge'>;
  bridgeProgram: string; setBridgeProgram: Setter<string>;
  bridgePrefix: string[]; setBridgePrefix: Setter<string[]>;
  bridgeArgvEnv: string; setBridgeArgvEnv: Setter<string>;
  metadataText: string; setMetadataText: Setter<string>;
  metadata: { ok: boolean };
  commandLayout: EntrypointHelp['command_layout']; setCommandLayout: Setter<EntrypointHelp['command_layout']>;
  helpArgs: string[];
  changeHelpArgs: (next: string[]) => void;
  textChoice: HelpTextChoice;
  changeTextChoice: (next: HelpTextChoice) => void;
  taskId: string;
  discover: () => Promise<void>;
  cancelHelp: () => void;
  found: HelpDiscovery | null;
  current: HelpDiscovery | null;
  summary: { total: number; uncertain: string[] } | null;
  skipHelp: boolean; setSkipHelp: Setter<boolean>;
  model: BindingState; setModel: Setter<BindingState>;
  port: BindingState; setPort: Setter<BindingState>;
  host: BindingState; setHost: Setter<BindingState>;
  served: BindingState; setServed: Setter<BindingState>;
  documented: string[];
  positionalDocumented: boolean;
  helpChecked: boolean;
  auth: 'none' | 'env'; setAuth: Setter<'none' | 'env'>;
  authName: string; setAuthName: Setter<string>;
  probeProgram: string; setProbeProgram: Setter<string>;
  probeArgs: string[]; setProbeArgs: Setter<string[]>;
  healthPath: string; setHealthPath: Setter<string>;
  healthAuth: boolean; setHealthAuth: Setter<boolean>;
  formats: string[]; setFormats: Setter<string[]>;
  review: () => Promise<void>;
  manifest: string;
  done: boolean;
  helpPending: EntrypointDraft | null;
  retryHelp: () => Promise<void>;
  register: () => Promise<void>;
}
