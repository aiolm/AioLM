import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { defaultPreferences } from "../../shared/config/preferences";
import SettingsPanel from "./Settings";
import { createTestStore } from "../../testing/appStore";

vi.mock("../../shared/api/index", () => ({ isNativeRuntimeAvailable: () => true }));

describe("desktop settings", () => {
  it("saves a port explicitly for the next start and preserves the live address", async () => {
    const store = createTestStore({ port: 8080 });
    store.status = { state: "running", url: "http://127.0.0.1:8080" };
    render(<I18nProvider initialLocale="en"><SettingsPanel preferences={defaultPreferences()} update={vi.fn()} reset={vi.fn()} store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Server" }));
    const port = screen.getByRole("spinbutton", { name: "Default server port" });
    fireEvent.change(port, { target: { value: "9090" } }); fireEvent.blur(port);
    expect(store.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(port).toHaveValue(8080);
    fireEvent.change(port, { target: { value: "9091" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith({ port: 9091 }));
    expect(screen.getByText("Current server: http://127.0.0.1:8080")).toBeVisible();
    expect(store.start).not.toHaveBeenCalled(); expect(store.stop).not.toHaveBeenCalled();
    expect(store.cfg?.active_model).toBe("model.gguf");
  });

  it("validates the port range and preserves failed save drafts", async () => {
    const store = createTestStore();
    vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error("Save failed"));
    render(<I18nProvider initialLocale="en"><SettingsPanel preferences={defaultPreferences()} update={vi.fn()} reset={vi.fn()} store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Server" }));
    const port = screen.getByRole("spinbutton", { name: "Default server port" });
    for (const value of ["0", "65536", "1.5", ""]) {
      fireEvent.change(port, { target: { value } });
      expect(port).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    }
    fireEvent.change(port, { target: { value: "9090" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(port).toHaveValue(9090);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(store.cfg?.port).toBe(8080);
  });

  it("detects a changed port without overwriting it and lets Cancel reload", async () => {
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><SettingsPanel preferences={defaultPreferences()} update={vi.fn()} reset={vi.fn()} store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Server" }));
    const port = screen.getByRole("spinbutton", { name: "Default server port" });
    fireEvent.change(port, { target: { value: "9090" } });
    store.cfg!.port = 8090;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The port changed elsewhere");
    expect(store.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(port).toHaveValue(8090);
  });

  it("explains mandatory exit cleanup instead of offering a nonfunctional toggle", () => {
    const update = vi.fn();
    render(<I18nProvider initialLocale="en"><SettingsPanel preferences={defaultPreferences()} update={update} reset={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Server" }));
    expect(screen.queryByRole("switch", { name: "Stop server on app exit" })).not.toBeInTheDocument();
    expect(screen.getByText("Managed processes stop on exit")).toBeInTheDocument();
    expect(screen.getByText(/Switching tabs does not stop them/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("hides Windows path prefixes in settings import failures", async () => {
    const update = vi.fn();
    const { container } = render(<I18nProvider initialLocale="en"><SettingsPanel preferences={defaultPreferences()} update={update} reset={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    const file = new File(["{}"], "settings.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: vi.fn().mockRejectedValue(new Error(String.raw`Cannot read \\?\UNC\server\settings.json`)) });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(String.raw`Cannot read \\server\settings.json`);
    expect(screen.getByRole("alert")).not.toHaveTextContent(String.raw`\\?\UNC`);
    expect(update).not.toHaveBeenCalled();
  });
});
