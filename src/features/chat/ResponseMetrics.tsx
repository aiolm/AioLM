import { intlLocales, type Locale } from "../../shared/i18n/i18nCatalog";
import { translate } from "../../shared/i18n/i18nUnified";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import type { ResponseMetrics as ResponseMetricsData } from "../../shared/lib/metrics";

interface ResponseMetricsProps {
  metrics: ResponseMetricsData;
  locale: Locale;
}

const numberFormats = new Map<string, Intl.NumberFormat>();

function formatMetric(value: number | undefined, locale: Locale, decimals: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  const key = `${locale}:${decimals}`;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(intlLocales[locale], { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    numberFormats.set(key, formatter);
  }
  return formatter.format(value);
}

export default function ResponseMetrics({ metrics, locale }: ResponseMetricsProps) {
  const text = (key: ChatTextKey) => translate(locale, `chat.${key}`);
  const seconds = (durationMs?: number) => formatMetric(durationMs === undefined ? undefined : durationMs / 1000, locale, 2);
  return (
    <div className="chat-response-metrics" role="group" aria-label={text("metricsLabel")}>
      <dl className="chat-response-metrics-stages">
        {(["pp", "tg"] as const).map((stage) => {
          const label = text(stage === "pp" ? "metricsPrefill" : "metricsGeneration");
          const values = metrics[stage];
          return (
            <div className="chat-response-metrics-row" key={stage}>
              <dt title={label}><span aria-hidden="true">{stage.toUpperCase()}</span><span className="sr-only">{label}</span></dt>
              <dd>
                <span><span className="sr-only">{text("metricsTokens")}: </span>{formatMetric(values.tokens, locale, 0)} tok</span>
                <span><span aria-hidden="true">· </span><span className="sr-only">{text("metricsDuration")}: </span>{seconds(values.durationMs)} s</span>
                <span><span aria-hidden="true">· </span><span className="sr-only">{text("metricsThroughput")}: </span>{formatMetric(values.tokensPerSecond, locale, 1)} tok/s</span>
              </dd>
            </div>
          );
        })}
      </dl>
      <details className="chat-response-metrics-details">
        <summary>{text("metricsDetails")}</summary>
        <dl>
          <div><dt>{text("metricsFirstToken")}</dt><dd>{seconds(metrics.firstTokenMs)} s</dd></div>
          <div><dt>{text("metricsPreparation")}</dt><dd>{seconds(metrics.preparationMs)} s</dd></div>
          <div><dt>{text("metricsRequest")}</dt><dd>{seconds(metrics.requestMs)} s</dd></div>
          <div><dt>{text("metricsCachedTokens")}</dt><dd>{formatMetric(metrics.cachedTokens, locale, 0)} tok</dd></div>
        </dl>
      </details>
    </div>
  );
}
