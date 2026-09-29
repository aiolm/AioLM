import { describe, expect, it } from "vitest";
import type { ServerState } from "../api/types";
import { translate } from "../i18n/i18nUnified";
import { modelStatusKey } from "./serverLifecycle";

const states: ServerState[] = ["stopped", "starting", "running", "stopping", "failed", "crashed"];

describe("model status labels", () => {
  it("describes every model state in each locale without naming the API server", () => {
    for (const locale of ["en", "ko", "ja", "zh"] as const) {
      const labels = states.map((state) => translate(locale, modelStatusKey(state)));
      expect(new Set(labels).size).toBe(states.length);
      for (const label of labels) {
        expect(label.trim()).not.toBe("");
        expect(label).not.toMatch(/^(status|action)\./);
        expect(label).not.toMatch(/api/i);
      }
    }
  });

  it("uses load and unload wording in English for the model lifecycle", () => {
    expect(translate("en", modelStatusKey("running"))).toBe("model loaded");
    expect(translate("en", modelStatusKey("stopped"))).toBe("no model loaded");
    expect(translate("en", modelStatusKey("starting"))).toBe("loading model");
    expect(translate("en", modelStatusKey("stopping"))).toBe("unloading model");
    expect(translate("en", "action.stop")).toBe("Unload");
  });
});
