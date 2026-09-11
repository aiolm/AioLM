import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigratedPath } from "../shared/storage/storageMigration";

const migratedPaths: MigratedPath[] = [{ from: "C:/test/old-data", to: "C:/test/new-data" }];
const migrate = vi.fn<(paths: MigratedPath[]) => Promise<void>>();
const invoke = vi.fn<(command: string) => Promise<MigratedPath[]>>();
const moduleLoaded = vi.fn<(name: string) => void>();
const appRendered = vi.fn();
const loadPreferences = vi.fn();
const applyTheme = vi.fn();
const loadFont = vi.fn();

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
let originalHtmlAttributes: Array<[string, string | null]>;

beforeEach(() => {
  // Fresh mock factories make eager imports observable on every bootstrap attempt.
  vi.resetModules();
  for (const mock of [migrate, invoke, moduleLoaded, appRendered, loadPreferences, applyTheme, loadFont]) mock.mockReset();
  invoke.mockResolvedValue(migratedPaths);
  loadFont.mockResolvedValue([]);
  loadPreferences.mockReturnValue({
    locale: "ko", theme: "dark", appearance: { density: "compact", reduceMotion: true },
  });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: loadFont } });
  originalHtmlAttributes = ["lang", "data-density", "class"].map(name => [name, document.documentElement.getAttribute(name)]);

  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  vi.doMock("../shared/storage/storageMigration", () => ({ migrateBrowserStorage: migrate }));
  vi.doMock("../shared/ui/InitialSurface", () => ({
    default: ({ children }: { children: ReactNode }) => children,
    SurfaceLoading: () => <div role="status">Starting application</div>,
  }));
  vi.doMock("./App", () => {
    moduleLoaded("app");
    return { default: () => { appRendered(); return <main>Application ready</main>; } };
  });
  vi.doMock("../shared/ui/ErrorBoundary", () => ({
    default: ({ children }: { children: ReactNode }) => children,
  }));
  vi.doMock("../shared/i18n/i18n", () => {
    moduleLoaded("i18n");
    return { I18nProvider: ({ children, initialLocale }: { children: ReactNode; initialLocale: string }) => <div lang={initialLocale}>{children}</div> };
  });
  vi.doMock("../shared/config/preferences", () => {
    moduleLoaded("preferences");
    return { loadPreferences };
  });
  vi.doMock("../shared/config/theme", () => ({ applyTheme }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  for (const [name, value] of originalHtmlAttributes) {
    if (value === null) document.documentElement.removeAttribute(name);
    else document.documentElement.setAttribute(name, value);
  }
});

async function renderBootstrap() {
  const { default: Bootstrap } = await import("./Bootstrap");
  return render(<Bootstrap />);
}

function expectApplicationDeferred() {
  expect(moduleLoaded).not.toHaveBeenCalled();
  expect(loadPreferences).not.toHaveBeenCalled();
  expect(appRendered).not.toHaveBeenCalled();
  expect(applyTheme).not.toHaveBeenCalled();
  expect(screen.queryByRole("main")).not.toBeInTheDocument();
}

describe("Bootstrap migration boundary", () => {
  it("waits for migration before importing application modules or reading preferences", async () => {
    const migration = deferred();
    migrate.mockReturnValueOnce(migration.promise);
    await renderBootstrap();
    await waitFor(() => expect(migrate).toHaveBeenCalledWith(migratedPaths));

    expect(invoke).toHaveBeenCalledWith("migration_paths");
    expect(screen.getByRole("status")).toHaveTextContent("Starting application");
    expectApplicationDeferred();
    expect(loadFont).not.toHaveBeenCalled();

    await act(async () => migration.resolve());
    expect(await screen.findByRole("main")).toHaveTextContent("Application ready");
    expect(moduleLoaded.mock.calls.map(([name]) => name).sort()).toEqual(["app", "i18n", "preferences"]);
    expect(loadPreferences).toHaveBeenCalledTimes(1);
    expect(loadFont).toHaveBeenCalledWith('14px "Pretendard Variable"');
    expect(applyTheme).toHaveBeenCalledWith("dark");
    expect(document.documentElement).toHaveAttribute("lang", "ko");
    expect(document.documentElement).toHaveAttribute("data-density", "compact");
    expect(document.documentElement).toHaveClass("app-reduce-motion");
  });

  it("keeps application data unread after migration fails and mounts after a successful retry", async () => {
    const failedMigration = deferred();
    const retriedMigration = deferred();
    migrate.mockReturnValueOnce(failedMigration.promise).mockReturnValueOnce(retriedMigration.promise);
    await renderBootstrap();
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1));
    await act(async () => failedMigration.reject(new Error("Migration test failure")));

    expect(await screen.findByRole("alert")).toHaveTextContent("Migration test failure");
    expect(screen.getByRole("heading", { name: "Your data could not be migrated" })).toBeInTheDocument();
    expectApplicationDeferred();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(2));
    expect(migrate).toHaveBeenLastCalledWith(migratedPaths);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Starting application");
    expectApplicationDeferred();

    await act(async () => retriedMigration.resolve());
    expect(await screen.findByRole("main")).toHaveTextContent("Application ready");
    expect(moduleLoaded.mock.calls.map(([name]) => name).sort()).toEqual(["app", "i18n", "preferences"]);
    expect(loadPreferences).toHaveBeenCalledTimes(1);
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
