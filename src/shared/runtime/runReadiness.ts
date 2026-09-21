import type { Locale } from "../i18n/i18nCatalog";
import { executionText } from "../i18n/executionI18n";

/**
 * What a launch target is still missing. A run action that is disabled for one
 * of these is disabled for a reason the user can act on, so every panel that
 * hides its start button behind one of them says which, and offers the move
 * that fixes it.
 */
export type RunSetupGap = "model" | "modelShards" | "runtime" | "runtimeMissing";

export interface RunSetup {
  activeModel: string;
  activeBackend: string;
  activeBuild: string;
  /** Selected model is a split GGUF with parts absent from the library. */
  modelIncomplete?: boolean;
  /**
   * Whether the selected backend and build are actually installed. Leave it
   * out where the installed list is not loaded: an unchecked runtime is
   * reported as fine rather than as missing.
   */
  runtimeInstalled?: boolean;
}

/**
 * One gap per subject, worst first: a model that is not chosen is reported
 * instead of, not alongside, an incomplete one, and the same for a runtime
 * that is not chosen versus one that is chosen but absent.
 */
export function runSetupGaps(setup: RunSetup): RunSetupGap[] {
  const gaps: RunSetupGap[] = [];
  if (!setup.activeModel.trim()) gaps.push("model");
  else if (setup.modelIncomplete) gaps.push("modelShards");
  if (!setup.activeBackend.trim() || !setup.activeBuild.trim()) gaps.push("runtime");
  else if (setup.runtimeInstalled === false) gaps.push("runtimeMissing");
  return gaps;
}

export function runSetupGapMessage(gap: RunSetupGap, locale: Locale): string {
  const copy = executionText[locale];
  switch (gap) {
    case "model": return copy.needModel;
    case "modelShards": return copy.needModelParts;
    case "runtime": return copy.needRuntime;
    default: return copy.runtimeMissing;
  }
}
