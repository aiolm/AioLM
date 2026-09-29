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
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
}));

const store = {
  cfg: null,
  status: { state: "stopped" },
  start: async () => "",
} as unknown as AppStore;

function renderPanel(section: "api" | "diagnostics") {
  return render(createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(DeveloperPanel, { store, section }),
  }));
}

/** Sections of the old API / Gateways split. None of them belongs to the single API server screen. */
const legacySections = [
  ".developer-summary-grid", ".developer-section--connection", ".developer-section--endpoints", ".developer-section--compatibility",
  ".developer-section--snippets", ".developer-section--gateway", ".developer-section--responses",
];

describe("DeveloperPanel layout", () => {
  it("renders the API server as one screen: control, models, connection, then closed details", async () => {
    const { container } = renderPanel("api");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start API" })).toBeEnabled());

    expect(container.querySelector(".api-server-page")).toHaveAttribute("data-developer-section", "api");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("API server");
    const control = container.querySelector(".api-server-control")!;
    const models = container.querySelector(".api-models")!;
    const connection = container.querySelector(".api-connection")!;
    const details = Array.from(container.querySelectorAll<HTMLDetailsElement>("details.api-disclosure"));
    for (const [before, after] of [[control, models], [models, connection], [connection, details[0]]]) {
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Port settings and the API reference are native details, closed by default.
    expect(details.map(item => item.querySelector("summary")?.textContent)).toEqual(["Server settings", "API reference & examples"]);
    expect(details.map(item => item.open)).toEqual([false, false]);
  });

  it("has no summary cards and none of the old API / Gateways sections", async () => {
    const { container } = renderPanel("api");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start API" })).toBeEnabled());

    for (const selector of legacySections) expect(container.querySelector(selector)).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--diagnostics")).not.toBeInTheDocument();
    // The model count appears beside the model list heading only once the API has answered.
    expect(container.querySelector(".api-model-count")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/gateway/i);
  });

  it("keeps model diagnostics on the diagnostics screen only", () => {
    const { container } = renderPanel("diagnostics");

    expect(container.querySelector(".api-server-page")).toHaveAttribute("data-developer-section", "diagnostics");
    expect(container.querySelector(".developer-section--diagnostics")).toBeInTheDocument();
    for (const selector of [...legacySections, ".api-server-control", ".api-models", ".api-connection", ".developer-api-status", "details"]) {
      expect(container.querySelector(selector)).not.toBeInTheDocument();
    }
  });
});
