import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { chatText } from "../../shared/i18n/chatI18n";
import type { ResponseMetrics as ResponseMetricsData } from "../../shared/lib/metrics";
import MessageBubble from "./MessageBubble";
import ResponseMetrics from "./ResponseMetrics";

const metrics: ResponseMetricsData = {
  pp: { tokens: 1536, durationMs: 800, tokensPerSecond: 1920 },
  tg: { tokens: 256, durationMs: 4000, tokensPerSecond: 64 },
  firstTokenMs: 825,
  preparationMs: 250,
  requestMs: 4900,
  cachedTokens: 1024,
};

const bubbleProps = {
  index: 0, messageCount: 1, phase: "idle" as const, copied: false, compact: false, locale: "en" as const,
  onCopy: () => undefined,
};

describe("response metrics", () => {
  it("keeps both processing stages visible with token totals, stage seconds and throughput", () => {
    render(<ResponseMetrics metrics={metrics} locale="en" />);
    const panel = screen.getByRole("group", { name: "Response metrics" });
    expect(within(panel).getByText("PP")).toBeVisible();
    expect(within(panel).getByText("TG")).toBeVisible();
    for (const value of ["1,536 tok", "0.80 s", "1,920.0 tok/s", "256 tok", "4.00 s", "64.0 tok/s"]) {
      expect(within(panel).getByText(value)).toBeVisible();
    }
    expect(within(panel).getByText(chatText.en.metricsPrefill)).toBeInTheDocument();
    expect(within(panel).getByText(chatText.en.metricsGeneration)).toBeInTheDocument();
    expect(panel.querySelector('[role="status"], [aria-live="polite"], [aria-live="assertive"]')).toBeNull();
  });

  it("shows missing values as unknown and preserves measured zero values", () => {
    render(<ResponseMetrics metrics={{ pp: {}, tg: { tokens: 0, durationMs: 0, tokensPerSecond: 0 } }} locale="en" />);
    for (const value of ["— tok", "— s", "— tok/s", "0 tok", "0.00 s", "0.0 tok/s"]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });

  it("shows first-token, preparation, request and cache measurements without anything to open", () => {
    render(<ResponseMetrics metrics={metrics} locale="en" />);
    const panel = screen.getByRole("group", { name: "Response metrics" });
    expect(panel.querySelector("details")).toBeNull();
    expect(within(panel).getByText("Time to first token (TTFT)")).toBeVisible();
    for (const value of ["0.83 s", "0.25 s", "4.90 s", "1,024 tok"]) {
      expect(within(panel).getByText(value)).toBeVisible();
    }
  });

  it.each(["ko", "ja", "zh"] as const)("localizes metric explanations and detail labels in %s", (locale) => {
    render(<ResponseMetrics metrics={metrics} locale={locale} />);
    expect(screen.getByRole("group", { name: chatText[locale].metricsLabel })).toBeInTheDocument();
    expect(screen.getByText(chatText[locale].metricsPrefill)).toBeInTheDocument();
    expect(screen.getByText(chatText[locale].metricsGeneration)).toBeInTheDocument();
    for (const key of ["metricsFirstToken", "metricsPreparation", "metricsRequest", "metricsCachedTokens"] as const) {
      expect(screen.getByText(chatText[locale][key])).toBeVisible();
    }
  });

  it("leaves legacy responses and user messages without a metrics panel", () => {
    const { rerender } = render(<MessageBubble {...bubbleProps} message={{ role: "assistant", content: "An earlier answer" }} />);
    expect(screen.queryByRole("group", { name: "Response metrics" })).not.toBeInTheDocument();
    rerender(<MessageBubble {...bubbleProps} message={{ role: "user", content: "A question", metrics }} />);
    expect(screen.queryByRole("group", { name: "Response metrics" })).not.toBeInTheDocument();
  });

  it.each(["", "Considering a tool call"])("keeps metrics attached when an assistant has no answer text and reasoning is %j", (reasoning) => {
    render(<MessageBubble {...bubbleProps} message={{ role: "assistant", content: "", reasoning, metrics }} />);
    expect(screen.getByRole("group", { name: "Response metrics" })).toBeVisible();
    expect(screen.getByText("64.0 tok/s")).toBeVisible();
  });
});
