import type * as api from "../../shared/api/types";
import { modelDisplayName } from "../../shared/lib/displayPaths";

export type RuntimeReferenceKind = "default" | "profile" | "session" | "model";
export interface RuntimeReference {
  kind: RuntimeReferenceKind;
  /** Empty for the default execution, which has no name of its own. */
  name: string;
}

type RuntimeSettings = { active_backend?: string; active_build?: string } | undefined;

function names(settings: RuntimeSettings, backend: string, build: string): boolean {
  return !!settings && settings.active_backend === backend && settings.active_build === build;
}

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
  if (!cfg || !backend || !build) return [];
  const found: RuntimeReference[] = [];
  if (cfg.active_backend === backend && cfg.active_build === build) found.push({ kind: "default", name: "" });
  for (const entry of cfg.settings_profiles?.entries ?? []) {
    if (names(entry.settings, backend, build)) found.push({ kind: "profile", name: entry.name });
  }
  const sessionNames = new Map((cfg.sessions ?? []).map(item => [item.id, item.name || item.id]));
  for (const definition of cfg.sessions ?? []) {
    if (names(definition.execution, backend, build)) found.push({ kind: "session", name: sessionNames.get(definition.id) ?? definition.id });
  }
  for (const [target, application] of Object.entries(cfg.settings_profiles?.applied ?? {})) {
    if (!names(application.settings, backend, build)) continue;
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
  return found.filter((item, index) => found.findIndex(other => other.kind === item.kind && other.name === item.name) === index);
}
