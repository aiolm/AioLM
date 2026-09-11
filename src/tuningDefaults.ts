import type { AppConfig } from "./api";
import type { JsonObject } from "./panels/tuningValidation";
import catalog from "./tuningDefaultsCatalog.json";
import { tuningResetValues } from './tuningResetValues';

/** A reset omits overrides, so defaults follow the selected runtime and model. */
export const RUNTIME_DEFAULT_KEYS = catalog.map((field) => field.key);
export const REQUEST_DEFAULT_KEYS = ["temperature", "top_p", "top_k", "reasoning_effort"];
export const usesRuntimeDefault = (cfg: Pick<AppConfig, "runtime_defaults">, key: string) => cfg.runtime_defaults?.includes(key) ?? false;

const chatAliases: Record<string, string[]> = {
  mirostat_lr: ["mirostat_lr", "mirostat_eta"], mirostat_ent: ["mirostat_ent", "mirostat_tau"],
  temperature: ["temperature", "temp"], typical_p: ["typical_p", "typ_p"],
  samplers: ["samplers", "sampling_seq"], max_tokens: ["max_tokens", "max_completion_tokens", "n_predict"],
  n_probs: ["n_probs", "logprobs", "top_logprobs"],
};
const cliAliases: Record<string, string[]> = {
  top_n_sigma: ['--top-nsigma', '--top-n-sigma'], dynatemp_exponent: ['--dynatemp-exp'],
  typical_p: ["--typical", "--typical-p"], samplers: ["--samplers", "--sampler-seq", "--sampling-seq"],
  seed: ["--seed", "-s"], n_probs: ["--probs"],
  max_tokens: ["--predict", "--n-predict", "-n"],
  repeat_last_n: ["--repeat-last-n"], repeat_penalty: ["--repeat-penalty"],
};

export function serverAliasesForRequest(key: string): readonly string[] {
  return catalog.find(field => field.key === key)?.args ?? cliAliases[key] ?? [`--${key.replace(/_/g, '-')}`];
}

export function removeArgs(args: readonly string[], names: readonly string[], isSwitch = false): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!names.includes(token.split("=", 1)[0])) { result.push(token); continue; }
    // Negative numeric values are values, not switches. Unknown option boundaries stay intact.
    if (!isSwitch && !token.includes("=") && i + 1 < args.length && !/^--?[a-zA-Z]/.test(args[i + 1])) i++;
  }
  return result;
}

export function removeChatOverride(options: JsonObject, key: string): JsonObject {
  const next = { ...options };
  for (const name of chatAliases[key] ?? [key]) delete next[name];
  if (key === "reasoning" || key === "reasoning_effort") {
    const kwargs = next.chat_template_kwargs;
    if (kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)) {
      const remaining = { ...kwargs };
      if (key === "reasoning") delete remaining.enable_thinking;
      else delete remaining.reasoning_effort;
      if (Object.keys(remaining).length) next.chat_template_kwargs = remaining;
      else delete next.chat_template_kwargs;
    }
  }
  return next;
}

export function canonicalResetKey(key: string): string {
  if (key.startsWith('raw-server:')) return catalog.find(field => field.args.includes(key.slice(11)))?.key ?? key;
  if (key.startsWith('raw-chat:')) {
    const name = key.slice(9);
    return Object.entries(chatAliases).find(([, aliases]) => aliases.includes(name))?.[0] ?? name;
  }
  return key;
}

export function resetTuningField(cfg: AppConfig, key: string, values = tuningResetValues()): Partial<AppConfig> {
  key = canonicalResetKey(key);
  if (key.startsWith("raw-server:")) return { runtime_defaults: [...(cfg.runtime_defaults ?? [])], server_args: removeArgs(cfg.server_args, [key.slice(11)]) };
  if (key.startsWith("raw-chat:")) return { runtime_defaults: [...(cfg.runtime_defaults ?? [])], chat_options: removeChatOverride(cfg.chat_options, key.slice(9)) };
  const field = catalog.find((entry) => entry.key === key);
  const names = field?.args ?? cliAliases[key] ?? [`--${key.replace(/_/g, "-")}`];
  return {
    ...(field ? { [key]: values[key as keyof AppConfig] } : {}),
    runtime_defaults: field ? [...new Set([...(cfg.runtime_defaults ?? []), key])] : [...(cfg.runtime_defaults ?? [])],
    server_args: removeArgs(cfg.server_args, names, field?.switch),
    chat_options: removeChatOverride(cfg.chat_options, key),
  };
}

export function hasChatOverride(cfg: AppConfig, key: string): boolean {
  const names = chatAliases[key] ?? [key];
  const flags = serverAliasesForRequest(key);
  return names.some((name) => cfg.chat_options[name] !== undefined)
    || cfg.server_args.some((arg) => flags.includes(arg.split("=", 1)[0]));
}

export function resetAllTuning(values = tuningResetValues()): Partial<AppConfig> {
  // Paths, adapters, GPU placement, runtime, sessions and saved profiles are not tuning values.
  return { ...values, runtime_defaults: [...RUNTIME_DEFAULT_KEYS], server_args: [], chat_options: {} };
}

/** Explicit edits opt back into an override. Run against the latest queued config. */
export function withManualOverrides(cfg: AppConfig, patch: Partial<AppConfig>): Partial<AppConfig> {
  if (patch.runtime_defaults !== undefined) return patch;
  const next = { ...patch };
  const explicitRaw = new Set<string>();
  // Raw sampling edits must not be silently masked by a previously reset field.
  for (const key of ["temperature", "top_p", "top_k", "reasoning_effort"] as const) {
    let value: unknown;
    if (patch.server_args) {
      const aliases = catalog.find((field) => field.key === key)?.args ?? [];
      for (let i = 0; i < patch.server_args.length; i++) {
        const token = patch.server_args[i];
        if (!aliases.includes(token.split("=", 1)[0])) continue;
        explicitRaw.add(key);
        const raw = token.includes("=") ? token.slice(token.indexOf("=") + 1) : patch.server_args[i + 1];
        value = key === "reasoning_effort" ? raw : Number(raw);
      }
    }
    for (const alias of chatAliases[key] ?? [key]) {
      if (patch.chat_options?.[alias] === undefined) continue;
      value = patch.chat_options[alias]; explicitRaw.add(key); break;
    }
    if (!(key in patch)) {
      if (key === "reasoning_effort" && typeof value === "string") next.reasoning_effort = value;
      else if (key !== "reasoning_effort" && typeof value === "number" && Number.isFinite(value)) next[key] = value;
    }
  }
  const defaults = (cfg.runtime_defaults ?? []).filter((key) => !(key in next) && !explicitRaw.has(key));
  return { ...next, runtime_defaults: defaults };
}
