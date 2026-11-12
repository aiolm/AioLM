import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { AppStore } from "../../shared/state/store";
import { I18nProvider } from "../../shared/i18n/i18n";
import DeveloperPanel from "./Developer";

vi.mock("../../shared/api/index", () => ({
  apiServerStatus: vi.fn(async () => ({ running: false, port: 8080 })),
  localModels: vi.fn(),
  startApiServer: vi.fn(),
  stopApiServer: vi.fn(),
  sessionSummaryList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown): unknown[] => Array.isArray(value) ? value : []),
}));

const store = {
  cfg: null,
  status: { state: "stopped" },
  start: async () => "",
} as unknown as AppStore;

function renderPanel() {
  return render(createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(DeveloperPanel, { store }),
  }));
}

describe("DeveloperPanel disclosures", () => {
  it("keeps server settings and examples closed while the listener can be started", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start API" })).toBeEnabled());

    const settings = screen.getByText("Server settings", { selector: "summary" }).closest("details");
    const examples = screen.getByText("API reference & examples", { selector: "summary" }).closest("details");
    expect(settings).not.toHaveAttribute("open");
    expect(examples).not.toHaveAttribute("open");
  });
});
