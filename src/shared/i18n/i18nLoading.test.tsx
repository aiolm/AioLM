import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.resetModules();
});

it("waits for the initial locale and publishes switched locales only after loading", async () => {
  // The normal setup preloads catalogs for synchronous component tests. This
  // test starts a fresh module graph to exercise a real first locale load.
  vi.resetModules();
  const { I18nProvider, loadLocale, useI18n } = await import("./i18n");
  const onLocaleChange = vi.fn();
  function Content() {
    const { t, setLocale } = useI18n();
    return <><h1>{t("settings.title")}</h1><button onClick={() => setLocale("ja")}>Japanese</button></>;
  }
  await act(async () => {
    render(<I18nProvider initialLocale="ko" onLocaleChange={onLocaleChange}><Content /></I18nProvider>);
    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
    await loadLocale("ko");
  });
  expect(screen.getByRole("heading", { name: "설정" })).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
    expect(screen.getByRole("heading", { name: "설정" })).toBeInTheDocument();
    expect(onLocaleChange).not.toHaveBeenCalled();
    await loadLocale("ja");
  });
  expect(screen.getByRole("heading", { name: "設定" })).toBeInTheDocument();
  expect(onLocaleChange).toHaveBeenCalledExactlyOnceWith("ja");
});
