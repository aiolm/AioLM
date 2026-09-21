import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FeedbackBanner, { type FeedbackTone } from "./FeedbackBanner";
import { I18nProvider } from "../i18n/i18n";

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider initialLocale="en">{ui}</I18nProvider>);
}

describe("FeedbackBanner", () => {
  it.each<[FeedbackTone, string, string, string]>([
    ["info", "status", "polite", "app-feedback--info"],
    ["success", "status", "polite", "app-feedback--success"],
    ["warning", "status", "polite", "app-feedback--warning"],
    ["error", "alert", "assertive", "app-feedback--error"],
  ])("renders tone %s with role=%s, aria-live=%s and class %s", (tone, role, ariaLive, expectedClass) => {
    renderWithI18n(<FeedbackBanner tone={tone}>Message for {tone}</FeedbackBanner>);
    const banner = screen.getByRole(role);
    expect(banner).toHaveAttribute("aria-live", ariaLive);
    expect(banner).toHaveAttribute("aria-atomic", "true");
    expect(banner).toHaveClass("app-feedback", expectedClass);
    expect(banner).toHaveTextContent(`Message for ${tone}`);
  });

  it("renders a decorative SVG tone icon for every tone", () => {
    const tones: FeedbackTone[] = ["info", "success", "warning", "error"];
    for (const tone of tones) {
      const { unmount } = renderWithI18n(<FeedbackBanner tone={tone}>Test {tone}</FeedbackBanner>);
      const iconWrapper = document.querySelector(".app-feedback-icon");
      expect(iconWrapper).toBeInTheDocument();
      expect(iconWrapper).toHaveAttribute("aria-hidden", "true");

      const svg = iconWrapper?.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
      expect(svg).toHaveAttribute("viewBox", "0 0 20 20");
      unmount();
    }
  });

  it("renders title and normalizes verbatim paths in title and children", () => {
    const rawPath = String.raw`\\?\C:\models\test.gguf`;
    const rawSub = String.raw`\\?\C:\models\subfolder`;
    renderWithI18n(
      <FeedbackBanner tone="info" title={rawPath}>
        Path is {rawSub}
      </FeedbackBanner>
    );
    expect(screen.getByText(String.raw`C:\models\test.gguf`)).toBeInTheDocument();
    expect(screen.getByText(String.raw`Path is C:\models\subfolder`)).toBeInTheDocument();
  });

  it("executes action callback when clicked", () => {
    const handleClick = vi.fn();
    renderWithI18n(
      <FeedbackBanner tone="warning" action={{ label: "Retry Now", onClick: handleClick }}>
        Something went wrong
      </FeedbackBanner>
    );
    const actionBtn = screen.getByRole("button", { name: "Retry Now" });
    expect(actionBtn).toHaveClass("app-feedback-action");
    fireEvent.click(actionBtn);
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it("renders dismiss button and executes onDismiss callback", () => {
    const handleDismiss = vi.fn();
    renderWithI18n(
      <FeedbackBanner tone="info" onDismiss={handleDismiss}>
        Dismissible notice
      </FeedbackBanner>
    );
    const dismissBtn = screen.getByRole("button", { name: "Dismiss" });
    expect(dismissBtn).toHaveClass("app-feedback-dismiss");
    fireEvent.click(dismissBtn);
    expect(handleDismiss).toHaveBeenCalledOnce();
  });

  it("preserves custom className", () => {
    renderWithI18n(
      <FeedbackBanner tone="info" className="custom-test-class">
        Custom class banner
      </FeedbackBanner>
    );
    expect(screen.getByRole("status")).toHaveClass("app-feedback", "app-feedback--info", "custom-test-class");
  });
});
