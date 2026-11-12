import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { loadLocale } from "./src/shared/i18n/i18nUnified";

// Components and direct catalog consumers remain synchronous in tests.
await Promise.all((["ko", "ja", "zh"] as const).map(loadLocale));

// jsdom ships <dialog> but not showModal()/close(). Without these, any
// component that opens a modal throws on mount instead of rendering. The
// polyfill only maintains the `open` state, which is what tests assert on.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, returnValue?: string) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}

// jsdom does not implement scrollTo() on elements; components that scroll a
// container into view on update throw on mount without this.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));
