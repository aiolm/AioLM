import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { defaultPreferences } from "../../shared/config/preferences";
import SettingsPanel from "./Settings";

vi.mock("../../shared/api/index", () => ({ isNativeRuntimeAvailable: () => true }));

describe("desktop settings", () => {
  it("explains mandatory exit cleanup instead of offering a nonfunctional toggle", () => {
    const update = vi.fn();
    render(<I18nProvider initialLocale="en"><SettingsPanel preferences={defaultPreferences()} update={update} reset={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Server" }));
    expect(screen.queryByRole("switch", { name: "Stop server on app exit" })).not.toBeInTheDocument();
    expect(screen.getByText("Managed processes stop on exit")).toBeInTheDocument();
    expect(screen.getByText(/Switching tabs does not stop them/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});
