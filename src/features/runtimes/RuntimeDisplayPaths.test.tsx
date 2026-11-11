import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { translate, type UnifiedKey, type TranslationVars } from "../../shared/i18n/i18nUnified";
import type { PullRequestPreview } from "../../shared/api/types";
import RuntimePullRequestProvenance from "./RuntimePullRequestProvenance";

const path = String.raw`\\?\C:\runtimes\llama-server.exe`;
const networkPath = String.raw`\\?\UNC\server\models\model.gguf`;
const displayNetworkPath = String.raw`\\server\models\model.gguf`;
const t = (key: UnifiedKey, vars?: TranslationVars) => translate("en", key, vars);

function expectReadableMarkup(container: HTMLElement) {
  expect(container.textContent).not.toContain(path.slice(0, 4));
  for (const element of container.querySelectorAll("[title], [aria-label]")) {
    expect(element.getAttribute("title") ?? "").not.toContain(path.slice(0, 4));
    expect(element.getAttribute("aria-label") ?? "").not.toContain(path.slice(0, 4));
  }
}

describe("runtime path presentation", () => {
  it("cleans path examples in pull-request details and artifact lookup failures", () => {
    const preview: PullRequestPreview = {
      pull_request: 123, title: `Fix loading ${networkPath}`, state: "open", draft: false,
      author: "contributor", repository: "contributor/llama.cpp", head_ref: "fix-paths",
      commit: "a".repeat(40), fork: true, url: "https://example.test/pull/123",
      archive_url: "https://example.test/archive.zip", updated_at: "2026-09-12T00:00:00Z",
      advisories: ["fork"], artifact_error: `Cannot write ${path}`,
    };
    const { container } = render(<I18nProvider initialLocale="en"><RuntimePullRequestProvenance t={t} preview={preview} backend="cpu" /></I18nProvider>);

    expect(screen.getByText(`Fix loading ${displayNetworkPath}`)).toBeInTheDocument();
    expect(container).toHaveTextContent(String.raw`Cannot write C:\runtimes\llama-server.exe`);
    expectReadableMarkup(container);
    expect(preview.title).toBe(`Fix loading ${networkPath}`);
  });

});
