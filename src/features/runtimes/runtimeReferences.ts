import type * as api from "../../shared/api/types";
import { modelDisplayName } from "../../shared/lib/displayPaths";
import type { ExecutionSettings } from "../../shared/config/executionSettings";
import type { ProviderId } from "../../shared/api/providers";

export type RuntimeReferenceKind = "default" | "profile" | "session" | "model";
export interface RuntimeReference {
  kind: RuntimeReferenceKind;
  /** Empty for the default execution, which has no name of its own. */
  name: string;
}

type RuntimeSettings = Partial<ExecutionSettings> | undefined;

/**
 * Everything a runtime removal would leave without one.
 *
 * Removing a build clears it from every profile that named it rather than
 * repointing them at a surviving build, so the targets listed here stop being
 * launchable until a runtime is chosen again. Naming them before the removal
 * is what makes that a decision instead of a surprise at the next launch.
 *
 * This mirrors what the backend clears, so the four places a runtime is stored
 * are all read: the default execution, saved profiles, session overrides, and
 * the per-target applications.
 */
export function runtimeReferences(cfg: api.AppConfig | null | undefined, backend: string, build: string): RuntimeReference[] {
  return referencesMatching(cfg, settings => !!settings && settings.active_backend === backend && settings.active_build === build, !!backend && !!build);
}

/** Provider removal leaves selections saved but unavailable until reconfigured. */
export function providerRuntimeReferences(cfg: api.AppConfig | null | undefined, provider: ProviderId, runtime: string): RuntimeReference[] {
  return referencesMatching(cfg, (settings, owner) => !!settings && (settings.active_provider ?? owner ?? cfg?.active_provider) === provider && settings.active_runtime === runtime, !!runtime);
}

function referencesMatching(cfg: api.AppConfig | null | undefined, matches: (settings: RuntimeSettings, owner?: ProviderId) => boolean, valid: boolean): RuntimeReference[] {
  if (!cfg || !valid) return [];
  const found: RuntimeReference[] = [];
  if (matches(cfg)) found.push({ kind: "default", name: "" });
  for (const entry of cfg.settings_profiles?.entries ?? []) {
    if (matches(entry.settings, entry.provider)) found.push({ kind: "profile", name: entry.name });
  }
  const sessionNames = new Map((cfg.sessions ?? []).map(item => [item.id, item.name || item.id]));
  for (const definition of cfg.sessions ?? []) {
    if (matches(definition.execution)) found.push({ kind: "session", name: sessionNames.get(definition.id) ?? definition.id });
  }
  for (const [target, application] of Object.entries(cfg.settings_profiles?.applied ?? {})) {
    if (!matches(application.settings, application.provider)) continue;
    if (target.startsWith("session:")) {
      const id = target.slice("session:".length);
      found.push({ kind: "session", name: sessionNames.get(id) ?? id });
    } else {
      const name = modelDisplayName(application.model);
      if (name) found.push({ kind: "model", name });
    }
  }
  // One line per target: a session that carries the runtime in both its own
  // override and its applied profile is still one thing the user loses.
  const seen = new Map<RuntimeReferenceKind, Set<string>>();
  return found.filter(item => {
    let namesForKind = seen.get(item.kind);
    if (!namesForKind) {
      namesForKind = new Set<string>();
      seen.set(item.kind, namesForKind);
    }
    if (namesForKind.has(item.name)) return false;
    namesForKind.add(item.name);
    return true;
  });
}
