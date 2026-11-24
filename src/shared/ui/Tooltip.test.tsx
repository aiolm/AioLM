import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import Tooltip from "./Tooltip";

afterEach(() => {
  cleanup();
});

describe("Tooltip", () => {
  it("stays hidden without top-left inline coordinates until opened, then positions at the trigger", () => {
    const innerWidthDesc = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const innerHeightDesc = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

    try {
      render(
        <I18nProvider initialLocale="en">
          <Tooltip label="Help label" content="Detailed help text" />
        </I18nProvider>,
      );

      const trigger = screen.getByRole("button", { name: "Help label" });
      const wrapper = trigger.closest("[data-tooltip]")!;
      const tooltip = screen.getByRole("tooltip");

      expect(tooltip).not.toHaveClass("is-open");
      expect(tooltip.style.left).toBe("");
      expect(tooltip.style.top).toBe("");

      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        x: 500,
        y: 200,
        left: 500,
        right: 528,
        top: 200,
        bottom: 228,
        width: 28,
        height: 28,
        toJSON: () => ({}),
      });

      fireEvent.mouseEnter(wrapper);
      expect(tooltip).toHaveClass("is-open");
      expect(tooltip.style.left).toBe("500px");
      expect(tooltip.style.top).toBe("235px");
      expect(tooltip.style.width).toBe("260px");

      fireEvent.mouseLeave(wrapper);
      expect(tooltip).not.toHaveClass("is-open");
    } finally {
      if (innerWidthDesc) Object.defineProperty(window, "innerWidth", innerWidthDesc);
      if (innerHeightDesc) Object.defineProperty(window, "innerHeight", innerHeightDesc);
    }
  });
});
