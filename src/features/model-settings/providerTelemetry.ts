import type { ProviderId } from "../../shared/api/providers";
import type { Locale } from "../../shared/i18n/i18nCatalog";

const flags: Record<string, string> = {
  enable_prompt_tokens_details: "--enable-prompt-tokens-details",
  enable_per_request_metrics: "--enable-per-request-metrics",
};

/** Mirrors capability-based launch defaults without changing saved options. */
export function automaticProviderTelemetry(provider: ProviderId, key: string, runtimeFlags: string[] | undefined, values: Record<string, unknown>): boolean {
  if (provider !== "vllm" || !flags[key] || !runtimeFlags?.includes(flags[key])) return false;
  const rawFlags = Array.isArray(values.extra_args) ? values.extra_args.filter((argument): argument is string => typeof argument === "string")
    .map(argument => argument.trim().split("=", 1)[0].replace(/_/g, "-")) : [];
  // Standard vLLM applies raw BooleanOptionalAction opt-outs after app defaults.
  if (rawFlags.includes(`--no-${flags[key].slice(2)}`)) return false;
  const statsDisabled = rawFlags.includes("--disable-log-stats");
  return key !== "enable_per_request_metrics" || !statsDisabled;
}

export const providerTelemetryCopy: Record<Locale, { automatic: string; hint: string }> = {
  en: { automatic: "Automatic (enabled)", hint: "AioLM enables this measurement automatically. Choose false to disable it." },
  ko: { automatic: "자동 (활성화)", hint: "AioLM이 이 측정값을 자동으로 활성화합니다. 끄려면 false를 선택하세요." },
  ja: { automatic: "自動（有効）", hint: "AioLMがこの測定を自動で有効にします。無効にするにはfalseを選択してください。" },
  zh: { automatic: "自动（启用）", hint: "AioLM会自动启用此测量。选择false可将其关闭。" },
};
