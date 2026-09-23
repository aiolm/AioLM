import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../shared/api/types";
import { testConfig } from "../../testing/appStore";
import { runtimeReferences } from "./runtimeReferences";

const configured: AppConfig = {
  ...testConfig,
  active_backend: "cuda",
  active_build: "b6215",
  sessions: [
    { id: "translate", name: "Translation", models: { primary_model: "translate.gguf", mmproj: "", draft_model: "" }, gpu: { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null }, enabled: true,
      execution: { active_backend: "cuda", active_build: "b6215" } },
    { id: "draft", name: "Drafting", models: { primary_model: "draft.gguf", mmproj: "", draft_model: "" }, gpu: { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null }, enabled: true,
      execution: { active_backend: "vulkan", active_build: "b11035" } },
  ],
  settings_profiles: {
    version: 1, revision: 4, legacy_imported: true, default_profile_id: "profile-default",
    entries: [
      { id: "profile-default", name: "Default", scope: "global", revision: 2, settings: { active_backend: "cuda", active_build: "b6215" } },
      { id: "profile-long", name: "Long context", scope: "global", revision: 1, settings: { active_backend: "vulkan", active_build: "b11035" } },
    ],
    applied: {
      "model:c:/models/chat.gguf": { model: "C:/models/chat.gguf", profile_id: "profile-default", settings: { active_backend: "cuda", active_build: "b6215" }, system_prompt: "" },
      "model:c:/models/other.gguf": { model: "C:/models/other.gguf", profile_id: "profile-long", settings: { active_backend: "vulkan", active_build: "b11035" }, system_prompt: "" },
      "session:translate": { model: "translate.gguf", profile_id: "profile-default", settings: { active_backend: "cuda", active_build: "b6215" }, system_prompt: "" },
    },
  },
};

describe("runtime references", () => {
  it("names every target a removal would leave without a runtime", () => {
    // Removing a build clears it everywhere rather than repointing anything at a
    // surviving build, so the confirmation has to reach all four places a
    // runtime is stored: the default execution, profiles, session overrides,
    // and the per-target applications.
    expect(runtimeReferences(configured, "cuda", "b6215")).toEqual([
      { kind: "default", name: "" },
      { kind: "profile", name: "Default" },
      { kind: "session", name: "Translation" },
      { kind: "model", name: "chat.gguf" },
    ]);
  });

  it("lists a session once even when its override and its application both name the runtime", () => {
    const listed = runtimeReferences(configured, "cuda", "b6215");
    expect(listed.filter(item => item.kind === "session")).toHaveLength(1);
  });

  it("leaves out everything that names a different build", () => {
    expect(runtimeReferences(configured, "vulkan", "b11035")).toEqual([
      { kind: "profile", name: "Long context" },
      { kind: "session", name: "Drafting" },
      { kind: "model", name: "other.gguf" },
    ]);
    expect(runtimeReferences(configured, "cuda", "b6102")).toEqual([]);
    expect(runtimeReferences(null, "cuda", "b6215")).toEqual([]);
  });
});
