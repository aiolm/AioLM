import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { projectFromConfig, readProjects, setActiveProjectId, writeProjects } from "./projectStore";
import ProjectsPanel from "./Projects";

describe("Project configuration snapshots", () => {
  beforeEach(() => localStorage.clear());

  it("keeps saved tuning when only project metadata changes", () => {
    const store = createTestStore({ ctx_size: 8192, temperature: 0.3, runtime_defaults: ["ngl"] });
    const project = projectFromConfig("Research", "Cite the source", store.cfg!);
    writeProjects([project]); setActiveProjectId(project.id);
    store.cfg = { ...store.cfg!, ctx_size: 2048, temperature: 1.1, runtime_defaults: [] };
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Research"), { target: { value: "Research notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0].config).toMatchObject({ ctx_size: 8192, temperature: 0.3, runtime_defaults: ["ngl"] });
    expect(readProjects()[0].name).toBe("Research notes");
  });

  it("captures current settings explicitly while preserving workspace content", () => {
    const gpu = { gpu_ids: ["runtime:cuda:CUDA0"], main_gpu: "runtime:cuda:CUDA0", split_mode: "none" as const, tensor_split: [], draft_gpu_id: null };
    const store = createTestStore();
    const project = projectFromConfig("Research", "Cite the source", store.cfg!, [{ name: "notes.md", path: "notes.md" }], ["docs:search"]);
    writeProjects([project]); setActiveProjectId(project.id);
    store.cfg = { ...store.cfg!, ctx_size: 32768, gpu, runtime_defaults: ["ngl", "temperature"] };
    render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Use current settings" }));
    expect(readProjects()[0].config.ctx_size).toBe(4096);
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ systemPrompt: "Cite the source", toolIds: ["docs:search"], documentBindings: [{ name: "notes.md", path: "notes.md" }], config: { ctx_size: 32768, gpu, runtime_defaults: ["ngl", "temperature"] } });
  });

  it("hides prefixes in restored document editors and model tooltips while preserving saved paths", () => {
    const model = String.raw`\\?\C:\models\test.gguf`;
    const document = String.raw`\\?\UNC\server\share\notes.md`;
    const displayDocument = String.raw`\\server\share\notes.md`;
    const store = createTestStore({ active_model: model });
    const project = projectFromConfig("Research", "Cite the source", store.cfg!, [{ name: "notes.md", path: document }]);
    writeProjects([project]); setActiveProjectId(project.id);
    const { container } = render(<I18nProvider initialLocale="en"><ProjectsPanel store={store} /></I18nProvider>);
    expect(screen.getByLabelText("Document bindings · one path per line")).toHaveValue(displayDocument);
    expect(container.querySelector('dd[title]')).toHaveAttribute('title', String.raw`C:\models\test.gguf`);
    expect(container.textContent).not.toContain('\\\\?\\');
    fireEvent.click(screen.getByRole("button", { name: "Update project" }));
    expect(readProjects()[0]).toMatchObject({ config: { active_model: model }, documentBindings: [{ name: "notes.md", path: document }] });
  });
});
