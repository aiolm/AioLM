import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import DiagnosticDetails, {
  DIAGNOSTIC_SUMMARY_MAX_LENGTH,
  isLongDiagnostic,
  summarizeDiagnostic,
} from "./DiagnosticDetails";
import { diagnosticDetailsCopy } from "../i18n/diagnosticDetailsCopy";
import type { Locale } from "../i18n/i18nCatalog";
import { I18nProvider } from "../i18n/i18n";

const FIRST_LINE =
  "server exited before ready (1). error while handling argument --chat-template-file: failed to open file [synthetic D15 missing path]";

function longDiagnostic(): string {
  const templates = Array.from(
    { length: 24 },
    (_, index) => `  synthetic-template-${String(index).padStart(2, "0")} (synthetic chatml variant ${index})`,
  ).join("\n");
  return [
    FIRST_LINE,
    "usage: synthetic-engine [options] --chat-template-file PATH",
    "available chat templates:",
    templates,
    "한글 진단 메시지: 합성 템플릿을 찾을 수 없습니다",
    "日本語の診断: 合成テンプレートが見つかりません",
    "中文诊断: 找不到合成模板",
    `token:${"x".repeat(500)}`,
    "😀 emoji tail",
  ].join("\n");
}

function renderWithI18n(ui: React.ReactElement, locale: Locale = "en") {
  return render(<I18nProvider initialLocale={locale}>{ui}</I18nProvider>);
}

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

function feedbackOf(container: HTMLElement): string | null | undefined {
  return container.querySelector('[role="status"].app-diagnostic-feedback')?.textContent;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("DiagnosticDetails", () => {
  it("shows a concise summary while keeping the full diagnostic collapsed", () => {
    const full = longDiagnostic();
    const { container } = renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />);
    expect(screen.getByText(FIRST_LINE)).toBeInTheDocument();
    const details = container.querySelector("details.app-diagnostic-disclosure");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText(diagnosticDetailsCopy.en.showDetails)).toBeInTheDocument();
    // Full text is preserved in the disclosure even while collapsed.
    const pre = container.querySelector("pre.app-diagnostic-full");
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toBe(full);
  });

  it("reveals the preserved full diagnostic when toggled", () => {
    const full = longDiagnostic();
    const { container } = renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />);
    fireEvent.click(screen.getByText(diagnosticDetailsCopy.en.showDetails));
    expect(container.querySelector("details.app-diagnostic-disclosure")).toHaveAttribute("open");
    expect(container.querySelector("pre.app-diagnostic-full")?.textContent).toBe(full);
  });

  it("copies the full original diagnostic with success feedback", async () => {
    const full = longDiagnostic();
    const writeText = vi.fn(async (_text: string) => undefined);
    mockClipboard(writeText);
    const { container } = renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />);
    fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toBe(full);
    await waitFor(() => expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copied));
  });

  it("shows failure feedback when copying fails without logging the diagnostic", async () => {
    const full = longDiagnostic();
    mockClipboard(vi.fn(async (_text: string) => {
      throw new Error("synthetic clipboard denial");
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />);
      fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copy }));
      expect(await screen.findByText(diagnosticDetailsCopy.en.copyFailed)).toBeInTheDocument();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("copies original bytes exactly when display normalization applies", async () => {
    const raw = [
      "synthetic summary line",
      "second \x1b[31mred\x1b[0m line",
      "verbatim synthetic: \\\\?\\C:\\synthetic\\missing.jinja",
      "trailing synthetic line",
    ].join("\n");
    const writeText = vi.fn(async (_text: string) => undefined);
    mockClipboard(writeText);
    const { container } = renderWithI18n(<DiagnosticDetails summary="synthetic summary line" detail={raw} />);
    fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toBe(raw);
    // Display may normalize ANSI escapes and verbatim prefixes; the clipboard must not.
    const displayed = container.querySelector("pre.app-diagnostic-full")?.textContent ?? "";
    expect(displayed).not.toContain("\x1b[");
    expect(displayed).not.toContain("\\\\?\\");
    expect(displayed).toContain("C:\\synthetic\\missing.jinja");
    await waitFor(() => expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copied));
  });

  it("keeps a later copy failure visible past the earlier success timer", async () => {
    vi.useFakeTimers();
    try {
      const full = longDiagnostic();
      const writeText = vi.fn(async (_text: string) => undefined);
      mockClipboard(writeText);
      const { container } = renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />);
      fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copy }));
      await act(async () => undefined);
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copied);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      writeText.mockRejectedValueOnce(new Error("synthetic clipboard denial"));
      fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copied }));
      await act(async () => undefined);
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copyFailed);
      // Advancing past the first success timer must not erase the failure.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copyFailed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a pending copy that resolves after the diagnostic changes", async () => {
    const first = longDiagnostic();
    const second = `${first}\nreplacement synthetic line`;
    const gate = deferred<void>();
    mockClipboard(vi.fn(() => gate.promise));
    const { container, rerender } = renderWithI18n(
      <DiagnosticDetails summary={summarizeDiagnostic(first)} detail={first} />,
    );
    fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copy }));
    rerender(
      <I18nProvider initialLocale="en">
        <DiagnosticDetails summary={summarizeDiagnostic(second)} detail={second} />
      </I18nProvider>,
    );
    await act(async () => {
      gate.resolve();
    });
    await act(async () => undefined);
    // Stale success for the replaced diagnostic must never appear.
    expect(feedbackOf(container)).toBe("");
  });

  it("lets the latest copy attempt win over an earlier pending one", async () => {
    const full = longDiagnostic();
    const first = deferred<void>();
    let calls = 0;
    mockClipboard(vi.fn(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.reject(new Error("synthetic denial"));
    }));
    const { container } = renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />);
    const copyButton = () => screen.getByRole("button", { name: /Copy|Copied/ });
    fireEvent.click(copyButton());
    fireEvent.click(copyButton());
    await act(async () => undefined);
    expect(calls).toBe(2);
    expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copyFailed);
    await act(async () => {
      first.resolve();
    });
    await act(async () => undefined);
    expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copyFailed);
  });

  it("does not update feedback after unmount", async () => {
    const full = longDiagnostic();
    const gate = deferred<void>();
    mockClipboard(vi.fn(() => gate.promise));
    const { container, unmount } = renderWithI18n(
      <DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />,
    );
    fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copy }));
    unmount();
    await act(async () => {
      gate.resolve();
    });
    await act(async () => undefined);
    expect(container.querySelector(".app-diagnostic-details")).toBeNull();
  });

  it("exposes unique disclosure ids across instances", () => {
    const full = longDiagnostic();
    const { container } = renderWithI18n(
      <>
        <DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} id="task-first" />
        <DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} id="task-second" />
      </>,
    );
    const ids = [...container.querySelectorAll("details.app-diagnostic-disclosure")].map((element) => element.id);
    expect(ids).toEqual(["task-first-diagnostic", "task-second-diagnostic"]);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps copy feedback working under StrictMode remount semantics", async () => {
    const full = longDiagnostic();
    const writeText = vi.fn(async (_text: string) => undefined);
    mockClipboard(writeText);
    const { container } = render(
      <StrictMode>
        <I18nProvider initialLocale="en">
          <DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />
        </I18nProvider>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: diagnosticDetailsCopy.en.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toBe(full);
    await waitFor(() => expect(feedbackOf(container)).toBe(diagnosticDetailsCopy.en.copied));
  });

  it("generates unique default ids with resolving descriptions", () => {
    const full = longDiagnostic();
    const { container } = renderWithI18n(
      <>
        <DiagnosticDetails summary="first synthetic summary" detail={full} />
        <DiagnosticDetails summary="second synthetic summary" detail={full} />
      </>,
    );
    const disclosures = [...container.querySelectorAll("details.app-diagnostic-disclosure")];
    expect(disclosures).toHaveLength(2);
    const ids = disclosures.map((element) => element.id);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    for (const disclosure of disclosures) {
      const describedBy = disclosure.querySelector("button")?.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(container.ownerDocument.getElementById(describedBy ?? "")).not.toBeNull();
    }
  });

  it("keeps multiline unicode and long unbroken text selectable in a bounded scroll region", () => {
    const full = longDiagnostic();
    const { container } = renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />);
    const pre = container.querySelector("pre.app-diagnostic-full");
    expect(pre).toHaveAttribute("tabindex", "0");
    expect(pre?.textContent).toContain("한글 진단 메시지");
    expect(pre?.textContent).toContain("日本語の診断");
    expect(pre?.textContent).toContain("中文诊断");
    expect(pre?.textContent).toContain(`token:${"x".repeat(500)}`);
    expect(pre?.textContent).toContain("😀 emoji tail");
  });

  it.each<[Locale, string, string]>([
    ["en", diagnosticDetailsCopy.en.showDetails, diagnosticDetailsCopy.en.copy],
    ["ko", diagnosticDetailsCopy.ko.showDetails, diagnosticDetailsCopy.ko.copy],
    ["ja", diagnosticDetailsCopy.ja.showDetails, diagnosticDetailsCopy.ja.copy],
    ["zh", diagnosticDetailsCopy.zh.showDetails, diagnosticDetailsCopy.zh.copy],
  ])("labels the toggle and copy action in %s", (locale, showDetails, copyLabel) => {
    const full = longDiagnostic();
    const { unmount } = renderWithI18n(<DiagnosticDetails summary={summarizeDiagnostic(full)} detail={full} />, locale);
    expect(screen.getByText(showDetails)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copyLabel })).toBeInTheDocument();
    unmount();
  });
});

describe("diagnostic summarization", () => {
  it("treats short single-line feedback as inline", () => {
    expect(isLongDiagnostic("Model loaded.")).toBe(false);
    expect(isLongDiagnostic("disk full")).toBe(false);
  });

  it("collapses multiline engine output and very long single lines", () => {
    expect(isLongDiagnostic(longDiagnostic())).toBe(true);
    expect(isLongDiagnostic(`token:${"x".repeat(500)}`)).toBe(true);
  });

  it("summarizes to the first actionable line without shortening stored detail", () => {
    const full = longDiagnostic();
    expect(summarizeDiagnostic(full)).toBe(FIRST_LINE);
    expect(full).toContain("synthetic-template-23");
  });

  it("truncates only the displayed summary when the first line itself is huge", () => {
    const huge = `${"y".repeat(400)}\nsecond line`;
    const summary = summarizeDiagnostic(huge);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.length).toBeLessThan(huge.length);
    expect(huge.length).toBeGreaterThan(400);
  });

  it("truncates by code points so emoji at the boundary stays intact", () => {
    const boundary = `${"a".repeat(DIAGNOSTIC_SUMMARY_MAX_LENGTH - 1)}😀${"b".repeat(50)}`;
    const summary = summarizeDiagnostic(boundary);
    expect(summary).toContain("😀");
    expect(summary).not.toContain("�");
    expect(Array.from(summary).length).toBeLessThanOrEqual(DIAGNOSTIC_SUMMARY_MAX_LENGTH + 1);
    expect(boundary).toContain("😀");
  });
});
